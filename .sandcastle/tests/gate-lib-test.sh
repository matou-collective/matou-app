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
eq ""      "$(printf 'README.md\ndocs/adr/0040.md\n'     | gate_langs_for_files)" "a plain doc/ADR touches no gate"
# The docs-diagram tier (GOTCHAS #143): the three trees whose mermaid/slice-map
# contracts the seam enforces, which carry no go/ts token.
# The docs tier's trees are per-repo (#47 — a vendored script names no consumer
# doc path): with no GATE_DOCS_GLOBS there is no docs tier at all.
eq ""      "$(printf 'docs/slices/x.mermaid\n' | GATE_DOCS_GLOBS='' gate_langs_for_files)" "no GATE_DOCS_GLOBS -> no docs tier"
globsroot="$(mktemp -d)"; mkdir -p "$globsroot/.sandcastle"
printf '# diagram sources\ndocs/slices/*\n\ndocs/ux/flows/*   # flows\n' > "$globsroot/.sandcastle/docs-gate.globs"
eq "docs/slices/* docs/ux/flows/* " "$(GATE_DOCS_GLOBS='' gate_docs_globs "$globsroot")" "gate_docs_globs reads the per-repo .sandcastle/docs-gate.globs"
eq "a/*" "$(GATE_DOCS_GLOBS='a/*' gate_docs_globs "$globsroot")" "GATE_DOCS_GLOBS wins over the per-repo file"
eq "" "$(GATE_DOCS_GLOBS='' gate_docs_globs "$(mktemp -d)")" "no env and no file -> no globs"
rm -rf "$globsroot"
# Everything below runs with idss's diagram trees declared, as its per-repo file does.
export GATE_DOCS_GLOBS='docs/architecture/* docs/slices/* docs/ux/flows/*'
eq "docs"  "$(printf 'docs/slices/report-and-request.mermaid\n' | gate_langs_for_files)" "a slice-DAG source is a docs change"
eq "docs"  "$(printf 'docs/architecture/09-founding-sequence.md\n' | gate_langs_for_files)" "an architecture diagram is a docs change"
eq "docs"  "$(printf 'docs/ux/flows/p6-members-idip.mermaid\n' | gate_langs_for_files)" "a UX flow source is a docs change"
eq ""      "$(printf 'docs/adr/0174-two-way-doors.md\n'  | gate_langs_for_files)" "an ADR under docs/ is NOT a docs-diagram change"
eq $'docs\nts' "$(printf 'docs/slices/x.mermaid\nb.ts\n' | gate_langs_for_files)" "a docs+TS change reports both"

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
# GATE_NO_NIX=1 forces the no-toolchain path so this runs on a nix host too — the
# `command -v nix` skip it replaces made the fail-closed arms green locally and
# red on CI (#314).
chmod -x "$gateroot/.sandcastle/go-gate.sh"
rc=0
GATE_NO_NIX=1 gate_go_stage "$gateroot" 2>/dev/null || rc=$?
[ "$rc" -ne 0 ] || fail "a non-executable .sandcastle/go-gate.sh must not satisfy the gate — fail closed"
pass=$((pass+1))
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
# GATE_NO_NIX=1 forces the no-toolchain path so this runs on a nix host too, and
# the root is the override-free $tsroot — NOT $PWD, which carries this repo's own
# self-consumer .sandcastle/ts-gate.sh (#312): that override resolves tier 2, so
# `gate_run "$PWD"` did NOT fail closed, and the `command -v nix` skip hid it on
# every nix host while CI went red (#314). Both arms must fail closed.
rm -f "$tsroot/.sandcastle/ts-gate.sh"
rc=0
GATE_NO_NIX=1 gate_ts_stage "$tsroot" 2>/dev/null || rc=$?
[ "$rc" -ne 0 ] || fail "a TS change with no toolchain must fail closed, not ship un-linted"
pass=$((pass+1))
rc=0
printf 'dashboard/src/x.ts\n' | GATE_NO_NIX=1 gate_run "$tsroot" 2>/dev/null || rc=$?
[ "$rc" -ne 0 ] || fail "gate_run must fail closed on an un-lintable TS change"
pass=$((pass+1))
rm -rf "$tsroot"

