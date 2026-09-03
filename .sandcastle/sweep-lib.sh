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

# prune_session_logs <logs_dir> [max_age_seconds]
# Retention half of #98's ingest-then-prune pipeline. Remove raw claude session
# `*.jsonl` files under <logs_dir> OLDER than max_age_seconds (default =
# SESSION_LOG_RETENTION_DAYS days, itself defaulting to 14) — Sandcastle logs
# session (and run) files here with no bound, so the dir grew forever. Safe to
# delete because record-run-result.sh ingests every run's session jsonl into
# swarm.db per-request spend + per-tool-call events IMMEDIATELY post-run: a file
# older than the window has provably already been harvested into its durable
# record, so this only prunes what is already captured — never destroys the sole
# copy of anything. The window is just a number, widen it here to keep raw jsonl
# longer. A file we cannot age is left alone (fail-safe). Never fails the caller.
prune_session_logs() {
  local dir="${1:-}"
  local max_age="${2:-$(( ${SESSION_LOG_RETENTION_DAYS:-14} * 86400 ))}"
  [ -n "$dir" ] && [ -d "$dir" ] || return 0

  local now cutoff f f_epoch
  now="$(date +%s)"
  cutoff="$(( now - max_age ))"
  for f in "$dir"/*.jsonl; do
    [ -f "$f" ] || continue
    f_epoch="$(stat -c %Y "$f" 2>/dev/null)" || continue
    [ -n "$f_epoch" ] || continue
    [ "$f_epoch" -ge "$cutoff" ] && continue
    rm -f "$f" 2>/dev/null || true
  done
}

# reap_containers [max_age_seconds]
# Force-remove leaked factory containers older than a run-lifetime. Three
# reap paths, widest-net last (#122):
#
#   1. NAME `sandcastle-*` — the worker containers Sandcastle names and leaks on
#      teardown; by 2026-07-31 three stale ones (44h and 2×2d) were up on an 8GB
#      host (#238). Aged past `max_age` (default 3h > swarm.yml's 180-min
#      timeout, so this run's own just-finished workers are never in range).
#   2. LABEL `matou.factory=<kind>` — the containers OTHER factory `docker run`s
#      leave behind when the Forgejo runner is cancelled or loses the task and
#      SIGKILLs only the `docker run` CLIENT: the product ci.yml's checks
#      container (`kind=ci`), the healer's ad-hoc bisect runs (`kind=heal`).
#      `--rm` never fires, `bash -lc` as PID 1 ignores SIGTERM, and the
#      container spins for days (5 leaked over 10 days on elitebook-03, ~3 cores
#      / ~700 MB swap, idss #1182). Reaped per-kind: an aged heal container past
#      HEAL_REAP_CEILING (heal.sh caps its agent at `timeout 900`, so 900s +
#      slack), a ci one past CI_REAP_CEILING (the product's ci `timeout-minutes`
#      + slack — product-defined, so it defaults to the run-lifetime floor and a
#      consumer tightens it via env), any other kind past the floor.
#   3. BELT by IMAGE — a container nobody named or labelled but whose image IS a
#      factory sandbox (`sandcastle:<repo>` tag, or a product ci image `*-ci`)
#      older than the floor: no legitimate factory container lives past a
#      run-lifetime, so this catches a leak that lost both its name and label.
#
# run-swarm.sh calls this from its EXIT trap while it holds the global
# /tmp/matou-swarm.lock; a concurrent slot-2 sibling (#577/ADR 0184) is spared
# because every ceiling is >= that kind's legitimate max lifetime. A container
# that is NONE of the three (not a factory container) is never touched. Prints
# each reaped id, one per line, and logs `id (reason, created …)` to stderr so a
# recurrence surfaces in the sweep line instead of leaking silently. Never fails
# the caller — no docker, no problem.
reap_containers() {
  local floor="${1:-10800}"
  command -v docker >/dev/null 2>&1 || return 0
  local heal_ceiling="${HEAL_REAP_CEILING:-1800}"   # 900s heal timeout + slack
  local ci_ceiling="${CI_REAP_CEILING:-$floor}"     # product ci timeout + slack
  local now id created names image kind ceiling reason created_epoch reaped=""
  now="$(date +%s)"
  # One pass over every container, classified in-shell. CreatedAt is a human
  # string like "2026-07-29 21:55:00 +0000 UTC"; GNU date chokes on the trailing
  # timezone-abbreviation token but parses the numeric offset, so drop the last
  # field before `date -d`. A row that fails to parse (or matches no path) is
  # left alone (fail-safe: never reap something we can't age or don't own).
  while IFS=$'\t' read -r id created names image kind; do
    [ -n "$id" ] || continue
    ceiling=""; reason=""
    case "$names" in
      sandcastle-*|/sandcastle-*) ceiling="$floor"; reason="name:$names" ;;
    esac
    if [ -z "$ceiling" ] && [ -n "$kind" ]; then
      case "$kind" in
        heal) ceiling="$heal_ceiling" ;;
        ci)   ceiling="$ci_ceiling" ;;
        *)    ceiling="$floor" ;;
      esac
      reason="label:matou.factory=$kind"
    fi
    if [ -z "$ceiling" ]; then
      case "$image" in
        sandcastle:*|*-ci|*-ci:*) ceiling="$floor"; reason="image:$image" ;;
      esac
    fi
    [ -n "$ceiling" ] || continue
    created_epoch="$(date -d "${created% *}" +%s 2>/dev/null)" || continue
    [ -n "$created_epoch" ] || continue
    if [ "$created_epoch" -lt "$(( now - ceiling ))" ]; then
      if docker rm -f "$id" >/dev/null 2>&1; then
        reaped+="$id"$'\n'
        echo "reap_containers: reaped $id ($reason, created $created)" >&2
      fi
    fi
  done < <(docker ps -a --format '{{.ID}}\t{{.CreatedAt}}\t{{.Names}}\t{{.Image}}\t{{.Label "matou.factory"}}' 2>/dev/null)
  printf '%s' "$reaped"
}
