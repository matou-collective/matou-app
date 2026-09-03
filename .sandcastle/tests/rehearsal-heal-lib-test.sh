#!/usr/bin/env bash
# Offline unit test for the healer's rails: diff cap, self-mod guard, single-
# commit rule, the three #1144 refusal rules (weaken-a-check / line cap /
# product-behaviour surface), close-keyword scrub, mechanical-failure counter,
# and the loop-guard marks. Real throwaway git repos, no shims.
# Run: bash .sandcastle/tests/rehearsal-heal-lib-test.sh
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

# 2: >3 files → breach + reset, reason names the file cap
co="$tmp/co2"; pre="$(mkco "$co")"
( cd "$co" && for i in 1 2 3 4; do echo $i > "f$i.txt"; done && git add -A && git commit -qm "rehearsal healer: wide" )
heal_rails "$co" "$pre" && fail "4-file commit passed"
[ "$(git -C "$co" rev-parse HEAD)" = "$pre" ] || fail "no reset after file-cap breach"
[ "$HEAL_RAIL_REASON" = "3-file cap" ] || fail "file-cap reason wrong: $HEAL_RAIL_REASON"
[ "$HEAL_RAIL_SWARMABLE" = "true" ] || fail "file-cap should be swarmable"
pass=$((pass+1))

# 3: >400 changed non-test lines → breach + reset (#1144 cap raised 200→400)
co="$tmp/co3"; pre="$(mkco "$co")"
( cd "$co" && seq 1 410 > big.txt && git add -A && git commit -qm "rehearsal healer: long" )
heal_rails "$co" "$pre" && fail "410-line commit passed"
[ "$(git -C "$co" rev-parse HEAD)" = "$pre" ] || fail "no reset after line-cap breach"
case "$HEAL_RAIL_REASON" in *"line cap"*) ;; *) fail "line-cap reason wrong: $HEAL_RAIL_REASON" ;; esac
[ "$HEAL_RAIL_SWARMABLE" = "true" ] || fail "line-cap should be swarmable"
pass=$((pass+1))

# 3b: 150 lines (over the old 60/200 caps, under 400) passes
co="$tmp/co3b"; pre="$(mkco "$co")"
( cd "$co" && seq 1 150 > fix.go && git add -A && git commit -qm "rehearsal healer: real fix" )
heal_rails "$co" "$pre" || fail "150-line commit rejected"
pass=$((pass+1))

# 3f: exactly 400 non-test lines passes, 401 breaches (the boundary)
co="$tmp/co3f"; pre="$(mkco "$co")"
( cd "$co" && seq 1 400 > f.go && git add -A && git commit -qm "rehearsal healer: at the cap" )
heal_rails "$co" "$pre" || fail "400-line commit rejected (off-by-one?)"
co="$tmp/co3g"; pre="$(mkco "$co")"
( cd "$co" && seq 1 401 > f.go && git add -A && git commit -qm "rehearsal healer: one over" )
heal_rails "$co" "$pre" && fail "401-line commit passed (off-by-one?)"
pass=$((pass+1))

# 3c: test files don't count toward the line cap: 20 fix lines + 300 lines of
#     _test.go / .test.ts / .spec.ts pass; 410 lines in a non-test file breach
co="$tmp/co3c"; pre="$(mkco "$co")"
( cd "$co" && seq 1 20 > fix.go && seq 1 150 > fix_test.go && seq 1 150 > fix.test.ts \
  && git add -A && git commit -qm "rehearsal healer: fix with tests" )
heal_rails "$co" "$pre" || fail "fix+tests (20 non-test lines) rejected"
co="$tmp/co3d"; pre="$(mkco "$co")"
( cd "$co" && seq 1 20 > fix.go && seq 1 410 > fix2.go && seq 1 150 > fix.spec.ts \
  && git add -A && git commit -qm "rehearsal healer: fix without tests" )
heal_rails "$co" "$pre" && fail "430 non-test lines + spec passed (spec exclusion miscounted?)"
co="$tmp/co3e"; pre="$(mkco "$co")"
( cd "$co" && seq 1 410 > helper.go && seq 1 5 > a.spec.ts \
  && git add -A && git commit -qm "rehearsal healer: big non-test" )
