#!/usr/bin/env bash
# The TypeScript pre-push lint gate for THIS repo (#1252, the TS twin of the Go
# gate wired in #346). Auto-detected by gate_ts_stage: an executable
# .sandcastle/ts-gate.sh takes precedence over the factory nix default. The
# vendored gate-lib.sh otherwise runs `nix develop .#default` (OurCloud's
# layout) — but matou-app has no flake, has no `nix` in the sandbox image, and
# its frontend lives in frontend/ under npm (package-lock.json, not pnpm). This
# repo's pinned toolchain is the sandbox image itself (Node + the frontend's
# package-lock), the same image ci.yml's eslint stage runs in, so this script IS
# matou-app's TS lint seam — not a bypass of it. Without it every TS-touching
# push fails closed (#1252 — a blocked push beats an un-linted main), which is
# why it exists as the drift-safe per-repo layer the gate documents.
#
# Runs from the repo root (gate_ts_stage cd's there). Mirrors the
# "eslint (npm run lint)" stage of .sandcastle/run-ci-checks.sh.
set -euo pipefail
cd frontend
[ -d node_modules ] || CI=true npm ci
npm run lint
