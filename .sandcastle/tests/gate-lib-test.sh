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
tsmarker="$(mktemp -u)"

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

# A TypeScript-only slice: the TS lint stage RUNS (#1252) and the Go stage is
# SKIPPED. The Go stub would create the go-marker if it ran — it must not; the
# TS stub creates the ts-marker to prove the TS stage ran.
rm -f "$marker" "$tsmarker"
rc=0
printf 'dashboard/src/x.ts\n' | \
  GATE_GO_CMD="touch '$marker'; true" GATE_TS_CMD="touch '$tsmarker'; true" \
  gate_run "$PWD" 2>/dev/null || rc=$?
[ "$rc" -eq 0 ] || fail "a clean TS-only change must pass the gate"
[ ! -f "$marker" ] || fail "a TS-only change must NOT run the Go stage"
[ -f "$tsmarker" ] || fail "a TS-only change MUST run the TS lint stage (#1252)"
pass=$((pass+1))

# A deliberate red-lint TS slice: the TS stage fails → the push is refused. This
# is the whole point of #1252 — a blocked push beats a TS lint break on main.
rc=0
printf 'dashboard/src/x.ts\n' | GATE_TS_CMD="false" gate_run "$PWD" 2>/dev/null || rc=$?
[ "$rc" -ne 0 ] || fail "a red TS lint stage must make the gate fail (the push is refused)"
pass=$((pass+1))

# A mixed Go+TS slice: BOTH stages run.
rm -f "$marker" "$tsmarker"
rc=0
printf 'a.go\nb.ts\n' | \
  GATE_GO_CMD="touch '$marker'; true" GATE_TS_CMD="touch '$tsmarker'; true" \
  gate_run "$PWD" 2>/dev/null || rc=$?
[ "$rc" -eq 0 ] || fail "a clean mixed change must pass the gate"
[ -f "$marker" ] || fail "a mixed change must run the Go stage"
[ -f "$tsmarker" ] || fail "a mixed change must run the TS stage"
pass=$((pass+1))

# The `only` filter: `gate_run <root> ts` runs ONLY the TS stage on a mixed
# change — the pre-push hook uses it to gate TS in every workdir while Go stays
# sandbox-only. And `gate_run <root> go` runs ONLY the Go stage.
rm -f "$marker" "$tsmarker"
rc=0
printf 'a.go\nb.ts\n' | \
  GATE_GO_CMD="touch '$marker'; true" GATE_TS_CMD="touch '$tsmarker'; true" \
  gate_run "$PWD" ts 2>/dev/null || rc=$?
[ "$rc" -eq 0 ] || fail "gate_run <root> ts must pass a clean TS stage"
[ ! -f "$marker" ] || fail "gate_run <root> ts must NOT run the Go stage"
[ -f "$tsmarker" ] || fail "gate_run <root> ts must run the TS stage"
pass=$((pass+1))
rm -f "$marker" "$tsmarker"
rc=0
printf 'a.go\nb.ts\n' | \
  GATE_GO_CMD="touch '$marker'; true" GATE_TS_CMD="touch '$tsmarker'; true" \
  gate_run "$PWD" go 2>/dev/null || rc=$?
[ "$rc" -eq 0 ] || fail "gate_run <root> go must pass a clean Go stage"
[ -f "$marker" ] || fail "gate_run <root> go must run the Go stage"
[ ! -f "$tsmarker" ] || fail "gate_run <root> go must NOT run the TS stage"
pass=$((pass+1))

# A docs-only slice: nothing gated, the push proceeds — no stage runs.
rm -f "$marker" "$tsmarker"
rc=0
printf 'README.md\n' | \
  GATE_GO_CMD="touch '$marker'; true" GATE_TS_CMD="touch '$tsmarker'; true" \
  gate_run "$PWD" 2>/dev/null || rc=$?
[ "$rc" -eq 0 ] || fail "a docs-only change must pass the gate"
[ ! -f "$marker" ] || fail "a docs-only change must run no Go stage"
[ ! -f "$tsmarker" ] || fail "a docs-only change must run no TS stage"
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

