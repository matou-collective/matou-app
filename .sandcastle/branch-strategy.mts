// branch-strategy.mts — the worker's post-run HOST branch strategy, made
// LANDING-aware (#230, deepened by #329). main.mts imports resolveBranchStrategy()
// and hands the result to Sandcastle's run({ branchStrategy }).
//
// WHY this is not a constant:
//
// Sandcastle's `merge-to-head` strategy runs the agent on a throwaway worktree
// branch and, WHEN THE RUN ENDS, merges that branch back onto the host's current
// branch (`main`) — see withSandboxLifecycle's "Merging to <branch>" step, run
// with `cwd: hostRepoDir`. That merge is INSIDE the Sandcastle lifecycle, BEFORE
// run-swarm.sh ever reaches its verify/land seams — so a conflict there is a hard
// SyncError + a workdir left mid-merge, and run-swarm's GOTCHAS 66 rescue ladder
// (rebase → classify → park on `sandcastle/rescue-*` → re-test → rescue PR) never
// engages. The collision is the NORMAL case for parallel agents the moment any
// other state-changing writer (a peer worker, the session-runner, a live session —
// all sharing `origin/main`) touched the same lines since the worktree forked;
// STATUS.md is the guaranteed surface (#230/#287, GOTCHAS 72). Under `LANDING=pr`
// the merge is additionally redundant (the landing already happened via the
// worker's pull request) and wrong (it puts worker commits on local `main` ahead
// of the human PR merge).
//
// So BOTH `LANDING=pr` and `LANDING=push` pin the worktree to a per-run NAMED
// branch: Sandcastle collects the worker's commits onto that branch and performs
// NO merge onto `main` (withSandboxLifecycle takes its `hostCurrentBranch === null`
// path when a branch is named). Under `pr` the worker's own land-pr.sh pushed the
// PR, so the host needs nothing more. Under `push` the HOST then ADOPTS that named
// branch onto its HEAD — a conflict-FREE local `git reset` (the branch forked from
// this run's HEAD), done by execute-lib.sh's execute_adopt_worker_branch right
// after the run — so verify_protected_paths still fingerprints the worker's tree
// and landing_push_main_with_rescue owns the ONLY rebase, against the LIVE
// `origin/main`, INSIDE the ladder, where a stale-base conflict PARKS instead of
// reding (#329). The named branch is per-run-unique and left for the next run's
// `git fetch origin main && git reset --hard origin/main` to discard.
//
// `landing` is read from SWARM_POLICY_LANDING — the env var policy-lib.sh's
// read_swarm_policy exports from the consumer's swarm-policy.sh before
// `pnpm run sandcastle` runs (push is the fleet default; a consumer opts into pr
// in its own identity layer — which repo lands which way is a consumer fact, not
// one this harness file names). `branchName` is the per-run-unique worktree
// branch; run-swarm.sh generates it (SWARM_WORKER_BRANCH) so the host knows the
// ref it must adopt, and main.mts falls back to its own name on a bare run.
//
// Only an EXPLICIT push|pr switches to a named branch. Anything else — notably an
// UNSET SWARM_POLICY_LANDING, i.e. a bare `pnpm run sandcastle` with no policy
// layer and no host to adopt the branch — keeps `merge-to-head`, so the local
// dev run still gets the worker's commits merged onto its own `main` with no
// run-swarm in the loop (the historical default, preserved).

export type WorkerBranchStrategy =
  | { readonly type: "merge-to-head" }
  | { readonly type: "branch"; readonly branch: string };

// resolveBranchStrategy — pure. `landing` is SWARM_POLICY_LANDING (push|pr|
// undefined); `branchName` is the per-run-unique worktree branch.
export function resolveBranchStrategy(
  landing: string | undefined,
  branchName: string,
): WorkerBranchStrategy {
  if (landing === "pr" || landing === "push") {
    return { type: "branch", branch: branchName };
  }
  return { type: "merge-to-head" };
}
