#!/usr/bin/env bash
# session-runner — drains the ready-for-session queue unattended (#538,
# ADR 0174). The workstation already runs unattended claude with host standing
# (healer, reporter); this extends that SAME standing from "heal reds" to
# "work the session queue" — it is not a new credential grant to sandboxed
# workers, and swarm workers still never see ready-for-session (their queue
# reads only ready-for-agent).
#
# One tick: kill switch → lock → limit park → pick the first workable ticket
# (priority first, then oldest; skip no-triage/deferred/agent-blocked/
# agent-working/blocked-by-open-deps/cooling-down) → claim with agent-working
# → run ONE headless claude session against a DEDICATED checkout → judge the
# outcome by the ticket itself (closed or no longer ready-for-session =
# advanced). Two unadvanced attempts escalate: agent-blocked + a ticket
# comment naming the log. Limit refusals ride the #510 two-account failover
# and park the host when both windows are gone — never counted as a ticket
# failure.
#
# Crontab (one line per enrolled repo on the host — the env file and the
# per-repo checkout path are the host's, sourced/rendered, never defaulted
# here):
#   */10 * * * * . <swarm-home>/env.sh && <swarm-home>/<owner>/<repo>/.sandcastle/session-runner.sh >> <swarm-home>/session-runner-<repo>.log 2>&1
#
# Kill switch: SESSION_RUNNER=0 in env, or touch the off-file
# (.sandcastle/session-runner.off by default) — checked before ANY network.
# Rollout knob: SESSION_RUNNER_PICK=<n> pins the pick to one ticket.
# Host affinity (#89): a ticket whose body carries `<!-- session-host: <name> -->`
# is picked ONLY by a host it names (no marker = any host, so nothing existing
# changes). Skipped at pick time, so a wrong-host skip burns no attempt.
# SESSION_RUNNER_HOST=<name> overrides the name this host answers to.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SESSION_RUNNER_PROMPT_FILE="${SESSION_RUNNER_PROMPT_FILE:-$here/session-runner-prompt.md}"

# ── kill switch: before any API call ─────────────────────────────────────────
SESSION_RUNNER_OFF_FILE="${SESSION_RUNNER_OFF_FILE:-$here/session-runner.off}"
if [ "${SESSION_RUNNER:-1}" = "0" ] || [ -f "$SESSION_RUNNER_OFF_FILE" ]; then
  echo "session-runner: kill switch is on — quiet tick"
  exit 0
fi

# shellcheck source=limit-lib.sh
. "$here/limit-lib.sh"
# shellcheck source=session-host-lib.sh
. "$here/session-host-lib.sh"  # host affinity for the queue (#89): session_host_marker/_match/_self — pure, no network.
# shellcheck source=model-lib.sh
. "$here/model-lib.sh"        # SWARM_MODEL — swarm.config is the ONE model source (#448); before this the session claude call passed no --model and ran on the host user's CLI default
# shellcheck source=swarm-db-lib.sh
. "$here/swarm-db-lib.sh"     # the swarm.db trace mirror (#447): a session it ACTUALLY starts records into the SAME host db the swarm uses, so monitors see it (#81). Best-effort — a mirror it cannot write never reds a tick.

