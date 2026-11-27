#!/usr/bin/env bash
# tests/branch-strategy-test.sh — offline test for the worker's LANDING-aware
# post-run host branch strategy (#230). Run: bash tests/branch-strategy-test.sh
#
# The hazard this closes (GOTCHAS 72, deepened by #329): main.mts handed Sandcastle
# an UNCONDITIONAL `branchStrategy: { type: "merge-to-head" }`, so after EVERY run
# the host merged the worker's temp branch onto local `main` INSIDE the Sandcastle
# lifecycle — a conflict there is a hard SyncError + a mid-merge workdir, BEFORE
# run-swarm's GOTCHAS 66 rescue ladder can engage, the instant any concurrent writer
# touched the same lines (STATUS.md is the guaranteed collision). The strategy is
# now LANDING-aware and BOTH explicit modes pin a per-run NAMED branch (no
# merge-back): pr lands via the worker's PR, push has the HOST adopt the branch and
# the land seam owns the only rebase (so the conflict parks, not reds). Only an
# UNSET/unknown LANDING keeps merge-to-head (a bare `pnpm run sandcastle`).
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

# --- LANDING=push ALSO pins a NAMED branch (#329): Sandcastle does NO merge, the
#     HOST adopts the branch and the land seam owns the rebase (conflict → park) ---
push="$(resolve push)"
check "push → type:branch (no in-lifecycle merge-to-head; #329)" \
  "[ \"\$(printf '%s' '$push' | grep -o '\"type\":\"[a-z-]*\"')\" = '\"type\":\"branch\"' ]"
check "push → carries the per-run branch name (the host adopts it)" \
  "printf '%s' '$push' | grep -q '\"branch\":\"sandcastle/worker/TESTBR\"'"
check "push → is NOT merge-to-head" "! printf '%s' '$push' | grep -q 'merge-to-head'"

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
# #329: main.mts takes the per-run branch NAME from the host (SWARM_WORKER_BRANCH)
# so the host knows the ref it must adopt after a push run — falling back to its
# own generated name only on a bare run. (The resolver feeds it to Sandcastle.)
check "main.mts reads SWARM_WORKER_BRANCH for the per-run branch name (#329)" \
  "grep -q 'SWARM_WORKER_BRANCH' '$mainmts'"

rm -rf "$(dirname "$harness")"
summary branch-strategy-test
