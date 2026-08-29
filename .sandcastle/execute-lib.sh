#!/usr/bin/env bash
# execute-lib.sh — the EXECUTE seam of run-swarm.sh (#2): the
# `pnpm run sandcastle` worker loop and the four distinct shapes its failure
# can take.
#
# limit-lib.sh and cancel-lib.sh own the DETECTORS — one definition each, shared
# with rehearsal-report.sh and session-runner.sh, because two copies drift (on
# 2026-07-29 an inline grep here looked for the literal "hit your limit" while
# the agent printed "hit your WEEKLY limit"; the guard missed and 70 queued runs
# went red in 92 minutes). What lived inline in run-swarm.sh, and lives here now,
# is the LOOP around them: classify → fail over once → notice with an hourly
# dedupe → pick one of three exits.
#
#   operator cancel (#612)  clean stop, never paged to the healer
#   auth-dead (#632)        failover once, then a NAMED halt, never a red
#   usage limit (#510)      failover once, then the quiet hourly park
#   anything else           the generic red, log LEFT for the verdict (#235)
#
# The ORDER is load-bearing and is asserted by the test: cancel first (a
# deliberate stop is never an incident), then auth BEFORE limit — a dead token
# must never wait out a "reset" that will never come, and must never fall
# through to the generic red either, which pages the healer on a signature that
# degrades to the workflow name alone (the "near-unparseable" class 2f0d3a6
# already ruled out for the rehearsal path; this is its mirror for the swarm).
#
# Callers must have sourced limit-lib.sh, cancel-lib.sh, verdict-lib.sh and
# swarm-db-lib.sh. Offline-tested by tests/execute-lib-test.sh with a shimmed
# pnpm + notify.

if [ -z "${__SWARM_EXECUTE_LIB:-}" ]; then
__SWARM_EXECUTE_LIB=1

_EXECUTE_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The notifier this seam announces through. Overridable so an offline test never
# posts anywhere.
EXECUTE_NOTIFY="${EXECUTE_NOTIFY:-$_EXECUTE_HERE/notify-mattermost.sh}"

# The auth-dead hourly notice-dedupe marker. Repo-agnostic on purpose, matching
# the limit marker (#238): the Claude auth session is one host-global thing, so
# one repo's outage correctly suppresses the other's redundant first notice.
EXECUTE_AUTH_MARKER="${EXECUTE_AUTH_MARKER:-/tmp/matou-swarm-claude-auth-dead}"
EXECUTE_AUTH_TTL="${EXECUTE_AUTH_TTL:-3600}"

# The rc that means "stop the run CLEANLY" — the caller exits 0. Distinct from
# rc 1 (the generic red) so run-swarm's three-way exit is a case, not a guess.
EXECUTE_RC_STOP=100

# #111: main.mts prints this marker line when the run ended while a rehearsal
# drive's reservation stood — its 2 s poller mirrored the reservation into the
# sandbox, list-ready-tasks.sh answered [] and the loop completed after its
# current task. The run is a SUCCESS (workers ran, work lands as usual); only
# the exit reason differs, so run-swarm's verdict names the yield rather than
# `completed`. Set on the success path; empty otherwise.
EXECUTE_YIELDED_TO_DRIVE=""
SANDCASTLE_YIELDED_TO_DRIVE_RE='^SANDCASTLE_YIELDED_TO_DRIVE run='
execute_drive_yield_hit() { grep -qE "$SANDCASTLE_YIELDED_TO_DRIVE_RE" "$1" 2>/dev/null; }

_execute_notify() { bash "$EXECUTE_NOTIFY" "$1" || true; }

# _execute_notice_due <marker> <ttl> — 0 iff a notice should be posted now (and
# stamps the marker). A queued-trigger burst against one outage must not become
# its own storm: the marker is only re-stamped when a notice actually goes out,
# so it stays fresh through an ongoing outage and goes stale once it clears.
_execute_notice_due() {
  local marker="$1" ttl="$2"
  if [ ! -f "$marker" ] || [ $(( $(date +%s) - $(stat -c %Y "$marker") )) -gt "$ttl" ]; then
    touch "$marker"
    return 0
  fi
  return 1
}

