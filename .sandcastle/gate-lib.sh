#!/usr/bin/env bash
# Pre-push language gate (issue #198) — pure, sourceable functions.
#
# Before a Sandcastle worker's push lands, run the pinned Go seam stages over
# any Go change so a lint/build/test defect is caught HERE — a worker-visible
# failure — instead of on main's seam (the #193/#195 pattern: two Go lint
# defects reached main un-linted in one evening because the sandbox had no Go
# toolchain). A change that touches no gated language, or TypeScript only, skips
# the Go stages, so its push is no slower than before (the sandbox already runs
# `pnpm lint` in-loop).
#
# By default the Go stages run through the repo's pinned dev shell (ADR 0040: one
# toolchain for CI, Sandcastle and humans) via `nix develop .#go-ci` — the lean
# shell that carries the exact `go`/`golangci-lint` the seam runs, flake.lock-
# pinned, no ad-hoc download. A consumer whose layout/toolchain differs from that
# default supplies a supported per-repo override — GATE_GO_CMD (env, set in the
# sandbox Dockerfile) or an executable `.sandcastle/go-gate.sh` — which also
# drives the logic offline in tests without a Go toolchain present (issue #126).
#
# .sandcastle/gate.sh wires these to git's pre-push stdin;
# .sandcastle/tests/gate-lib-test.sh drives them offline.

GATE_ZERO_SHA=0000000000000000000000000000000000000000

# gate_langs_for_files — read newline-separated repo paths on stdin, echo the
# set of language tokens the change touches ("go" and/or "ts"), one per line,
# sorted and unique. A path that maps to no gated toolchain contributes nothing.
gate_langs_for_files() {
  local f
  {
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      case "$f" in
        *.go|go.mod|go.sum|go.work|go.work.sum|.golangci.yml|.golangci.yaml)
          echo go ;;
      esac
      case "$f" in
        *.ts|*.tsx|*.vue|*.mts|*.cts|package.json|pnpm-lock.yaml|pnpm-workspace.yaml|tsconfig*.json)
          echo ts ;;
      esac
    done
  } | sort -u
}

# gate_go_default_cmd <root> — the real Go gate: the seam's Go stages, run inside
# the pinned lean dev shell. Mirrors scripts/seam-smoke.sh's Go section (gofmt,
# build, vet, test, lint — main module + broker + the `dev`-tag build ADR 0100 excludes
# from the production build) so a Go slice cannot ship un-linted. Kept a separate
# function so gate_go_stage can substitute a per-repo override (GATE_GO_CMD or an
# executable .sandcastle/go-gate.sh) — which is also the offline test seam.
gate_go_default_cmd() {
  local root="$1"
  nix develop "$root#go-ci" --command bash -euo pipefail -c '
    unformatted="$(gofmt -l . | grep -v "^node_modules/" || true)"
    if [ -n "$unformatted" ]; then
      echo "gofmt debt — run gofmt -w on:"; printf "%s\n" "$unformatted"; exit 1
    fi
    go build ./...
    go vet ./...
    go test ./...
    golangci-lint run ./...
    go build -tags dev ./...
    go vet -tags dev ./...
    cd broker
    go build ./...
    go vet ./...
    go test ./...
    golangci-lint run ./...
  '
}

# gate_ts_default_cmd <root> — the real TypeScript lint gate: the seam's TS lint
# stage (`pnpm run lint`, i.e. eslint), run inside the pinned default dev shell
# (ADR 0040: one toolchain for CI, Sandcastle and humans). Mirrors
# scripts/seam-smoke.sh's "lint (eslint)" step so a TS slice cannot ship
# un-linted (#1252). `pnpm install --frozen-lockfile --prefer-offline` runs
# first so a freshly-vendored checkout has node_modules; it is a fast no-op when
# they are already present. Kept a separate function so gate_ts_stage can
# substitute a per-repo override (GATE_TS_CMD or an executable
# .sandcastle/ts-gate.sh) — which is also the offline test seam.
gate_ts_default_cmd() {
  local root="$1"
  nix develop "$root#default" --command bash -euo pipefail -c '
    pnpm install --frozen-lockfile --prefer-offline
    pnpm run lint
  '
}

# gate_scrub_git_env — unset the environment variables git injects when it runs
# a hook (GIT_DIR, GIT_INDEX_FILE, …). The pre-push hook runs inside git's own
# environment, and those vars otherwise LEAK into the seam's `go test`: nix reads
# GIT_DIR and mis-evaluates the flake, and any test that shells out to
# `git -C <tmpdir>` (internal/member, internal/rescue seed a throwaway config
# repo) targets THIS repo instead of its tempdir — "nothing to commit" on the
# worker's own branch. Call it inside the stage subshell so the language stages
# run as a plain checkout. Unsetting an already-unset var is a no-op.
gate_scrub_git_env() {
  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_PREFIX \
        GIT_OBJECT_DIRECTORY GIT_QUARANTINE_PATH GIT_INTERNAL_GITDIR 2>/dev/null || true
}

