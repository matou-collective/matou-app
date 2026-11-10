// branch-strategy.mts — the worker's post-run HOST branch strategy, made
// LANDING-aware (#230). main.mts imports resolveBranchStrategy() and hands the
// result to Sandcastle's run({ branchStrategy }).
//
// WHY this is not a constant:
//
// Sandcastle's `merge-to-head` strategy runs the agent on a throwaway worktree
// branch and, WHEN THE RUN ENDS, merges that branch back onto the host's
// current branch (`main`) — see withSandboxLifecycle's "Merging to <branch>"
// step. That merge is the right move under `LANDING=push`, where the host's
// `main` IS the landing surface and the worker's commits belong on it.
//
// Under `LANDING=pr` it is actively wrong. The landing already happened via the
// pull request the worker opened (land-pr.sh); the post-run merge onto local
// `main` is then (a) redundant, (b) puts worker commits on local `main` AHEAD
// of the human PR merge, and (c) turns a merely-stale worker branch into a hard
// SyncError + a workdir left mid-merge the moment any OTHER state-changing
// writer (a peer worker, the session-runner, a live session — all sharing
// `origin/main`) has touched the same lines since the worktree forked. STATUS.md
// is the guaranteed collision (#230, GOTCHAS 72).
//
// So under `LANDING=pr` we pin the worktree to a NAMED branch instead: Sandcastle
// collects the worker's commits from that branch and performs NO merge onto the
// host branch (withSandboxLifecycle takes its `hostCurrentBranch === null` path
// when a branch is named), so there is nothing to conflict and nothing to red.
// The named branch is per-run-unique and left for the next run's
// `git fetch origin main && git reset --hard origin/main` to discard, exactly
// like the `sandcastle/worker/*` temp branches merge-to-head leaves behind.
//
// The value is read from SWARM_POLICY_LANDING — the env var policy-lib.sh's
// read_swarm_policy exports from the consumer's swarm-policy.sh before
// `pnpm run sandcastle` runs (push is the fleet default; dev-factory sets pr).

export type WorkerBranchStrategy =
  | { readonly type: "merge-to-head" }
  | { readonly type: "branch"; readonly branch: string };

// resolveBranchStrategy — pure. `landing` is SWARM_POLICY_LANDING (push|pr|
// undefined); `branchName` is the per-run-unique worktree branch used only in
// the pr case. Anything that is not exactly "pr" keeps the historical
// merge-to-head behaviour, so a bare `npm run sandcastle` (no policy env) and
// every push repo are unchanged.
export function resolveBranchStrategy(
  landing: string | undefined,
  branchName: string,
): WorkerBranchStrategy {
  if (landing === "pr") {
    return { type: "branch", branch: branchName };
  }
  return { type: "merge-to-head" };
}
