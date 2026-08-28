#!/usr/bin/env bash
# Headless triage: when untriaged issues exist, run the /triage skill via
# claude -p (labels get applied exactly as in an interactive session), then
# post to Mattermost every issue newly routed to a human gate.
# Run from the repo checkout root.
#
# Env: FORGEJO_TOKEN, FORGEJO_API, CLAUDE_CODE_OAUTH_TOKEN,
#      MATTERMOST_URL/MATTERMOST_BOT_TOKEN/MATTERMOST_CHANNEL_ID (optional),
#      REPO_SLUG (optional).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=verdict-lib.sh
. "$here/verdict-lib.sh"
# shellcheck source=limit-lib.sh
. "$here/limit-lib.sh"
# shellcheck source=model-lib.sh
. "$here/model-lib.sh"   # SWARM_MODEL — swarm.config is the ONE model source (#448); before this the triage claude call passed no --model and ran on the host user's CLI default
# shellcheck source=host-capacity-lib.sh
# The drive reservation predicate (#663/#664/#30): a waiting rehearsal drive
# declares it wants the host's heavy capacity; triage is a heavy (claude-calling)
# consumer and stands down before taking a slot. Consumed by the drive-yield gate
# below.
. "$here/host-capacity-lib.sh"
# shellcheck source=policy-lib.sh
# The per-repo POLICY layer (ADR 0002) — read here for ONE knob,
# TWO_WAY_DOOR_DOC: the record this repo keeps its two-way-door doctrine in,
# spliced into the /triage prompt below (#42). SWARM_POLICY_FILE is a test-only
# seam, as in list-ready-tasks.sh/close-report.sh (unset in production → the
# real policy file beside this script).
. "$here/policy-lib.sh"
# shellcheck source=swarm-db-lib.sh
# The swarm.db trace mirror (#447/#91): a triage that ACTUALLY starts opens a
# `runs` + `processes` row before the claude call and closes them on exit, so a
# busy-triaging host stops reading as idle in the fleet timeline. Best-effort:
# every writer swallows its exit (the db is a mirror; the verdict artifact stays
# the dependable record), so a missing python3 never reds a triage run.
. "$here/swarm-db-lib.sh"
# shellcheck source=triage-yield-lib.sh
# The per-repo consecutive-YIELD counter (#110): every pre-work yield below
# (limit-parked, drive-reserved) bumps it via triage-yield-signal.sh when
# untriaged issues exist, and a real triage pass resets it — so a repo starving
# behind other repos' heavy work surfaces a signal instead of a run of green
# no-op ticks (Matou/coa: 12 untriaged, 12 green yields, 0 triaged).
. "$here/triage-yield-lib.sh"
policy_load "${SWARM_POLICY_FILE:-}"
: "${FORGEJO_TOKEN:?}"
: "${FORGEJO_API:?}"
repo_slug="${REPO_SLUG:-${FORGEJO_API##*/repos/}}"
# One runner serves TWO repos (#238) — a /tmp verdict path must carry the repo
# or the two clobber each other's (#574). Same formula as run-swarm.sh/heal.sh.
repo_tag="${repo_slug//\//-}"
# Durable host-side home for the captured claude log (#91): a triage run's
# evidence is MOVED here on exit instead of `rm -f`'d, and its path is recorded
# as a run-scoped event. Off the host home like every other swarm state dir
# (swarm.db, the runlogs); a test seam overrides it to a tmp dir.
TRIAGE_LOGDIR="${TRIAGE_LOGDIR:-$HOME/swarm/logs/triage}"

api() { curl -sf -H "Authorization: token $FORGEJO_TOKEN" "$@"; }

