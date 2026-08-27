#!/usr/bin/env bash
# schedule-lib.sh — the SCHEDULE seam of run-swarm.sh (#2).
#
# The 2026-08-15 factory-reengineering survey named run-swarm.sh the patch
# magnet (598 lines, 22 responsibilities, 12 hand-maintained exit points) with
# eight natural seams already visible — preflight → identity → schedule →
# provision → execute → verify → land → report — of which six already had a
# library. This is one of the two that did not.
#
# Everything between "a trigger fired" and "this run has a ready set, a
# debounce ruling and a model":
#
#   drive yield → janitor re-arm → list ready → debounce → per-run model
#
# All of it was inline in run-swarm.sh, and the debounce coalescer's only test
# was a byte-for-byte COPY of the block kept in tests/debounce-test.sh — the
# copy-and-hope pattern that lets an original drift from its pin silently.
#
# Pure-ish: the only side effects are the debounce stamp and the consumer's
# consecutive-defer counter (both caller-supplied paths, so tests never touch
# real host /tmp state — the #664 lesson). No network of its own; the ready set
# comes from list-ready-tasks.sh and the janitor from claim-lib.sh, each
# overridable/shimmable. Offline-tested by tests/schedule-lib-test.sh.
#
# Callers must have sourced host-capacity-lib.sh (the drive predicate),
# model-lib.sh (swarm_resolve_model), claim-lib.sh (janitor_sweep) and
# verdict-lib.sh (schedule_list_ready_or_verdict's stage/error re-key, #52) —
# the same libs run-swarm.sh already sources.

if [ -z "${__SWARM_SCHEDULE_LIB:-}" ]; then
__SWARM_SCHEDULE_LIB=1

_SCHEDULE_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The lister this seam reads its ready set from. Overridable so an offline test
# never needs a tracker.
SCHEDULE_LIST_READY="${SCHEDULE_LIST_READY:-$_SCHEDULE_HERE/list-ready-tasks.sh}"

# Coalescing window, seconds. See schedule_debounce_decide.
SWARM_DEBOUNCE="${SWARM_DEBOUNCE:-600}"

# ── the drive-reservation yield (#663 producer / #664 consumer / #30) ───────
# A waiting rehearsal drive needs EVERY host lock at once and yields the instant
# one is busy, so it loses — unboundedly — to anything that claims a NEW ticket
# in the gap. A swarm run is about to spawn workers that CLAIM new tickets, so it
# stands down BEFORE any of that (session-runner's posture — yield, never camp;
# host-capacity-lib.sh's header rule). The predicate is TTL-bounded, so an
# abandoned reservation expires instead of wedging every tick forever.
#
# schedule_drive_yield <defer-counter-path>
#   rc 0 + the yield line on stdout — the caller must exit 0 immediately, before
#          the EXIT trap / verdict / preflight, so a yield is a clean exit and
#          not a recorded run
#   rc 1  — no live reservation; the counter is reset and the run proceeds
#
# The counter path is the CONSUMER's own (swarm's :15/:45 cadence differs from
# triage's and session-runner's, so one shared counter would conflate three
# unrelated streaks — #664). The line carries the reservation's age so it and the
# executor's "skipped N ticks" line corroborate on the same reservation.
schedule_drive_yield() {
  local counter="$1" defer_n
  if host_capacity_drive_wanted; then
    defer_n="$(host_capacity_consumer_defer_bump "$counter")"
    echo "run-swarm: a rehearsal drive has reserved host capacity (#663) — yielding this run to a ready drive — reservation age $(host_capacity_drive_wanted_age)s — skipped $defer_n consecutive tick(s)"
    return 0
  fi
  host_capacity_consumer_defer_reset "$counter"
  return 1
}

# ── the janitor (spec D4) ──────────────────────────────────────────────────
# Re-arm tickets whose claiming run died: a crashed host must not strand
# agent-working tickets. Called BEFORE listing so re-armed tickets rejoin this
# very run's queue. claim-lib.sh owns the sweep (and its test); this reports it.
# Silent when nothing was stale, and NEVER fails the run — a janitor pass that
# errors must not cost a run that can still do work.
schedule_janitor_rearm() {
  local rearmed
  rearmed="$(janitor_sweep || true)"
  [ -n "$rearmed" ] || return 0
  echo "run-swarm: janitor re-armed stale-claimed issue(s): $(printf '%s' "$rearmed" | tr '\n' ' ')"
}

# ── the ready set ──────────────────────────────────────────────────────────

# schedule_ready_tasks -> the ready-task JSON array, from the lister.
schedule_ready_tasks() { bash "$SCHEDULE_LIST_READY"; }

