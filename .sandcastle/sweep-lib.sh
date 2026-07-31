#!/usr/bin/env bash
# sweep-lib.sh — post-run cleanup of the git worktrees and branches Sandcastle's
# `branchStrategy: merge-to-head` + `copyToWorktree` leaves behind. Each
# iteration creates a worktree `.sandcastle/worktrees/sandcastle-worker-<ts>-<id>`
# and a branch `sandcastle/worker/<ts>-<id>` and NOTHING ever removes them. By
# 2026-07-30 the swarm workdir had 18 stale worktrees (2.9 GB) and 198 orphaned
# `sandcastle/worker/*` branches, and the stale checkouts poisoned
# `go test ./internal/wireconvention/...` with 1867 phantom findings (#187).
#
# run-swarm.sh sources this and runs sweep_worktrees from an EXIT trap. Both this
# and the healer serialize behind the global /tmp/matou-swarm.lock, so when a run
# reaches its exit trap no OTHER swarm is running — every worktree under
# .sandcastle/worktrees/ is a finished-or-dead checkout and safe to remove.

# sweep_worktrees <repo_dir>
# Remove every worktree under <repo_dir>/.sandcastle/worktrees, prune the
# admin refs, then delete every MERGED sandcastle/worker/* branch. Prints, one
# per line to stdout, any unmerged sandcastle/worker/* branch it REFUSED to
# delete — an unmerged branch is evidence of lost work and must be surfaced, not
# destroyed (hence `git branch -d`, never `-D`). Never fails the caller.
sweep_worktrees() {
  local repo="${1:-.}"
  git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 || return 0

  local wt
  if [ -d "$repo/.sandcastle/worktrees" ]; then
    for wt in "$repo/.sandcastle/worktrees"/*; do
      [ -e "$wt" ] || continue
      # --force: the worker is done, so a dirty tree is a superseded scrap.
      git -C "$repo" worktree remove --force "$wt" >/dev/null 2>&1 || rm -rf "$wt"
    done
  fi
  git -C "$repo" worktree prune >/dev/null 2>&1 || true

  # Never delete the branch HEAD is on — `git branch -d` refuses it and it would
  # otherwise be mis-surfaced as unmerged. The workflow runs on main; this guards
  # a manual/host run that happens to sit on a worker branch.
  local current unmerged=""
  current="$(git -C "$repo" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  local br
  while IFS= read -r br; do
    [ -n "$br" ] || continue
    [ "$br" = "$current" ] && continue
    if ! git -C "$repo" branch -d "$br" >/dev/null 2>&1; then
      unmerged+="$br"$'\n'
    fi
  done < <(git -C "$repo" for-each-ref --format='%(refname:short)' 'refs/heads/sandcastle/worker' 2>/dev/null)

  printf '%s' "$unmerged"
}