# Drop a stage/exit verdict on failure so the healer keys the incident signature
# on the run's REAL failing stage, not on worker chain-of-thought prose (#235).
verdict_begin "${TRIAGE_VERDICT_PATH:-/tmp/matou-$repo_tag-triage-verdict.txt}"
# swarm.db trace state (#91): a triage it ACTUALLY starts opens a run + process
# row at the choke point below (set triage_recorded=1 there). The EXIT trap
# finalises them — the SAME kills-finalise discipline session-runner/run-swarm
# use: a graceful exit closes the process row and stamps the run verdict; a
# SIGKILL/OOM/reboot leaves the row OPEN (ended_at NULL = believed alive = the
# #435 wedge marker every monitor reads). A tick that never reached the claude
# call (limit-parked, drive-yielded, nothing untriaged) records NOTHING —
# triage_recorded stays 0, so a deferred tick mints no run row.
triage_recorded=0
triage_run_db_id=""
triage_verdict=""   # set at each intentional post-start exit; else derived
# The EXIT trap: write the verdict FIRST (it greps $triage_log at its temp path),
# THEN, for a recorded run, MOVE that log to a durable host path as evidence
# (#91) — never `rm -f` it — record its path as a run-scoped event, and close
# the run + process rows with the run's real verdict. An unrecorded (deferred)
# tick just discards any temp log, exactly as before.
#
# Cleaning up AFTER the verdict is written, never before, preserves the #18 fix —
# an `rm` on the failure path ahead of `exit 1` used to delete the log the EXIT
# trap's verdict_write then tried to read, leaving an empty `--- error lines ---`
# block and defeating the whole stage/exit/error verdict.
triage_on_exit() {
  local ec="$1" now reason dest
  verdict_write "$ec"
  if [ "$triage_recorded" = 1 ]; then
    now="$(date +%s)"
    reason="${triage_verdict:-died-in:triage}"
    if [ -n "${triage_log:-}" ] && [ -f "$triage_log" ]; then
      mkdir -p "$TRIAGE_LOGDIR" 2>/dev/null || true
      dest="$TRIAGE_LOGDIR/$triage_run_db_id.log"
      if mv -f "$triage_log" "$dest" 2>/dev/null; then
        swarmdb_event "$triage_run_db_id" "" triage_log "$dest" "triage claude log (#91)"
      fi
    fi
    swarmdb proc-close --run "$triage_run_db_id" --ref "$$" --ended "$now"
    swarmdb_run_end "$triage_run_db_id" "$reason" "$reason" "$ec" "$now"
  else
    [ -n "${triage_log:-}" ] && rm -f "$triage_log" 2>/dev/null || true
  fi
}
trap 'triage_on_exit $?' EXIT
# Kills finalise the trace (the swarm-db.py invariant): a graceful SIGTERM/SIGINT
# (systemd stop, an operator ^C) is routed through the EXIT trap so the process
# row closes cleanly; an untrappable SIGKILL/OOM/reboot cannot reach here — its
# open row is the wedge marker, by design. 143 = 128+SIGTERM, 130 = 128+SIGINT.
triage_on_signal() { triage_verdict="killed:$1"; trap - EXIT; triage_on_exit "$2"; exit "$2"; }
trap 'triage_on_signal SIGTERM 143' TERM
trap 'triage_on_signal SIGINT 130' INT

# Limit gate, BEFORE claude (#253): if the host-global marker says the Claude
# subscription window is already exhausted (a worker or the healer parked it),
# yield cleanly — a blind claude call would only refuse, and one refusal within
# the watchdog window mints an always-red incident. Exit 0 with an honest
# "limit-parked" note so the run list never reads a parked window as green health.
if claude_limit_parked; then
  echo "run-triage: limit-parked — Claude usage limit window (marker fresh), yielding without calling claude"
  # A yield with untriaged issues waiting is a starvation signal (#110); a parked
  # host that keeps yielding while tickets pile up must not read as green health.
  # Best-effort — the signal never changes this clean exit.
  bash "$here/triage-yield-signal.sh" limit-parked || true
  exit 0
fi