# --- per-repo override: an executable .sandcastle/go-gate.sh runs (#126) ------
# A consumer whose layout/toolchain differs from the nix default drops a per-repo
# executable at .sandcastle/go-gate.sh; with no GATE_GO_CMD, the Go stage runs it.
gateroot="$(mktemp -d)"
mkdir -p "$gateroot/.sandcastle"
printf '#!/usr/bin/env bash\ntouch %q\n' "$marker" > "$gateroot/.sandcastle/go-gate.sh"
chmod +x "$gateroot/.sandcastle/go-gate.sh"

rm -f "$marker"
rc=0
gate_go_stage "$gateroot" 2>/dev/null || rc=$?
[ "$rc" -eq 0 ] || fail "an executable .sandcastle/go-gate.sh must run and its exit propagate"
[ -f "$marker" ] || fail "the Go stage must run .sandcastle/go-gate.sh when no GATE_GO_CMD is set"
pass=$((pass+1))

# GATE_GO_CMD takes precedence over an executable .sandcastle/go-gate.sh: the
# script would create the marker; the env override (which does not) must win.
rm -f "$marker"
rc=0
GATE_GO_CMD="true" gate_go_stage "$gateroot" 2>/dev/null || rc=$?
[ "$rc" -eq 0 ] || fail "GATE_GO_CMD must resolve when set"
[ ! -f "$marker" ] || fail "GATE_GO_CMD must take precedence over .sandcastle/go-gate.sh"
pass=$((pass+1))

# The .sandcastle/go-gate.sh branch runs under the same git-env scrub as
# GATE_GO_CMD — GIT_DIR/GIT_INDEX_FILE must not leak into the per-repo gate.
printf '#!/usr/bin/env bash\n[ -z "${GIT_DIR:-}${GIT_INDEX_FILE:-}" ] || exit 7\n' \
  > "$gateroot/.sandcastle/go-gate.sh"
chmod +x "$gateroot/.sandcastle/go-gate.sh"
rc=0
GIT_DIR=/somewhere/.git GIT_INDEX_FILE=/somewhere/.git/index \
  gate_go_stage "$gateroot" 2>/dev/null || rc=$?
[ "$rc" -eq 0 ] || fail ".sandcastle/go-gate.sh must run with git's hook env scrubbed"
pass=$((pass+1))

# A non-executable .sandcastle/go-gate.sh is NOT honoured: with no GATE_GO_CMD
# and no nix it still fails closed (an un-lintable Go change never ships).
if ! command -v nix >/dev/null 2>&1; then
  chmod -x "$gateroot/.sandcastle/go-gate.sh"
  rc=0
  gate_go_stage "$gateroot" 2>/dev/null || rc=$?
  [ "$rc" -ne 0 ] || fail "a non-executable .sandcastle/go-gate.sh must not satisfy the gate — fail closed"
  pass=$((pass+1))
fi
rm -rf "$gateroot"

# --- per-repo override: an executable .sandcastle/ts-gate.sh runs (#1252) -----
# Mirrors the Go override: a consumer whose toolchain differs from the nix
# default drops a per-repo executable at .sandcastle/ts-gate.sh; with no
# GATE_TS_CMD, the TS stage runs it.
tsroot="$(mktemp -d)"
mkdir -p "$tsroot/.sandcastle"
printf '#!/usr/bin/env bash\ntouch %q\n' "$tsmarker" > "$tsroot/.sandcastle/ts-gate.sh"
chmod +x "$tsroot/.sandcastle/ts-gate.sh"

rm -f "$tsmarker"
rc=0
gate_ts_stage "$tsroot" 2>/dev/null || rc=$?
[ "$rc" -eq 0 ] || fail "an executable .sandcastle/ts-gate.sh must run and its exit propagate"
[ -f "$tsmarker" ] || fail "the TS stage must run .sandcastle/ts-gate.sh when no GATE_TS_CMD is set"
pass=$((pass+1))

# GATE_TS_CMD takes precedence over an executable .sandcastle/ts-gate.sh.
rm -f "$tsmarker"
rc=0
GATE_TS_CMD="true" gate_ts_stage "$tsroot" 2>/dev/null || rc=$?
[ "$rc" -eq 0 ] || fail "GATE_TS_CMD must resolve when set"
[ ! -f "$tsmarker" ] || fail "GATE_TS_CMD must take precedence over .sandcastle/ts-gate.sh"
pass=$((pass+1))

