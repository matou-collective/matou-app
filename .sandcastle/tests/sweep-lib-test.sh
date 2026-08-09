#!/usr/bin/env bash
# Offline tests for sweep-lib.sh — the post-run worktree/branch cleanup that
# run-swarm.sh runs from its exit trap. Run: bash .sandcastle/tests/sweep-lib-test.sh
#
# Builds a throwaway git repo with the exact leak #187 describes — a
# .sandcastle/worktrees/* checkout on a sandcastle/worker/* branch — and proves
# the sweep removes the merged debris while LEAVING (and surfacing) any unmerged
# worker branch, because an unmerged branch is possible lost work.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/../sweep-lib.sh"

fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0

repo="$(mktemp -d)"; trap 'rm -rf "$repo"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
git -C "$repo" init -q -b main
git -C "$repo" commit -q --allow-empty -m base
mkdir -p "$repo/.sandcastle/worktrees"

# --- a MERGED worker branch + its worktree (the common case: work landed) ---
git -C "$repo" branch sandcastle/worker/20260730-000000-merged
git -C "$repo" worktree add -q "$repo/.sandcastle/worktrees/sandcastle-worker-20260730-000000-merged" \
  sandcastle/worker/20260730-000000-merged
# a superseded scrap in the worktree — --force must still remove it
echo dirty > "$repo/.sandcastle/worktrees/sandcastle-worker-20260730-000000-merged/scrap.txt"

# --- an UNMERGED worker branch + its worktree (evidence of lost work) ---
git -C "$repo" worktree add -q -b sandcastle/worker/20260730-111111-unmerged \
  "$repo/.sandcastle/worktrees/sandcastle-worker-20260730-111111-unmerged" main
git -C "$repo" -C "$repo/.sandcastle/worktrees/sandcastle-worker-20260730-111111-unmerged" \
  commit -q --allow-empty -m "unmerged work"

# --- a NON-worker branch must be left entirely alone ---
git -C "$repo" branch keep/me

out="$(sweep_worktrees "$repo")"

[ -z "$(ls -A "$repo/.sandcastle/worktrees" 2>/dev/null)" ] \
  || fail "worktrees/ should be empty, still has: $(ls -A "$repo/.sandcastle/worktrees")"
pass=$((pass+1))

git -C "$repo" show-ref --verify -q refs/heads/sandcastle/worker/20260730-000000-merged \
  && fail "the merged worker branch should be deleted"
pass=$((pass+1))

git -C "$repo" show-ref --verify -q refs/heads/sandcastle/worker/20260730-111111-unmerged \
  || fail "the UNMERGED worker branch must be left intact (possible lost work)"
pass=$((pass+1))

printf '%s' "$out" | grep -qx "sandcastle/worker/20260730-111111-unmerged" \
  || fail "the unmerged branch must be surfaced on stdout, got: $out"
printf '%s' "$out" | grep -qx "sandcastle/worker/20260730-000000-merged" \
  && fail "a deleted branch must NOT be surfaced as unmerged"
pass=$((pass+1))

git -C "$repo" show-ref --verify -q refs/heads/keep/me \
  || fail "a non-worker branch must never be touched"
pass=$((pass+1))

# --- idempotent: a second sweep on the cleaned repo does nothing and is quiet ---
out2="$(sweep_worktrees "$repo")"
printf '%s' "$out2" | grep -qx "sandcastle/worker/20260730-111111-unmerged" \
  || fail "a re-run must still surface the surviving unmerged branch"
pass=$((pass+1))

# --- a repo with no worktrees dir / not a git dir must be a safe no-op ---
sweep_worktrees "$(mktemp -d)" >/dev/null || fail "non-git dir must be a no-op, not an error"
pass=$((pass+1))

echo "sweep-lib: $pass groups passed"
