#!/usr/bin/env bash
# Offline test for the prepare-commit-msg attribution hook (#223, follow-up to
# #200).
#
# Drives REAL `git commit`s so git actually invokes the hook, and asserts the
# `Factory-Account: <fp>` trailer is stamped from CLAUDE_ACCOUNT_FP — mechanical
# attribution that survives into `git log`, keyed by the same fingerprint #200
# keys the limit markers and spend.account_fp by. No network, no docker.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
fac="$(cd "$here/.." && pwd)"     # dev-factory root: source of the hook

pass=0 fail=0
ok()  { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); echo "FAIL: $*" >&2; }

tmp="$(mktemp -d "${TMPDIR:-/tmp}/prepare-commit-msg.XXXXXX")"; trap 'rm -rf "$tmp"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export GIT_CONFIG_NOSYSTEM=1 HOME="$tmp"

git init -q "$tmp/work"; cd "$tmp/work" || exit 1
mkdir -p .sandcastle/git-hooks
cp "$fac/git-hooks/prepare-commit-msg" .sandcastle/git-hooks/prepare-commit-msg
chmod +x .sandcastle/git-hooks/prepare-commit-msg
git config core.hooksPath .sandcastle/git-hooks

FP="a1b2c3d4e5f6"   # a well-formed sha256[:12] fingerprint

# body_of <ref> — the trailer block of a commit message (git's own parse).
trailer_count() { git log -1 --pretty=%B "$1" 2>/dev/null | grep -c '^Factory-Account:'; }
trailer_val()   { git log -1 --pretty=%B "$1" 2>/dev/null | sed -n 's/^Factory-Account: //p' | head -n1; }

commit_as() { # commit_as <fp-env> <message>; sets global rc
  local fpenv="$1" msg="$2"
  echo "$RANDOM$RANDOM" >> f.txt; git add -A
  rc=0
  CLAUDE_ACCOUNT_FP="$fpenv" git commit -qm "$msg" || rc=$?
}

# 1) fp set → the trailer is stamped, exactly once, with the fingerprint value.
commit_as "$FP" "sandcastle: #223 — a worker commit"
[ "$rc" -eq 0 ] || bad "1: commit must succeed"; [ "$rc" -eq 0 ] && ok
[ "$(trailer_count HEAD)" = 1 ] || bad "1: exactly one Factory-Account trailer (got $(trailer_count HEAD))"; [ "$(trailer_count HEAD)" = 1 ] && ok
[ "$(trailer_val HEAD)" = "$FP" ] || bad "1: trailer carries the fingerprint (got '$(trailer_val HEAD)')"; [ "$(trailer_val HEAD)" = "$FP" ] && ok

# 1b) the subject is untouched (the commit-msg claim gate keys off it).
[ "$(git log -1 --pretty=%s HEAD)" = "sandcastle: #223 — a worker commit" ] \
  || bad "1b: subject line must be preserved"; [ "$(git log -1 --pretty=%s HEAD)" = "sandcastle: #223 — a worker commit" ] && ok

# 2) fp UNSET → no trailer, message byte-identical to the pre-#223 behaviour.
commit_as "" "sandcastle: #223 — a token-less commit"
[ "$(trailer_count HEAD)" = 0 ] || bad "2: no trailer when CLAUDE_ACCOUNT_FP is empty"; [ "$(trailer_count HEAD)" = 0 ] && ok

# 3) a malformed fingerprint (not bare hex) is rejected, never injected.
commit_as "not a fp; rm -rf" "sandcastle: #223 — a junk fp"
[ "$(trailer_count HEAD)" = 0 ] || bad "3: a malformed fp must not be stamped"; [ "$(trailer_count HEAD)" = 0 ] && ok

# 4) idempotent on amend: re-running the hook with the SAME fp does not duplicate.
commit_as "$FP" "sandcastle: #223 — amend me"
CLAUDE_ACCOUNT_FP="$FP" git commit --amend -q --no-edit
[ "$(trailer_count HEAD)" = 1 ] || bad "4: amend with same fp must not duplicate (got $(trailer_count HEAD))"; [ "$(trailer_count HEAD)" = 1 ] && ok

# 5) coexists with the harness-injected Co-Authored-By trailer: both survive, in
#    the trailer block, neither clobbering the other.
echo "$RANDOM" >> f.txt; git add -A
CLAUDE_ACCOUNT_FP="$FP" git commit -q -m "$(printf 'sandcastle: #223 — with co-author\n\nbody.\n\nCo-Authored-By: Claude <noreply@anthropic.com>')"
git log -1 --pretty=%B HEAD | grep -q '^Co-Authored-By: Claude' || bad "5: Co-Authored-By must survive"; git log -1 --pretty=%B HEAD | grep -q '^Co-Authored-By: Claude' && ok
[ "$(trailer_count HEAD)" = 1 ] || bad "5: Factory-Account still stamped alongside Co-Authored-By"; [ "$(trailer_count HEAD)" = 1 ] && ok

# 6) a mid-run failover (amend with a DIFFERENT fp) records BOTH accounts.
commit_as "$FP" "sandcastle: #223 — failover case"
CLAUDE_ACCOUNT_FP="f6e5d4c3b2a1" git commit --amend -q --no-edit
[ "$(trailer_count HEAD)" = 2 ] || bad "6: a different fp on amend records both (got $(trailer_count HEAD))"; [ "$(trailer_count HEAD)" = 2 ] && ok

echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
