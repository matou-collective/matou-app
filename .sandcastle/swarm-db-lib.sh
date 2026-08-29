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

# swarmdb_sweep_orphans — durably finalise ORPHAN runs (#113): open `runs` rows
# whose every open process is a provably-dead pid and whose start predates a full
# run-lifetime. The SIGKILL case heal.sh documents but cannot self-heal (a
# Forgejo-runner CANCEL kills the tree before the EXIT trap fires), so the next
# orchestrator tick / the post-run backstop closes it instead. Host-global,
# age-floored and idempotent — safe to call from every run's exit. Best-effort:
# echoes each `swept <run_id> <trigger>` line, swallows every failure.
swarmdb_sweep_orphans() {
  swarmdb_available || return 0
  python3 "$_SWARMDB_PY" --db "$SWARM_DB" sweep-orphans 2>/dev/null || true
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

# swarmdb_ingest <run_id> <issue|''> <session_jsonl_path> <account|''> — #98:
# parse ONE claude session jsonl into per-request `spend` rows + per-tool-call
# `events`. Unlike the other writers this one's stdout MATTERS — it echoes
# `<n_spend> <n_tool_events>` so record-run-result.sh can tell whether the
# per-request rows landed (and thus skip its aggregate fallback). Best-effort:
# a missing engine, or any failure, echoes `0 0` and never fails the caller.
swarmdb_ingest() {
  local run="$1" issue="$2" session="$3" account="${4:-}"
  swarmdb_available || { echo "0 0"; return 0; }
  local args=(ingest --run "$run" --session "$session")
  [ -n "$issue" ] && args+=(--issue "$issue")
  [ -n "$account" ] && args+=(--account "$account")
  python3 "$_SWARMDB_PY" --db "$SWARM_DB" "${args[@]}" 2>/dev/null || echo "0 0"
}

# swarmdb_spend_from_result <run> <issue|''> <account> <result-json> — #94: a
# STANDALONE claude call (session-runner today; triage/heal once their runs are
# recorded, #91/#92) emits ONE result object with `--output-format json` whose
# `.usage` block carries the call's token counts. Turn it into ONE aggregate
# `spend` row attributed to <account> — the SAME account-attributed shape
# record-run-result.sh writes per swarm iteration (fresh input, cache classes
# split #96, model passed through when the result surfaces one else NULL). This
# does NOT touch record-run-result.sh's own path (it reads sandbox RunResult, not
# a --output-format json blob), so its behaviour is unchanged. Best-effort, this
# lib's posture: a missing / unparseable / usage-less result writes NOTHING and
# never fails the caller. Echoes 1 iff a row was written, else 0.
swarmdb_spend_from_result() {
  local run="$1" issue="$2" account="$3" result="$4"
  swarmdb_available || { echo 0; return 0; }
  [ -n "$result" ] && [ -f "$result" ] || { echo 0; return 0; }
  local usage
  usage="$(jq -c 'if type=="object" and (.usage|type=="object") then .usage else empty end' "$result" 2>/dev/null)" || usage=""
  [ -n "$usage" ] || { echo 0; return 0; }
  local in out cc cr model
  in="$(jq -r '.input_tokens // 0' <<<"$usage" 2>/dev/null)";                 case "$in" in ''|*[!0-9]*) in=0 ;; esac
  out="$(jq -r '.output_tokens // 0' <<<"$usage" 2>/dev/null)";               case "$out" in ''|*[!0-9]*) out=0 ;; esac
  cc="$(jq -r '.cache_creation_input_tokens // 0' <<<"$usage" 2>/dev/null)";   case "$cc" in ''|*[!0-9]*) cc=0 ;; esac
  cr="$(jq -r '.cache_read_input_tokens // 0' <<<"$usage" 2>/dev/null)";       case "$cr" in ''|*[!0-9]*) cr=0 ;; esac
  # #96: the aggregate result carries no per-request model, but recent CLIs expose
  # the billing model as a `.modelUsage` key (or a top-level `.model`); pass it
  # through when present, else leave NULL rather than guess.
  model="$(jq -r 'if type=="object" then ((.modelUsage // {} | keys[0]?) // .model? // empty) else empty end' "$result" 2>/dev/null)" || model=""
  local model_args=() acct_args=() issue_args=()
  [ -n "$model" ] && model_args=(--model "$model")
  [ -n "$account" ] && acct_args=(--account "$account")
  [ -n "$issue" ] && issue_args=(--issue "$issue")
  swarmdb spend --run "$run" ${issue_args[@]+"${issue_args[@]}"} \
    --input "$in" --output "$out" --cache-creation "$cc" --cache-read "$cr" --requests 1 \
    ${acct_args[@]+"${acct_args[@]}"} ${model_args[@]+"${model_args[@]}"}
  echo 1
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