# --- fail-closed: a Go change with no GATE_GO_CMD and no nix blocks the push -
# Over an override-free root (a fresh tmp dir, NOT $PWD — a self-consumer
# .sandcastle/go-gate.sh would resolve tier 2, the Go twin of #312/#314), with
# GATE_NO_NIX=1 forcing the no-toolchain path so this runs on a nix host too:
# none of the three resolve.
goroot="$(mktemp -d)"
rc=0
printf 'internal/x.go\n' | GATE_NO_NIX=1 gate_run "$goroot" 2>/dev/null || rc=$?
[ "$rc" -ne 0 ] || fail "a Go change with no toolchain must fail closed, not ship un-linted"
pass=$((pass+1))
rm -rf "$goroot"

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

# --- the docs-diagram tier (GOTCHAS #143) -----------------------------------
# A docs-only change carries no go/ts token, so the pre-push gate was blind to it
# and a bare `%%` (or a `;`, or an unquoted `#`) red CI one run too late, on a
# branch a human had to re-open. The docs tier runs the cheap in-repo mermaid /
# slice-map checkers on EVERY push path. GATE_DOCS_CMD is its offline test seam.
docsmarker="$(mktemp -u)"

# A red docs slice: the stage fails → the push is refused.
rc=0
printf 'docs/slices/x.mermaid\n' | GATE_DOCS_CMD="rm -f '$docsmarker'; false" gate_run "$PWD" 2>/dev/null || rc=$?
[ "$rc" -ne 0 ] || fail "a red docs stage must make the gate fail (the push is refused)"
pass=$((pass+1))

# A green docs slice: the stage passes AND actually ran.
rm -f "$docsmarker"; rc=0
printf 'docs/slices/x.mermaid\n' | GATE_DOCS_CMD="touch '$docsmarker'; true" gate_run "$PWD" 2>/dev/null || rc=$?
[ "$rc" -eq 0 ] || fail "a green docs stage must let the gate pass"
[ -f "$docsmarker" ] || fail "the docs stage must actually run on a docs change"
pass=$((pass+1))

# A docs-only change runs ONLY the docs stage — not Go, not TS.
rm -f "$marker" "$tsmarker" "$docsmarker"; rc=0
printf 'docs/ux/flows/p6.mermaid\n' | \
  GATE_GO_CMD="touch '$marker'; true" GATE_TS_CMD="touch '$tsmarker'; true" \
  GATE_DOCS_CMD="touch '$docsmarker'; true" gate_run "$PWD" 2>/dev/null || rc=$?
[ "$rc" -eq 0 ] || fail "a clean docs-only change must pass the gate"
[ ! -f "$marker" ] || fail "a docs-only change must NOT run the Go stage"
[ ! -f "$tsmarker" ] || fail "a docs-only change must NOT run the TS stage"
[ -f "$docsmarker" ] || fail "a docs-only change MUST run the docs stage (GOTCHAS #143)"
pass=$((pass+1))

# The docs tier runs under the HOST profile too (go_tier=gofmt): GOTCHAS #143's
# incident was a HOST-path docs push, so it must fire there, not only the sandbox.
rm -f "$docsmarker"; rc=0
printf 'docs/slices/x.mermaid\n' | GATE_DOCS_CMD="touch '$docsmarker'; true" \
  gate_run "$PWD" "" gofmt 2>/dev/null || rc=$?
[ "$rc" -eq 0 ] || fail "a clean docs change must pass under the host profile"
[ -f "$docsmarker" ] || fail "the host profile MUST run the docs stage (GOTCHAS #143)"
pass=$((pass+1))

# The docs stage runs with git's hook env scrubbed (like the Go/TS/gofmt stages).
rc=0
printf 'docs/slices/x.mermaid\n' | \
  GIT_DIR=/somewhere/.git GIT_INDEX_FILE=/somewhere/.git/index \
  GATE_DOCS_CMD='[ -z "${GIT_DIR:-}${GIT_INDEX_FILE:-}" ] || exit 7' \
  gate_run "$PWD" 2>/dev/null || rc=$?
