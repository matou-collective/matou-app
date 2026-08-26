#!/usr/bin/env bash
# swarm-db-lib.sh — best-effort bash front-end to the swarm.db trace MIRROR
# (#447, L4). Sourced by run-swarm.sh; every function shells out to swarm-db.py
# and SWALLOWS its exit so a mirror we cannot write NEVER reds a run (the db is
# a mirror — the runlog + verdict artifacts stay the dependable record).
#
# The engine is python3 (guaranteed on every swarm host AND in the worker
# sandbox; the sqlite3 CLI is not) with WAL + busy_timeout on every connection.
# If python3 is somehow absent, swarmdb_available returns non-zero and every
# writer becomes a no-op — the run proceeds unmirrored, never blocked.

# Location of the db (on the workstation, NEVER in-repo) and the engine script.
: "${SWARM_DB:=$HOME/swarm/state/swarm.db}"
export SWARM_DB
_SWARMDB_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_SWARMDB_PY="${SWARM_DB_PY:-$_SWARMDB_HERE/swarm-db.py}"

# swarmdb_available — python3 present and the engine readable. Cheap; called by
# every writer so a missing engine degrades to silent no-ops, never an error.
swarmdb_available() {
  command -v python3 >/dev/null 2>&1 && [ -f "$_SWARMDB_PY" ]
}

# swarmdb <subcommand> [args...] — the one shell-out. Best-effort: stdout is
# discarded, a non-zero exit is swallowed, so `set -e` in the caller is safe.
swarmdb() {
  swarmdb_available || return 0
  python3 "$_SWARMDB_PY" --db "$SWARM_DB" "$@" >/dev/null 2>&1 || true
}

# --- typed writers run-swarm.sh calls ----------------------------------------

# swarmdb_run_start <run_id> <repo> <trigger> <started_epoch>
swarmdb_run_start() {
  swarmdb run-start --run "$1" --repo "$2" --trigger "$3" --started "$4"
}

# swarmdb_run_end <run_id> <verdict> <source> <exit_code> <ended_epoch>
# Finalises the run AND every open attempt (kills-finalise invariant).
swarmdb_run_end() {
  swarmdb run-end --run "$1" --verdict "$2" --source "$3" --exit "$4" --ended "$5"
}

# swarmdb_event <run_id> <issue|''> <kind> <detail> [evidence]
swarmdb_event() {
  local run="$1" issue="$2" kind="$3" detail="$4" evidence="${5:-}"
  if [ -n "$issue" ]; then
    swarmdb event --run "$run" --issue "$issue" --kind "$kind" --detail "$detail" --evidence "$evidence"
  else
    swarmdb event --run "$run" --kind "$kind" --detail "$detail" --evidence "$evidence"
  fi
}

# swarmdb_wedge <run_id> <ready_nums> — the #435 answer: a green run that
# spawned NO worker is written as an UNFINALISED processes row (ended_at NULL =
# believed alive, but it emitted nothing) plus a worker_wedge event. `open
# -processes` then surfaces it forever until a human accounts for it.
swarmdb_wedge() {
  local run="$1" ready="$2"
  swarmdb proc-open --run "$run" --kind worker --ref "wedge:$run" \
    --command "sandcastle run concluded success but spawned NO worker (#435)"
  swarmdb_event "$run" "" worker_wedge "ready set [$ready] went untouched — no worker container was born" "green-wedge (#435)"
}