heal_rails "$co" "$pre" && fail "410 non-test lines passed"
[ "$(git -C "$co" rev-parse HEAD)" = "$pre" ] || fail "no reset after non-test line-cap breach"
pass=$((pass+1))

# --- #1144 refusal rule 1: never weaken what a check proves ------------------
mkfixture() { # mkfixture <dir> <path> <baseline-content> — echoes pre_head
  git init -q "$1"; ( cd "$1"; git config user.email t@t; git config user.name t
    mkdir -p "$(dirname "$2")"; printf '%s\n' "$3" > "$2"; git add -A; git commit -qm base )
  git -C "$1" rev-parse HEAD
}

# R1a: rewriting an expect(...) line refuses with the assertion reason, no commit kept
co="$tmp/coR1a"; pre="$(mkfixture "$co" "foo.test.ts" "expect(total).toBe(3)")"
( cd "$co" && printf 'expect(total).toBe(999)\n' > foo.test.ts && git commit -aqm "rehearsal healer: relax expect (sigR1)" )
heal_rails "$co" "$pre" && fail "assertion-weakening passed"
[ "$HEAL_RAIL_REASON" = "assertion rule" ] || fail "reason not assertion rule: $HEAL_RAIL_REASON"
[ "$HEAL_RAIL_SWARMABLE" = "false" ] || fail "assertion refusal should not be swarmable"
[ "$(git -C "$co" rev-parse HEAD)" = "$pre" ] || fail "no reset after assertion breach"
pass=$((pass+1))

