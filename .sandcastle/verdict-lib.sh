#!/usr/bin/env bash
# Shared on-failure verdict for the swarm/triage workflows (#235), extending the
# `ci` seam verdict (#197, scripts/seam-smoke.sh) to the other two runners.
#
# On failure a workflow drops a machine-readable stage/exit/error marker at a
# well-known host path. The swarm healer folds it into the incident signature
# (heal-lib.sh:seam_verdict_signal), so a MOVED fault yields a NEW signature and
# re-triggers investigation — instead of the old behaviour where error_line()
# grepped Sandcastle worker chain-of-thought prose (saturated with "error" /
# "failed"), collapsing every distinct fault onto whatever the newest stale
# worker log happened to be narrating.
#
# The format is exactly seam-smoke's, so heal-lib.sh's one parser serves all
# three runners. No network, no state beyond the single verdict file.

# verdict_begin <path> — remember where the verdict goes and clear any stale one,
# so a verdict on disk always belongs to the current run (the healer additionally
# ignores verdicts older than its run window as a second guard).
verdict_begin() {
  VERDICT_PATH="$1"
  VERDICT_STAGE="starting"
  VERDICT_ERRLOG=""
  rm -f "$VERDICT_PATH" 2>/dev/null || true
}

# verdict_stage <name> [errlog] — mark the stage now beginning. When <errlog> is
# a readable file, its error-ish tail feeds the verdict if THIS stage fails;
# otherwise the stage name alone keys the signature (still marker-derived, still
# distinct per stage — never worker prose).
verdict_stage() {
  VERDICT_STAGE="$1"
  VERDICT_ERRLOG="${2:-}"
}

# verdict_write <exit-code> — write the verdict iff the code is non-zero. Safe to
# wire into an EXIT trap: a clean (exit 0) run leaves no verdict behind.
verdict_write() {
  local ec="$1" errs=""
  [ "${ec:-0}" -eq 0 ] 2>/dev/null && return 0
  [ -n "${VERDICT_PATH:-}" ] || return 0
  if [ -n "${VERDICT_ERRLOG:-}" ] && [ -f "$VERDICT_ERRLOG" ]; then
    errs="$(grep -hiE 'error|fail|timed out|fatal|panic|cannot|not found|undefined|:[0-9]+:[0-9]+:|✗|✖' \
      "$VERDICT_ERRLOG" 2>/dev/null | grep -v '^==> ' | tail -12)"
    [ -z "$errs" ] && errs="$(grep -vE '^[[:space:]]*$' "$VERDICT_ERRLOG" 2>/dev/null | tail -8)"
  fi
  {
    echo "stage=${VERDICT_STAGE:-unknown}"
    echo "exit=$ec"
    echo "--- error lines ---"
    printf '%s\n' "$errs"
  } > "$VERDICT_PATH" 2>/dev/null || true
}