# shellcheck disable=SC1091
if [ -z "${FORGEJO_TOKEN:-}" ] && [ -f "$here/.env" ]; then . "$here/.env"; fi
: "${FORGEJO_TOKEN:?}"
# shellcheck source=identity-lib.sh
. "$here/identity-lib.sh"     # identity_require — the contract seam (#31)
# shellcheck source=swarm-identity.sh
. "${SWARM_IDENTITY_FILE:-$here/swarm-identity.sh}"   # FORGEJO_API / REPO_SLUG — this repo's identity (ADR 0180 / #571)
# Host state is REPO-SCOPED (#35, ADR 0004 point 6). Two enrolled repos on one
# host must not share a lock (a host-global lock let one repo's in-flight
# session absorb every OTHER repo's tick for a whole SESSION_RUNNER_TIMEOUT with
# no rotation — Ben's starvation report) NOR a state dir (its fail-$n/attempt-$n
# counters are keyed by ISSUE NUMBER alone, which is per-repo: a host-global dir
# escalated repo A's issue 3 under repo B's issue 3). Key all three by REPO_SLUG
# (sanitised — '/' cannot appear in a filename). Host-wide heavy concurrency is
# STILL capped at 2 by the shared host capacity pool below; this only stops the
# host-global lock in FRONT of that pool from starving a peer. Each keeps its
# ${VAR:=…} override form: a caller pinning the old shared path still wins, and
# pre-change fail-*/attempt-* under the old dir are simply orphaned (they carry
# no repo attribution — the correct outcome, no migration).
sr_slug="${REPO_SLUG//\//-}"
# Issue numbers are per-repo (#35/#36), so this must NOT default to any product's
# number: a baked-in default silently filters that issue out of EVERY consumer's
# ready-for-session queue. Default it EMPTY — an unset value filters nothing (the
# select below is a no-op when $drive is "") — and let a repo that runs a standing
# drive declare its own number from its identity layer, exactly as
# list-ready-tasks.sh already does (#43).
: "${REHEARSAL_DRIVE_ISSUE:=}"
# Prefix for the repo-scoped /tmp derivations below (the lock, the drive-defer
# counter). Overridable so the offline suite can exercise the REAL repo-scoped
# derivation logic (test 13, #35) inside its own temp dir instead of littering
# the live host's /tmp with one leaked lock per suite run (#58). Production
# leaves it /tmp; a caller pinning the full SESSION_RUNNER_LOCK still wins the
# `:=` below, so no existing override changes.
: "${SESSION_RUNNER_TMP:=/tmp}"
: "${SESSION_RUNNER_STATE:=$HOME/.local/state/matou-session-runner-$sr_slug}"
: "${SESSION_RUNNER_CHECKOUT:=$HOME/session-runner/${REPO_SLUG##*/}}"
: "${SESSION_RUNNER_REPO:=https://git.matou.nz/${REPO_SLUG}.git}"
: "${SESSION_RUNNER_LOCK:=$SESSION_RUNNER_TMP/matou-session-runner-$sr_slug.lock}"
# Belt to the outer lock (#78, GOTCHAS 25). SESSION_RUNNER_LOCK is keyed by the
# REPO_SLUG *spelling*, but SESSION_RUNNER_CHECKOUT is keyed by the BARE repo
# name (`##*/`) — so two invocations whose slug differs while the checkout
# matches, or one with SESSION_RUNNER_LOCK pinned by an env file and one on the
# default, take DIFFERENT outer locks over the SAME tree. The second tick's
# `git reset --hard` + `clean -fd` (below) then silently destroy the first,
# still-live session's uncommitted work. This second guard is keyed off the
# CHECKOUT PATH itself, so the invariant is one-lock-per-CHECKOUT, not
# one-lock-per-slug-spelling: any two invocations that resolve the same
# SESSION_RUNNER_CHECKOUT contend here however they were invoked. flock releases
# on process death, so a crashed session leaves no stale owner to reap — a later
# tick simply takes it. Same ${VAR:=…} override form as the paths above, and it
# rides the same SESSION_RUNNER_TMP prefix so the offline suite never leaves an
# owner-lock file in the live host's real /tmp either (#58).
: "${SESSION_RUNNER_OWNER_LOCK:=$SESSION_RUNNER_TMP/matou-session-runner-owner${SESSION_RUNNER_CHECKOUT//\//-}.lock}"
: "${SESSION_RUNNER_TIMEOUT:=7200}"
: "${SESSION_RUNNER_COOLDOWN:=3600}"
# Release-path nudge (#45): the command to fire once a heavy session ends and its
# pooled slot is freed, so the slot is consumed by the STALEST repo within ~a
# minute instead of waiting up to a full backstop (15m) / cron (30m) window. The
# host renders this to its own <home>/factory-cron/backstop-tick.sh path (which
# now dispatches stalest-first, #45) — never defaulted to any host here (a path
# is host state; the empty default fires nothing and keeps offline ticks quiet).
: "${SESSION_RUNNER_NUDGE:=}"
mkdir -p "$SESSION_RUNNER_STATE/logs"

