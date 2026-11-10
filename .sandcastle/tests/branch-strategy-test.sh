#!/usr/bin/env bash
# tests/branch-strategy-test.sh — offline test for the worker's LANDING-aware
# post-run host branch strategy (#230). Run: bash tests/branch-strategy-test.sh
#
# The hazard this closes (GOTCHAS 72): main.mts handed Sandcastle an
# UNCONDITIONAL `branchStrategy: { type: "merge-to-head" }`, so after EVERY run
# the host merged the worker's temp branch onto local `main`. Under LANDING=pr
# the landing already happened via the worker's pull request, so that merge is
# redundant AND reds the run with a SyncError the instant any concurrent writer
# has touched the same lines (STATUS.md is the guaranteed collision). The
# strategy is now LANDING-aware: pr pins a named branch (no merge-back), push
# keeps merge-to-head.
#
# Pure TS logic, so the test exercises resolveBranchStrategy() directly via tsx
# (the same runner `pnpm run sandcastle` uses). No docker, no network.
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"

# tests/ is .sandcastle/tests/ in a consumer, so the module is one level up (#23).
sc="$here/.."
module="$sc/branch-strategy.mts"

check "branch-strategy.mts exists beside the harness" "[ -f '$module' ]"

# Find tsx: the repo's own node_modules first (consumer: .sandcastle/node_modules
# or the repo root one level above that), then PATH. A worker runs
# `pnpm run sandcastle` = `tsx …/main.mts`, so tsx is present wherever main.mts
# runs; where it is genuinely absent (a trimmed offline checkout) the test SKIPs
# loudly rather than failing the suite — the same absent-binary discipline the
# close-report reviewer gate keeps (#228).
tsx_bin=""
for d in "$sc" "$sc/.." "$sc/../.."; do
  if [ -x "$d/node_modules/.bin/tsx" ]; then tsx_bin="$d/node_modules/.bin/tsx"; break; fi
done
if [ -z "$tsx_bin" ] && command -v tsx >/dev/null 2>&1; then tsx_bin="$(command -v tsx)"; fi

if [ -z "$tsx_bin" ]; then
  echo "branch-strategy-test: SKIP — no tsx on this host (nothing to run the .mts with)"
  summary branch-strategy-test
  exit 0
fi

# A tiny harness that dynamically imports the module by absolute path and prints
# the resolved strategy as JSON for a given LANDING value.
harness="$(mktemp -d)/run.mts"
cat > "$harness" <<'EOF'
const mod = await import(process.argv[2]);
const landing = process.argv[3] === "__unset__" ? undefined : process.argv[3];
console.log(JSON.stringify(mod.resolveBranchStrategy(landing, "sandcastle/worker/TESTBR")));
EOF

resolve() { "$tsx_bin" "$harness" "$module" "$1" 2>/dev/null; }

# --- LANDING=pr pins a NAMED branch (no merge-back onto main) ---
pr="$(resolve pr)"
check "pr → type:branch (no merge-to-head)" \
  "[ \"\$(printf '%s' '$pr' | grep -o '\"type\":\"[a-z-]*\"')\" = '\"type\":\"branch\"' ]"
check "pr → carries the per-run branch name" \
  "printf '%s' '$pr' | grep -q '\"branch\":\"sandcastle/worker/TESTBR\"'"
check "pr → is NOT merge-to-head" "! printf '%s' '$pr' | grep -q 'merge-to-head'"

# --- LANDING=push keeps merge-to-head (main is the landing surface) ---
push="$(resolve push)"
check "push → type:merge-to-head" "printf '%s' '$push' | grep -q '\"type\":\"merge-to-head\"'"
check "push → has no named branch" "! printf '%s' '$push' | grep -q '\"branch\"'"

# --- unset / unknown falls back to merge-to-head (bare `npm run sandcastle`) ---
unset_v="$(resolve __unset__)"
check "unset LANDING → merge-to-head (historical default preserved)" \
  "printf '%s' '$unset_v' | grep -q '\"type\":\"merge-to-head\"'"
other="$(resolve weird)"
check "unknown LANDING → merge-to-head (only exactly 'pr' switches)" \
  "printf '%s' '$other' | grep -q '\"type\":\"merge-to-head\"'"

# --- main.mts actually wires it (not a dead helper): it imports the resolver
#     and feeds it SWARM_POLICY_LANDING, not a hardcoded { type: … } ---
mainmts="$sc/main.mts"
check "main.mts imports resolveBranchStrategy" \
  "grep -q 'resolveBranchStrategy' '$mainmts'"
check "main.mts feeds it SWARM_POLICY_LANDING" \
  "grep -q 'resolveBranchStrategy(' '$mainmts' && grep -q 'SWARM_POLICY_LANDING' '$mainmts'"
check "main.mts no longer hardcodes an unconditional merge-to-head branchStrategy" \
  "! grep -q 'branchStrategy: { type: \"merge-to-head\" }' '$mainmts'"

rm -rf "$(dirname "$harness")"
summary branch-strategy-test
