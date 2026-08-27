#!/usr/bin/env bash
# Offline unit test for the healer's rails: diff cap, self-mod guard, single-
# commit rule, close-keyword scrub, mechanical-failure counter. Real throwaway
# git repos, no shims. Run: bash .sandcastle/tests/rehearsal-heal-lib-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/../rehearsal-heal-lib.sh"
fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
export REHEARSAL_STATE="$tmp/state"; mkdir -p "$REHEARSAL_STATE"

mkco() { # mkco <dir> — a checkout with one baseline commit; echoes pre_head
  git init -q "$1"; cd "$1"
  git config user.email t@t; git config user.name t
  echo base > base.txt; mkdir -p .sandcastle .forgejo/workflows
  echo x > .sandcastle/rehearsal-report.sh; echo y > .forgejo/workflows/ci.yml
  git add -A; git commit -qm base; git rev-parse HEAD; cd - >/dev/null
}

# 1: small clean commit passes the rails
co="$tmp/co1"; pre="$(mkco "$co")"
( cd "$co" && sed -i s/base/fixed/ base.txt && git commit -aqm "rehearsal healer: tiny fix (sig1)" )
heal_rails "$co" "$pre" || fail "small commit rejected"
[ "$(git -C "$co" rev-parse HEAD)" != "$pre" ] || fail "commit lost"
pass=$((pass+1))

# 2: >3 files → breach + reset
co="$tmp/co2"; pre="$(mkco "$co")"
( cd "$co" && for i in 1 2 3 4; do echo $i > "f$i.txt"; done && git add -A && git commit -qm "rehearsal healer: wide" )
heal_rails "$co" "$pre" && fail "4-file commit passed"
[ "$(git -C "$co" rev-parse HEAD)" = "$pre" ] || fail "no reset after file-cap breach"
pass=$((pass+1))

# 3: >60 changed lines → breach + reset
co="$tmp/co3"; pre="$(mkco "$co")"
( cd "$co" && seq 1 70 > big.txt && git add -A && git commit -qm "rehearsal healer: long" )
heal_rails "$co" "$pre" && fail "70-line commit passed"
[ "$(git -C "$co" rev-parse HEAD)" = "$pre" ] || fail "no reset after line-cap breach"
pass=$((pass+1))

# 4: touching .sandcastle/rehearsal-* → breach + reset (self-mod guard)
co="$tmp/co4"; pre="$(mkco "$co")"
( cd "$co" && echo hacked >> .sandcastle/rehearsal-report.sh && git commit -aqm "rehearsal healer: sly" )
heal_rails "$co" "$pre" && fail "self-mod passed"
[ "$(git -C "$co" rev-parse HEAD)" = "$pre" ] || fail "no reset after self-mod"
pass=$((pass+1))

# 5: touching .forgejo/workflows/ → breach + reset
co="$tmp/co5"; pre="$(mkco "$co")"
( cd "$co" && echo hacked >> .forgejo/workflows/ci.yml && git commit -aqm "rehearsal healer: wf" )
heal_rails "$co" "$pre" && fail "workflow edit passed"
pass=$((pass+1))

# 6: two commits → breach + reset
co="$tmp/co6"; pre="$(mkco "$co")"
( cd "$co" && echo a >> base.txt && git commit -aqm "rehearsal healer: one" \
  && echo b >> base.txt && git commit -aqm "rehearsal healer: two" )
heal_rails "$co" "$pre" && fail "two commits passed"
[ "$(git -C "$co" rev-parse HEAD)" = "$pre" ] || fail "no reset after multi-commit"
pass=$((pass+1))

# 7: HEAD == pre_head ("healed" with no commit) → breach, nothing to reset
co="$tmp/co7"; pre="$(mkco "$co")"
heal_rails "$co" "$pre" && fail "no-commit healed passed"
pass=$((pass+1))

# 8: scrub rewrites close keywords and enforces the prefix
co="$tmp/co8"; pre="$(mkco "$co")"
( cd "$co" && echo a >> base.txt && git commit -aqm "closes #378 selector fix" )
scrub_commit_message "$co"
msg="$(git -C "$co" log -1 --pretty=%B)"
grep -qi 'closes #378' <<<"$msg" && fail "close keyword survived scrub"
grep -q 'advances #378' <<<"$msg" || fail "keyword not rewritten to advances"
grep -q '^rehearsal healer: ' <<<"$msg" || fail "prefix not enforced"
pass=$((pass+1))