api() { curl -sf --max-time 30 -H "Authorization: token $FORGEJO_TOKEN" "$@"; }
# The message is DATA, never a command: emit the fallback with printf '%s\n'
# (not echo) so a leading '-'/backslash — or a ':shortcode:' — reaches the log
# verbatim and can never be interpreted as a flag or escape (#27).
notify() { bash "$here/notify-mattermost.sh" "$1" >/dev/null 2>&1 || printf 'session-runner: (notice) %s\n' "$1"; }

# session_runner_nudge — after a heavy session ends and its slot is freed, fire
# ONE backstop tick so the freed slot is consumed by the stalest repo fast (#45).
# Best-effort and time-bounded: a nudge that finds the slot already re-taken just
# loses like any other probe (#238's never-camp posture), and it must never delay
# or fail the tick. No-op when SESSION_RUNNER_NUDGE is unset (offline ticks, and
# a host that has not rendered a backstop). Called from exactly one choke point —
# the post-session outcome path — so a yielded/absorbed/parked tick never nudges.
session_runner_nudge() {
  [ -n "$SESSION_RUNNER_NUDGE" ] || return 0
  echo "session-runner: nudging the host backstop so the freed slot is consumed fast (#45)"
  timeout 120 bash -c "$SESSION_RUNNER_NUDGE" >/dev/null 2>&1 || true
}

# Loud, not silent (#31): one Mattermost line when a tick dies BEFORE it can
# claim — but rate-limited per fault signature like the healer, so a runner
# broken for hours posts once per cooldown, not once per */10 tick. The #31
# hazard is a drainer that fails every tick without a trace; the identity seam
# below is its first caller. Signature = the message folded to a stable key; a
# stamp under state gates the repeat.
SESSION_RUNNER_ALARM_COOLDOWN="${SESSION_RUNNER_ALARM_COOLDOWN:-21600}"   # 6h
session_runner_alarm() {
  local msg="$1" sig stamp
  sig="$(printf '%s' "$msg" | cksum | tr -cd '0-9')"
  stamp="$SESSION_RUNNER_STATE/alarm-$sig"
  if [ -f "$stamp" ] && [ $(( $(date +%s) - $(stat -c %Y "$stamp") )) -le "$SESSION_RUNNER_ALARM_COOLDOWN" ]; then
    echo "session-runner: (alarm within cooldown, not reposting) $msg"
    return 0
  fi
  : > "$stamp"
  notify ":rotating_light: **session-runner: dead tick before claiming** — $msg"
}

# ── identity contract seam (#31): the harness calls swarm_git_identity, defined
#    in the consumer-owned (vendor-excluded) swarm-identity.sh. If a pin bump
#    needs a newer identity layer than the consumer regenerated, fail LOUD here
#    — before the lock, the pool, any claim — and post ONE rate-limited alarm,
#    never die mid-tick on `command not found` after ~15 silent claim-flickering
#    ticks (the #31 outage). ────────────────────────────────────────────────
if ! id_err="$(identity_require 2>&1)"; then
  echo "session-runner: $id_err" >&2
  session_runner_alarm "$id_err"
  exit 2
fi

# ── one at a time: a session in flight absorbs this tick ─────────────────────
exec 9>"$SESSION_RUNNER_LOCK"
if ! flock -n 9; then echo "session-runner: session in flight — tick absorbed"; exit 0; fi

# ── belt: one live session per CHECKOUT (#78, GOTCHAS 25) ────────────────────
# The outer lock above is keyed by slug; this one is keyed by the checkout, so a
# tick that slipped past a differently-keyed outer lock (a divergent slug
# spelling, one caller with SESSION_RUNNER_LOCK pinned and one not) still cannot
# reset/clean a tree another session is live in. Checked HERE — before the pick,
# the claim, and the reset/clean below — never after, so no destructive git runs
# against an owned tree. Non-blocking (never camp) and held for the session's
# whole life (the fd stays open to process exit); flock releases on death, so a
# crashed session leaves no stale owner and a later tick simply takes it.
exec {sr_owner_fd}>"$SESSION_RUNNER_OWNER_LOCK"
if ! flock -n "$sr_owner_fd"; then
  echo "session-runner: another live session owns the checkout — tick absorbed"
  exit 0
fi

