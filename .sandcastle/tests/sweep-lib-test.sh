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

# This suite drives REAL `git worktree add`/`remove` to build and sweep its
# fixture — exactly the operations .sandcastle/git-fence refuses inside the
# Sandcastle sandbox (#239), where every worker shares one .git/worktrees/
# admin. It is a normal green suite off-sandbox (workstation/CI), where the
# fence is absent. Skip explicitly here rather than red on the fence (#587).
# Off-sandbox `git` is the real binary, so the marker never matches and the
# suite runs in full.
# --- #98: prune_session_logs — proven FIRST, before the git-fence skip below,
#     because it uses NO git worktree op and must run in-sandbox too. Raw session
#     jsonl older than the retention window is removed (already ingested into
#     swarm.db); fresher jsonl and any non-jsonl are left alone; a missing dir is
#     a safe no-op.
plogs="$(mktemp -d)"
printf '{}\n' > "$plogs/old.jsonl"
printf '{}\n' > "$plogs/fresh.jsonl"
printf 'run log text\n' > "$plogs/run.log"          # non-jsonl: never pruned here
touch -d '30 days ago' "$plogs/old.jsonl"
touch -d '30 days ago' "$plogs/run.log"             # aged, but not a .jsonl
prune_session_logs "$plogs"                          # default 14-day window
[ -e "$plogs/old.jsonl" ] && fail "a jsonl older than the retention window must be pruned"
[ -e "$plogs/fresh.jsonl" ] || fail "a fresh jsonl (within the window) must be kept"
[ -e "$plogs/run.log" ] || fail "a non-jsonl file must never be pruned by prune_session_logs"
pass=$((pass+1))

# the window is a plain number: an explicit max-age overrides the default.
touch -d '2 days ago' "$plogs/fresh.jsonl"
prune_session_logs "$plogs" 86400                    # 1-day window: 2-day-old now falls
[ -e "$plogs/fresh.jsonl" ] && fail "an explicit shorter window must prune the now-too-old jsonl"
pass=$((pass+1))

# a missing dir / empty arg: safe no-ops, never an error.
prune_session_logs "$plogs/does-not-exist" || fail "a missing logs dir must be a no-op, not an error"
prune_session_logs "" || fail "an empty dir arg must be a no-op, not an error"
pass=$((pass+1))
rm -rf "$plogs"

if grep -qs git-fence "$(command -v git 2>/dev/null)"; then
  echo "sweep-lib: SKIP (worktree suite) — git worktree add is fenced in-sandbox (#239); prune_session_logs proven above, run the rest off-sandbox"
  exit 0
fi

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

# --- a FRESH worktree standing in for a concurrent, still-live slot-2 swarm on
#     this same repo (#577/ADR 0184): its mtime is NOW, so the age floor must
#     SPARE it — removing it would unlink a running worker's checkout mid-flight
#     (the exit-128 `git checkout --detach` incident this guards against). ---
git -C "$repo" worktree add -q -b sandcastle/worker/20260822-999999-live \
  "$repo/.sandcastle/worktrees/sandcastle-worker-20260822-999999-live" main

# Age the two DEAD fixtures past the floor so they are still swept; a real dead
# run's worktree is older than the 180-min job timeout. The live one is left at
# its just-created mtime.
touch -d '4 hours ago' \
  "$repo/.sandcastle/worktrees/sandcastle-worker-20260730-000000-merged" \
  "$repo/.sandcastle/worktrees/sandcastle-worker-20260730-111111-unmerged"

# --- a NON-worker branch must be left entirely alone ---
git -C "$repo" branch keep/me

out="$(sweep_worktrees "$repo")"

# Only the fresh live worktree survives; both aged fixtures are gone.
survivors="$(ls -A "$repo/.sandcastle/worktrees" 2>/dev/null)"
[ "$survivors" = "sandcastle-worker-20260822-999999-live" ] \
  || fail "only the fresh live worktree should survive, worktrees/ has: [$survivors]"
pass=$((pass+1))

# The live sibling's branch must NOT be reported as lost work (it is still
# checked out in the spared worktree — branch -d would refuse it).
printf '%s' "$out" | grep -qx "sandcastle/worker/20260822-999999-live" \
  && fail "a still-checked-out live worktree's branch must NOT be surfaced as unmerged"
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

# --- reap_containers: force-remove leaked sandcastle-* containers older than a
#     run-lifetime, leave fresh ones alone (#238 AC4) ---
# A fake `docker` on PATH: `ps` emits canned rows (one stale, one fresh, in
# docker's real CreatedAt format incl. the trailing tz name); `rm -f` records
# the id it was asked to remove. This exercises the age arithmetic and the
# CreatedAt parsing without a real daemon.
bin="$(mktemp -d)"; rmlog="$(mktemp)"; psfile="$(mktemp)"
export FAKE_RM_LOG="$rmlog" FAKE_PS_FILE="$psfile"
cat > "$bin/docker" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  ps)      cat "$FAKE_PS_FILE" ;;
  rm)      shift; [ "$1" = "-f" ] && shift; printf '%s\n' "$@" >> "$FAKE_RM_LOG" ;;
esac
EOF
chmod +x "$bin/docker"

fmt='+%Y-%m-%d %H:%M:%S %z UTC'   # docker CreatedAt shape, trailing tz name
printf '%s\t%s\n' stale_old "$(date -u -d '2 days ago' "$fmt")"  >  "$psfile"
printf '%s\t%s\n' fresh_now "$(date -u "$fmt")"                  >> "$psfile"

reaped="$(PATH="$bin:$PATH" reap_containers 10800)"   # 3h floor

printf '%s' "$reaped" | grep -qx stale_old || fail "the 2-day-old container must be reaped, got: [$reaped]"
printf '%s' "$reaped" | grep -qx fresh_now && fail "a just-created container must NOT be reaped (in-flight run)"
grep -qx stale_old "$rmlog" || fail "reap must call docker rm -f on the stale container"
grep -qx fresh_now "$rmlog" && fail "reap must never rm -f a fresh container"
pass=$((pass+1))

# --- no docker on PATH: a safe no-op, never an error (host without docker) ---
emptybin="$(mktemp -d)"
( PATH="$emptybin" reap_containers ) >/dev/null 2>&1 || fail "missing docker must be a no-op, not an error"
pass=$((pass+1))

rm -rf "$bin" "$emptybin" "$rmlog" "$psfile"
echo "sweep-lib: $pass groups passed"