# Yield to a ready rehearsal drive (#663 producer / #664 consumer / #30): a
# waiting drive needs EVERY host lock at once and loses to anything that takes a
# slot in the gap. Triage's claude call is a slot, so it stands down HERE, before
# the preflight/skill work — the same posture session-runner takes (yield, never
# camp). A clean exit 0: the EXIT trap's verdict_write writes nothing on a zero
# exit, so a yield is never mistaken for a fault. Triage's consecutive-defer
# count is its OWN (its :05/:35 cadence differs from swarm's and
# session-runner's, so a shared counter would conflate three streaks — #664); the
# yield line carries the reservation's age to corroborate the executor's skip log.
TRIAGE_DRIVE_DEFER_COUNT="${TRIAGE_DRIVE_DEFER_COUNT:-/tmp/matou-triage-drive-defer-count}"
if host_capacity_drive_wanted; then
  defer_n="$(host_capacity_consumer_defer_bump "$TRIAGE_DRIVE_DEFER_COUNT")"
  echo "run-triage: a rehearsal drive has reserved host capacity (#663) — yielding this run to a ready drive — reservation age $(host_capacity_drive_wanted_age)s — skipped $defer_n consecutive tick(s)"
  # Same starvation signal (#110): the drive-defer counter above is the DRIVE's
  # own streak; this is the per-repo triage-queue streak, and it fires a visible
  # signal once untriaged issues have waited through the threshold. Best-effort.
  bash "$here/triage-yield-signal.sh" drive-reserved || true
  exit 0
fi
host_capacity_consumer_defer_reset "$TRIAGE_DRIVE_DEFER_COUNT"

verdict_stage "preflight (list untriaged issues)"
untriaged="$(bash "$here/preflight-triage.sh")"
n="$(jq 'length' <<<"$untriaged")"
if [ "$n" -eq 0 ]; then
  # An empty queue is not starvation — clear any consecutive-yield streak (#110)
  # so a burst that DID get triaged never leaves a stale count to mis-signal on
  # the next unlucky yield.
  triage_yield_reset
  echo "run-triage: nothing to triage"
  exit 0
fi
echo "run-triage: $n untriaged issue(s):"
jq -r '.[] | "  #\(.number) \(.title)"' <<<"$untriaged"

# Open issues currently sitting at a human gate, as "number<TAB>label" lines.
#
# Only labels this repo ACTUALLY mints are queried (#104): Forgejo does not 404
# an unknown `labels=` filter — it silently returns EVERY open issue — so a gate
# label a consumer never minted (`needs-design` outside a design-tier repo) would
# otherwise report the whole open backlog as gated, spamming a false
# ":wave: Triage needs you … → needs-design" digest. Validate against the repo's
# real label set instead of trusting the filter.
#
# `LC_ALL=C sort -u` forces BYTE collation (#104): under the runner's locale
# `sort` ignores the TAB in "<num>\t<label>", so `62\tx` sorts before `6\tx`.
# GNU `comm` (below) order-checks with LOCALE collation whenever LC_COLLATE is
# not C (it only falls back to `memcmp` under C/POSIX), so a byte-sorted input
# fed to an ambient-locale `comm` is seen as out of order — `comm` aborts the
# run under `set -euo pipefail` (#106). Both sides must agree on collation, so
# the `comm` is pinned `LC_ALL=C` too; the check is lazy, so it only bit once
# triage changed the gated set — exactly when triage did work.
human_gated() {
  local existing label
  existing="$(api "$FORGEJO_API/labels?limit=100" | jq -r '.[].name')"
  for label in ready-for-human needs-design; do
    grep -qxF "$label" <<<"$existing" || continue
    page=1
    while :; do
      batch="$(api "$FORGEJO_API/issues?state=open&type=issues&labels=$label&limit=50&page=$page")"
      count="$(jq 'length' <<<"$batch")"
      [ "$count" -eq 0 ] && break
      jq -r --arg l "$label" '.[] | "\(.number)\t\($l)"' <<<"$batch"
      [ "$count" -lt 50 ] && break
      page=$((page + 1))
    done
  done | LC_ALL=C sort -u
}

