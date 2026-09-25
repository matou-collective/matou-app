#!/usr/bin/env bash
# Offline test for the commit-msg claim gate (idss #1717).
#
# Drives REAL `git commit`s so git actually invokes the hook, against the fake
# Forgejo (fakebin/curl) — no network. The gate refuses a swarm worker's commit
# for a ticket its run never claimed (run 29782's #1713 duplicate-work + orphan
# that poisoned local main), at the FIRST revertible moment: the commit.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
fac="$(cd "$here/.." && pwd)"     # dev-factory root: source of the hook + claim-lib

pass=0 fail=0
ok()   { pass=$((pass + 1)); }
bad()  { fail=$((fail + 1)); echo "FAIL: $*" >&2; [ -f "${OUT:-}" ] && { echo "--- commit output ---"; cat "$OUT"; }; }

tmp="$(mktemp -d "${TMPDIR:-/tmp}/commit-msg-gate.XXXXXX")"; trap 'rm -rf "$tmp"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export GIT_CONFIG_NOSYSTEM=1 HOME="$tmp"
export PATH="$fac/tests/fakebin:$PATH"
export FORGEJO_TOKEN=ftok
export FORGEJO_API="http://fj.test/api/v1/repos/Matou/idss"

# Fake Forgejo state dir the fakebin/curl routes to.
FAKE_DIR="$tmp/fake"; mkdir -p "$FAKE_DIR"; export FAKE_DIR
# #700 carries a live-shaped swarm-claim for run 900 (and one for another run).
jq -n '[{"id":5001,"body":"swarm-claim host=hostA run=900\n(automated)"},
        {"id":5002,"body":"swarm-claim host=hostB run=902\n(automated)"}]' >"$FAKE_DIR/comments-700.json"

git init -q "$tmp/work"; cd "$tmp/work"
mkdir -p .sandcastle/git-hooks
cp "$fac/git-hooks/commit-msg" .sandcastle/git-hooks/commit-msg
cp "$fac/claim-lib.sh"         .sandcastle/claim-lib.sh
chmod +x .sandcastle/git-hooks/commit-msg
# Minimal identity layer — the hook sources it only if FORGEJO_API is unset; we
# export FORGEJO_API above, so this is belt-and-braces (and proves the file need
# not exist to break the hook).
git config core.hooksPath .sandcastle/git-hooks

echo seed > f.txt; git add -A
SWARM_RUN_ID= git commit -qm "seed (no run)" || { echo "seed commit failed" >&2; exit 1; }

OUT="$tmp/out"
# try_commit <run> <message> -> sets global rc; commit output in $OUT
try_commit() {
  local run="$1" msg="$2"
  echo "$RANDOM$RANDOM" >> f.txt; git add -A
  rc=0
  SWARM_RUN_ID="$run" git commit -qm "$msg" >"$OUT" 2>&1 || rc=$?
  # Leave the tree clean for the next case whether or not the commit landed.
  git reset -q --hard >/dev/null 2>&1
}

# 1) Inert for a non-swarm context (SWARM_RUN_ID unset) even for an unclaimed
#    ticket — a session-runner / human / host reconcile must never be gated.
try_commit "" "sandcastle: #1713 — a session commit for an unclaimed ticket"
[ "$rc" -eq 0 ] || bad "1: unset SWARM_RUN_ID must be inert"; [ "$rc" -eq 0 ] && ok

# 2) Owned: this run holds a claim on the cited ticket -> commit allowed.
try_commit 900 "sandcastle: #700 — the ticket this run claimed"
[ "$rc" -eq 0 ] || bad "2: a claimed ticket's commit must be allowed"; [ "$rc" -eq 0 ] && ok

# 3) The core bug: this run holds NO claim on the cited ticket -> BLOCKED.
try_commit 901 "sandcastle: #700 — a ticket another run claimed"
[ "$rc" -ne 0 ] || bad "3: an unclaimed ticket's commit must be BLOCKED"; [ "$rc" -ne 0 ] && ok
grep -q "BLOCKED (#1717)" "$OUT" || bad "3: the block must name #1717 loudly"; grep -q "BLOCKED (#1717)" "$OUT" && ok

# 3b) run 29782's exact shape: an issue this run never touched (no claim at all).
try_commit 29782 "sandcastle: #1713 — the run-29782 duplicate-work case"
[ "$rc" -ne 0 ] || bad "3b: an unclaimed #1713 commit must be BLOCKED"; [ "$rc" -ne 0 ] && ok

# 4) Fail OPEN: an unreachable tracker must not wedge the worker. The commit is
#    allowed even for a run with no proven claim, and it says why.
touch "$FAKE_DIR/api-timeout"
try_commit 901 "sandcastle: #700 — tracker is down"
rm -f "$FAKE_DIR/api-timeout"
[ "$rc" -eq 0 ] || bad "4: an unreachable tracker must FAIL OPEN"; [ "$rc" -eq 0 ] && ok
grep -q "fail-open" "$OUT" || bad "4: the fail-open path must say so"; grep -q "fail-open" "$OUT" && ok

# 5) A subject citing no ticket (housekeeping) is not gated.
try_commit 901 "chore: tidy the worktree"
[ "$rc" -eq 0 ] || bad "5: a commit citing no ticket must be allowed"; [ "$rc" -eq 0 ] && ok

# 6) run 0 is never a real swarm claim (#468) -> inert (allowed).
try_commit 0 "sandcastle: #700 — run-0 is not a swarm worker"
[ "$rc" -eq 0 ] || bad "6: run 0 must be inert"; [ "$rc" -eq 0 ] && ok

echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
