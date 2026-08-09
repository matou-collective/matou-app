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

# reap_containers [max_age_seconds]
# Force-remove leaked Sandcastle worker containers (name `sandcastle-*`) older
# than a run-lifetime. Worker teardown leaks them — by 2026-07-31 three stale
# `sandcastle-*` containers (44h and 2×2d old) were still up on an 8GB host
# (#238). run-swarm.sh calls this from its EXIT trap while it still holds the
# global /tmp/matou-swarm.lock, so no other swarm is live: any container older
# than a full run-lifetime is dead and safe to remove regardless of its state
# (the stale ones were "still up", so a stopped-only prune would miss them).
# The age floor (default 3h > swarm.yml's 180-min timeout) guarantees this
# run's own just-finished workers are never in range. Prints each reaped
# container id, one per line. Never fails the caller — no docker, no problem.
reap_containers() {
  local max_age="${1:-10800}"
  command -v docker >/dev/null 2>&1 || return 0
  local now cutoff id created created_epoch reaped=""
  now="$(date +%s)"
  cutoff="$(( now - max_age ))"
  # CreatedAt is a human string like "2026-07-29 21:55:00 +0000 UTC". GNU date
  # chokes on the trailing timezone-abbreviation token but parses the numeric
  # offset, so drop the last field before `date -d`. A row that still fails to
  # parse is left alone (fail-safe: never reap something we can't age).
  while IFS=$'\t' read -r id created; do
    [ -n "$id" ] || continue
    created_epoch="$(date -d "${created% *}" +%s 2>/dev/null)" || continue
    [ -n "$created_epoch" ] || continue
    if [ "$created_epoch" -lt "$cutoff" ]; then
      docker rm -f "$id" >/dev/null 2>&1 && reaped+="$id"$'\n'
    fi
  done < <(docker ps -a --filter 'name=^/?sandcastle-' --format '{{.ID}}\t{{.CreatedAt}}' 2>/dev/null)
  printf '%s' "$reaped"
}