# schedule_list_ready_or_verdict <out-file> — fetch the ready set into <out-file>
# (rc 0), or rc non-zero after naming the "list ready tasks" stage AND capturing
# the failing read's status/output as the verdict's error line (#52).
#
# The ready-list is a Forgejo GET on run-swarm's HAPPY PATH — after preflight
# passed but BEFORE any later verdict_stage — so before this a transient 5xx/
# timeout that outlived list-ready-tasks.sh's retries died under `set -e` while
# VERDICT_STAGE was still "preflight self-tests (#446)", mis-keying the healer's
# signature to preflight with an EMPTY error block. That is GOTCHAS #7's
# implicit-`set -e` sibling: #7 fixed the guards that FATAL to stderr and then
# `exit`, but left this death-inside-a-`$(...)`-assignment path uncovered.
#
# MUST be called in the run's OWN shell (never `x="$(schedule_list_ready...)"`):
# the whole point is that verdict_stage/verdict_error land on the PARENT's
# VERDICT_* that the EXIT trap reads, so the death is keyed on THIS stage — a
# command-substitution subshell would lose both. The ready JSON goes to
# <out-file> for the same reason. Callers must have sourced verdict-lib.sh.
schedule_list_ready_or_verdict() {
  local out="$1" err errline rc=0
  verdict_stage "list ready tasks"
  err="$(mktemp)"
  schedule_ready_tasks >"$out" 2>"$err" || rc=$?
  if [ "$rc" -ne 0 ]; then
    errline="$(tr '\n' ' ' <"$err" | sed 's/  */ /g; s/^ *//; s/ *$//')"
    verdict_error "list-ready-tasks.sh failed (rc=$rc — transient Forgejo 5xx/timeout after retries)${errline:+: $errline}"
    rm -f "$err"
    return "$rc"
  fi
  rm -f "$err"
}

# schedule_ready_count <ready-json> -> how many tickets are ready.
schedule_ready_count() { jq 'length' <<<"$1"; }

# schedule_ready_nums <ready-json> -> "7,9" — the runlog/swarm.db ready-set field.
# Tolerant by design: a malformed set must not red a run before it starts.
schedule_ready_nums() { jq -r '[.[].number] | join(",")' <<<"$1" 2>/dev/null || true; }

# schedule_ready_listing <ready-json> -> one "  #N title" line per ready ticket.
schedule_ready_listing() { jq -r '.[] | "  #\(.number) \(.title)"' <<<"$1"; }

# ── debounce / trigger coalescing ──────────────────────────────────────────
# Every `issues` event queues its own run and they drain one-at-a-time behind the
# global lock, so a labelling pass over N tickets means N runs over the SAME
# ready set. (2026-07-29: filing 22 tickets in three label passes queued ~66
# events; the backlog took 92 minutes to drain.)
#
# Keyed on the ready set itself, not on time alone: the moment real work lands,
# an issue closes, the set changes, and the next trigger runs immediately. Only
# genuinely repeated attempts at unchanged work are dropped. The 30-minute cron
# is the backstop either way.

# schedule_stamp_path <repo-tag> -> the per-repo debounce stamp path.
# Per-repo (#238): a shared /tmp/matou-swarm-lastready let each repo overwrite
# the other's stamp, defeating the coalescing entirely. SWARM_DEBOUNCE_STAMP
# overrides (tests, and an operator forcing a run).
schedule_stamp_path() {
  printf '%s' "${SWARM_DEBOUNCE_STAMP:-/tmp/matou-swarm-lastready-$1}"
}

# schedule_ready_hash <ready-json> -> the short digest the stamp is keyed on.
schedule_ready_hash() { printf '%s' "$1" | sha1sum | cut -c1-16; }

# schedule_debounce_decide <ready-json> <stamp-path> <window-seconds>
#   -> "run"                 this trigger is genuine; the stamp is REWRITTEN
#   -> "coalesce <age-secs>" the identical set was attempted <age>s ago
# The caller records that it wrote a fresh stamp (run-swarm's stamp_written), so
# a run that dies quietly without a worker can invalidate it on the way out
# (#435) instead of coalescing away the very next genuine retry.
schedule_debounce_decide() {
  local ready="$1" stamp="$2" window="$3" ready_hash last_hash last_at now
  ready_hash="$(schedule_ready_hash "$ready")"
  now="$(date +%s)"
  if [ -s "$stamp" ]; then
    read -r last_hash last_at < "$stamp" || true
    if [ "$last_hash" = "$ready_hash" ] &&
       [ $(( now - ${last_at:-0} )) -lt "$window" ]; then
      echo "coalesce $(( now - ${last_at:-0} ))"
      return 0
    fi
  fi
  printf '%s %s\n' "$ready_hash" "$now" > "$stamp"
  echo run
}

# ── the per-run model (#448) ───────────────────────────────────────────────
# The swarm works the FIRST ready task, so THIS run's model follows that
# ticket's model-<name> label (list-ready-tasks.sh surfaces it as `.model`, null
# when unlabelled), defaulting to SWARM_MODEL. Resolved + validated BEFORE a
# single worker spawns — an unknown model fails LOUD now, never a silent fall
# back to the default.

# schedule_first_model <ready-json> -> the first ticket's model label, or empty.
schedule_first_model() { jq -r '.[0].model // empty' <<<"$1" 2>/dev/null || true; }

# schedule_first_number <ready-json> -> the first ticket's number.
schedule_first_number() { jq -r '.[0].number' <<<"$1"; }

# schedule_resolve_run_model <ready-json> -> the resolved model id (rc 0), or
# rc non-zero (model-lib's LOUD refusal on stderr) for an unknown label.
schedule_resolve_run_model() { swarm_resolve_model "$(schedule_first_model "$1")"; }

# schedule_model_note <ready-json> <resolved-model> -> the job-log line, citing
# the label + ticket it came from when the first ticket carried one.
schedule_model_note() {
  local ready="$1" model="$2" first
  first="$(schedule_first_model "$ready")"
  printf 'run-swarm: model for this run: %s%s\n' "$model" \
    "${first:+ (from label model-$first on #$(schedule_first_number "$ready"))}"
}

fi