[ "$rc" -eq 0 ] || fail "the docs stage must run with git's hook env scrubbed"
pass=$((pass+1))

# Per-repo override: an executable .sandcastle/docs-gate.sh runs when no
# GATE_DOCS_CMD is set (mirrors the Go/TS overrides).
docsroot="$(mktemp -d)"
mkdir -p "$docsroot/.sandcastle"
printf '#!/usr/bin/env bash\ntouch %q\n' "$docsmarker" > "$docsroot/.sandcastle/docs-gate.sh"
chmod +x "$docsroot/.sandcastle/docs-gate.sh"
rm -f "$docsmarker"; rc=0
gate_docs_stage "$docsroot" 2>/dev/null || rc=$?
[ "$rc" -eq 0 ] || fail "an executable .sandcastle/docs-gate.sh must run and its exit propagate"
[ -f "$docsmarker" ] || fail "the docs stage must run .sandcastle/docs-gate.sh when no GATE_DOCS_CMD is set"
pass=$((pass+1))

# GATE_DOCS_CMD takes precedence over an executable .sandcastle/docs-gate.sh.
rm -f "$docsmarker"; rc=0
GATE_DOCS_CMD="true" gate_docs_stage "$docsroot" 2>/dev/null || rc=$?
[ "$rc" -eq 0 ] || fail "GATE_DOCS_CMD must resolve when set"
[ ! -f "$docsmarker" ] || fail "GATE_DOCS_CMD must take precedence over .sandcastle/docs-gate.sh"
pass=$((pass+1))

# The docs-gate.sh branch runs under the git-env scrub, like the other stages.
printf '#!/usr/bin/env bash\n[ -z "${GIT_DIR:-}${GIT_INDEX_FILE:-}" ] || exit 7\n' \
  > "$docsroot/.sandcastle/docs-gate.sh"
chmod +x "$docsroot/.sandcastle/docs-gate.sh"
rc=0
GIT_DIR=/somewhere/.git GIT_INDEX_FILE=/somewhere/.git/index \
  gate_docs_stage "$docsroot" 2>/dev/null || rc=$?
[ "$rc" -eq 0 ] || fail ".sandcastle/docs-gate.sh must run with git's hook env scrubbed"
pass=$((pass+1))
rm -rf "$docsroot"

# Fail-closed: a docs change with no GATE_DOCS_CMD, no docs-gate.sh and no `node`
# blocks the push — a docs change that cannot be checked never ships un-checked.
if ! command -v node >/dev/null 2>&1; then
  docsroot="$(mktemp -d)"
  rc=0; gate_docs_stage "$docsroot" 2>/dev/null || rc=$?
  [ "$rc" -ne 0 ] || fail "a docs change with no node must fail closed, not ship un-checked"
  pass=$((pass+1))
  rc=0
  printf 'docs/slices/x.mermaid\n' | gate_run "$PWD" 2>/dev/null || rc=$?
  [ "$rc" -ne 0 ] || fail "gate_run must fail closed on an un-checkable docs change"
  pass=$((pass+1))
  rm -rf "$docsroot"
fi

# --- the DEFAULT docs command: the real checkers over a real fixture --------
# Like the real-gofmt checks above, exercise gate_docs_default_cmd WITHOUT a stub
# (the #400 lesson: a gate's real default command gets at least one test that
# does not stub it). Guarded on the presence of `node`, the in-repo checkers, the
# vendored mermaid and an installed happy-dom — all present in the product repo's
# seam, none in the factory's bash-only test env, so this block simply skips
# there. An isolated root (copied checkers + vendored parser, symlinked app tree)
# keeps the scan off the live docs trees.
realroot="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"
if command -v node >/dev/null 2>&1 \
   && [ -f "$realroot/scripts/check-mermaid.mjs" ] \
   && [ -f "$realroot/scripts/check-slices-yaml.mjs" ] \
   && [ -f "$realroot/docs/architecture/vendor/mermaid.min.js" ] \
   && [ -d "$realroot/app/node_modules/happy-dom" ]; then
  docsroot="$(mktemp -d)"
  mkdir -p "$docsroot/scripts" "$docsroot/docs/architecture/vendor" \
           "$docsroot/docs/slices" "$docsroot/docs/ux/flows"
  cp "$realroot/scripts/check-mermaid.mjs" "$realroot/scripts/check-slices-yaml.mjs" "$docsroot/scripts/"
  cp "$realroot/docs/architecture/vendor/mermaid.min.js" "$docsroot/docs/architecture/vendor/"
  ln -s "$realroot/app" "$docsroot/app"

  # The bare-`%%` source from the #143 incident: a comment with content on lines
  # 1–4, a BARE `%%` on line 5. The stripper removes the content lines with their
  # newlines; the bare `%%` survives and glues onto `flowchart TD` → a line-1
  # parse error. This is the exact shape that red CI on PR #2067 (run 52773).
  cat > "$docsroot/docs/slices/report-and-request.mermaid" <<'MMD'