verdict_stage "human_gated (before)"
before="$(human_gated)"
# Capture the claude output so a limit refusal can be classified after a failed
# call (#253): the log feeds both the limit detector and the verdict's error
# lines if this stage fails for a REAL fault.
triage_log="$(mktemp)"
verdict_stage "triage skill (claude -p /triage)" "$triage_log"

# ── swarm.db: THIS is the choke point where a triage actually starts (#91) ────
# Every earlier exit (limit-parked, drive-yielded, nothing untriaged) returned
# before here, so only a run that reaches the claude call opens rows. One run row
# (trigger `triage`, repo-scoped so the fleet monitor's per-repo reads attribute
# it) and one live process row (kind `triage`, ref the pid — ended_at NULL =
# believed alive). The EXIT trap closes both with the run's verdict and moves the
# captured log to $TRIAGE_LOGDIR. Best-effort: a missing engine no-ops silently.
triage_run_db_id="triage-$repo_tag-$(date +%s)-$$"
triage_started="$(date +%s)"
swarmdb_run_start "$triage_run_db_id" "$repo_slug" triage "$triage_started"
swarmdb proc-open --run "$triage_run_db_id" --kind triage --ref "$$" \
  --command "run-triage $repo_slug — $n issue(s)" --started "$triage_started"
triage_recorded=1

# The two-way-door POINTER in the prompt below is per-repo (#42). "ADR 0174" is
# the factory's inherited audit-trail vocabulary — it names no path and cannot
# 404, so it stays (#33) — but the RECORD it names lives at a different path in
# every consumer, and the literal `docs/adr/0174-*.md` this prompt used to carry
# exists only in Matou/idss. A prompt string in a shell script is assembled at
# RUN time, so #1's {{ENRICH:<slot>}} mechanism cannot reach it; the pointer
# comes from the repo's own policy layer instead. Declaring none is a legitimate
# state, not a hole: the doctrine's whole test is stated inline below, so an
# undeclared repo is told that in words rather than sent to a missing file.
#
# The prompt's OTHER doc path is gone for a different reason (#47, ADR 0001
# amendment). It pointed at `docs/agents/triage-labels.md` for the `## Why
# human` rule — a FACTORY doc, and `docs/**` is vendor-excluded, so it resolved
# only in a repo that happened to keep its own copy (`matou-app` carries no
# `docs/agents/` at all, so every /triage run there was sent to a 404). It is
# not a policy knob either: that would point each repo at its own copy of
# doctrine the factory already owns and already renders — policy-lib.sh's
# `policy_trigger_guidance one-way-door` (#14), whose wording ("name the human
# residue in a `## Why human` line") the sentence below deliberately mirrors.
# So the prompt states the rule instead of linking it. General rule, ratcheted
# by tests/judgement-call-prompts-test.sh: a harness prompt string may name a
# repo-relative path only when the harness itself puts it in the consumer's
# tree (a vendored `.sandcastle/…` file) or the repo DECLARES it in its own
# layer. Factory doctrine travels as vendored code that renders text, never as
# a doc path a consumer is trusted to have.
if [ -n "${SWARM_POLICY_TWO_WAY_DOOR_DOC:-}" ]; then
  two_way_door="the factory's inherited two-way-door doctrine, recorded for this repo in $SWARM_POLICY_TWO_WAY_DOOR_DOC"
else
  two_way_door="the factory's inherited two-way-door doctrine; this repo declares no local record of it (set TWO_WAY_DOOR_DOC in swarm-policy.sh), so the bar stated here is the whole test"
