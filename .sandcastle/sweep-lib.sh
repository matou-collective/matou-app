#!/usr/bin/env bash
# sweep-lib.sh — post-run cleanup of the git worktrees and branches Sandcastle's
# `branchStrategy: merge-to-head` + `copyToWorktree` leaves behind. Each
# iteration creates a worktree `.sandcastle/worktrees/sandcastle-worker-<ts>-<id>`
# and a branch `sandcastle/worker/<ts>-<id>` and NOTHING ever removes them. By
# 2026-07-30 the swarm workdir had 18 stale worktrees (2.9 GB) and 198 orphaned
# `sandcastle/worker/*` branches, and the stale checkouts poisoned
# `go test ./internal/wireconvention/...` with 1867 phantom findings (#187).
#
# run-swarm.sh sources this and runs sweep_worktrees from an EXIT trap. This USED
# to lean on "we hold /tmp/matou-swarm.lock for the whole run, so no OTHER swarm
# is live when this exit trap fires". That single-lock exclusivity DIED with #577
# / ADR 0184: host capacity is now a TWO-slot pool (/tmp/matou-swarm.lock +
# /tmp/matou-host-slot-2.lock) with NO repo affinity, so two swarm runs for the
# SAME repo share one $HOME/swarm/<repo> workdir — hence one .sandcastle/worktrees/
# dir — at the same time. A blind "remove every worktree here" on one run's exit
# then unlinks the OTHER, still-live run's checkout out from under its worker
# mid-flight; Sandcastle's post-run `git checkout --detach` in that victim then
# dies exit 128 (the incident this fix closes). So the sweep now carries the SAME
# age floor reap_containers already uses: a worktree younger than a full
# run-lifetime may belong to a concurrent live run and is spared; only checkouts
# older than the job timeout — provably from a dead run — are removed. The #187
# leak (worktrees accumulating over DAYS) is still cleaned; a live sibling is not.

# sweep_worktrees <repo_dir> [max_age_seconds]
# Remove every worktree under <repo_dir>/.sandcastle/worktrees OLDER than
# max_age_seconds (default 10800 = 3h > swarm.yml's 180-min timeout, so a spared
# worktree can never be from a dead run), prune the admin refs, then delete every
# MERGED sandcastle/worker/* branch whose worktree is gone. Prints, one per line
# to stdout, any unmerged sandcastle/worker/* branch it REFUSED to delete — an
# unmerged branch is evidence of lost work and must be surfaced, not destroyed
# (hence `git branch -d`, never `-D`). Never fails the caller.
sweep_worktrees() {
  local repo="${1:-.}"
  local max_age="${2:-10800}"
  git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 || return 0

  local now cutoff
  now="$(date +%s)"
  cutoff="$(( now - max_age ))"

  local wt wt_epoch
  if [ -d "$repo/.sandcastle/worktrees" ]; then
    for wt in "$repo/.sandcastle/worktrees"/*; do
      [ -e "$wt" ] || continue
      # Spare anything younger than a run-lifetime: it may be the live checkout
      # of a concurrent slot-2 swarm on this same repo (#577/ADR 0184), and
      # removing it unlinks the worktree under that run's running worker. A row
      # we cannot age is left alone (fail-safe), exactly like reap_containers.
      wt_epoch="$(stat -c %Y "$wt" 2>/dev/null)" || continue
      [ -n "$wt_epoch" ] || continue
      [ "$wt_epoch" -ge "$cutoff" ] && continue
      # --force: the worker is done, so a dirty tree is a superseded scrap.
      git -C "$repo" worktree remove --force "$wt" >/dev/null 2>&1 || rm -rf "$wt"
    done
  fi
  git -C "$repo" worktree prune >/dev/null 2>&1 || true

  # Never delete the branch HEAD is on — `git branch -d` refuses it and it would
  # otherwise be mis-surfaced as unmerged. The workflow runs on main; this guards
  # a manual/host run that happens to sit on a worker branch. Likewise skip any
  # branch still checked out in a SURVIVING worktree (a spared young one above,
  # or a live sibling run's): branch -d refuses those too, so without this they'd
  # be mis-surfaced as lost work and spam the sweep's Mattermost alert.
  local current unmerged="" checked_out=""
  current="$(git -C "$repo" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  checked_out="$(git -C "$repo" worktree list --porcelain 2>/dev/null | sed -n 's#^branch refs/heads/##p')"
  local br
  while IFS= read -r br; do
    [ -n "$br" ] || continue
    [ "$br" = "$current" ] && continue
    printf '%s\n' "$checked_out" | grep -qxF "$br" && continue
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