%% report-and-request fixture — GOTCHAS #143 bare-%% regression (block opens line 1)
%% a comment line with content, so the stripper removes it and its trailing newline
%% another content comment line, likewise removed
%% a fourth content comment line
%%
flowchart TD
    A["start"] --> B["end"]
MMD
  rc=0; out="$(gate_docs_stage "$docsroot" 2>&1)" || rc=$?
  [ "$rc" -ne 0 ] || fail "the bare-%% incident source must be REFUSED by the docs gate (GOTCHAS #143)"
  printf '%s\n' "$out" | grep -q 'will not parse' \
    || fail "the docs gate must name the parse failure, got: $out"
  pass=$((pass+1))

  # The SAME file with line 5 given content (`%% —`) parses — the gate accepts it.
  sed -i '5s/^%%$/%% —/' "$docsroot/docs/slices/report-and-request.mermaid"
  rc=0; gate_docs_stage "$docsroot" >/dev/null 2>&1 || rc=$?
  [ "$rc" -eq 0 ] || fail "the same source with line 5 given content must be ACCEPTED"
  pass=$((pass+1))

  # A missing happy-dom (the sandbox-with-no-install case, #400) CRASHES the
  # checker (exit 2). It must be reported as a HARNESS fault naming happy-dom —
  # never as a broken diagram, never silently skipped. Drop the app symlink so
  # happy-dom no longer resolves; the fixture itself now parses, proving the
  # verdict is about the crash, not the diagram.
  rm -f "$docsroot/app"
  rc=0; out="$(gate_docs_stage "$docsroot" 2>&1)" || rc=$?
  [ "$rc" -ne 0 ] || fail "a missing happy-dom must make the docs gate fail (a harness fault)"
  printf '%s\n' "$out" | grep -qi 'happy-dom' \
    || fail "the harness fault must NAME happy-dom, got: $out"
  printf '%s\n' "$out" | grep -qi 'HARNESS fault' \
    || fail "the crash must be reported as a harness fault, got: $out"
  if printf '%s\n' "$out" | grep -q 'will not parse'; then
    fail "a crash must NOT be reported as a broken diagram, got: $out"
  fi
  pass=$((pass+1))
  rm -rf "$docsroot"
fi
rm -f "$docsmarker"

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

# --- #253: a STALE placeholder remote branch (an ancestor of origin/main) must
# scope to the merge-base with main, NOT the ancient branch head ---------------
# A PR-mode worker pushes agent/issue-<N> non-force; when that remote branch
# already sits at an OLD ancestor of main (a PR-less placeholder), git hands the
# gate rsha=<old-head>. Using base=rsha would diff the whole intervening history
# and mis-fire the gate on unrelated languages (TS/Go the real slice never
# touched), blocking a push whose actual change touches nothing gated.
staler="$(mktemp -d)"
git -C "$staler" init -q -b main
# M0 — the ancient placeholder point: no gated files.
echo "# readme" > "$staler/README.md"
git -C "$staler" add -A && git -C "$staler" commit -q -m m0
placeholder="$(git -C "$staler" rev-parse HEAD)"
# main advances with unrelated GATED history (a lockfile + a .ts file).
printf '{}\n' > "$staler/package.json"; printf 'export const x = 1\n' > "$staler/app.ts"
git -C "$staler" add -A && git -C "$staler" commit -q -m m1
# origin/main := the advanced main; the placeholder branch is left behind at M0.
git -C "$staler" update-ref refs/remotes/origin/main HEAD
# The worker's real slice: a fresh branch off origin/main adding ONLY an ungated
# file (a fleet-tui/** change — the #238 case that first hit this bug).
mkdir -p "$staler/fleet-tui/floor/web"
printf 'export const b = 2\n' > "$staler/fleet-tui/floor/web/board.js"
git -C "$staler" add -A && git -C "$staler" commit -q -m slice
slice="$(git -C "$staler" rev-parse HEAD)"

