#!/usr/bin/env bash
# Offline test for park-wiring-lib.sh (#85 / GOTCHAS 30) — the VENDORED
# standby-token wiring property. No network, no docker, no agent: every input
# is a workflow file this test writes itself.
#
# What it pins:
#   1. the real bug shape (a park-capable step carrying the primary token
#      alone) is caught, and the STEP is named;
#   2. legitimate wiring is not red — step-level env, and job/workflow-level
#      env the steps inherit (this predicate gates a run CLOSED, so a false
#      positive is worse than in a plain test);
#   3. a sibling step's token does NOT cover a bare step — the exact 2026-08-25
#      shape, where one workflow's steps disagreed with each other;
#   4. "nothing was scanned" is its own return code, never silent green — the
#      whole reason #85 could read green while consumers parked hosts.
# Run: bash .sandcastle/tests/park-wiring-lib-test.sh
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SC="$here/.."
# shellcheck source=../park-wiring-lib.sh
. "$SC/park-wiring-lib.sh"

pass=0; fail=0
check() { if eval "$2"; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: $1"; fi; }

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
# #58: this test never EXECS an orchestrator — the entry-point names below live
# inside workflow-YAML fixtures — but test-env.sh's lint deliberately
# over-approximates, and a guard is worth more conservative than clever. Redirect
# host state anyway; it costs nothing and keeps that lint unweakened.
# shellcheck source=test-env.sh
. "$here/test-env.sh"
test_env_hermetic "$tmp"
wf="$tmp/workflows"; mkdir -p "$wf" "$tmp/empty"

# ── 1. The bug shape: two park-capable steps, primary token only. ────────────
cat > "$wf/triage.yml" <<'YML'
name: triage
on:
  schedule:
    - cron: "0 * * * *"
jobs:
  triage:
    runs-on: pool
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Triage under global lock
        env:
          FORGEJO_TOKEN: ${{ secrets.SWARM_FORGEJO_TOKEN }}
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
        run: |
          bash .sandcastle/run-triage.sh
      - name: Investigate failure (healer)
        if: failure()
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
        run: |
          bash .sandcastle/heal.sh
YML
out="$(park_wiring_file_violations "$wf/triage.yml")"
check "a park-capable step with the primary token alone is a violation" \
  '[ "$(printf "%s\n" "$out" | grep -c .)" -eq 2 ]'
check "the violation NAMES the run-triage.sh step" \
  'grep -q "^Triage under global lock$" <<<"$out"'
check "the violation NAMES the heal.sh step" \
  'grep -q "^Investigate failure (healer)$" <<<"$out"'
check "a step that invokes no park-capable entry point is not reported" \
  '! grep -q "Checkout" <<<"$out"'

# ── 2a. Step-level env: the correct wiring, must be clean. ───────────────────
cat > "$wf/swarm.yml" <<'YML'
name: swarm
jobs:
  swarm:
    steps:
      - name: Swarm under global lock
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          CLAUDE_CODE_OAUTH_TOKEN_B: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN_B }}
        run: bash .sandcastle/run-swarm.sh
YML
check "a step carrying the standby in its own env is clean" \
  '[ -z "$(park_wiring_file_violations "$wf/swarm.yml")" ]'

# ── 2b. Job-level env the steps inherit: also correct wiring, must be clean.
#       A hard gate that red-flagged this would refuse a working repo.
cat > "$wf/joblevel.yml" <<'YML'
name: ci
jobs:
  seam:
    env:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      CLAUDE_CODE_OAUTH_TOKEN_B: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN_B }}
    steps:
      - name: Investigate failure (healer)
        run: bash .sandcastle/heal.sh
YML
check "job-level env carrying the standby covers its steps (no false red)" \
  '[ -z "$(park_wiring_file_violations "$wf/joblevel.yml")" ]'

# ── 3. A SIBLING step's token must not cover a bare step (the outage shape). ─
cat > "$wf/mixed.yml" <<'YML'
name: mixed
jobs:
  a:
    steps:
      - name: wired step
        env:
          CLAUDE_CODE_OAUTH_TOKEN_B: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN_B }}
        run: bash .sandcastle/run-swarm.sh
      - name: bare step
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
        run: bash .sandcastle/heal.sh
YML
out="$(park_wiring_file_violations "$wf/mixed.yml")"
check "a sibling step's standby does NOT cover a bare step" \
  '[ "$out" = "bare step" ]'

# ── 4. Scanning a directory names file AND step; rc 1 when violations exist. ─
scan_out="$(park_wiring_scan "$wf")"; scan_rc=$?
check "park_wiring_scan returns 1 when a directory holds violations" '[ "$scan_rc" -eq 1 ]'
check "park_wiring_scan names the offending file and step" \
  'grep -q "triage.yml: Investigate failure (healer)" <<<"$scan_out"'
check "park_wiring_scan does not report the correctly wired files" \
  '! grep -qE "swarm\.yml|joblevel\.yml" <<<"$scan_out"'

rm -f "$wf/triage.yml" "$wf/mixed.yml"
park_wiring_scan "$wf" >/dev/null; scan_rc=$?
check "park_wiring_scan returns 0 when every scanned file is wired" '[ "$scan_rc" -eq 0 ]'

# ── 5. Nothing scanned is rc 2, NOT clean. The whole point of GOTCHAS 30: a
#      guard that cannot reach the code it guards must say so, never read green.
park_wiring_scan "$tmp/empty" >/dev/null; scan_rc=$?
check "an empty directory returns rc 2 (unreachable), not rc 0 (clean)" '[ "$scan_rc" -eq 2 ]'
park_wiring_scan "$tmp/does-not-exist" >/dev/null; scan_rc=$?
check "a missing directory returns rc 2 (unreachable), not rc 0 (clean)" '[ "$scan_rc" -eq 2 ]'

# ── 6. Every park-capable entry point in the regex is really one, and every
#      limit-lib caller that can park is in the regex. Guards the list itself
#      from going stale — a new parking entry point silently omitted is a fresh
#      #85 in a new workflow.
for ep in run-swarm.sh run-triage.sh heal.sh session-runner.sh rehearsal-report.sh; do
  check "$ep is still a real entry point in the harness" '[ -f "$SC/$ep" ]'
  cat > "$wf/probe.yml" <<YML
name: probe
jobs:
  j:
    steps:
      - name: probe step
        run: bash .sandcastle/$ep
YML
  check "$ep is recognised as park-capable" \
    '[ "$(park_wiring_file_violations "$wf/probe.yml")" = "probe step" ]'
done
rm -f "$wf/probe.yml"

# limit-lib.sh only DEFINES claude_limit_park — a workflow step that merely
# sources it cannot park, so it must not be treated as an entry point.
cat > "$wf/lib.yml" <<'YML'
name: lib
jobs:
  j:
    steps:
      - name: sources the lib only
        run: . .sandcastle/limit-lib.sh && claude_limit_parked
YML
check "limit-lib.sh alone is not treated as a park-capable invocation" \
  '[ -z "$(park_wiring_file_violations "$wf/lib.yml")" ]'
rm -f "$wf/lib.yml"

# ── 7. The remedy sentence is non-empty and names the token — every caller
#      prints it, so a consumer never has to guess what to change.
check "park_wiring_remedy names the token" \
  'park_wiring_remedy | grep -q CLAUDE_CODE_OAUTH_TOKEN_B'

echo "park-wiring-lib: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
