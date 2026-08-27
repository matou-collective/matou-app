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
  # Companion breadcrumb path (#34). Same deterministic suffix the healer's reader
  # derives, so writer and reader agree without sharing state.
  VERDICT_BREADCRUMB="${VERDICT_PATH}.breadcrumb"
  VERDICT_STAGE="starting"
  VERDICT_ERRLOG=""
  VERDICT_ERROR=""
  rm -f "$VERDICT_PATH" 2>/dev/null || true
  verdict_breadcrumb_write
}

# verdict_stage <name> [errlog] — mark the stage now beginning. When <errlog> is
# a readable file, its error-ish tail feeds the verdict if THIS stage fails;
# otherwise the stage name alone keys the signature (still marker-derived, still
# distinct per stage — never worker prose). Clears any explicit error line from a
# prior stage so a stale FATAL never leaks into this one's verdict.
verdict_stage() {
  VERDICT_STAGE="$1"
  VERDICT_ERRLOG="${2:-}"
  VERDICT_ERROR=""
  verdict_breadcrumb_write
}

# verdict_breadcrumb_write — drop the CURRENTLY-running stage to a companion file,
# eagerly (NOT via the EXIT trap). The whole verdict seam is trap-driven
# (verdict_write fires from an `EXIT` trap), and a SIGKILL — the OOM killer's
# weapon — cannot be trapped, so a resource-killed heavy job leaves NO verdict at
# all: the healer then degrades to the bare workflow-name signature and burns a
# full investigation on a NON-fault (#34). This breadcrumb survives a kill because
# it is written the moment each stage begins; verdict_write erases it on ANY
# trapped exit (clean OR faulted), so a breadcrumb on disk with no verdict beside
# it means exactly one thing to the healer: the run was killed mid-stage.
verdict_breadcrumb_write() {
  [ -n "${VERDICT_BREADCRUMB:-}" ] || return 0
  {
    echo "stage=${VERDICT_STAGE:-unknown}"
    echo "status=running"
  } > "$VERDICT_BREADCRUMB" 2>/dev/null || true
}

# verdict_error <line> — record an explicit error line for a stage that fails
# with no errlog to grep: a guard's FATAL is echoed to the job's stderr, not a
# file (#9), so verdict_write would otherwise emit an EMPTY `--- error lines ---`
# block and the healer would key its signature on the bare stage. Set this to the
# FATAL text right before the guard's `exit`; verdict_write uses it as the error
# line when no errlog yielded one.
verdict_error() {
  VERDICT_ERROR="$1"
}

# verdict_write <exit-code> — write the verdict iff the code is non-zero. Safe to
# wire into an EXIT trap: a clean (exit 0) run leaves no verdict behind.
verdict_write() {
  local ec="$1" errs=""
  # The EXIT trap ran, so this run was NOT SIGKILL'd: erase the breadcrumb (#34).
  # Only a kill — where this line never executes — leaves it behind, and that
  # residue is exactly the resource-kill signal the healer keys on.
  [ -n "${VERDICT_BREADCRUMB:-}" ] && rm -f "$VERDICT_BREADCRUMB" 2>/dev/null
  [ "${ec:-0}" -eq 0 ] 2>/dev/null && return 0
  [ -n "${VERDICT_PATH:-}" ] || return 0
  if [ -n "${VERDICT_ERRLOG:-}" ] && [ -f "$VERDICT_ERRLOG" ]; then
    errs="$(grep -hiE 'error|fail|timed out|fatal|panic|cannot|not found|undefined|:[0-9]+:[0-9]+:|✗|✖' \
      "$VERDICT_ERRLOG" 2>/dev/null | grep -v '^==> ' | tail -12)"
    [ -z "$errs" ] && errs="$(grep -vE '^[[:space:]]*$' "$VERDICT_ERRLOG" 2>/dev/null | tail -8)"
  fi
  # No errlog line (a guard that FATAL-ed to stderr, #9): fall back to the
  # explicit line the caller recorded via verdict_error, so the healer sees the
  # real cause instead of an empty error block.
  [ -z "$errs" ] && errs="${VERDICT_ERROR:-}"
  {
    echo "stage=${VERDICT_STAGE:-unknown}"
    echo "exit=$ec"
    echo "--- error lines ---"
    printf '%s\n' "$errs"
  } > "$VERDICT_PATH" 2>/dev/null || true
}