# R1b: deleting a Go test declaration refuses
co="$tmp/coR1b"; pre="$(mkfixture "$co" "x_test.go" "func TestThing(t *testing.T) { t.Fatal(\"x\") }")"
( cd "$co" && printf '// gone\n' > x_test.go && git commit -aqm "rehearsal healer: drop test (sigR1b)" )
heal_rails "$co" "$pre" && fail "deleting a test passed"
[ "$HEAL_RAIL_REASON" = "assertion rule" ] || fail "reason not assertion rule (deleted test): $HEAL_RAIL_REASON"
pass=$((pass+1))

# R1c: adding a .skip marker refuses
co="$tmp/coR1c"; pre="$(mkfixture "$co" "y.test.ts" "it('runs', () => {})")"
( cd "$co" && printf "it.skip('runs', () => {})\n" > y.test.ts && git commit -aqm "rehearsal healer: skip it (sigR1c)" )
heal_rails "$co" "$pre" && fail "adding a skip passed"
[ "$HEAL_RAIL_REASON" = "assertion rule" ] || fail "reason not assertion rule (skip): $HEAL_RAIL_REASON"
pass=$((pass+1))

# R1d: a selector-drift heal (edits a locator/action line, NOT an expect line)
#      PASSES — the healer's bread-and-butter mechanical fix stays in-lane
co="$tmp/coR1d"; pre="$(mkfixture "$co" "journey.spec.ts" "await page.getByRole('button', { name: 'Old' }).click()")"
( cd "$co" && printf "await page.getByRole('button', { name: 'New' }).click()\n" > journey.spec.ts \
  && git commit -aqm "rehearsal healer: selector drift (sigR1d)" )
heal_rails "$co" "$pre" || fail "selector-drift heal was refused (rule too broad)"
[ "$(git -C "$co" rev-parse HEAD)" != "$pre" ] || fail "selector-drift heal reset"
pass=$((pass+1))

# --- #1144 refusal rule 3: never change a product-behaviour surface ----------

# Run the product-surface checks from a cwd that HAS real internal/ and app/src
# dirs: an unquoted `for g in $surfaces` pathname-expands, so `internal/*` would
# iterate real files instead of the literal pattern and `case` would never match
# — the idss regression where the rule silently no-opped. heal_rails uses
# absolute paths, so cwd only steers the glob; the noglob guard must hold here.
mkdir -p "$tmp/decoy/internal" "$tmp/decoy/app/src"
echo x > "$tmp/decoy/internal/plant.go"; echo y > "$tmp/decoy/app/src/plant.ts"
cd "$tmp/decoy"
# R3a: with surface globs declared, a changed internal/ file refuses
co="$tmp/coR3a"; pre="$(mkco "$co")"
( cd "$co" && mkdir -p internal && echo 'behaviour' > internal/foo.go && git add -A && git commit -qm "rehearsal healer: surface" )
export HEAL_PRODUCT_SURFACE_GLOBS='internal/* app/src/*'
heal_rails "$co" "$pre" && fail "product-surface change passed"
[ "$HEAL_RAIL_REASON" = "product-behaviour surface" ] || fail "reason not product surface: $HEAL_RAIL_REASON"
[ "$HEAL_RAIL_SWARMABLE" = "false" ] || fail "product-surface refusal should not be swarmable"
[ "$(git -C "$co" rev-parse HEAD)" = "$pre" ] || fail "no reset after product-surface breach"
pass=$((pass+1))

# R3b: a test file under a surface dir is fair game (passes)
co="$tmp/coR3b"; pre="$(mkco "$co")"
( cd "$co" && mkdir -p internal && echo 'code' > internal/foo_test.go && git add -A && git commit -qm "rehearsal healer: internal test" )
heal_rails "$co" "$pre" || fail "internal test file refused as a surface"
unset HEAL_PRODUCT_SURFACE_GLOBS
pass=$((pass+1))

# R3c: a non-surface path (scripts/) passes even with globs declared
co="$tmp/coR3c"; pre="$(mkco "$co")"
( cd "$co" && mkdir -p scripts && echo 'plumbing' > scripts/x.sh && git add -A && git commit -qm "rehearsal healer: script" )
export HEAL_PRODUCT_SURFACE_GLOBS='internal/* app/src/*'
heal_rails "$co" "$pre" || fail "scripts/ change refused as a surface"
unset HEAL_PRODUCT_SURFACE_GLOBS
pass=$((pass+1))

# R3d: NO globs declared (factory default) → the rule is a no-op, internal/ passes
co="$tmp/coR3d"; pre="$(mkco "$co")"
( cd "$co" && mkdir -p internal && echo 'behaviour' > internal/foo.go && git add -A && git commit -qm "rehearsal healer: surface no globs" )
heal_rails "$co" "$pre" || fail "internal/ refused with no surface globs declared (rule not a no-op)"
pass=$((pass+1))

cd "$tmp"
# 4: touching .sandcastle/rehearsal-* → breach + reset (self-mod guard)
co="$tmp/co4"; pre="$(mkco "$co")"
( cd "$co" && echo hacked >> .sandcastle/rehearsal-report.sh && git commit -aqm "rehearsal healer: sly" )
heal_rails "$co" "$pre" && fail "self-mod passed"
[ "$(git -C "$co" rev-parse HEAD)" = "$pre" ] || fail "no reset after self-mod"
[ "$HEAL_RAIL_REASON" = "self-modification" ] || fail "self-mod reason wrong: $HEAL_RAIL_REASON"
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
[ "$HEAL_RAIL_REASON" = "no commit" ] || fail "no-commit reason wrong: $HEAL_RAIL_REASON"
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

# 9b: loop-guard mark (#1144 rail-6): 0 → mark → 1 → clear → 0, and it is a
#     DISTINCT namespace from the mechanical counter (marking one never moves
#     the other)
[ "$(heal_healed_count sigL)" = "0" ] || fail "fresh healed-count not 0"
heal_healed_mark sigL; [ "$(heal_healed_count sigL)" = "1" ] || fail "healed-count not 1"
[ "$(heal_fail_count sigL)" = "0" ] || fail "healed mark leaked into the mechanical counter"
heal_fail_mark sigL; [ "$(heal_healed_count sigL)" = "1" ] || fail "mechanical mark moved the healed counter"
heal_healed_clear sigL; [ "$(heal_healed_count sigL)" = "0" ] || fail "healed clear failed"
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
