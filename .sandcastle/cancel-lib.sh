#!/usr/bin/env bash
# cancel-lib.sh — the operator-cancel kill-path for a live swarm run (#612,
# idss ADR 0186 — read that first for the full design). Sourced by
# run-swarm.sh (log-side detection) and, on the reading/writing end, the
# factory TUI's data/cancel.py (which shells out to the SAME marker-file
# functions below via a thin subprocess call, so the protocol has exactly one
# implementation, never a Python re-derivation that could drift).
#
# Two independent surfaces, deliberately following patterns that already
# exist in this exact codebase instead of inventing new IPC:
#
#   1. THE MARKER FILE — how a separate host process (the TUI) tells this
#      run's main.mts "stop". One file per run_id, host-local, under
#      $HOME/swarm/state/ — the same home swarm.db itself already uses
#      (never .sandcastle/, never git-tracked, never synced). Presence/
#      content-as-signal is the exact shape limit-lib.sh's CLAUDE_LIMIT_MARKER
#      and CLAUDE_ACTIVE_MARKER already use.
#
#   2. THE LOG DETECTOR — how run-swarm.sh's retry loop learns that THIS
#      run's `pnpm run sandcastle` exited because main.mts caught a deliberate
#      abort, not because it crashed. Byte-for-byte the same shape as
#      limit-lib.sh's claude_limit_hit: grep a captured log for a structured
#      marker line, never worker chain-of-thought prose.
#
# Pure: no network, no swarm.db writes (run-swarm.sh does those itself, via
# the EXISTING swarmdb_run_end kills-finalise path — see ADR 0186 §2). Tested
# offline by tests/cancel-lib-test.sh.

# ── 1. marker-file protocol ───────────────────────────────────────────────

SWARM_CANCEL_DIR="${SWARM_CANCEL_DIR:-$HOME/swarm/state/cancel-request}"

# swarm_cancel_marker_path <run-id> — the file whose presence requests cancel.
swarm_cancel_marker_path() { printf '%s/%s' "$SWARM_CANCEL_DIR" "$1"; }

# swarm_cancel_request <run-id> <reason> — write the marker (idempotent; a
# second request just overwrites the reason). Called by the TUI's Cancel
# action. reason may be empty — an operator who cancels without typing one.
swarm_cancel_request() {
  mkdir -p "$SWARM_CANCEL_DIR" 2>/dev/null || return 1
  printf '%s' "$2" > "$(swarm_cancel_marker_path "$1")"
}

# swarm_cancel_requested <run-id> — 0 iff a cancel marker exists for THIS run.
swarm_cancel_requested() { [ -f "$(swarm_cancel_marker_path "$1")" ]; }

# swarm_cancel_reason <run-id> — the operator's stated reason, or empty (both
# "no marker" and "marker with an empty reason" print nothing — callers that
# care about the distinction use swarm_cancel_requested first).
swarm_cancel_reason() { cat "$(swarm_cancel_marker_path "$1")" 2>/dev/null || true; }

# swarm_cancel_clear <run-id> — consume the marker. Best-effort/idempotent: a
# clear on an already-absent marker is a quiet no-op, never an error.
swarm_cancel_clear() { rm -f "$(swarm_cancel_marker_path "$1")" 2>/dev/null || true; }

# ── 2. log-side detector ──────────────────────────────────────────────────
#
# main.mts prints exactly one line, on the abort path only, mirroring
# close-report.sh's existing SANDCASTLE_ATTEMPT convention (a protocol line
# for a host-side parser — see record-run-result.sh's header on why that
# line is never worker prose):
#
#   SANDCASTLE_CANCELLED run=<run_id> reason=<operator text, may be empty>
#
# Anchored on the literal marker token, not a bare word like "cancelled" —
# the same false-positive concern limit-lib.sh's header calls out: a stray
# match here would misreport a real crash as an intentional, unalarmed stop.
SANDCASTLE_CANCELLED_RE='^SANDCASTLE_CANCELLED run=\S+ reason='

# swarm_cancel_hit <logfile> — 0 iff the log shows main.mts's cancel marker.
swarm_cancel_hit() { grep -qE "$SANDCASTLE_CANCELLED_RE" "$1"; }

# swarm_cancel_hit_reason <logfile> — the reason= tail off the marker line,
# or empty (both "no marker" and "marker with an empty reason" print
# nothing — callers use swarm_cancel_hit first, exactly like
# swarm_cancel_reason above).
swarm_cancel_hit_reason() {
  grep -oE "$SANDCASTLE_CANCELLED_RE.*" "$1" 2>/dev/null | head -1 | sed -E 's/^SANDCASTLE_CANCELLED run=\S+ reason=//'
}