# pre-push with rsha = the stale placeholder at M0 (an ancestor of origin/main):
# the gate must see ONLY the real slice's file, never the intervening gated history.
staleln="refs/heads/agent/issue-253 $slice refs/heads/agent/issue-253 $placeholder"
stalefiles="$(cd "$staler" && printf '%s\n' "$staleln" | gate_files_from_prepush)"
printf '%s\n' "$stalefiles" | grep -qx fleet-tui/floor/web/board.js \
  || fail "#253: the push's real slice (board.js) must be in scope, got: $stalefiles"
if printf '%s\n' "$stalefiles" | grep -qE 'package\.json|app\.ts'; then
  fail "#253: a stale-placeholder base must NOT drag in main's intervening gated history, got: $stalefiles"
fi
pass=$((pass+1))
# ...and so no gated language fires — the push is no longer wrongly blocked.
eq "" "$(printf '%s\n' "$stalefiles" | gate_langs_for_files)" "#253: a stale-placeholder push of an ungated slice fires no language gate"

# The LIVE incremental case is preserved: when rsha is a real branch head with
# unmerged work (NOT an ancestor of origin/main), base=rsha still scopes to just
# the commits this push adds — not the whole branch from its main branch-point.
printf 'export const c = 3\n' > "$staler/fleet-tui/floor/web/extra.ts"
git -C "$staler" add -A && git -C "$staler" commit -q -m increment
inc="$(git -C "$staler" rev-parse HEAD)"
incln="refs/heads/agent/issue-253 $inc refs/heads/agent/issue-253 $slice"
incfiles="$(cd "$staler" && printf '%s\n' "$incln" | gate_files_from_prepush)"
printf '%s\n' "$incfiles" | grep -qx fleet-tui/floor/web/extra.ts \
  || fail "#253: the incremental case must surface the newly-pushed extra.ts, got: $incfiles"
if printf '%s\n' "$incfiles" | grep -qx fleet-tui/floor/web/board.js; then
  fail "#253: a live rsha must stay incremental — not re-scope the already-pushed board.js, got: $incfiles"
fi
pass=$((pass+1))
rm -rf "$staler"