# Both TS override branches run under the git-env scrub (GIT_DIR/GIT_INDEX_FILE
# must not leak into eslint/pnpm/nix), exactly like the Go stage.
GIT_DIR=/somewhere/.git GIT_INDEX_FILE=/somewhere/.git/index \
  GATE_TS_CMD='[ -z "${GIT_DIR:-}${GIT_INDEX_FILE:-}" ] || exit 7' \
  gate_ts_stage "$tsroot" 2>/dev/null || fail "GATE_TS_CMD must run with git's hook env scrubbed"
pass=$((pass+1))
printf '#!/usr/bin/env bash\n[ -z "${GIT_DIR:-}${GIT_INDEX_FILE:-}" ] || exit 7\n' \
  > "$tsroot/.sandcastle/ts-gate.sh"
chmod +x "$tsroot/.sandcastle/ts-gate.sh"
rc=0
GIT_DIR=/somewhere/.git GIT_INDEX_FILE=/somewhere/.git/index \
  gate_ts_stage "$tsroot" 2>/dev/null || rc=$?
[ "$rc" -eq 0 ] || fail ".sandcastle/ts-gate.sh must run with git's hook env scrubbed"
pass=$((pass+1))

# Fail-closed: a TS change with no GATE_TS_CMD, no ts-gate.sh and no nix blocks
# the push — a TS change that cannot be linted never ships un-linted (#1252).
if ! command -v nix >/dev/null 2>&1; then
  rm -f "$tsroot/.sandcastle/ts-gate.sh"
  rc=0
  gate_ts_stage "$tsroot" 2>/dev/null || rc=$?
  [ "$rc" -ne 0 ] || fail "a TS change with no toolchain must fail closed, not ship un-linted"
  pass=$((pass+1))
  rc=0
  printf 'dashboard/src/x.ts\n' | gate_run "$PWD" 2>/dev/null || rc=$?
  [ "$rc" -ne 0 ] || fail "gate_run must fail closed on an un-lintable TS change"
  pass=$((pass+1))
fi
rm -rf "$tsroot"

# --- fail-closed: a Go change with no GATE_GO_CMD and no nix blocks the push -
# (no executable .sandcastle/go-gate.sh here either — none of the three resolve.)
if ! command -v nix >/dev/null 2>&1; then
  rc=0
  printf 'internal/x.go\n' | gate_run "$PWD" 2>/dev/null || rc=$?
  [ "$rc" -ne 0 ] || fail "a Go change with no toolchain must fail closed, not ship un-linted"
  pass=$((pass+1))
fi

# --- Gate 3b: the gofmt-only host gate (#1458) ------------------------------
# gofmt debt reaches main through the HOST push, not the sandbox (f291b547/#1429
# red'd #344). The host push path runs a cheap gofmt-ONLY Go gate — no nix, no
# compile — instead of the full Go seam. GATE_GOFMT_CMD is its offline test seam.
fmtmarker="$(mktemp -u)"

# A red gofmt slice: the stage fails → the push is refused.
rc=0
GATE_GOFMT_CMD="rm -f '$fmtmarker'; false" gate_gofmt_stage "$PWD" 2>/dev/null || rc=$?
[ "$rc" -ne 0 ] || fail "a red gofmt stage must make the gate fail (the push is refused)"
pass=$((pass+1))

# A green gofmt slice: the stage passes AND actually ran.
rm -f "$fmtmarker"; rc=0
GATE_GOFMT_CMD="touch '$fmtmarker'; true" gate_gofmt_stage "$PWD" 2>/dev/null || rc=$?
[ "$rc" -eq 0 ] || fail "a green gofmt stage must let the gate pass"
[ -f "$fmtmarker" ] || fail "the gofmt stage must actually run"
pass=$((pass+1))

# The gofmt stage runs with git's hook env scrubbed (like the Go/TS stages).
rm -f "$fmtmarker"; rc=0
GIT_DIR=/somewhere/.git GIT_INDEX_FILE=/somewhere/.git/index \
  GATE_GOFMT_CMD='[ -z "${GIT_DIR:-}${GIT_INDEX_FILE:-}" ] || exit 7' \
  gate_gofmt_stage "$PWD" 2>/dev/null || rc=$?
[ "$rc" -eq 0 ] || fail "the gofmt stage must run with git's hook env scrubbed"
pass=$((pass+1))