# ── join the host capacity pool: a live session-runner session runs a
#    headless claude call exactly like a swarm/triage worker, so it now
#    counts against the SAME 2-slot host-wide pool instead of being
#    invisible to it (a live session and a live swarm worker could
#    otherwise both run concurrently, unbounded). Held for the same span
#    SESSION_RUNNER_LOCK already covers — process exit releases both fds.
# shellcheck source=host-capacity-lib.sh
. "$here/host-capacity-lib.sh"
# Drive reservation (#663 producer / #664 consumer): a waiting rehearsal drive
# needs EVERY host lock at once and yields the instant one is busy, so it loses
# to anything that claims in the gap — unboundedly. Stand down BEFORE taking a
# slot; this tick is idempotent and costs nothing deferred. Work already running
# is untouched, and the predicate is TTL-bounded so an abandoned reservation
# expires instead of absorbing every tick forever. The consecutive-defer count
# is session-runner's OWN (not the drive's) — its */10 cadence differs from
# swarm's and triage's, so each consumer tracks its own streak (#664).
SESSION_RUNNER_DRIVE_DEFER_COUNT="${SESSION_RUNNER_DRIVE_DEFER_COUNT:-$SESSION_RUNNER_TMP/matou-session-runner-$sr_slug-drive-defer-count}"
if host_capacity_drive_wanted; then
  n="$(host_capacity_consumer_defer_bump "$SESSION_RUNNER_DRIVE_DEFER_COUNT")"
  echo "session-runner: a rehearsal drive has reserved host capacity (#663) — deferring to a ready drive — skipped $n consecutive tick(s)"
  exit 0
fi
host_capacity_consumer_defer_reset "$SESSION_RUNNER_DRIVE_DEFER_COUNT"
if ! host_capacity_acquire_heavy; then
  echo "session-runner: host capacity pool exhausted — tick absorbed"
  exit 0
fi

# ── the host-global limit guard every claude caller rides (#253/#510) ────────
# A session tick is also a limit-park EXIT observer (#100): if the marker is
# stale, close its window with a paired unpark event before deciding to proceed.
claude_limit_sweep
if claude_limit_parked; then
  echo "session-runner: host is limit-parked — quiet tick"
  exit 0
fi

# ── label ids, LOUD on a missing label (never guess an id) ───────────────────
labels_json="$(api "$FORGEJO_API/labels?limit=50")" \
  || { echo "session-runner: cannot read labels — quiet tick"; exit 0; }
label_id() {
  jq -er --arg n "$1" '.[] | select(.name == $n) | .id' <<<"$labels_json" \
    || { echo "session-runner: label '$1' missing on the repo" >&2; return 1; }
}
aw_id="$(label_id agent-working)"
ab_id="$(label_id agent-blocked)"

# session_runner_escalate <issue-number> <note-sentence> — two attempts without
# progress: agent-blocked + a ticket comment + one Mattermost line. Shared by the
# post-session outcome path AND the stale-claim sweep (#63), so a session that
# DIED without its EXIT trap firing is accounted identically to one that ran
# without advancing — the two-failure escalation fires on genuine repeat deaths
# either way.
session_runner_escalate() {
  local n="$1" note="$2"
  echo "session-runner: escalating #$n — two attempts without progress"
  jq -n --argjson l "$ab_id" '{labels: [$l]}' \
    | api -X POST -H 'Content-Type: application/json' -d @- \
        "$FORGEJO_API/issues/$n/labels" >/dev/null || true
  jq -n --arg b "session-runner: two unattended attempts did not advance this ticket — labelled \`agent-blocked\` for a human look (ADR 0174 escalation). $note Remove \`agent-blocked\` (and the stale fail counter if re-arming by hand) to let the runner retry." '{body: $b}' \
    | api -X POST -H 'Content-Type: application/json' -d @- \
        "$FORGEJO_API/issues/$n/comments" >/dev/null || true
  notify ":rotating_light: **session-runner escalated #$n** — two attempts, no progress; \`agent-blocked\`, human look needed. $note"
}

