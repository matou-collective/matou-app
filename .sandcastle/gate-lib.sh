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
# set of language tokens the change touches ("go", "ts", "docs" and/or "sh"),
# one per line, sorted and unique. A path that maps to no gated toolchain
# contributes nothing. "docs" is the diagram-source tier: the trees whose
# mermaid/slice-map contracts the seam enforces (#343, #834) but which carry NO
# go/ts token, so a docs-only change was invisible to the pre-push gate and its
# break was CI-only (GOTCHAS #143, the bare-`%%` that red CI a second time).
# "sh" is the shellcheck tier (#379): a shell-script change the `ci / static`
# job's `shellcheck -S warning -x` would scan but which the push gate never did,
# so an SC regression was CI-only and landed on main first (#360, #371, #378).
# The sh mapping is deliberately by EXTENSION / universal harness filename, never
# by ci.yml's factory-ROOT dir globs (onboarding/, tests/, .forgejo/): those are
# this repo's own layout, and a vendored file must name no product-specific path
# (CLAUDE.md blast radius; ci.yml is NOT vendored). So any *.sh, the extension-
# less harness hooks (git-hooks/*) and git-fence map to sh in EVERY consumer — a
# superset of the factory's own scan set, which only tightens the gate.
#
# WHICH trees are diagram sources is per-repo (a vendored script must never name a
# consumer's doc paths — #47): GATE_DOCS_GLOBS, space-separated shell globs. Unset
# means no docs tier. gate_run fills it from the repo's own
# .sandcastle/docs-gate.globs (one glob per line, # comments) when the env is unset.
gate_langs_for_files() {
  local f g
  {
    set -f  # (a pipe subshell) the globs are case patterns, never cwd-expanded
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
      case "$f" in
        *.sh|git-fence|git-hooks/*) echo sh ;;
      esac
      if [ -n "${GATE_DOCS_GLOBS:-}" ]; then
        for g in $GATE_DOCS_GLOBS; do
          # shellcheck disable=SC2254  # $g is a glob, matched on purpose
          case "$f" in $g) echo docs; break ;; esac
        done
      fi
    done
  } | sort -u
}

# gate_sh_files — read newline-separated repo paths on stdin, echo the subset
# that is a shell script the shellcheck tier covers (the sh token's members, same
# extension/universal-filename mapping as gate_langs_for_files), one per line.
# The shellcheck tier is CHANGED-FILE-SCOPED — a whole-tree `shellcheck -S
# warning -x` is ~3 min, too slow for a push; a handful of files is sub-second —
# so gate_run passes exactly these paths to gate_shellcheck_stage.
gate_sh_files() {
  local f
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in
      *.sh|git-fence|git-hooks/*) printf '%s\n' "$f" ;;
    esac
  done
}

# gate_docs_globs <root> — echo the docs-tier globs: GATE_DOCS_GLOBS if set, else
# the repo's per-repo-layer .sandcastle/docs-gate.globs (not in FACTORY_MANIFEST,
# so drift-safe), else nothing.
gate_docs_globs() {
  local root="$1"
  if [ -n "${GATE_DOCS_GLOBS:-}" ]; then
    printf '%s\n' "$GATE_DOCS_GLOBS"
  elif [ -f "$root/.sandcastle/docs-gate.globs" ]; then
    sed -e 's/#.*//' -e 's/[[:space:]]*$//' "$root/.sandcastle/docs-gate.globs" | grep -v '^[[:space:]]*$' | tr '\n' ' '
  fi
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
    gofiles="$(find . -type f -name "*.go" \
      -not -path "./node_modules/*" -not -path "./.sandcastle/nix-store/*" \
      -not -path "./.sandcastle/worktrees/*" \
      -printf "%P\\n" 2>/dev/null || true)"
    if [ -z "$gofiles" ]; then
      echo "gofmt debt check FAILED: found no Go files to scan — refusing to pass" >&2; exit 1
    fi
    unformatted="$(printf "%s\\n" "$gofiles" | xargs -d "\\n" -r gofmt -l || true)"
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

# gate_nix_available — true when a usable `nix` is on PATH to run the pinned dev
# shells. Factored out of the stage functions so the offline test can force the
# no-toolchain path deterministically with GATE_NO_NIX=1 — proving the fail-closed
# arms on EVERY host, not only CI's nix-less runners. The arms used to be gated
# behind a `command -v nix` skip in the test, so a fail-closed assertion that
# resolved a per-repo override (this repo's own .sandcastle/ts-gate.sh, #312) was
# green on the nix-having author/pool hosts and red on CI (#314). Default
# behaviour is unchanged: with GATE_NO_NIX unset it is exactly `command -v nix`.
gate_nix_available() {
  [ "${GATE_NO_NIX:-}" = 1 ] && return 1
  command -v nix >/dev/null 2>&1
}

# gate_shellcheck_available — true when a usable `shellcheck` is on PATH. Factored
# out of gate_shellcheck_stage (the #379 tier) exactly like gate_nix_available, so
# the offline test can force the no-shellcheck path deterministically with
# GATE_NO_SHELLCHECK=1 — proving BOTH the fail-open default AND the
# GATE_SHELLCHECK_REQUIRE fail-closed arm on EVERY host, not only ones that happen
# to carry shellcheck (the #314 lesson: a `command -v` skip hides an arm on the
# author/pool hosts and reds CI). Default behaviour is unchanged: with
# GATE_NO_SHELLCHECK unset it is exactly `command -v shellcheck`.
gate_shellcheck_available() {
  [ "${GATE_NO_SHELLCHECK:-}" = 1 ] && return 1
  command -v shellcheck >/dev/null 2>&1
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
  if ! gate_nix_available; then
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
  if ! gate_nix_available; then
    echo "gate: TypeScript change detected but no supported TS gate resolved in this workdir." >&2
    echo "gate: refusing to push un-linted TypeScript (#1252). Cause is either a missing" >&2
    echo "gate: toolchain (no \`nix\`) OR a layout that differs from the nix default." >&2
    echo "gate: set a supported per-repo override — GATE_TS_CMD in the sandbox Dockerfile," >&2
    echo "gate: or an executable .sandcastle/ts-gate.sh — to run this repo's TS lint gate." >&2
    return 3
  fi
  ( cd "$root" && gate_scrub_git_env && gate_ts_default_cmd "$root" )
}

# gate_gofmt_tree_go_files — newline-separated, root-relative list of the repo's
# OWN Go files: the tree minus the gitignored local build artifacts that carry
# FOREIGN Go — `node_modules/`, `.sandcastle/nix-store/` and `.sandcastle/worktrees/`.
# Pruning the scan's INPUT (not filtering its output) is what keeps the verdict
# readable: a nix store ships the Go distribution's own `src/`, whose
# deliberately-malformed testdata makes gofmt print hundreds of parse errors
# before any verdict at all.
#
# The nix-store entry is why the host gofmt gate never worked. Gate 3b landed
# 2026-09-12, one day AFTER a nix store appeared in the swarm workdir, and that
# store holds ~340 files gofmt calls unformatted. So every Go push from a workdir
# carrying one was blocked by a verdict about files this repo does not own and
# cannot fix, whatever the pushed code looked like. CI never saw it (a clean
# checkout has no nix-store), leaving #344 the only honest gofmt verdict — and a
# gate that always blocks is a gate that gets bypassed, which is how gofmt debt
# reached main again in ce04cd10, the repeat of f291b547/#1429 Gate 3b exists to
# stop. Prune the input, never the exit status: the gate still fails closed.
# Assumes cwd is the repo root.
gate_gofmt_tree_go_files() {
  find . -type f -name '*.go' \
    -not -path './node_modules/*' -not -path './.sandcastle/nix-store/*' \
    -not -path './.sandcastle/worktrees/*' \
    -printf '%P\n' 2>/dev/null || true
}

# gate_gofmt_default_cmd <root> — the cheap gofmt-only check: `gofmt -l` over the
# tree (mirrors the gofmt step of gate_go_default_cmd / seam-smoke.sh's #344
# stage), with NO nix shell and NO compile — a pure parse+print, sub-second on a
# large tree. That is the whole reason a gofmt gate can run on the HOST push path
# where the full Go seam (build/vet/test/lint) cannot (#198): it costs nothing.
# Assumes cwd is <root> (its caller cd's there inside the git-env-scrub subshell).
gate_gofmt_default_cmd() {
  local gofiles unformatted
  gofiles="$(gate_gofmt_tree_go_files)"
  # No Go file at all in a repo whose pushed range touched Go means the pruner or
  # the cwd is wrong, not that the tree is clean. Fail CLOSED, like the missing-
  # gofmt arm of gate_gofmt_stage: a blocked push beats a red main (#1458).
  if [ -z "$gofiles" ]; then
    echo "gate: gofmt check found no Go files to scan under $PWD — refusing to" >&2
    echo "gate: report a clean tree it never looked at (#1458). Fix the scan." >&2
    return 4
  fi
  unformatted="$(printf '%s\n' "$gofiles" | xargs -d '\n' -r gofmt -l || true)"
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

# gate_docs_default_cmd <root> — the cheap docs-diagram check: the repo's in-repo
# mermaid-parse (#343) and slice-map YAML (#834) checkers over the diagram trees,
# run with plain `node` — NO nix, NO build — so it costs the host push path next
# to nothing, the docs twin of gate_gofmt_default_cmd (#1458). Runs the SAME two
# commands scripts/seam-smoke.sh's `Docs:` stages run (bare, i.e. the checkers'
# own DEFAULT_TARGETS: architecture + slices + ux/flows for mermaid, slices for
# the yaml), so a bare `%%` (GOTCHAS #143) or an unquoted `#` can no longer reach
# main CI-only. Assumes cwd is <root> (its caller cd's there in the scrub subshell).
#
# check-mermaid.mjs resolves happy-dom out of app/node_modules and its exit code
# is a THREE-way contract this stage must honour — the GOTCHAS #400 shape in a
# docs tier (a sandbox with no `pnpm install` has no happy-dom):
#   0  every block parses        -> go on to the yaml check;
#   1  a block will NOT parse     -> a real docs break, refuse the push;
#   *  the checker CRASHED (the    -> a HARNESS fault: refuse LOUDLY and NAME it
#      usual cause: no happy-dom)     (never report a crash as a broken diagram,
#                                      never silently skip — #400).
# The yaml checker has no DOM dependency; its exit 1 is a truncated scalar.
gate_docs_default_cmd() {
  local rc
  node scripts/check-mermaid.mjs
  rc=$?
  if [ "$rc" -eq 1 ]; then
    return 1
  elif [ "$rc" -ne 0 ]; then
    echo "gate: the mermaid-parse checker CRASHED (exit $rc) — a HARNESS fault, not a" >&2
    echo "gate: broken diagram. The usual cause is a missing \`happy-dom\` in" >&2
    echo "gate: app/node_modules (check-mermaid.mjs resolves it there; a sandbox with" >&2
    echo "gate: no \`pnpm install\` has none — GOTCHAS #400). Refusing to pass: a crash" >&2
    echo "gate: must never be reported as a parse failure, nor silently skipped." >&2
    return 3
  fi
  node scripts/check-slices-yaml.mjs
  rc=$?
  [ "$rc" -eq 0 ] || return 1
}

# gate_docs_stage <root> — run the docs-diagram gate for a docs-touching change
# on EVERY push path (GOTCHAS #143's bare-`%%` red CI a SECOND time because the
# push gate had no docs tier: a diagram break was CI-only, one run too late, on a
# branch a human had to re-open). The docs twin of gate_gofmt_stage: cheap, never
# enters a nix shell. Resolves the docs command by a first-match-wins precedence
# so a consumer whose layout/toolchain differs can satisfy the gate without
# editing this vendored file:
#   1. GATE_DOCS_CMD — a supported override (env); also the offline test seam;
#   2. an executable per-repo .sandcastle/docs-gate.sh — auto-detected, run
#      through the same git-env-scrubbed `cd "$root"` subshell. Not in
#      FACTORY_MANIFEST, so it stays a per-repo layer file (drift-safe);
#   3. a `node` on PATH — run the repo's in-repo checkers (gate_docs_default_cmd).
# FAIL CLOSED when NONE resolve — no GATE_DOCS_CMD, no executable
# .sandcastle/docs-gate.sh, no `node`: a docs change whose diagrams cannot be
# checked blocks the push, exactly as the Go/TS gates fail closed (a blocked push
# beats a red main). Returns the stage's exit code.
gate_docs_stage() {
  local root="$1"
  if [ -n "${GATE_DOCS_CMD:-}" ]; then
    ( cd "$root" && gate_scrub_git_env && eval "$GATE_DOCS_CMD" )
    return $?
  fi
  if [ -x "$root/.sandcastle/docs-gate.sh" ]; then
    ( cd "$root" && gate_scrub_git_env && ./.sandcastle/docs-gate.sh )
    return $?
  fi
  if ! command -v node >/dev/null 2>&1; then
    echo "gate: docs-diagram change detected but no supported docs gate resolved." >&2
    echo "gate: refusing to push un-checked diagrams (GOTCHAS #143). Cause is either a" >&2
    echo "gate: missing \`node\` OR a layout that differs from the default. Set a" >&2
    echo "gate: supported override — GATE_DOCS_CMD, or an executable" >&2
    echo "gate: .sandcastle/docs-gate.sh — to run this repo's docs checkers." >&2
    return 3
  fi
  ( cd "$root" && gate_scrub_git_env && gate_docs_default_cmd "$root" )
}

# gate_shellcheck_default_cmd <root> <file...> — the real shellcheck tier: run
# `shellcheck -S warning -x` (byte-for-byte the severity + `-x` follow-sources
# flags the `ci / static` job runs) over ONLY the changed shell files passed as
# args. Changed-file-scoped by design: a whole-tree run is ~3 min, too slow for a
# push, while a handful of files is sub-second — cheap enough to run on the HOST
# push path too, which is where #360/#371/#378 all slipped past CI-only. `-x`
# follows `# shellcheck source=` directives (the repo's .shellcheckrc sets
# source-path=SCRIPTDIR); the full checkout means every sourced lib resolves.
# Assumes cwd is <root> (its caller cd's there in the git-env-scrub subshell), so
# the repo-root .shellcheckrc applies. A call with no files is a no-op pass — the
# caller only reaches here when the sh token fired, i.e. at least one file.
gate_shellcheck_default_cmd() {
  local root="$1"; shift
  [ "$#" -gt 0 ] || return 0
  shellcheck -S warning -x "$@"
}

# gate_shellcheck_stage <root> <file...> — run the shellcheck tier for a
# shell-touching change on EVERY push path (#379). Resolves shellcheck by a
# first-match-wins precedence, like the sibling tiers:
#   1. GATE_SHELLCHECK_CMD — a supported per-repo override (env; also the offline
#      test seam). It receives the changed shell files as positional parameters
#      ("$@"), so an override can stay changed-file-scoped;
#   2. a `shellcheck` on PATH — run `shellcheck -S warning -x` over the changed
#      files (gate_shellcheck_default_cmd).
#
# When NEITHER resolves the posture is DELIBERATELY fail-OPEN — a LOUD warning,
# then pass — UNLESS GATE_SHELLCHECK_REQUIRE=1, which flips it fail-CLOSED like
# the Go/TS/docs tiers. This is the #379 ruling (ADR 0174 — veto anytime), and it
# is why this tier ALONE among the gate's tiers defaults fail-open:
#   * shellcheck is NOT provisioned-by-contract across the fleet. gofmt ships in
#     every pinned dev shell, node in every docs consumer, nix is the toolchain
#     contract — but shellcheck is absent from at least one pool host's PATH, and
#     the factory carries no nix flake providing it (ci/static tarball-FETCHES a
#     pinned build, and #332/#333 proved that fetch fraught).
#   * A fail-CLOSED tier that resolved no shellcheck would block the live
#     reconcile/session rail for EVERY shell-touching push — nearly every harness
#     push — across all consumers: a fleet-wide outage, far worse than the CI-only
#     SC reds this tier is meant to pre-empt.
# So the tier CATCHES SC regressions wherever a shellcheck is present (the sandbox
# image, a provisioned host, or via GATE_SHELLCHECK_CMD) and WARNS LOUDLY — never
# silently, the gofmt-bypass lesson — where it is not, until a consumer that has
# provisioned shellcheck sets GATE_SHELLCHECK_REQUIRE=1 to enforce it here. The
# fleet-wide provisioning + the flip to required are the follow-up a host/flake
# standing settles, not this code change. Returns the stage's exit code.
gate_shellcheck_stage() {
  local root="$1"; shift
  if [ -n "${GATE_SHELLCHECK_CMD:-}" ]; then
    ( cd "$root" && gate_scrub_git_env && eval "$GATE_SHELLCHECK_CMD" )
    return $?
  fi
  if gate_shellcheck_available; then
    ( cd "$root" && gate_scrub_git_env && gate_shellcheck_default_cmd "$root" "$@" )
    return $?
  fi
  if [ "${GATE_SHELLCHECK_REQUIRE:-}" = 1 ]; then
    echo "gate: shell change detected but no shellcheck resolved, and GATE_SHELLCHECK_REQUIRE=1." >&2
    echo "gate: refusing to push un-shellchecked shell (#379 fail-closed). Put \`shellcheck\` on" >&2
    echo "gate: PATH (ci/static pins v0.11.0) or set GATE_SHELLCHECK_CMD to this repo's tier." >&2
    return 3
  fi
  echo "gate: WARNING — shell change detected but no shellcheck resolved; SKIPPING the" >&2
  echo "gate: shellcheck tier (fail-OPEN by default, #379). An SC -S warning regression will" >&2
  echo "gate: be caught only by ci/static AFTER this lands (as #360/#371/#378 were). Provision" >&2
  echo "gate: \`shellcheck\` on PATH (or GATE_SHELLCHECK_CMD) + GATE_SHELLCHECK_REQUIRE=1 to enforce here." >&2
  return 0
}

# gate_run <root> [only] [go_tier] — read the changed-file list on stdin, decide
# which language gates to run, run them. A Go change runs the Go gate; a
# TypeScript change runs the eslint lint gate (#1252 — TS lint breaks reached
# main un-gated); a docs-diagram change runs the cheap mermaid/slice-map checkers
# (GOTCHAS #143 — a docs break was CI-only until the gate grew a docs tier); a
# shell change runs the scoped shellcheck tier (#379 — an SC regression was
# CI-only until the gate grew an sh tier). The optional <only>
# ("go"|"ts"|"docs"|"sh") restricts execution to a single language. The optional
# <go_tier> selects HOW DEEP the Go gate runs when a Go change is present: "full"
# (default) runs the pinned Go seam stages (sandbox); "gofmt" runs only the cheap
# gofmt-only host gate (Gate 3b, #1458). The pre-push hook uses go_tier=gofmt on
# the HOST push path so a formatting break is caught there (where f291b547/#1429
# slipped past) while the heavy Go seam stays sandbox-only (#198). The docs and sh
# tiers are cheap on every path, so they run regardless of go_tier.
# Returns non-zero if any stage that ran failed.
gate_run() {
  local root="$1" only="${2:-}" go_tier="${3:-full}" files langs rc=0
  # Capture stdin once: the lang set AND the sh tier's changed-file list both read
  # it, and stdin can be consumed only once (the sh tier is changed-file-scoped).
  files="$(cat)"
  langs="$(printf '%s\n' "$files" | GATE_DOCS_GLOBS="$(gate_docs_globs "$root")" gate_langs_for_files)"
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
  if [ -z "$only" ] || [ "$only" = docs ]; then
    if grep -qx docs <<<"$langs"; then
      echo "gate: docs-diagram change detected — running the cheap mermaid/slice-map checkers (GOTCHAS #143)" >&2
      gate_docs_stage "$root" || rc=$?
    fi
  fi
  if [ -z "$only" ] || [ "$only" = sh ]; then
    if grep -qx sh <<<"$langs"; then
      # The sh token fired, so there is at least one changed shell file; collect
      # them (newline-separated repo paths, no spaces) and pass them scoped to the
      # stage — a changed-file run, never a whole-tree ~3 min scan (#379).
      local _l; local -a _shf=()
      while IFS= read -r _l; do [ -n "$_l" ] && _shf+=("$_l"); done \
        < <(printf '%s\n' "$files" | gate_sh_files)
      echo "gate: shell change detected — running the scoped shellcheck tier (#379)" >&2
      gate_shellcheck_stage "$root" "${_shf[@]}" || rc=$?
    fi
  fi
  return $rc
}

# gate_files_from_prepush — read git's pre-push stdin
# (`<local-ref> <local-sha> <remote-ref> <remote-sha>` per line) and echo the
# union of files changed across every pushed ref, one per line, sorted-unique.
# A branch deletion (all-zero local sha) contributes nothing.
#
# Base selection — scope the gate to the change this push adds on top of main,
# never to the full delta from an ancient remote-branch head (#253):
#   * remote sha is a live branch head (a valid commit NOT already contained in
#     origin/main) → base = rsha: lint only the commits this push adds on top of
#     the previously-pushed tip (the incremental PR-update case);
#   * remote sha is unknown (new ref / zero) OR a STALE/placeholder branch
#     sitting at an ancestor of origin/main → base = merge-base(lsha, origin/main):
#     lint what the push introduces relative to main. A placeholder branch (e.g.
#     an `agent/issue-<N>` left at an old ancestor of main with no PR) would
#     otherwise make base=rsha drag in all of main's intervening history and
#     mis-fire the gate on unrelated languages — the push gets blocked though its
#     real slice touches nothing gated (#253);
#   * no base resolvable at all → fall back to the commit's own diff.
gate_files_from_prepush() {
  local lref lsha rref rsha base
  {
    while read -r lref lsha rref rsha; do
      [ -n "${lsha:-}" ] || continue
      case "$lsha" in *[!0]*) : ;; *) continue ;; esac  # all-zero = branch delete
      if [ -n "${rsha:-}" ] && [ "$rsha" != "$GATE_ZERO_SHA" ] &&
         git cat-file -e "$rsha^{commit}" 2>/dev/null &&
         ! git merge-base --is-ancestor "$rsha" origin/main 2>/dev/null; then
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
