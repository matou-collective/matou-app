#!/usr/bin/env bash
# Offline test for check-harness-drift.sh's pull-based model (ADR 0180 /
# #571): no real network — FACTORY_REPO points at a local bare git repo, so
# the real git fetch/clone/checkout code paths run for real, just against a
# throwaway local remote instead of git.matou.nz.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/../check-harness-drift.sh"
fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

# A throwaway "factory" repo with two files at commit A, then a commit B.
factory_src="$tmp/factory-src"
mkdir -p "$factory_src"
git init -q "$factory_src"
git -C "$factory_src" config user.email t@t.test
git -C "$factory_src" config user.name t
echo 'echo one' >"$factory_src/one.sh"
echo 'echo two' >"$factory_src/two.sh"
git -C "$factory_src" add -A && git -C "$factory_src" commit -q -m A
rev_a="$(git -C "$factory_src" rev-parse HEAD)"
echo 'echo two v2' >"$factory_src/two.sh"
git -C "$factory_src" add -A && git -C "$factory_src" commit -q -m B
# Plumbing update-ref (not the porcelain `branch -f`), so this works
# regardless of whether "main" happens to already be the checked-out branch.
git -C "$factory_src" update-ref refs/heads/main HEAD
export FACTORY_REPO="$factory_src"

# A throwaway .sandcastle-shaped consumer dir, vendored at rev_a. The script
# under test derives its own directory from BASH_SOURCE (not $PWD), so it is
# copied IN here — this runs the exact same script content, just resolving
# "here" against $sc instead of the real .sandcastle/.
sc="$tmp/sandcastle"; mkdir -p "$sc"
cp "$script" "$sc/check-harness-drift.sh"
cp "$factory_src/one.sh" "$sc/"
printf 'echo two\n' >"$sc/two.sh"   # rev_a's content
printf '%s\n' "$rev_a" >"$sc/FACTORY_REF"
printf 'one.sh\ntwo.sh\n' >"$sc/FACTORY_MANIFEST"

# run <out-file> <err-file> — never trips `set -e`: the caller reads $rc.
run() { rc=0; (cd "$sc" && bash ./check-harness-drift.sh) >"$1" 2>"$2" || rc=$?; }

# T1: no FACTORY_REF -> green, "nothing to enforce"
rm "$sc/FACTORY_REF"
run "$tmp/out" "$tmp/err"
[ "$rc" -eq 0 ] || fail "no FACTORY_REF should exit 0: $(cat "$tmp/err")"
grep -q "nothing to enforce" "$tmp/out" || fail "no FACTORY_REF should say nothing to enforce"
pass=$((pass+1))

# T2: in sync -> green
printf '%s\n' "$rev_a" >"$sc/FACTORY_REF"
run "$tmp/out" "$tmp/err"
[ "$rc" -eq 0 ] || fail "in-sync copies should exit 0: $(cat "$tmp/err")"
grep -q "^check-harness-drift: OK" "$tmp/out" || fail "in-sync copies should print OK: $(cat "$tmp/out")"
pass=$((pass+1))

# T3: a vendored file hand-edited locally -> red, names the file
echo 'echo tampered' >>"$sc/two.sh"
run "$tmp/out" "$tmp/err"
[ "$rc" -eq 1 ] || fail "hand-edited local copy should exit 1"
grep -q "DRIFT: .sandcastle/two.sh was edited directly here" "$tmp/err" || fail "should name the drifted file: $(cat "$tmp/err")"
printf 'echo two\n' >"$sc/two.sh"  # restore
pass=$((pass+1))

# T4: a manifest file missing locally -> red, says re-vendor
rm "$sc/two.sh"
run "$tmp/out" "$tmp/err"
[ "$rc" -eq 1 ] || fail "a missing vendored file should exit 1"
grep -q "DRIFT: two.sh is missing here" "$tmp/err" || fail "should say the file is missing: $(cat "$tmp/err")"
printf 'echo two\n' >"$sc/two.sh"  # restore (rev_a's content)
pass=$((pass+1))

# T5: pinned at rev_a, vendored copy matches rev_a exactly even though the
# factory has since moved to rev_b — this must be green (a stale pin is not
# drift; ADR 0180: "drift becomes behind a tagged release", advisory only).
run "$tmp/out" "$tmp/err"
[ "$rc" -eq 0 ] || fail "a stale-but-matching pin should exit 0: $(cat "$tmp/err")"
grep -q "NOTE — FACTORY_REF is 1 commit(s) behind" "$tmp/out" || fail "should note the pin is 1 commit behind main (advisory): $(cat "$tmp/out")"
pass=$((pass+1))

echo "check-harness-drift: $pass passed"
