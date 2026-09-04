#!/usr/bin/env bash
# The Go pre-push gate for THIS repo (issue #346). Wired via GATE_GO_CMD in
# .sandcastle/Dockerfile: the factory-vendored gate-lib.sh (#198) otherwise
# runs `nix develop .#go-ci` over a root-level module + broker/ — OurCloud's
# layout — but matou-app has no flake and its Go module lives in backend/.
# This repo's pinned toolchain is the sandbox image itself (Go + golangci-lint
# pinned in the Dockerfile, the same image ci.yml runs in), so this script IS
# the "pinned Go seam stages" for matou-app, not a bypass of them.
#
# Runs from the repo root (gate_go_stage cd's there). Mirrors the stages the
# factory gate runs: gofmt, build, vet, test, lint.
#
# Scope — step 1 of #346: gofmt and lint look only at what changed since
# origin/main (changed .go files / --new-from-rev), because main carries
# pre-existing gofmt + lint debt that must not block every Go push. Step 2
# (the debt-sweep ticket) clears main and drops the scoping so the gate and
# ci.yml check the whole module. Build, vet and test are always whole-module.
set -euo pipefail
cd backend
base="$(git merge-base HEAD origin/main 2>/dev/null || echo origin/main)"
changed="$(git diff --name-only --relative --diff-filter=ACMR "$base" HEAD -- . | grep '\.go$' || true)"
if [ -n "$changed" ]; then
  # shellcheck disable=SC2086
  unformatted="$(gofmt -l $changed || true)"
  if [ -n "$unformatted" ]; then
    echo "gofmt — run gofmt -w on:" >&2; printf '%s\n' "$unformatted" >&2; exit 1
  fi
fi
go build ./...
go vet ./...
go test ./...
golangci-lint run --new-from-rev origin/main ./...