# gate_go_stage <root> — run the Go gate for a Go-touching change. Resolves the
# Go command by a first-match-wins precedence so a consumer whose layout/toolchain
# differs from the nix default can satisfy the gate without editing the vendored
# file (issue #126):
#   1. GATE_GO_CMD — a supported per-repo override (set it in the sandbox
#      Dockerfile's ENV); it also serves as the offline test seam;
#   2. an executable per-repo `.sandcastle/go-gate.sh` — auto-detected, run
#      through the same git-env-scrubbed `cd "$root"` subshell as GATE_GO_CMD.
#      Not in FACTORY_MANIFEST, so it stays a per-repo layer file (drift-safe);
#   3. the pinned nix dev-shell default (gate_go_default_cmd).
# FAIL CLOSED only when NONE of the three resolve — no GATE_GO_CMD, no executable
# `.sandcastle/go-gate.sh`, no `nix`: a Go change that cannot be linted must block
# the push, never slip through un-linted (the whole point of #198 — a blocked
# push beats a red main). Returns the stage's exit code.
gate_go_stage() {
  local root="$1"
  if [ -n "${GATE_GO_CMD:-}" ]; then
    ( cd "$root" && gate_scrub_git_env && eval "$GATE_GO_CMD" )
    return $?
  fi
  if [ -x "$root/.sandcastle/go-gate.sh" ]; then
    ( cd "$root" && gate_scrub_git_env && ./.sandcastle/go-gate.sh )
    return $?
  fi
  if ! command -v nix >/dev/null 2>&1; then
    echo "gate: Go change detected but no supported Go gate resolved in this sandbox." >&2
    echo "gate: refusing to push un-linted Go (issue #198). Cause is either a missing" >&2
    echo "gate: Go toolchain (no \`nix\`) OR a layout that differs from the nix default." >&2
    echo "gate: set a supported per-repo override — GATE_GO_CMD in the sandbox Dockerfile," >&2
    echo "gate: or an executable .sandcastle/go-gate.sh — to run this repo's Go gate." >&2
    return 3
  fi
  ( cd "$root" && gate_scrub_git_env && gate_go_default_cmd "$root" )
}

# gate_ts_stage <root> — run the TypeScript lint gate for a TS-touching change.
# Same first-match-wins precedence as gate_go_stage so a consumer whose
# layout/toolchain differs from the nix default can satisfy the gate without
# editing this vendored file:
#   1. GATE_TS_CMD — a supported per-repo override (env; also the offline test
#      seam);
#   2. an executable per-repo `.sandcastle/ts-gate.sh` — auto-detected, run
#      through the same git-env-scrubbed `cd "$root"` subshell as GATE_TS_CMD.
#      Not in FACTORY_MANIFEST, so it stays a per-repo layer file (drift-safe);
#   3. the pinned nix dev-shell default (gate_ts_default_cmd).
# FAIL CLOSED only when NONE of the three resolve — no GATE_TS_CMD, no executable
# `.sandcastle/ts-gate.sh`, no `nix`: a TS change that cannot be linted must
# block the push, never slip through un-linted (#1252 — a TS lint break reaches
# main and is caught only post-push by ci; a blocked push beats a red main).
# Returns the stage's exit code.
gate_ts_stage() {
  local root="$1"
  if [ -n "${GATE_TS_CMD:-}" ]; then
    ( cd "$root" && gate_scrub_git_env && eval "$GATE_TS_CMD" )
    return $?
  fi
  if [ -x "$root/.sandcastle/ts-gate.sh" ]; then
    ( cd "$root" && gate_scrub_git_env && ./.sandcastle/ts-gate.sh )
    return $?
  fi
  if ! command -v nix >/dev/null 2>&1; then
    echo "gate: TypeScript change detected but no supported TS gate resolved in this workdir." >&2
    echo "gate: refusing to push un-linted TypeScript (#1252). Cause is either a missing" >&2
    echo "gate: toolchain (no \`nix\`) OR a layout that differs from the nix default." >&2
    echo "gate: set a supported per-repo override — GATE_TS_CMD in the sandbox Dockerfile," >&2
    echo "gate: or an executable .sandcastle/ts-gate.sh — to run this repo's TS lint gate." >&2
    return 3
  fi
  ( cd "$root" && gate_scrub_git_env && gate_ts_default_cmd "$root" )
}

# gate_gofmt_default_cmd <root> — the cheap gofmt-only check: `gofmt -l` over the
# tree (mirrors the gofmt step of gate_go_default_cmd / seam-smoke.sh's #344
# stage), with NO nix shell and NO compile — a pure parse+print, sub-second on a
# large tree. That is the whole reason a gofmt gate can run on the HOST push path
# where the full Go seam (build/vet/test/lint) cannot (#198): it costs nothing.
# Assumes cwd is <root> (its caller cd's there inside the git-env-scrub subshell).
gate_gofmt_default_cmd() {
  local unformatted
  unformatted="$(gofmt -l . | grep -v '^node_modules/' || true)"
  if [ -n "$unformatted" ]; then
    echo "gofmt debt — run gofmt -w on:" >&2
    printf '%s\n' "$unformatted" >&2
    return 1
  fi
}

