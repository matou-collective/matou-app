#!/usr/bin/env bash
# Offline tests for issue #239 — a worker sandbox must never need, nor be able,
# to mutate the shared git-worktree admin every parallel worker bind-mounts.
# Covers .sandcastle/worktree-lib.sh (the root fix), .sandcastle/git-fence (the
# command backstop), and the run-1649 regression. No container, no nix.
# Run: bash .sandcastle/tests/worktree-lib-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/../worktree-lib.sh"
fence="$here/../git-fence"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0

# This suite drives REAL `git worktree add` to build its fixture — exactly the
# operation .sandcastle/git-fence refuses inside the Sandcastle sandbox (#239),
# where every worker shares one .git/worktrees/ admin. It is a normal green
# suite off-sandbox (workstation/CI), where the fence is absent. Skip explicitly
# here rather than red on the fence (#587). Off-sandbox `git` is the real
# binary, so the marker never matches and the suite runs in full.
if grep -qs git-fence "$(command -v git 2>/dev/null)"; then
  echo "worktree-lib: SKIP — git worktree add is fenced in-sandbox (#239); run off-sandbox"
  exit 0
fi

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

# A repo with two linked worker worktrees, exactly Sandcastle's merge-to-head
# layout (.sandcastle/worktrees/<name>, sharing the parent .git/worktrees/).
git init -q -b main "$tmp/repo"
( cd "$tmp/repo" && echo hi > a && git add -A && git commit -qm base )
mkdir -p "$tmp/repo/.sandcastle/worktrees"
git -C "$tmp/repo" worktree add -q .sandcastle/worktrees/wA -b sandcastle/worker/A
git -C "$tmp/repo" worktree add -q .sandcastle/worktrees/wB -b sandcastle/worker/B

adminA="$tmp/repo/.git/worktrees/wA"
adminB="$tmp/repo/.git/worktrees/wB"
[ -f "$adminA/gitdir" ] || fail "fixture: worktree A admin back-link missing"

# --- worktree_realign_backpointer: the root fix ----------------------------

# 1. A healthy worktree whose back-link already resolves is left untouched.
before="$(cat "$adminA/gitdir")"
out="$(worktree_realign_backpointer "$adminA" "$tmp/repo/.sandcastle/worktrees/wA")"
[ -z "$out" ] || fail "a resolving back-link must not be rewritten (got: $out)"
[ "$(cat "$adminA/gitdir")" = "$before" ] || fail "a resolving back-link must be left byte-identical"
pass=$((pass+1))

# 2. The container mismatch: A is mounted at /home/agent/workspace, so its
#    recorded HOST back-link no longer resolves. Simulate the mount by copying
#    the checkout to a "container" path and pointing realign at it.
mount="$tmp/workspace"
cp -a "$tmp/repo/.sandcastle/worktrees/wA" "$mount"
# Break the back-link the way the container does: point it at a path that does
# NOT exist in this environment (a stand-in for the absent host mount path).
absent="$tmp/absent-container/.git"
[ -e "$absent" ] && fail "fixture: the stand-in container path must not exist"
printf '%s\n' "$absent" > "$adminA/gitdir"
[ -e "$(cat "$adminA/gitdir")" ] && fail "fixture: broken back-link must not resolve"
out="$(worktree_realign_backpointer "$adminA" "$mount")"
[ -n "$out" ] || fail "a broken back-link must be realigned"
[ "$(cat "$adminA/gitdir")" = "$mount/.git" ] || fail "realign must point at <mount>/.git, got: $(cat "$adminA/gitdir")"
pass=$((pass+1))

# 3. Realigning A touched ONLY A's entry — B is byte-identical (the whole point:
#    two parallel workers cannot break each other's shared admin state).
[ "$(cat "$adminB/gitdir")" = "$tmp/repo/.sandcastle/worktrees/wB/.git" ] \
  || fail "realigning A must not touch sibling B's back-link"
pass=$((pass+1))

# 4. Idempotent: a second run over the now-correct link is a no-op.
out="$(worktree_realign_backpointer "$adminA" "$mount")"
[ -z "$out" ] || fail "realign must be idempotent (got: $out)"
pass=$((pass+1))

# 5. Never invent a target: if <mount>/.git does not exist, refuse to write.
printf '%s\n' "$absent" > "$adminA/gitdir"
out="$(worktree_realign_backpointer "$adminA" "$tmp/does-not-exist")"
[ -z "$out" ] || fail "realign must not write an unverifiable target"
[ "$(cat "$adminA/gitdir")" = "$absent" ] || fail "the link must be left untouched when the fix is unverifiable"
pass=$((pass+1))

# 6. A non-worktree checkout (main repo / head mode) is never touched.
out="$(worktree_realign_backpointer "$tmp/repo/.git" "$tmp/repo")"
[ -z "$out" ] || fail "a main-repo .git (not a linked worktree) must be left alone"
pass=$((pass+1))