fi
# Ride the host's active account (#510) — triage was the ONE claude caller
# without select/failover: with only the primary token it refused on A's
# exhausted window and its claude_limit_park below stamped the HOST-GLOBAL
# marker, parking every caller on the host (workers holding a working standby
# token included) for another TTL, hourly. Same shape as heal.sh: select once,
# retry ONCE after a successful failover; a second refusal means both windows
# are exhausted and the quiet park is honest again.
claude_select_token
triage_attempt=1
while :; do
  if ! timeout 2700 claude --model "$SWARM_MODEL" -p "/triage You are running headless in CI: no human can answer questions, so never ask any. Every untriaged issue must leave this run carrying a triage label. When you hit ambiguity or a judgement call you would normally ask a human about, first try to RULE it yourself under ADR 0174 ($two_way_door): if the call is revertible by a later commit or label change and provable by an existing test/drive/probe, and it is not on the one-way-door list (personal credentials, a security-posture widening, a member-facing trust accept, data destruction, non-routine spend), post the ruling to the issue — 'Ruled by agent under ADR 0174 — veto anytime', the ruling, why it is a two-way door, and what proves it — and apply the label your ruling calls for. Only label ready-for-human when the call is a genuine one-way door (state which in a '## Why human' line naming the human residue), or needs-info if the reporter must supply missing information." --dangerously-skip-permissions 2>&1 | tee "$triage_log"; then
    # A limit refusal parks the host for every caller and exits CLEAN (never
    # red) — but only after the standby account was tried (#510); any other
    # failure still reddens honestly (the EXIT trap's verdict reads the log).
    if claude_limit_hit "$triage_log"; then
      if [ "$triage_attempt" = 1 ] && claude_failover; then
        triage_attempt=2
        echo "run-triage: Claude account limited — failed over to account $(claude_active_account); retrying the /triage skill once"
        continue
      fi
      claude_limit_park
      triage_verdict="limit-parked"   # the run row records why triage ended without triaging; not a fault
      echo "run-triage: limit-parked — Claude refused with a usage-limit signature; marked the host parked, exiting clean"
      exit 0
    fi
    exit 1
  fi
  break
done
triage_verdict="triaged"   # the claude call returned clean; the run row closes green
# A real triage pass ran — reset the per-repo consecutive-yield streak and clear
# any starvation-signal episode marker (#110), so the next yield counts from 1.
triage_yield_reset

# Each post-claude stage names ITSELF (#104). verdict_stage was last set to the
# claude stage WITH the claude log as its errlog; leaving it there meant any
# failure below (a comm collation abort, a notify error, the recount) was blamed
# on the claude call AND had verdict_write grep the claude log — whose triage
# PROSE ("… cannot …") matched the error regex, keying the healer on a triage
# RULING instead of the real downstream fault (#235's hazard one stage on). No
# errlog on these stages: the stage name alone keys the signature, never prose.
verdict_stage "human_gated (after)"
after="$(human_gated)"

verdict_stage "human-gate digest + notify"
new="$(LC_ALL=C comm -13 <(printf '%s\n' "$before") <(printf '%s\n' "$after"))"
if [ -n "$new" ]; then
  digest=""
  while IFS=$'\t' read -r num label; do
    [ -z "$num" ] && continue
    if [ "$label" = ready-for-human ]; then
      # The answerable ask thread, straight after triage — quotes the triage
      # comment; the resume sweep records the reply and re-arms the issue.
      bash "$here/post-issue-ask.sh" "$num" || true
      continue
    fi
    issue="$(api "$FORGEJO_API/issues/$num")"
    title="$(jq -r .title <<<"$issue")"
    url="$(jq -r .html_url <<<"$issue")"
    digest="$digest
- [#$num $title]($url) → \`$label\`"
  done <<<"$new"
  if [ -n "$digest" ]; then
    bash "$here/notify-mattermost.sh" ":wave: **Triage needs you** in \`$repo_slug\`:$digest"
  fi
fi

verdict_stage "recount untriaged"
still="$(bash "$here/preflight-triage.sh" | jq 'length')"
if [ "$still" -gt 0 ]; then
  echo "run-triage: $still issue(s) still untriaged (next tick retries)" >&2
fi
exit 0
