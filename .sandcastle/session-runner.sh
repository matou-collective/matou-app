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
# Crontab (workstation):
#   */10 * * * * . /home/dev/swarm/rehearsal-env.sh && /home/dev/swarm/Matou/idss/.sandcastle/session-runner.sh >> /home/dev/swarm/session-runner.log 2>&1
#
# Kill switch: SESSION_RUNNER=0 in env, or touch the off-file
# (.sandcastle/session-runner.off by default) — checked before ANY network.
# Rollout knob: SESSION_RUNNER_PICK=<n> pins the pick to one ticket.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── kill switch: before any API call ─────────────────────────────────────────
SESSION_RUNNER_OFF_FILE="${SESSION_RUNNER_OFF_FILE:-$here/session-runner.off}"
if [ "${SESSION_RUNNER:-1}" = "0" ] || [ -f "$SESSION_RUNNER_OFF_FILE" ]; then
  echo "session-runner: kill switch is on — quiet tick"
  exit 0
fi

# shellcheck source=limit-lib.sh
. "$here/limit-lib.sh"

# shellcheck disable=SC1091
if [ -z "${FORGEJO_TOKEN:-}" ] && [ -f "$here/.env" ]; then . "$here/.env"; fi
: "${FORGEJO_TOKEN:?}"
# shellcheck source=swarm-identity.sh
. "$here/swarm-identity.sh"   # FORGEJO_API / REPO_SLUG — this repo's identity (ADR 0180 / #571)
: "${REHEARSAL_DRIVE_ISSUE:=492}"
: "${SESSION_RUNNER_STATE:=$HOME/.local/state/matou-session-runner}"
: "${SESSION_RUNNER_CHECKOUT:=$HOME/session-runner/${REPO_SLUG##*/}}"
: "${SESSION_RUNNER_REPO:=https://git.matou.nz/${REPO_SLUG}.git}"
: "${SESSION_RUNNER_LOCK:=/tmp/matou-session-runner.lock}"
: "${SESSION_RUNNER_TIMEOUT:=7200}"
: "${SESSION_RUNNER_COOLDOWN:=3600}"
mkdir -p "$SESSION_RUNNER_STATE/logs"

api() { curl -sf --max-time 30 -H "Authorization: token $FORGEJO_TOKEN" "$@"; }
notify() { bash "$here/notify-mattermost.sh" "$1" >/dev/null 2>&1 || echo "session-runner: (notice) $1"; }

# ── one at a time: a session in flight absorbs this tick ─────────────────────
exec 9>"$SESSION_RUNNER_LOCK"
if ! flock -n 9; then echo "session-runner: session in flight — tick absorbed"; exit 0; fi

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
SESSION_RUNNER_DRIVE_DEFER_COUNT="${SESSION_RUNNER_DRIVE_DEFER_COUNT:-/tmp/matou-session-runner-drive-defer-count}"
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

# ── pick: priority first, then oldest; hard filters in jq, per-ticket checks
#    (deps, cooldown, fail cap) in the loop ────────────────────────────────────
if [ -n "${SESSION_RUNNER_PICK:-}" ]; then
  candidates="$SESSION_RUNNER_PICK"
else
  queue="$(api "$FORGEJO_API/issues?state=open&type=issues&labels=ready-for-session&limit=50")" \
    || { echo "session-runner: cannot read the queue — quiet tick"; exit 0; }
  candidates="$(jq -r --argjson drive "$REHEARSAL_DRIVE_ISSUE" '
    [ .[]
      | select(.state == "open")
      | select(.number != $drive)
      | select( ([.labels[].name] | index("no-triage"))     == null )
      | select( ([.labels[].name] | index("deferred"))      == null )
      | select( ([.labels[].name] | index("agent-blocked")) == null )
      | select( ([.labels[].name] | index("agent-working")) == null )
    ]
    | sort_by((if ([.labels[].name] | index("priority")) != null then 0 else 1 end), .number)
    | .[].number' <<<"$queue")"
fi

pick=""
for n in $candidates; do
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
trap release_claim EXIT
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

# ── the session: one headless claude, riding the #510 failover ───────────────
# Stamp the factory git identity (#19) so the session's commits carry
# "…(session-runner@<host>)", never the host user's ~/.gitconfig.
swarm_git_identity session-runner
ts="$(date -u +%Y%m%dT%H%M%SZ)"
log="$SESSION_RUNNER_STATE/logs/run-$pick-$ts.log"
touch "$SESSION_RUNNER_STATE/attempt-$pick"
prompt="$(cat "$here/session-runner-prompt.md")

Ticket #$pick: $title

$body"
claude_select_token
attempt=1
while :; do
  ( cd "$SESSION_RUNNER_CHECKOUT" && timeout "$SESSION_RUNNER_TIMEOUT" claude \
      --permission-mode acceptEdits --allowedTools "Edit,Write,Bash,WebFetch,WebSearch" \
      -p "$prompt" ) > "$log" 2>&1 || true
  if claude_limit_hit "$log"; then
    if [ "$attempt" = 1 ] && claude_failover; then
      attempt=2
      echo "session-runner: Claude account limited — failed over to account $(claude_active_account); retrying once"
      continue
    fi
    claude_limit_park
    echo "session-runner: Claude usage limit — parked the host; #$pick is untouched (not a failure)"
    notify ":hourglass_flowing_sand: **session-runner parked — Claude limit** while holding #$pick; claim released, the ticket re-queues after the window."
    exit 0
  fi
  break
done

# ── outcome: the ticket itself is the verdict ────────────────────────────────
after="$(api "$FORGEJO_API/issues/$pick")" || after=""
state_after="$(jq -r '.state // "unknown"' <<<"$after")"
still_session="$(jq -r '[.labels[].name] | index("ready-for-session") != null' <<<"$after" 2>/dev/null || echo true)"
if [ "$state_after" = "closed" ] || [ "$still_session" = "false" ]; then
  echo "session-runner: #$pick outcome: advanced (state=$state_after, ready-for-session=$still_session)"
  rm -f "$SESSION_RUNNER_STATE/fail-$pick"
  notify ":white_check_mark: **session-runner** worked #$pick — $title (state=$state_after). Log: \`$log\` on the workstation."
  exit 0
fi

fails=$(( $(cat "$SESSION_RUNNER_STATE/fail-$pick" 2>/dev/null || echo 0) + 1 ))
echo "$fails" > "$SESSION_RUNNER_STATE/fail-$pick"
echo "session-runner: #$pick outcome: not advanced (attempt $fails)"
if [ "$fails" -ge 2 ]; then
  echo "session-runner: escalating #$pick — two attempts without progress"
  jq -n --argjson l "$ab_id" '{labels: [$l]}' \
    | api -X POST -H 'Content-Type: application/json' -d @- \
        "$FORGEJO_API/issues/$pick/labels" >/dev/null || true
  jq -n --arg b "session-runner: two unattended attempts did not advance this ticket — labelled \`agent-blocked\` for a human look (ADR 0174 escalation). Latest session log: \`$log\` on the workstation. Remove \`agent-blocked\` (and the stale fail counter if re-arming by hand) to let the runner retry." '{body: $b}' \
    | api -X POST -H 'Content-Type: application/json' -d @- \
        "$FORGEJO_API/issues/$pick/comments" >/dev/null || true
  notify ":rotating_light: **session-runner escalated #$pick** — two attempts, no progress; \`agent-blocked\`, human look needed. Log: \`$log\`."
else
  notify ":warning: **session-runner** attempt $fails on #$pick did not advance it — cooling down, will retry. Log: \`$log\`."
fi
exit 0