# go_tier=gofmt runs the gofmt stage, NOT the full Go seam. The full-Go stub
# would create the go-marker if it ran — it must not; the gofmt stub creates the
# fmt-marker to prove the gofmt tier ran.
rm -f "$marker" "$fmtmarker"; rc=0
printf 'internal/x.go\n' | \
  GATE_GO_CMD="touch '$marker'; true" GATE_GOFMT_CMD="touch '$fmtmarker'; true" \
  gate_run "$PWD" "" gofmt 2>/dev/null || rc=$?
[ "$rc" -eq 0 ] || fail "a clean Go change must pass the gofmt-tier gate"
[ ! -f "$marker" ] || fail "go_tier=gofmt must NOT run the full Go seam"
[ -f "$fmtmarker" ] || fail "go_tier=gofmt MUST run the gofmt-only stage (#1458)"
pass=$((pass+1))

# The HOST profile (only="", go_tier=gofmt) on a mixed Go+TS change: the gofmt
# tier runs for Go (not the full seam) AND the TS lint gate runs (#1252).
rm -f "$marker" "$fmtmarker" "$tsmarker"; rc=0
printf 'a.go\nb.ts\n' | \
  GATE_GO_CMD="touch '$marker'; true" GATE_GOFMT_CMD="touch '$fmtmarker'; true" \
  GATE_TS_CMD="touch '$tsmarker'; true" \
  gate_run "$PWD" "" gofmt 2>/dev/null || rc=$?
[ "$rc" -eq 0 ] || fail "a clean mixed change must pass the host-profile gate"
[ ! -f "$marker" ] || fail "the host profile must NOT run the full Go seam"
[ -f "$fmtmarker" ] || fail "the host profile MUST run the gofmt-only Go gate (#1458)"
[ -f "$tsmarker" ] || fail "the host profile MUST run the TS lint gate (#1252)"
pass=$((pass+1))

# A red gofmt tier under the host profile fails the whole gate — the whole point
# of #1458: a blocked push beats gofmt debt on main.
rc=0
printf 'a.go\n' | GATE_GOFMT_CMD="false" gate_run "$PWD" "" gofmt 2>/dev/null || rc=$?
[ "$rc" -ne 0 ] || fail "a red gofmt tier must make the host-profile gate fail"
pass=$((pass+1))

# The real gofmt binary (when present): a well-formatted tree passes, gofmt debt
# fails — with NO GATE_GOFMT_CMD, exercising the bare-`gofmt` resolution path.
if command -v gofmt >/dev/null 2>&1; then
  fmtroot="$(mktemp -d)"
  printf 'package main\n\nfunc main() {}\n' > "$fmtroot/main.go"
  rc=0; gate_gofmt_stage "$fmtroot" >/dev/null 2>&1 || rc=$?
  [ "$rc" -eq 0 ] || fail "the bare-gofmt path must pass a well-formatted tree"
  pass=$((pass+1))
  # Misformatted (double spaces / wrong indentation gofmt rewrites) → debt.
  printf 'package main\nfunc  main()  {\nx := 1\n_ = x\n}\n' > "$fmtroot/main.go"
  rc=0; gate_gofmt_stage "$fmtroot" >/dev/null 2>&1 || rc=$?
  [ "$rc" -ne 0 ] || fail "the bare-gofmt path must fail on gofmt debt (#1458)"
  pass=$((pass+1))
  rm -rf "$fmtroot"
fi

# Fail-closed: a Go change with no GATE_GOFMT_CMD and no `gofmt` blocks the push
# — an un-checkable Go change never ships un-gofmt'd, exactly as the TS gate fails
# closed (#1252). (Skipped where gofmt IS present — then the bare path resolves.)
if ! command -v gofmt >/dev/null 2>&1; then
  rc=0; gate_gofmt_stage "$PWD" 2>/dev/null || rc=$?
  [ "$rc" -ne 0 ] || fail "a Go change with no gofmt must fail closed (#1458)"
  pass=$((pass+1))
fi
rm -f "$fmtmarker"

# --- pre-push stdin → changed files, over a throwaway repo -----------------
repo="$(mktemp -d)"; trap 'rm -rf "$repo" "$marker" "$tsmarker" "$fmtmarker"' EXIT
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