# 9: mechanical-failure counter: 0 → mark → 1 → mark → 2 → clear → 0
[ "$(heal_fail_count sigX)" = "0" ] || fail "fresh count not 0"
heal_fail_mark sigX; [ "$(heal_fail_count sigX)" = "1" ] || fail "count not 1"
heal_fail_mark sigX; [ "$(heal_fail_count sigX)" = "2" ] || fail "count not 2"
heal_fail_clear sigX; [ "$(heal_fail_count sigX)" = "0" ] || fail "clear failed"
pass=$((pass+1))

# --- heal_push (#460): a heal survives a concurrent advance of origin/main ---
mkorigin() { # mkorigin <bare> <work> — bare origin (default branch main) + work clone with a baseline; echoes work HEAD
  git init -q --bare "$1"
  git -C "$1" symbolic-ref HEAD refs/heads/main   # so every clone checks out main, not master
  git clone -q "$1" "$2" 2>/dev/null
  ( cd "$2"; git config user.email t@t; git config user.name t
    echo base > base.txt; git add -A; git commit -qm base; git push -q origin main )
  git -C "$2" rev-parse HEAD
}
advance() { # advance <bare> <edit-cmd> — a second clone lands a commit on origin/main
  git clone -q "$1" "$2" 2>/dev/null
  ( cd "$2"; git config user.email t@t; git config user.name t; eval "$3"
    git commit -aqm "operator: concurrent" >/dev/null 2>&1 || { git add -A && git commit -qm "operator: concurrent"; }
    git push -q origin main )
}

# 10: origin/main advanced (unrelated file) → heal_push rebases and lands
bare="$tmp/o10"; co="$tmp/co10"; pre="$(mkorigin "$bare" "$co")"
advance "$bare" "$tmp/adv10" 'echo advance > advance.txt; git add -A'
( cd "$co" && sed -i s/base/fixed/ base.txt && git commit -aqm "rehearsal healer: tiny (sig10)" )
rd="$tmp/rd10"; mkdir -p "$rd/logs"
heal_push "$co" "$pre" "$rd" || fail "heal_push did not land after origin advanced"
healed="$(git -C "$co" rev-parse HEAD)"
git -C "$co" ls-remote origin main | grep -q "^$healed" || fail "healed commit not on origin/main"
git -C "$co" fetch -q origin main
git -C "$co" cat-file -e origin/main:advance.txt 2>/dev/null || fail "concurrent advance lost"
git -C "$co" show origin/main:base.txt | grep -q fixed || fail "heal not applied on origin"
pass=$((pass+1))

# 11: rebase conflict (origin changed the same line) → reset to pre + fail
bare="$tmp/o11"; co="$tmp/co11"; pre="$(mkorigin "$bare" "$co")"
advance "$bare" "$tmp/adv11" 'sed -i s/base/theirs/ base.txt'
( cd "$co" && sed -i s/base/ours/ base.txt && git commit -aqm "rehearsal healer: conflicting (sig11)" )
rd="$tmp/rd11"; mkdir -p "$rd/logs"
heal_push "$co" "$pre" "$rd" && fail "heal_push landed despite a rebase conflict"
[ "$(git -C "$co" rev-parse HEAD)" = "$pre" ] || fail "no reset to pre after rebase conflict"
pass=$((pass+1))

# --- rehearsal_heal_authed_url (#676) ----------------------------------------

# 12: a bare git.matou.nz https URL gets the swarm:$FORGEJO_TOKEN credential
FORGEJO_TOKEN=tok12
got="$(rehearsal_heal_authed_url "https://git.matou.nz/Matou/idss.git")"
[ "$got" = "https://swarm:tok12@git.matou.nz/Matou/idss.git" ] || fail "credential not injected: $got"
pass=$((pass+1))

# 13: a local bare-repo path (the test fixtures' shape) passes through unchanged
got="$(rehearsal_heal_authed_url "$tmp/origin.git")"
[ "$got" = "$tmp/origin.git" ] || fail "local path was rewritten: $got"
pass=$((pass+1))

# 14: a URL that already carries userinfo passes through unchanged (idempotent)
got="$(rehearsal_heal_authed_url "https://swarm:tok12@git.matou.nz/Matou/idss.git")"
[ "$got" = "https://swarm:tok12@git.matou.nz/Matou/idss.git" ] || fail "already-credentialed URL was rewritten: $got"
pass=$((pass+1))

echo "OK: $pass cases"
