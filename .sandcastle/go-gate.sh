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
# Whole-module — step 2 of #346 (issue #349) cleared main's pre-existing gofmt
# + lint debt, so the gate now checks the entire module (the since-origin/main
# scoping is gone). gofmt, build, vet, test and lint all run whole-module.
set -euo pipefail
cd backend
unformatted="$(gofmt -l .)"
if [ -n "$unformatted" ]; then
  echo "gofmt — run gofmt -w on:" >&2; printf '%s\n' "$unformatted" >&2; exit 1
fi
go build ./...
go vet ./...
go test ./...
golangci-lint run ./...
