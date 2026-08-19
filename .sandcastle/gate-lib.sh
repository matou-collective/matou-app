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
# The Go stages run through the repo's pinned dev shell (ADR 0040: one toolchain
# for CI, Sandcastle and humans) via `nix develop .#go-ci` — the lean shell that
# carries the exact `go`/`golangci-lint` the seam runs, flake.lock-pinned, no
# ad-hoc download. Tests override that command with GATE_GO_CMD so the logic is
# driven offline without a Go toolchain present.
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
# function so gate_go_stage can substitute GATE_GO_CMD in tests.
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

# gate_go_stage <root> — run the Go gate for a Go-touching change. Uses
# GATE_GO_CMD when set (tests), else the pinned dev-shell stages. If neither a
# GATE_GO_CMD nor `nix` is available, FAIL CLOSED: a Go change that cannot be
# linted must block the push, never slip through un-linted (the whole point of
# #198 — a blocked push beats a red main). Returns the stage's exit code.
gate_go_stage() {
  local root="$1"
  if [ -n "${GATE_GO_CMD:-}" ]; then
    ( cd "$root" && gate_scrub_git_env && eval "$GATE_GO_CMD" )
    return $?
  fi
  if ! command -v nix >/dev/null 2>&1; then
    echo "gate: Go change detected but no Go toolchain (nix) in this sandbox." >&2
    echo "gate: refusing to push un-linted Go (issue #198) — rebuild the sandbox image." >&2
    return 3
  fi
  ( cd "$root" && gate_scrub_git_env && gate_go_default_cmd "$root" )
}

# gate_run <root> — read the changed-file list on stdin, decide which language
# gates to run, run them. Go changes run the Go stage; a TypeScript-only or
# untyped change is a skip (the sandbox lints TS in-loop, so a TS-only push is no
# slower). Returns non-zero if any stage failed.
gate_run() {
  local root="$1" langs rc=0
  langs="$(gate_langs_for_files)"
  if [ -z "$langs" ]; then
    echo "gate: no gated language touched — nothing to check" >&2
    return 0
  fi
  if grep -qx go <<<"$langs"; then
    echo "gate: Go change detected — running the pinned Go seam stages" >&2
    gate_go_stage "$root" || rc=$?
  elif grep -qx ts <<<"$langs"; then
    echo "gate: TypeScript-only change — Go stages skipped (pnpm lint runs in-loop)" >&2
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