# execute_classify <log> -> cancel | auth | limit | failed
# The one place the ordering above is expressed. Pure (reads the log only).
execute_classify() {
  if swarm_cancel_hit "$1"; then echo cancel
  elif claude_auth_failed "$1"; then echo auth
  elif claude_limit_hit "$1"; then echo limit
  else echo failed
  fi
}

# execute_sandcastle_run <log> <run-db-id> <repo-slug> <repo-tag>
#   rc 0                 workers ran; the caller proceeds to the verify stage
#   rc $EXECUTE_RC_STOP  a clean, NAMED halt (cancel / auth-dead / limit park) —
#                        the caller exits 0; nothing was started or lost
#   rc 1                 the generic red; the log is left for verdict_write
#
# Sets SWARM_EXIT_REASON on every non-success path (run-swarm's EXIT trap reads
# it, falling back to died-in:<stage> when unset).
execute_sandcastle_run() {
  local log="$1" run_db_id="$2" repo_slug="$3" repo_tag="$4"
  local attempt=1

  # #574: main.mts (the sandcastle orchestrator — runs on THIS host, so it needs
  # no docker-forwarded env, just its own process env) records the RunResult it
  # captures against this SAME run id, or its attempts/spend/events rows would
  # land under a different run_id than the `runs` row swarmdb_run_start opened
  # and never join up with everything else run-swarm writes.
  export SWARM_DB_RUN_ID="$run_db_id"
  # Exit observer for a prior limit-park (#100): if the host marker is present but
  # STALE (the window ended), close its window with a paired unpark event before
  # this run — every swarm worker tick is a chance to stamp the exit exactly once.
  claude_limit_sweep "$run_db_id"
  # The captured log feeds the verdict's error lines if this stage fails (#235).
  verdict_stage "sandcastle run (workers)" "$log"
  # Two-account failover (#510): start on the host's active account (a fresh B
  # marker means a prior caller already failed over — don't pay a failed attempt
  # to rediscover it).
  claude_select_token

  while ! pnpm run sandcastle 2>&1 | tee "$log"; do
    case "$(execute_classify "$log")" in
      cancel)
        _execute_cancel "$log" "$run_db_id" "$repo_slug" "$repo_tag"
        return "$EXECUTE_RC_STOP" ;;
      auth)
        if [ "$attempt" = 1 ] && _execute_failover auth "$log" "$run_db_id" "$repo_slug"; then
          attempt=2; : > "$log"; continue
        fi
        _execute_auth_halt "$log" "$run_db_id" "$repo_slug"
        return "$EXECUTE_RC_STOP" ;;
      limit)
        if [ "$attempt" = 1 ] && _execute_failover limit "$log" "$run_db_id" "$repo_slug"; then
          attempt=2; : > "$log"; continue
        fi
        _execute_limit_park "$log" "$run_db_id" "$repo_slug"
        return "$EXECUTE_RC_STOP" ;;
      *)
        # Leave $log in place — the EXIT trap's verdict_write reads it.
        SWARM_EXIT_REASON="sandcastle-run-failed"
        return 1 ;;
    esac
  done
  if execute_drive_yield_hit "$log"; then
    EXECUTE_YIELDED_TO_DRIVE=1
    echo "run-swarm: a rehearsal drive reserved host capacity mid-run — this run finished its current task and claimed nothing more (#111); the drive fires next, the swarm resumes on its next trigger"
  fi
  rm -f "$log"
  return 0
}

# _execute_cancel — a deliberate operator cancel (the TUI's Cancel action, via
# main.mts's AbortController) reads as a distinct, UNALARMED stop: never the
# generic sandcastle-run-failed fallback, and never paged to the healer
# (verdict_write only fires on a non-zero exit).
_execute_cancel() {
  local log="$1" run_db_id="$2" repo_slug="$3" repo_tag="$4" reason
  reason="$(swarm_cancel_hit_reason "$log")"
  _execute_notify ":stop_sign: **Swarm run cancelled** in \`$repo_slug\` — operator cancel via the factory TUI${reason:+ ($reason)}. In-flight work for this run's current iteration is NOT recorded in swarm.db (ADR 0186); its ticket will be picked back up by the next janitor sweep."
  swarmdb_event "$run_db_id" "" cancelled "operator cancel${reason:+: $reason}" "$repo_tag"
  rm -f "$log"
  echo "run-swarm: run cancelled by operator${reason:+ ($reason)}"
  SWARM_EXIT_REASON="cancelled:operator"
}

