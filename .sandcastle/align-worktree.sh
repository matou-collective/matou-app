#!/usr/bin/env bash
# align-worktree.sh — NOT WIRED into main.mts. The #239 fix is the worktrees
# mount in main.mts (worktrees mounted at their host path), under which the
# admin back-link resolves in both environments untouched. This script must not
# return to onSandboxReady: its back-link write lands in the host-shared
# `.git/worktrees/` admin and breaks the host's merge-to-head after the
# container exits (regression 93c6afb, runs 1654+). Kept only as the tested
# reference for the two-way-link mechanics — see .sandcastle/worktree-lib.sh.
#
# Active only inside the sandbox (OURCLOUD_SANDBOX=1). On a host checkout the
# worktree's recorded path already matches, so there is nothing to align and we
# must not touch a developer's git state.
set -euo pipefail

[ "${OURCLOUD_SANDBOX:-}" = "1" ] || exit 0

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=worktree-lib.sh
. "$here/worktree-lib.sh"

# Plain `git` tolerates the dangling back-link, so these read cleanly even before
# the fix. If this is not a git checkout at all, there is nothing to do.
git rev-parse --git-dir >/dev/null 2>&1 || exit 0
git_dir="$(git rev-parse --absolute-git-dir 2>/dev/null)" || exit 0
toplevel="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

result="$(worktree_realign_backpointer "$git_dir" "$toplevel")"
if [ -n "$result" ]; then
  echo "align-worktree: $result"
else
  echo "align-worktree: worktree back-link already resolves — no change"
fi