# gate_gofmt_stage <root> — run the gofmt-only gate for a Go-touching change on
# the HOST push path (Gate 3b, #1458). The Go twin of the TS host gate (#1252):
# gofmt debt reaches `main` through the HOST reconcile/session push, not only the
# sandbox — f291b547 (#1429) landed un-gofmt'd because Gate 3 (the full Go seam)
# is sandbox-only and the host path ran no Go check at all, red'ing #344 on main.
# UNLIKE gate_go_stage this never enters a nix shell; it resolves gofmt by a
# first-match-wins precedence and runs only the pure formatting check:
#   1. GATE_GOFMT_CMD — a supported override (env); also the offline test seam;
#   2. a `gofmt` on PATH — the ordinary host case (the pinned dev shell every
#      reconcile host already sources puts gofmt there), run bare.
# FAIL CLOSED when neither resolves — no GATE_GOFMT_CMD and no `gofmt`: a Go
# change whose formatting cannot be checked blocks the push, exactly as the TS
# gate fails closed (#1252 — a blocked push beats a red main). Returns the
# stage's exit code.
gate_gofmt_stage() {
  local root="$1"
  if [ -n "${GATE_GOFMT_CMD:-}" ]; then
    ( cd "$root" && gate_scrub_git_env && eval "$GATE_GOFMT_CMD" )
    return $?
  fi
  if command -v gofmt >/dev/null 2>&1; then
    ( cd "$root" && gate_scrub_git_env && gate_gofmt_default_cmd "$root" )
    return $?
  fi
  echo "gate: Go change detected but no gofmt resolved on the host push path." >&2
  echo "gate: refusing to push un-gofmt'd Go (#1458). Put \`gofmt\` on PATH (it ships" >&2
  echo "gate: in the repo's pinned dev shell) or set GATE_GOFMT_CMD to this repo's" >&2
  echo "gate: gofmt check. The full Go seam stays sandbox-only (#198); only the cheap" >&2
  echo "gate: gofmt check runs on the host push path." >&2
  return 3
}

# gate_run <root> [only] [go_tier] — read the changed-file list on stdin, decide
# which language gates to run, run them. A Go change runs the Go gate; a
# TypeScript change runs the eslint lint gate (#1252 — TS lint breaks reached
# main un-gated). The optional <only> ("go"|"ts") restricts execution to a single
# language. The optional <go_tier> selects HOW DEEP the Go gate runs when a Go
# change is present: "full" (default) runs the pinned Go seam stages (sandbox);
# "gofmt" runs only the cheap gofmt-only host gate (Gate 3b, #1458). The pre-push
# hook uses go_tier=gofmt on the HOST push path so a formatting break is caught
# there (where f291b547/#1429 slipped past) while the heavy Go seam stays
# sandbox-only (#198). Returns non-zero if any stage that ran failed.
gate_run() {
  local root="$1" only="${2:-}" go_tier="${3:-full}" langs rc=0
  langs="$(gate_langs_for_files)"
  if [ -z "$langs" ]; then
    echo "gate: no gated language touched — nothing to check" >&2
    return 0
  fi
  if [ -z "$only" ] || [ "$only" = go ]; then
    if grep -qx go <<<"$langs"; then
      if [ "$go_tier" = gofmt ]; then
        echo "gate: Go change detected — running the cheap gofmt-only host gate (#1458)" >&2
        gate_gofmt_stage "$root" || rc=$?
      else
        echo "gate: Go change detected — running the pinned Go seam stages" >&2
        gate_go_stage "$root" || rc=$?
      fi
    fi
  fi
  if [ -z "$only" ] || [ "$only" = ts ]; then
    if grep -qx ts <<<"$langs"; then
      echo "gate: TypeScript change detected — running the pinned eslint lint gate" >&2
      gate_ts_stage "$root" || rc=$?
    fi
  fi
  return $rc
}

# gate_files_from_prepush — read git's pre-push stdin
# (`<local-ref> <local-sha> <remote-ref> <remote-sha>` per line) and echo the
# union of files changed across every pushed ref, one per line, sorted-unique.
# A branch deletion (all-zero local sha) contributes nothing. When the remote
# sha is unknown (new ref / zero), fall back to the merge-base with origin/main,
# then to the commit's own diff.
gate_files_from_prepush() {
  local lref lsha rref rsha base
  {
    while read -r lref lsha rref rsha; do
      [ -n "${lsha:-}" ] || continue
      case "$lsha" in *[!0]*) : ;; *) continue ;; esac  # all-zero = branch delete
      if [ -n "${rsha:-}" ] && [ "$rsha" != "$GATE_ZERO_SHA" ] &&
         git cat-file -e "$rsha^{commit}" 2>/dev/null; then
        base="$rsha"
      else
        base="$(git merge-base "$lsha" origin/main 2>/dev/null || true)"
      fi
      if [ -n "$base" ]; then
        git diff --name-only "$base" "$lsha"
      else
        git show --name-only --format= "$lsha"
      fi
    done
  } | sort -u
}