# ── stale-claim sweep (#63) ──────────────────────────────────────────────────
# A session that died without its EXIT trap firing (SIGKILL/OOM/reboot class)
# leaves its agent-working claim on the ticket forever; the picker excludes
# agent-working, so the ticket goes INVISIBLE to every future tick — silently,
# until an operator spots it by eye. Reclaim it before the pick: for each
# ready-for-session issue still carrying agent-working, release the claim iff
# THIS host owns the attempt. Ownership is proven by LOCAL state alone —
# SESSION_RUNNER_STATE is both repo-scoped AND host-local (#35), so an
# attempt-$n marker existing here means THIS host (not a peer host, not another
# repo) ran that attempt; a claim with no local marker belongs to a peer's slot
# or another repo and is left untouched. We hold the repo-scoped flock above, so
# no session of OURS is live. Only reclaim a marker older than
# SESSION_RUNNER_TIMEOUT + slack — a younger one is a live session on a slow
# ticket, never swept. A reclaim IS the failed attempt it was (bump fail-$n), so
# the two-failure escalation still fires on genuine repeat deaths.
SESSION_RUNNER_STALE_SLACK="${SESSION_RUNNER_STALE_SLACK:-300}"
stale_after=$(( SESSION_RUNNER_TIMEOUT + SESSION_RUNNER_STALE_SLACK ))
sweep_queue="$(api "$FORGEJO_API/issues?state=open&type=issues&labels=ready-for-session&limit=50")" || sweep_queue=""
if [ -n "$sweep_queue" ]; then
  sweep_now="$(date +%s)"
  for sn in $(jq -r '[.[] | select(([.labels[].name] | index("agent-working")) != null)] | .[].number' <<<"$sweep_queue" 2>/dev/null || true); do
    am="$SESSION_RUNNER_STATE/attempt-$sn"
    [ -f "$am" ] || continue                                   # no local marker → a peer host / another repo owns this claim
    [ $(( sweep_now - $(stat -c %Y "$am") )) -gt "$stale_after" ] || continue   # younger than timeout+slack → a live slow session
    echo "session-runner: #$sn carries a stale agent-working claim (attempt older than ${stale_after}s, no live session) — releasing and counting the failed attempt (#63)"
    api -X DELETE "$FORGEJO_API/issues/$sn/labels/$aw_id" >/dev/null 2>&1 || true
    sfails=$(( $(cat "$SESSION_RUNNER_STATE/fail-$sn" 2>/dev/null || echo 0) + 1 ))
    echo "$sfails" > "$SESSION_RUNNER_STATE/fail-$sn"
    if [ "$sfails" -ge 2 ]; then
      session_runner_escalate "$sn" "The prior session left no exit trace (SIGKILL/OOM/reboot class); its stale claim was swept (#63)."
    fi
  done
fi

# ── pick: priority first, then oldest; hard filters in jq, per-ticket checks
#    (deps, cooldown, fail cap) in the loop ────────────────────────────────────
if [ -n "${SESSION_RUNNER_PICK:-}" ]; then
  candidates="$SESSION_RUNNER_PICK"
else
  queue="$(api "$FORGEJO_API/issues?state=open&type=issues&labels=ready-for-session&limit=50")" \
    || { echo "session-runner: cannot read the queue — quiet tick"; exit 0; }
  candidates="$(jq -r --arg drive "$REHEARSAL_DRIVE_ISSUE" '
    [ .[]
      | select(.state == "open")
      | select( (.number | tostring) != $drive )
      | select( ([.labels[].name] | index("no-triage"))     == null )
      | select( ([.labels[].name] | index("deferred"))      == null )
      | select( ([.labels[].name] | index("agent-blocked")) == null )
      | select( ([.labels[].name] | index("agent-working")) == null )
    ]
    | sort_by((if ([.labels[].name] | index("priority")) != null then 0 else 1 end), .number)
    | .[].number' <<<"$queue")"
fi

# sr_issue_body <n> — the ticket's body, from the queue read we already hold
# (the list endpoint carries `.body`, so the host filter below costs ZERO extra
# API calls on the normal path). Only the SESSION_RUNNER_PICK rollout path,
# which skips the queue read entirely, pays a fetch. A body we cannot read is
# empty — i.e. "any host", the pre-#89 behaviour, never a hard fail.
sr_issue_body() {
  local n="$1" b=""
  if [ -n "${queue:-}" ]; then
    b="$(jq -r --arg n "$n" '.[] | select((.number|tostring) == $n) | .body // ""' <<<"$queue" 2>/dev/null || true)"
    [ -n "$b" ] && { printf '%s\n' "$b"; return 0; }
  fi
  api "$FORGEJO_API/issues/$n" | jq -r '.body // ""' 2>/dev/null || true
}

