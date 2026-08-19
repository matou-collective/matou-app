#!/usr/bin/env bash
# runlog-lib.sh — host-side, always-on record of every run-swarm exit (#435).
#
# The swarm twice went hours "green-and-empty": swarm.yml runs concluded
# "success" on cadence with a ready ticket sitting unworked and NO worker
# container ever spawned. The two stall windows were pure archaeology precisely
# because a green no-op run leaves no host-side trace — the job log has it, but
# the Actions REST API hangs intermittently, so job logs are not a dependable
# forensic path.
#
# So run-swarm.sh appends ONE line to a host-side log at EVERY exit path (no
# ready tasks, coalesce, limit-pause, each verdict_stage failure, the green
# wedge, normal completion): timestamp, repo, ready-set numbers, exit reason,
# exit code, duration. The next stall is readable off disk, not the API.
#
# Pure and side-effect-light: runlog_line does string formatting only (unit
# tested by tests/runlog-lib-test.sh); runlog_append is the one filesystem
# touch; worker_wedge is a pure predicate. No network. Never fails its caller.

# runlog_line <started_epoch> <now_epoch> <repo> <ready_nums> <reason> <exit_code>
# One host-log line. Deterministic given fixed epochs (the timestamp is derived
# from <now_epoch>), so the format pins under test.
runlog_line() {
  local started="$1" now="$2" repo="$3" ready="$4" reason="$5" ec="$6" ts
  ts="$(date -u -d "@$now" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '%s repo=%s ready=[%s] reason=%s exit=%s duration=%ss\n' \
    "$ts" "$repo" "$ready" "$reason" "$ec" "$(( now - started ))"
}

# runlog_append <logfile> <line...> — append one line, creating the log dir if
# needed. Never fails the caller: a log we cannot write is not worth reding a
# run over (the verdict + job log still carry the failure).
runlog_append() {
  local log="$1"; shift
  mkdir -p "$(dirname "$log")" 2>/dev/null || return 0
  printf '%s\n' "$*" >> "$log" 2>/dev/null || true
}

# worker_wedge <ready_count> <sandcastle_exit> <workers_born> -> "wedge" | ""
# The #435 defect: a dispatched run with a NON-empty ready set concluded
# success (exit 0) yet never spawned a worker container. That combination is
# never legitimate — even a task the agent immediately blocks spawns a container
# to decide so — so run-swarm.sh fails loud on it instead of exiting green. A
# run that already failed loud (exit != 0) is not this wedge; an empty ready set
# never reaches here (run-swarm exits earlier).
worker_wedge() {
  local ready_count="$1" ec="$2" workers="$3"
  if [ "${ready_count:-0}" -gt 0 ] 2>/dev/null &&
     [ "${ec:-1}" -eq 0 ] 2>/dev/null &&
     [ "${workers:-0}" -eq 0 ] 2>/dev/null; then
    echo wedge
  fi
}
