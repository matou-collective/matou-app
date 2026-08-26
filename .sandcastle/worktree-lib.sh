#!/usr/bin/env bash
# worktree-lib.sh — keep a Sandcastle worker's git worktree evaluable under
# `nix develop` WITHOUT the worker ever running a `git worktree` admin command
# (issue #239). RETIRED from the sandbox: the realign write below persists to
# the host-shared admin and broke the host's merge-to-head (93c6afb, runs
# 1654+); the live fix is main.mts's worktrees-at-host-path mount. Sourced only
# by tests/worktree-lib-test.sh and the unwired align-worktree.sh.
#
# The problem (run 1649). Sandcastle's merge-to-head strategy checks the worker
# out in a linked worktree under .sandcastle/worktrees/<name>. A linked worktree
# has a TWO-WAY link:
#   - the worktree's `.git` FILE          -> `<repo>/.git/worktrees/<name>`   (forward)
#   - the admin `.git/worktrees/<name>/gitdir` FILE -> `<worktree>/.git`      (back)
# The container bind-mounts the worktree at /home/agent/workspace and the parent
# `.git` at its host path, so the FORWARD link resolves but the BACK link still
# names the worktree's HOST path — which does not exist in the container. Plain
# `git` tolerates the dangling back-link; libgit2 (what `nix` uses to read the
# flake) does not, so `nix develop .#go-ci` — the #198 pre-push gate — fails to
# evaluate. Workers "fixed" this in-sandbox with `git worktree repair`, which
# rewrites the shared parent `.git/worktrees/` admin every sibling worker also
# mounts — corrupting a parallel worker's setup and reding the run.
#
# The fix (option 1, Ben's ruling 2026-07-31). Re-point ONLY this worker's own
# admin back-link at the container path, with a direct one-file write — never
# `git worktree repair` (which scans/rewrites siblings' entries too). A sibling's
# `.git/worktrees/<other>/gitdir` is a different file, so two parallel workers
# can never touch each other's state. The command fence (.sandcastle/git-fence)
# is the backstop (option 3).

# worktree_realign_backpointer <git_dir> <repo_toplevel>
#   <git_dir>       — absolute path of this worktree's git dir
#                     (…/.git/worktrees/<name>), as `git rev-parse
#                     --absolute-git-dir` reports it.
#   <repo_toplevel> — this worktree's checkout root in the CURRENT environment
#                     (the container mount, e.g. /home/agent/workspace).
#
# Re-point the admin back-link (<git_dir>/gitdir) at "<repo_toplevel>/.git" — but
# ONLY when all of these hold, so the function is a safe no-op everywhere else:
#   - <git_dir> is a linked-worktree admin entry (its parent dir is `worktrees`);
#     a non-worktree checkout (head mode / the main repo) is left untouched.
#   - the back-link file exists (it is a real linked worktree).
#   - the back-link's current target does NOT resolve here — the mount mismatch
#     we are fixing; a link that already resolves is left as-is (idempotent).
#   - the corrected target ("<repo_toplevel>/.git") DOES resolve here — never
#     write a link we cannot verify.
# Touches exactly one file (this entry's back-link); runs no `git` command.
# Echoes "realigned <old> -> <new>" when it writes, nothing otherwise. Returns 0.
worktree_realign_backpointer() {
  local git_dir="$1" toplevel="$2"
  [ -n "$git_dir" ] && [ -n "$toplevel" ] || return 0

  # Only linked worktrees have a back-link; a main checkout's git dir is `.git`,
  # whose parent is the repo root, not `worktrees`.
  [ "$(basename "$(dirname "$git_dir")")" = "worktrees" ] || return 0

  local backlink="$git_dir/gitdir"
  [ -f "$backlink" ] || return 0

  local current want
  current="$(tr -d '\n' < "$backlink")"
  want="$toplevel/.git"

  # Already resolves (mount matches, or we already fixed it) — nothing to do.
  [ -e "$current" ] && return 0
  # Never write a target we cannot verify exists in this environment.
  [ -e "$want" ] || return 0
  # Nothing to change if the (broken) link already names the target.
  [ "$current" = "$want" ] && return 0

  printf '%s\n' "$want" > "$backlink"
  echo "realigned $current -> $want"
}
