#!/usr/bin/env bash
# Offline test for version-code.sh (#321): asserts the version->versionCode
# mapping so it can never silently drift back to the CI run number. No network.
# Run: bash scripts/android/version-code-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
helper="$here/version-code.sh"
fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0

# code <version> — echo the derived versionCode.
code() { bash "$helper" "$1"; }

# --- representative version -> code mappings (the MMMmmmppp formula) ---
[ "$(code 0.4.1)" = 4001 ]       || fail "0.4.1 must map to 4001, got $(code 0.4.1)"
[ "$(code 0.5.0)" = 5000 ]       || fail "0.5.0 must map to 5000, got $(code 0.5.0)"
[ "$(code 0.4.0)" = 4000 ]       || fail "0.4.0 must map to 4000, got $(code 0.4.0)"
[ "$(code 1.2.3)" = 1002003 ]    || fail "1.2.3 must map to 1002003, got $(code 1.2.3)"
[ "$(code 0.0.0)" = 0 ]          || fail "0.0.0 must map to 0, got $(code 0.0.0)"
[ "$(code 0.4.999)" = 4999 ]     || fail "0.4.999 must map to 4999, got $(code 0.4.999)"
pass=$((pass+1))

# --- a leading v (tag ref form) is accepted and maps identically ---
[ "$(code v0.4.1)" = "$(code 0.4.1)" ] || fail "v0.4.1 must map like 0.4.1"
pass=$((pass+1))

# --- tag and non-tag paths agree for the same version (the whole point) ---
[ "$(code v0.5.0)" = "$(code 0.5.0)" ] || fail "tag and dispatch must share a code for the same version"
pass=$((pass+1))

# --- reading the version from package.json ---
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
printf '{\n  "name": "x",\n  "version": "2.3.4",\n}\n' > "$tmp"
[ "$(bash "$helper" "" "$tmp")" = 2003004 ] || fail "package.json read must map 2.3.4 -> 2003004"
pass=$((pass+1))

# --- malformed versions are rejected, not silently coerced ---
for bad in "1.2" "1.2.3.4" "abc" "1.2.x" "v" "12345"; do
  if bash "$helper" "$bad" >/dev/null 2>&1; then
    fail "malformed version '$bad' must be rejected"
  fi
done
pass=$((pass+1))

echo "OK: $pass version-code checks passed"