sr_host="$(session_host_self)"
pick=""
for n in $candidates; do
  # host affinity (#89) FIRST — cheapest check, and the one that must never
  # reach the fail counter: a ticket pinned to another host's standing is not
  # this host's failed attempt, it is not this host's ticket at all. Skipping
  # here (before the claim, the attempt marker and fail-$n) is what stops a
  # correctly-labelled ticket walking itself to agent-blocked on two hosts that
  # could never have done it.
  sr_want="$(session_host_marker "$(sr_issue_body "$n")")"
  if ! session_host_match "$sr_want" "$sr_host"; then
    echo "session-runner: #$n is declared for host(s) '$sr_want' — this host is '$sr_host'; skipped (not an attempt, #89)"
    continue
  fi
  # cooling down after a failed attempt? (mtime-fresh attempt marker)
  am="$SESSION_RUNNER_STATE/attempt-$n"
  if [ "$SESSION_RUNNER_COOLDOWN" -gt 0 ] && [ -f "$am" ] \
     && [ $(( $(date +%s) - $(stat -c %Y "$am") )) -le "$SESSION_RUNNER_COOLDOWN" ]; then
    echo "session-runner: #$n cooling down — skipped"; continue
  fi
  # already escalated? (belt to agent-blocked's braces)
  if [ -f "$SESSION_RUNNER_STATE/fail-$n" ] && [ "$(cat "$SESSION_RUNNER_STATE/fail-$n")" -ge 2 ]; then
    echo "session-runner: #$n failed twice — escalated, skipped"; continue
  fi
  open_deps="$(api "$FORGEJO_API/issues/$n/dependencies?limit=50" \
    | jq '[.[] | select(.state == "open")] | length')" \
    || { echo "session-runner: #$n dependency check failed — skipped (never run on an unverified frontier)"; continue; }
  [ "$open_deps" = "0" ] || { echo "session-runner: #$n blocked by $open_deps open issue(s) — skipped"; continue; }
  pick="$n"; break
done
[ -n "$pick" ] || { echo "session-runner: nothing workable in the session queue — quiet tick"; exit 0; }

issue="$(api "$FORGEJO_API/issues/$pick")" || { echo "session-runner: cannot read #$pick — quiet tick"; exit 0; }
title="$(jq -r '.title' <<<"$issue")"
body="$(jq -r '.body' <<<"$issue")"
echo "session-runner: picked #$pick — $title"

# ── claim: agent-working, released on every exit path ────────────────────────
claimed=0
release_claim() {
  [ "$claimed" = 1 ] || return 0
  curl -sf --max-time 30 -X DELETE -H "Authorization: token $FORGEJO_TOKEN" \
    "$FORGEJO_API/issues/$pick/labels/$aw_id" >/dev/null 2>&1 || true
  claimed=0
}
# swarm.db trace (#447/#81): a session it ACTUALLY starts opens a run row +
# a live-session process row below (set session_recorded=1 at that choke point).
# The EXIT trap finalises them — the SAME kills-finalise discipline run-swarm
# uses (swarm-db.py invariant 2): a graceful exit closes the process row and
# stamps the run verdict; a SIGKILL/OOM/reboot leaves the process row OPEN
# (ended_at NULL = believed alive = the #435 wedge marker every monitor already
# reads). A tick that never started a session (kill switch, absorbed, parked,
# nothing workable) records NOTHING — session_recorded stays 0 (no per-empty
# -tick noise, the ticket's own requirement).
session_recorded=0
sr_run_db_id=""
sr_verdict=""       # set at each intentional post-start exit; else derived
sr_on_exit() {
  local ec=$?
  release_claim
  [ "$session_recorded" = 1 ] || return 0
  local now reason
  now="$(date +%s)"
  reason="${sr_verdict:-died-in:session}"
  swarmdb proc-close --run "$sr_run_db_id" --ref "$$" --ended "$now"
  swarmdb_run_end "$sr_run_db_id" "$reason" "$reason" "$ec" "$now"
}
trap sr_on_exit EXIT
# Kills finalise the trace (invariant 2): a graceful SIGTERM/SIGINT (systemd
# stop, an operator ^C) is routed through the EXIT trap so the process row
# closes cleanly, exactly as run-swarm routes its own signals. An untrappable
# SIGKILL/OOM/reboot cannot reach here — its open row is the wedge marker, by
# design. 143 = 128+SIGTERM, 130 = 128+SIGINT.
sr_on_signal() { sr_verdict="killed:$1"; trap - EXIT; (exit "$2"); sr_on_exit; exit "$2"; }
trap 'sr_on_signal SIGTERM 143' TERM
trap 'sr_on_signal SIGINT 130' INT
jq -n --argjson l "$aw_id" '{labels: [$l]}' \
  | api -X POST -H 'Content-Type: application/json' -d @- \
      "$FORGEJO_API/issues/$pick/labels" >/dev/null \
  || { echo "session-runner: could not claim #$pick — quiet tick"; exit 0; }