# _execute_failover <auth|limit> — flip to the standby account and announce it.
# rc 1 (no side effects) when no standby is configured, so the caller falls
# through to its halt/park path. Callers retry ONCE; a second refusal means both
# windows are exhausted.
_execute_failover() {
  local kind="$1" log="$2" run_db_id="$3" repo_slug="$4" from hint
  from="$(claude_active_account)"
  claude_failover || return 1
  if [ "$kind" = auth ]; then
    hint="$(_execute_auth_line "$log")"
    _execute_notify ":arrows_counterclockwise: **Swarm failover — Claude account $from auth-dead** in \`$repo_slug\` (${hint:-not logged in}) — retrying once on account $(claude_active_account)."
    swarmdb_event "$run_db_id" "" auth-failover "Claude account $from auth-dead — failed over to $(claude_active_account)" "${hint:-not logged in}"
  else
    hint="$(claude_limit_reset_hint "$log")"
    _execute_notify ":arrows_counterclockwise: **Swarm failover — Claude account $from limited** in \`$repo_slug\` (${hint:-reset time unknown}) — retrying once on account $(claude_active_account)."
    swarmdb_event "$run_db_id" "" limit-failover "Claude account $from limited — failed over to $(claude_active_account)" "${hint:-reset time unknown}"
  fi
}

# _execute_auth_line <log> — the CLI's own refusal wording, for the notice.
_execute_auth_line() {
  grep -ihoE "$CLAUDE_AUTH_RE[^\"]*" "$1" | head -1
}

# _execute_auth_halt — BOTH accounts (or the only account) are auth-dead. A
# clean, named halt: no worker was lost, queued tickets stay ready and pick back
# up once the token is refreshed. Mirrors the #510 limit park exactly.
_execute_auth_halt() {
  local log="$1" run_db_id="$2" repo_slug="$3" line headline
  line="$(_execute_auth_line "$log")"
  if claude_standby_available; then
    headline="**Swarm halted — BOTH Claude accounts auth-dead** in \`$repo_slug\` — re-login required"
  else
    headline="**Swarm halted — Claude account $(claude_active_account) auth-dead** in \`$repo_slug\` — re-login required"
  fi
  if _execute_notice_due "$EXECUTE_AUTH_MARKER" "$EXECUTE_AUTH_TTL"; then
    _execute_notify ":rotating_light: $headline (${line:-not logged in}). No worker was lost; queued tickets stay ready and pick back up once the token is refreshed."
  fi
  swarmdb_event "$run_db_id" "" auth-dead "$headline" "${line:-not logged in}"
  rm -f "$log"
  echo "run-swarm: Claude auth refusal — $headline"
  SWARM_EXIT_REASON="claude-auth-dead"
}

# _execute_limit_park — the subscription window is exhausted. Every agent
# invocation would fail instantly and a queued trigger backlog would drain as one
# red alert per minute (the 2026-07-25 18:41–20:00 storm). Post ONE hourly-deduped
# notice and exit green — nothing was started, nothing is lost, the limit
# self-heals. The marker is GLOBAL by design (#238): one subscription window is
# shared across every repo.
_execute_limit_park() {
  local log="$1" run_db_id="$2" repo_slug="$3" hint headline
  hint="$(claude_limit_reset_hint "$log")"
  if claude_standby_available; then
    headline="**Swarm paused — BOTH Claude accounts limited** in \`$repo_slug\` (${hint:-reset time unknown})"
  else
    headline="**Swarm paused — Claude usage limit** in \`$repo_slug\` (account $(claude_active_account); ${hint:-reset time unknown})"
  fi
  if ! claude_limit_parked; then
    # claude_limit_park stamps the account into the marker and records the paired
    # park edge to swarm.db (#100) — one entry per outage, not one per re-hit.
    claude_limit_park "$run_db_id" "${hint:-reset time unknown}"
    _execute_notify ":hourglass_flowing_sand: $headline. Queued runs will drain quietly until it resets; no work was started or lost."
  fi
  rm -f "$log"
  echo "run-swarm: Claude usage limit — pausing quietly"
  SWARM_EXIT_REASON="claude-limit-parked"
}

fi
