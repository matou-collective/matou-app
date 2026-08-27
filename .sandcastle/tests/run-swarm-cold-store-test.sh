#!/usr/bin/env bash
# Offline test for run-swarm.sh's cold-pnpm-store guard death attribution (#9).
#
# elitebook-03 × matou-app died on every tick for 20 h logged as
# `died-in:preflight self-tests (#446)` with an EMPTY error block: the cold-store
# FATAL set neither verdict_stage nor an error line, so the EXIT trap attributed
# the death to the last stage set (still "preflight self-tests") and the healer
# escalated CLASS unknown.
#
# Until #2 this file kept a structurally-identical COPY of the guard. It now
# lives in provision-lib.sh (the PROVISION seam) as provision_pnpm_store_guard,
# so this test drives the REAL guard and keeps only the EXIT-trap reason
# derivation as a local replica — that half genuinely belongs to run-swarm's
# trap, and the `fixed=0` arm still reproduces the pre-#9 symptom for contrast,
# proving the assertions have teeth.
#
# Run: bash .sandcastle/tests/run-swarm-cold-store-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sc="$here/.."
. "$sc/verdict-lib.sh"
. "$sc/heal-lib.sh"        # seam_verdict_signal — the healer's reader
. "$sc/provision-lib.sh"   # the guard under test

fail() { echo "FAIL: $1" >&2; exit 1; }
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
pass=0

# run_guard <store-root> <allow_cold> <fixed> ; sets REASON, VP
# `fixed=1` runs the real (#9) guard; `fixed=0` reproduces the pre-#9 bug — the
# same refusal WITHOUT the verdict_stage/verdict_error — for contrast.
run_guard() {
  local root="$1" SWARM_ALLOW_COLD_STORE="$2" fixed="$3"
  local SWARM_EXIT_REASON="" ec=0
  VP="$tmp/verdict.txt"
  verdict_begin "$VP"
  # Earlier in the run the last stage set was the preflight self-tests — the
  # intervening verdict_stage calls only fire inside failure branches not taken.
  verdict_stage "preflight self-tests (#446)"
  if [ "$fixed" = 1 ]; then
    provision_pnpm_store_guard "$root" 2>/dev/null || ec=1
  else
    if [ "${SWARM_ALLOW_COLD_STORE:-0}" != "1" ] \
       && [ -z "$(find "$root/pnpm-store" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
      ec=1
    fi
  fi
  # on_exit's reason derivation (verbatim from run-swarm.sh): SWARM_EXIT_REASON
  # is unset on this path, so the reason falls back to died-in:<stage>.
  verdict_write "$ec"
  local reason="${SWARM_EXIT_REASON:-}"
  [ -n "$reason" ] || reason="died-in:${VERDICT_STAGE:-unknown}"
  REASON="$reason"
  return "$ec"
}

# --- 1. Cold store, #9 fix: death keyed on the pnpm-store stage, FATAL captured,
#        runlog reason is died-in:pnpm store warm check, healer not blind. ---
d="$tmp/cold"; mkdir -p "$d/pnpm-store"
if run_guard "$d" 0 1; then fail "cold store must refuse (exit non-zero)"; fi
[ "$REASON" = "died-in:pnpm store warm check (#489)" ] \
  || fail "runlog reason should attribute the death to the pnpm-store stage, got: $REASON"
grep -q '^stage=pnpm store warm check (#489)$' "$VP" || fail "verdict stage wrong:
$(cat "$VP")"
grep -q 'pnpm store .* is EMPTY' "$VP" || fail "FATAL text not captured as the error line:
$(cat "$VP")"
[ -n "$(seam_verdict_signal "$VP")" ] || fail "healer got an EMPTY signal — would escalate unknown"
pass=$((pass+1))

# --- 2. Pre-#9 (buggy) guard: proves the assertions have teeth — without the
#        verdict_stage/verdict_error the death is mis-keyed to preflight with an
#        empty error block (the exact 20 h symptom). ---
d="$tmp/cold-buggy"; mkdir -p "$d/pnpm-store"
if run_guard "$d" 0 0; then fail "cold store must refuse even in the buggy variant"; fi
[ "$REASON" = "died-in:preflight self-tests (#446)" ] \
  || fail "buggy variant should reproduce the mis-attribution, got: $REASON"
err="$(sed -n '/^--- error lines ---$/,$p' "$VP" | sed '1d' | grep -E '[^[:space:]]' || true)"
[ -z "$err" ] || fail "buggy variant should have an EMPTY error block, got: $err"
pass=$((pass+1))

# --- 3. Warm store: guard passes, no verdict written. ---
d="$tmp/warm"; mkdir -p "$d/pnpm-store/.pnpm"
run_guard "$d" 0 1 || fail "a warm store must pass the guard"
[ ! -f "$VP" ] || fail "a passing guard must leave no verdict behind"
pass=$((pass+1))

# --- 4. SWARM_ALLOW_COLD_STORE=1 overrides even an empty store. ---
d="$tmp/override"; mkdir -p "$d/pnpm-store"
run_guard "$d" 1 1 || fail "SWARM_ALLOW_COLD_STORE=1 must pass an empty store"
[ ! -f "$VP" ] || fail "the override path must leave no verdict behind"
pass=$((pass+1))

echo "run-swarm-cold-store: $pass scenarios passed"