claimed=1

# ── dedicated checkout (NEVER the shared swarm checkout — peers work there) ──
if [ ! -d "$SESSION_RUNNER_CHECKOUT/.git" ]; then
  git clone -q "$SESSION_RUNNER_REPO" "$SESSION_RUNNER_CHECKOUT" \
    || { echo "session-runner: clone failed — releasing claim, quiet tick"; exit 0; }
fi
git -C "$SESSION_RUNNER_CHECKOUT" fetch -q origin || true
git -C "$SESSION_RUNNER_CHECKOUT" reset -q --hard origin/main || true
git -C "$SESSION_RUNNER_CHECKOUT" clean -qfd || true
# Wire the factory pre-push drift gate into this real (non-sandbox) checkout so a
# session that edits a factory-vendored file (FACTORY_MANIFEST, ADR 0180) is
# blocked BEFORE the push, not by a red seam on main (idss #932). Same knob the
# sandbox sets in main.mts. Best-effort: a config hiccup must not fail the tick.
git -C "$SESSION_RUNNER_CHECKOUT" config core.hooksPath .sandcastle/git-hooks || true

# ── the session: one headless claude, riding the #510 failover ───────────────
# Stamp the factory git identity (#19) so the session's commits carry
# "…(session-runner@<host>)", never the host user's ~/.gitconfig. Belt to the
# identity_require seam's braces (#31): a stamp that claims the contract but is
# missing the symbol still names the fix instead of `command not found`.
command -v swarm_git_identity >/dev/null || {
  echo "identity: swarm_git_identity missing from swarm-identity.sh — re-run: onboard.sh identity ${REPO_SLUG:-<owner/repo>} .sandcastle/swarm-identity.sh" >&2
  exit 2
}
swarm_git_identity session-runner
ts="$(date -u +%Y%m%dT%H%M%SZ)"
log="$SESSION_RUNNER_STATE/logs/run-$pick-$ts.log"
touch "$SESSION_RUNNER_STATE/attempt-$pick"
prompt="$(cat "$SESSION_RUNNER_PROMPT_FILE")

Ticket #$pick: $title

$body"
claude_select_token

# ── swarm.db: THIS is the choke point where a session actually starts ─────────
# One run row (trigger `session`, repo-scoped so the fleet monitor's per-repo
# reads attribute it), one live-session process row (kind `session`, ref the pid
# — ended_at NULL = believed alive), and one attempt row for the ticket (issue
# known at claim). Success is EARNED (invariant 1): the attempt inserts at the
# DB DEFAULT 'fail' and is promoted to 'success' only on the advanced outcome
# below; a limit-park / not-advanced / death keeps 'fail'. Spend IS recorded now
# (#94): the claude call below runs with `--output-format json`, whose usage block
# becomes ONE aggregate `spend` row attributed to the active account — closing the
# #81 gap where a session's real account budget was invisible to the Usage tab.
sr_run_db_id="session-$sr_slug-$(date +%s)-$$"
sr_started="$(date +%s)"
swarmdb_run_start "$sr_run_db_id" "$REPO_SLUG" session "$sr_started"
swarmdb proc-open --run "$sr_run_db_id" --kind session --ref "$$" \
  --command "session-runner #$pick — $title" --started "$sr_started"
swarmdb attempt --run "$sr_run_db_id" --issue "$pick" --started "$sr_started"
session_recorded=1