# --- align-worktree.sh: no-op off the sandbox, aligns inside it -------------
# Off the sandbox (OURCLOUD_SANDBOX unset) it must exit 0 without touching git.
( cd "$tmp/repo/.sandcastle/worktrees/wB" && unset OURCLOUD_SANDBOX && bash "$here/../align-worktree.sh" >/dev/null ) \
  || fail "align-worktree must be a clean no-op off the sandbox"
pass=$((pass+1))

# End-to-end through the driver (real git plumbing): break wB's back-link, then
# run the driver from inside wB with OURCLOUD_SANDBOX=1 — it must resolve the git
# dir and toplevel via git and realign the back-link to the checkout it runs in.
printf '%s\n' "$absent" > "$adminB/gitdir"
( cd "$tmp/repo/.sandcastle/worktrees/wB" && OURCLOUD_SANDBOX=1 bash "$here/../align-worktree.sh" >/dev/null ) \
  || fail "align-worktree must succeed inside the sandbox"
[ "$(cat "$adminB/gitdir")" = "$tmp/repo/.sandcastle/worktrees/wB/.git" ] \
  || fail "align-worktree must realign a broken back-link to the running checkout, got: $(cat "$adminB/gitdir")"
pass=$((pass+1))

# --- git-fence: the command backstop ---------------------------------------
# A stub 'real git' that records it was reached, so we can assert pass-through.
stub="$tmp/realgit"; touched="$tmp/realgit-ran"
cat > "$stub" <<EOF
#!/usr/bin/env bash
echo "REALGIT \$*" > "$touched"
exit 0
EOF
chmod +x "$stub"
run_fence() { GIT_FENCE_REAL="$stub" bash "$fence" "$@"; }

# Fenced: the two named incidents must be refused, real git never reached.
for op in repair prune; do
  rm -f "$touched"; rc=0
  run_fence worktree "$op" >/dev/null 2>&1 || rc=$?
  [ "$rc" -ne 0 ] || fail "git worktree $op must be refused in the sandbox"
  [ ! -f "$touched" ] || fail "git worktree $op must never reach real git"
  pass=$((pass+1))
done

# Fenced through git's global options (the value of -C must not be mistaken for
# the subcommand).
rm -f "$touched"; rc=0
run_fence -C "$tmp/repo" worktree repair >/dev/null 2>&1 || rc=$?
[ "$rc" -ne 0 ] || fail "git -C <path> worktree repair must still be fenced"
[ ! -f "$touched" ] || fail "fenced command must not reach real git even behind -C"
pass=$((pass+1))

# The other mutating operations are fenced too (any shared-admin mutation).
for op in add remove move lock unlock; do
  rm -f "$touched"; rc=0
  run_fence worktree "$op" x >/dev/null 2>&1 || rc=$?
  [ "$rc" -ne 0 ] || fail "git worktree $op must be fenced (shared admin mutation)"
  pass=$((pass+1))
done

# Pass-through: read-only and non-worktree git commands reach real git untouched.
for args in "worktree list" "status" "worktree" "rev-parse --git-dir"; do
  rm -f "$touched"; rc=0
  # shellcheck disable=SC2086
  run_fence $args >/dev/null 2>&1 || rc=$?
  [ "$rc" -eq 0 ] || fail "git $args must pass through the fence (rc=$rc)"
  [ -f "$touched" ] || fail "git $args must reach real git"
  pass=$((pass+1))
done

# --- run-1649 regression ---------------------------------------------------
# Worker A tries the exact move that killed run 1649 — `git worktree repair` on
# the shared admin — while sibling B is mid-setup. With the fence installed as
# `git`, A's attempt is refused, B's admin is untouched, and B stays checkoutable.
b_before="$(cat "$adminB/gitdir")"
bin="$tmp/bin"; mkdir -p "$bin"
ln -sf "$fence" "$bin/git"                       # the shim IS `git` on PATH
realgit="$(command -v git)"
rc=0
( cd "$tmp/repo/.sandcastle/worktrees/wA" \
    && PATH="$bin:$PATH" GIT_FENCE_REAL="$realgit" git worktree repair ) >/dev/null 2>&1 || rc=$?
[ "$rc" -ne 0 ] || fail "run-1649: an in-sandbox 'git worktree repair' must be refused"
[ "$(cat "$adminB/gitdir")" = "$b_before" ] || fail "run-1649: sibling B's admin must be untouched"
git -C "$tmp/repo" worktree list >/dev/null 2>&1 || fail "run-1649: the shared worktree admin must remain valid"
git -C "$tmp/repo/.sandcastle/worktrees/wB" status >/dev/null 2>&1 || fail "run-1649: sibling B must remain a working tree"
pass=$((pass+1))

echo "worktree-lib: $pass checks passed"
