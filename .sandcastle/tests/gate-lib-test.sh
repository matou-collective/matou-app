#!/usr/bin/env bash
# Offline tests for gate-lib.sh — the pre-push language gate (#198). No Go
# toolchain required: the Go stage is stubbed via GATE_GO_CMD, exactly the seam
# the manifest names ("a deliberate red-lint test slice caught pre-push").
# Run: bash .sandcastle/tests/gate-lib-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/../gate-lib.sh"

fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0

# --- language detection: paths → gated language tokens --------------------
eq() { # eq <expected> <actual> <msg>
  [ "$1" = "$2" ] || fail "$3 — expected [$1] got [$2]"; pass=$((pass+1))
}
eq "go"    "$(printf 'internal/controlapi/x.go\n'        | gate_langs_for_files)" "a .go file is a Go change"
eq "go"    "$(printf 'go.work\n'                         | gate_langs_for_files)" "go.work is a Go change"
eq "go"    "$(printf '.golangci.yml\n'                   | gate_langs_for_files)" "the linter config is a Go change"
eq "ts"    "$(printf 'dashboard/src/lib/api/x.ts\n'      | gate_langs_for_files)" "a .ts file is a TS change"
eq "ts"    "$(printf 'pnpm-lock.yaml\n'                  | gate_langs_for_files)" "the lockfile is a TS change"
eq $'go\nts' "$(printf 'a.go\nb.ts\n'                    | gate_langs_for_files)" "a mixed change reports both"
eq ""      "$(printf 'README.md\ndocs/adr/0040.md\n'     | gate_langs_for_files)" "docs-only touches no gate"

# --- the gate: a Go change runs the Go stage; red is caught, green passes ---
marker="$(mktemp -u)"

# A deliberate red-lint slice: the Go stage fails → the push is refused.
rc=0
printf 'internal/x.go\n' | GATE_GO_CMD="rm -f '$marker'; false" gate_run "$PWD" 2>/dev/null || rc=$?
[ "$rc" -ne 0 ] || fail "a red Go stage must make the gate fail (the push is refused)"
pass=$((pass+1))

# A clean Go slice: the Go stage passes → the gate passes, and the stage RAN.
rc=0
printf 'internal/x.go\n' | GATE_GO_CMD="touch '$marker'; true" gate_run "$PWD" 2>/dev/null || rc=$?
[ "$rc" -eq 0 ] || fail "a green Go stage must let the gate pass"
[ -f "$marker" ] || fail "the Go stage must actually run on a Go change"
pass=$((pass+1))
rm -f "$marker"

# A TypeScript-only slice: the Go stage is SKIPPED and the push proceeds. The
# stub would create the marker if it ran — it must not.
rc=0
printf 'dashboard/src/x.ts\n' | GATE_GO_CMD="touch '$marker'; true" gate_run "$PWD" 2>/dev/null || rc=$?
[ "$rc" -eq 0 ] || fail "a TS-only change must pass the gate"
[ ! -f "$marker" ] || fail "a TS-only change must NOT run the Go stage (no slower than today)"
pass=$((pass+1))

# A docs-only slice: nothing gated, the push proceeds.
rc=0
printf 'README.md\n' | GATE_GO_CMD="touch '$marker'; true" gate_run "$PWD" 2>/dev/null || rc=$?
[ "$rc" -eq 0 ] || fail "a docs-only change must pass the gate"
[ ! -f "$marker" ] || fail "a docs-only change must run no stage"
pass=$((pass+1))

# --- git's hook env is scrubbed before the Go stage runs -------------------
# The pre-push hook runs inside git's environment; GIT_DIR/GIT_INDEX_FILE must
# NOT reach `go test` (they poison nix's flake read and any test that shells out
# to `git -C <tmp>`). The stage must see them unset.
rc=0
printf 'internal/x.go\n' | \
  GIT_DIR=/somewhere/.git GIT_INDEX_FILE=/somewhere/.git/index \
  GATE_GO_CMD='[ -z "${GIT_DIR:-}${GIT_INDEX_FILE:-}" ] || { echo "git env leaked" >&2; exit 7; }' \
  gate_run "$PWD" 2>/dev/null || rc=$?
[ "$rc" -eq 0 ] || fail "the Go stage must run with git's hook env (GIT_DIR/GIT_INDEX_FILE) scrubbed"
pass=$((pass+1))

# --- fail-closed: a Go change with no GATE_GO_CMD and no nix blocks the push -
if ! command -v nix >/dev/null 2>&1; then
  rc=0
  printf 'internal/x.go\n' | gate_run "$PWD" 2>/dev/null || rc=$?
  [ "$rc" -ne 0 ] || fail "a Go change with no toolchain must fail closed, not ship un-linted"
  pass=$((pass+1))
fi

# --- pre-push stdin → changed files, over a throwaway repo -----------------
repo="$(mktemp -d)"; trap 'rm -rf "$repo" "$marker"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
git -C "$repo" init -q -b main
printf 'package main\n' > "$repo/main.go"; echo "# readme" > "$repo/README.md"
git -C "$repo" add -A && git -C "$repo" commit -q -m base
base="$(git -C "$repo" rev-parse HEAD)"
printf 'package main\n// changed\n' > "$repo/main.go"
git -C "$repo" commit -qam change
head="$(git -C "$repo" rev-parse HEAD)"

files="$(cd "$repo" && printf 'refs/heads/main %s refs/heads/main %s\n' "$head" "$base" | gate_files_from_prepush)"
printf '%s\n' "$files" | grep -qx main.go || fail "pre-push parsing must surface the changed main.go, got: $files"
pass=$((pass+1))

# a branch deletion (all-zero local sha) contributes no files
del="$(cd "$repo" && printf 'refs/heads/x %s refs/heads/x %s\n' "$GATE_ZERO_SHA" "$head" | gate_files_from_prepush)"
[ -z "$del" ] || fail "a branch deletion must contribute no files, got: $del"
pass=$((pass+1))

# and the range's language is Go, so the gate would run the Go stage
lang="$(printf '%s\n' "$files" | gate_langs_for_files)"
eq "go" "$lang" "the pushed range is a Go change"

echo "gate-lib: $pass checks passed"