# `--output-format json` so the call's usage block is captured for the #94 spend
# row: the JSON result lands in $result, diagnostics in $log, and the JSON is then
# folded into $log so the operator log AND the limit scan below still see the full
# session output whichever stream a refusal lands in.
result="$SESSION_RUNNER_STATE/logs/run-$pick-$ts.result.json"
attempt=1
while :; do
  ( cd "$SESSION_RUNNER_CHECKOUT" && timeout "$SESSION_RUNNER_TIMEOUT" claude --model "$SWARM_MODEL" \
      --permission-mode acceptEdits --allowedTools "Edit,Write,Bash,WebFetch,WebSearch" \
      --output-format json -p "$prompt" ) > "$result" 2>"$log" || true
  cat "$result" >> "$log" 2>/dev/null || true
  if claude_limit_hit "$log"; then
    if [ "$attempt" = 1 ] && claude_failover; then
      attempt=2
      echo "session-runner: Claude account limited — failed over to account $(claude_active_account); retrying once"
      continue
    fi
    claude_limit_park
    sr_verdict="limit-parked"   # not a ticket failure; the run row records why the session ended without advancing
    echo "session-runner: Claude usage limit — parked the host; #$pick is untouched (not a failure)"
    notify ":hourglass_flowing_sand: **session-runner parked — Claude limit** while holding #$pick; claim released, the ticket re-queues after the window."
    exit 0
  fi
  break
done

# ── spend: attribute the session's token usage to the active account (#94) ────
# #81 recorded the run/process/attempt rows but NO spend, so every completed
# session's real account budget was invisible to the fleet Usage tab. The
# `--output-format json` result captured above carries the call's usage block;
# turn it into ONE aggregate spend row via the shared swarm-db-lib helper
# (triage/heal adopt the same helper next, #91/#92) — the same account-attributed
# shape record-run-result.sh writes for swarm iterations. Best-effort: a
# usage-less / unparseable result writes nothing and never reds the tick.
sr_account="$(claude_active_account)"
if [ "$(swarmdb_spend_from_result "$sr_run_db_id" "$pick" "$sr_account" "$result")" = 1 ]; then
  echo "session-runner: recorded the session's token spend for account $sr_account (#94)"
fi

# ── freed slot → one backstop nudge (#45) ────────────────────────────────────
# The heavy claude session is done: release the pooled slot NOW (process exit
# would too, but an explicit release lets the nudge's backstop tick see the slot
# already free) and fire exactly ONE backstop nudge. Only a COMPLETED session
# reaches here — every yield/absorb/limit-park path exited above — so this is
# one nudge per session end, none on a yielded or absorbed tick.
host_capacity_release_heavy
session_runner_nudge

# ── outcome: the ticket itself is the verdict ────────────────────────────────
after="$(api "$FORGEJO_API/issues/$pick")" || after=""
state_after="$(jq -r '.state // "unknown"' <<<"$after")"
still_session="$(jq -r '[.labels[].name] | index("ready-for-session") != null' <<<"$after" 2>/dev/null || echo true)"
if [ "$state_after" = "closed" ] || [ "$still_session" = "false" ]; then
  echo "session-runner: #$pick outcome: advanced (state=$state_after, ready-for-session=$still_session)"
  rm -f "$SESSION_RUNNER_STATE/fail-$pick"
  # Success is EARNED — promote the attempt from its DEFAULT 'fail' (invariant 1).
  swarmdb attempt --run "$sr_run_db_id" --issue "$pick" --status success --close-outcome advanced
  sr_verdict="advanced"
  notify ":white_check_mark: **session-runner** worked #$pick — $title (state=$state_after). Log: \`$log\` on the workstation."
  exit 0
fi

sr_verdict="not-advanced"   # the attempt keeps its DEFAULT 'fail' — success was never earned
fails=$(( $(cat "$SESSION_RUNNER_STATE/fail-$pick" 2>/dev/null || echo 0) + 1 ))
echo "$fails" > "$SESSION_RUNNER_STATE/fail-$pick"
echo "session-runner: #$pick outcome: not advanced (attempt $fails)"
if [ "$fails" -ge 2 ]; then
  session_runner_escalate "$pick" "Latest session log: \`$log\` on the workstation."
else
  notify ":warning: **session-runner** attempt $fails on #$pick did not advance it — cooling down, will retry. Log: \`$log\`."
fi
exit 0