# --- the DEFAULT gofmt command: what it scans (the #1458 regression) --------
# Every check above stubs the stage with GATE_GOFMT_CMD, so gate_gofmt_default_cmd
# — the arm that actually runs on a host push — was never exercised, which is how
# it shipped scanning `.sandcastle/nix-store/`. That store holds the Go
# distribution's own src/, ~340 files gofmt calls unformatted plus a wall of
# deliberately-malformed testdata parse errors: the host gate blocked EVERY Go
# push with a verdict about files this repo cannot fix, so it got bypassed and
# gofmt debt reached main again (ce04cd10). These checks pin the scan's shape —
# including `.sandcastle/worktrees/` (#2134): the gitignored dir holding every
# SIBLING worker's live worktree, so a concurrent worker's in-flight un-gofmt'd
# Go must not refuse this worker's push (it is a foreign tree, same as nix-store).
if command -v gofmt >/dev/null 2>&1; then
  fmtrepo="$(mktemp -d)"
  mkdir -p "$fmtrepo/internal" "$fmtrepo/node_modules/dep" \
           "$fmtrepo/.sandcastle/nix-store/store/go-1.23.8/share/go/src/cmd" \
           "$fmtrepo/.sandcastle/worktrees/sandcastle-worker-sibling/internal/breakglass"
  # gofmt wants a tab indent; two spaces is debt.
  debt='package p\n\nfunc f() {\n  return\n}\n'
  clean='package p\n\nfunc f() {\n\treturn\n}\n'
  printf "$clean" > "$fmtrepo/internal/ours.go"
  printf "$debt"  > "$fmtrepo/node_modules/dep/vendored.go"
  printf "$debt"  > "$fmtrepo/.sandcastle/nix-store/store/go-1.23.8/share/go/src/cmd/foreign.go"
  # a SIBLING worker's in-flight un-gofmt'd Go, in the shared gitignored worktrees
  # dir — foreign to this worker, must never enter the scan (#2134).
  printf "$debt"  > "$fmtrepo/.sandcastle/worktrees/sandcastle-worker-sibling/internal/breakglass/actions.go"
  # and the malformed testdata that makes gofmt print parse errors, not a verdict
  printf 'package p\nfunc f() { if x := 1 {} }\n' \
    > "$fmtrepo/.sandcastle/nix-store/store/go-1.23.8/share/go/src/cmd/broken.go"

  # Debt that lives ONLY in gitignored artifact trees is not this repo's debt.
  rc=0; out="$(gate_gofmt_stage "$fmtrepo" 2>&1)" || rc=$?
  [ "$rc" -eq 0 ] || fail "artifact-only gofmt debt must not block the push, got rc=$rc: $out"
  [ -z "$out" ] || fail "the gate must stay silent on a clean tree, got: $out"
  pass=$((pass+1))

  # Debt in the repo's OWN Go is still caught, and named root-relative.
  printf "$debt" > "$fmtrepo/internal/ours.go"
  rc=0; out="$(gate_gofmt_stage "$fmtrepo" 2>&1)" || rc=$?
  [ "$rc" -ne 0 ] || fail "real gofmt debt must block the push"
  printf '%s\n' "$out" | grep -qx 'internal/ours.go' \
    || fail "the verdict must name the offending file root-relative, got: $out"
  printf '%s\n' "$out" | grep -qv 'nix-store' \
    || fail "the verdict must not mention nix-store, got: $out"
  printf '%s\n' "$out" | grep -qv 'worktrees' \
    || fail "the verdict must not mention a sibling worker's worktree (#2134), got: $out"
  [ "$(printf '%s\n' "$out" | wc -l)" -le 2 ] \
    || fail "the verdict must be the debt and nothing else, got: $out"
  pass=$((pass+1))

  # A scan that finds no Go file at all is a broken scan, not a clean tree:
  # fail CLOSED rather than wave a push through unchecked.
  rc=0; gate_gofmt_stage "$(mktemp -d)" >/dev/null 2>&1 || rc=$?
  [ "$rc" -ne 0 ] || fail "a scan that found no Go files must fail closed (#1458)"
  pass=$((pass+1))

  rm -rf "$fmtrepo"
fi

# End to end: with the env unset, gate_run takes the docs tier from the repo's own
# .sandcastle/docs-gate.globs — and a repo without one has no docs tier.
gr="$(mktemp -d)"; mkdir -p "$gr/.sandcastle"; echo 'docs/slices/*' > "$gr/.sandcastle/docs-gate.globs"
grmark="$gr/ran"
printf 'docs/slices/x.mermaid\n' | GATE_DOCS_GLOBS='' GATE_DOCS_CMD="touch '$grmark'" gate_run "$gr" 2>/dev/null
[ -f "$grmark" ] || fail "gate_run must read the per-repo docs-gate.globs and run the docs stage"; pass=$((pass+1))
rm -f "$gr/.sandcastle/docs-gate.globs" "$grmark"
printf 'docs/slices/x.mermaid\n' | GATE_DOCS_GLOBS='' GATE_DOCS_CMD="touch '$grmark'" gate_run "$gr" 2>/dev/null
[ ! -f "$grmark" ] || fail "a repo with no docs-gate.globs must have no docs tier (#47)"; pass=$((pass+1))
rm -rf "$gr"

echo "gate-lib: $pass checks passed"
