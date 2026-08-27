#!/usr/bin/env bash
# Offline unit test for verdict-lib.sh's explicit error-line capture (#9).
#
# A guard that FATAL-s to the job's stderr (the cold-pnpm-store / .env-allowlist
# guards in run-swarm.sh) has no errlog file for verdict_write to grep, so the
# verdict's `--- error lines ---` block used to come out EMPTY and the healer
# keyed its signature on the bare stage. verdict_error <line> records the FATAL
# so the writer emits it as the run's error line. Run:
#   bash .sandcastle/tests/verdict-lib-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sc="$here/.."
. "$sc/verdict-lib.sh"
. "$sc/heal-lib.sh"   # seam_verdict_signal — the healer's reader

fail() { echo "FAIL: $1" >&2; exit 1; }
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
pass=0

# --- 1. verdict_error is emitted as the error line when there is no errlog. ---
vp="$tmp/v1.txt"
( verdict_begin "$vp"; verdict_stage "pnpm store warm check (#489)"
  verdict_error "run-swarm: FATAL — pnpm store /x/pnpm-store is EMPTY: workers cannot install (GOTCHAS #20, #489)."
  verdict_write 1 )
[ -f "$vp" ] || fail "verdict_write produced no artifact on a non-zero exit"
grep -q '^stage=pnpm store warm check (#489)$' "$vp" || fail "stage= not recorded:
$(cat "$vp")"
grep -q 'pnpm store /x/pnpm-store is EMPTY' "$vp" || fail "the FATAL was not captured as the error line:
$(cat "$vp")"
# The healer's own parser must recover a non-empty signal (stage :: error) — the
# whole point of #9 is that it no longer degrades to a bare stage / unknown.
sig="$(seam_verdict_signal "$vp")"
case "$sig" in
  "pnpm store warm check (#489) :: run-swarm: FATAL"*) ;;
  *) fail "seam_verdict_signal did not recover stage :: FATAL, got: $sig" ;;
esac
pass=$((pass+1))

# --- 2. verdict_stage clears a prior stage's explicit error (no leak). ---
vp="$tmp/v2.txt"
( verdict_begin "$vp"; verdict_stage "guard A"; verdict_error "FATAL A"
  verdict_stage "guard B"   # a later stage with its OWN, unrelated failure
  verdict_write 1 )
grep -q '^stage=guard B$' "$vp" || fail "stage B not recorded"
grep -q 'FATAL A' "$vp" && fail "a prior stage's FATAL leaked into guard B's verdict:
$(cat "$vp")"
pass=$((pass+1))

# --- 3. An errlog still wins: verdict_error is only the fallback for a stage
#        that has no readable log. ---
vp="$tmp/v3.txt"; errlog="$tmp/e3.log"
printf 'compiling\nerror: undefined symbol foo\n' > "$errlog"
( verdict_begin "$vp"; verdict_stage "build" "$errlog"; verdict_error "unused fallback"
  verdict_write 3 )
grep -q 'undefined symbol foo' "$vp" || fail "errlog error line was not used:
$(cat "$vp")"
grep -q 'unused fallback' "$vp" && fail "verdict_error overrode a real errlog line:
$(cat "$vp")"
pass=$((pass+1))

# --- 4. A clean (exit 0) run writes nothing, even with an error queued. ---
vp="$tmp/v4.txt"
( verdict_begin "$vp"; verdict_stage "guard"; verdict_error "FATAL never happened"
  verdict_write 0 )
[ ! -f "$vp" ] || fail "verdict_write wrote a verdict on a CLEAN run"
pass=$((pass+1))

# --- 5. The SIGKILL breadcrumb (#34): a heavy job killed mid-stage before its
#        EXIT trap can run leaves NO verdict (a SIGKILL is untrappable), so the
#        healer degrades to the bare workflow name and burns an investigation on
#        a non-fault. The breadcrumb, written eagerly at each verdict_stage,
#        survives the kill and records the last running stage. ---
vp="$tmp/v5.txt"; bc="$vp.breadcrumb"
# NO verdict_write here — simulate the process being SIGKILL'd mid-stage.
( verdict_begin "$vp"; verdict_stage "triage skill (claude -p /triage)" )
[ ! -f "$vp" ] || fail "a killed run must leave NO verdict (verdict_write never ran)"
[ -f "$bc" ] || fail "a killed run must leave a breadcrumb for the healer to key on"
grep -q '^stage=triage skill (claude -p /triage)$' "$bc" || fail "the breadcrumb must record the last running stage:
$(cat "$bc")"
grep -q '^status=running$' "$bc" || fail "the breadcrumb must mark the run as still running:
$(cat "$bc")"
# The healer keys the signature on the STAGE, never the bare workflow name — the
# whole point is that the phantom sha1("triage|") incident stops being minted.
sigKilled="$(compute_signature triage "killed mid-stage :: $(sed -n 's/^stage=//p' "$bc" | head -1)")"
sigBare="$(compute_signature triage "")"
[ "$sigKilled" != "$sigBare" ] || fail "a killed-stage signature must differ from the bare-workflow-name signature"
pass=$((pass+1))

# --- 6. verdict_write erases the breadcrumb on EVERY trapped exit, so a
#        breadcrumb only ever survives a real kill. A clean run leaves neither
#        verdict nor breadcrumb; a genuine fault leaves the verdict (never the
#        breadcrumb), so the healer reads the real fault, not the kill path. ---
vp="$tmp/v6a.txt"; bc="$vp.breadcrumb"
( verdict_begin "$vp"; verdict_stage "guard"; verdict_write 0 )
[ ! -f "$bc" ] || fail "a clean (exit 0) run must erase the breadcrumb"
vp="$tmp/v6b.txt"; bc="$vp.breadcrumb"; errlog="$tmp/e6.log"
printf 'error: real fault line\n' > "$errlog"
( verdict_begin "$vp"; verdict_stage "build" "$errlog"; verdict_write 2 )
[ -f "$vp" ] || fail "a genuine fault must still write its verdict"
[ ! -f "$bc" ] || fail "a genuine fault must erase the breadcrumb (the verdict supersedes it)"
grep -q 'real fault line' "$vp" || fail "the fault verdict must carry the real error line"
pass=$((pass+1))

echo "verdict-lib: $pass scenarios passed"
