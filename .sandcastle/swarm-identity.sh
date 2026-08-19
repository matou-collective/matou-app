#!/usr/bin/env bash
# swarm-identity.sh — this repo's declarative identity for the swarm factory
# (ADR 0180 / #571 phase 1: the factory core moves to its own repo, consumed
# by pull; product repos keep a thin declarative layer). Vendored factory
# scripts (claim-next-task.sh, heal.sh, schedule-backstop.sh,
# rehearsal-report.sh, list-ready-tasks.sh, session-runner.sh,
# preflight-triage.sh, ...) need a FORGEJO_API/WORKDIR default but must never
# hardcode one — a hardcoded "Matou/matou-app" default baked into a
# byte-identical file is exactly the "slug as value" half of harness-sync's
# ownership-inversion bug the extraction retires. Every per-repo default
# collapses into this ONE file instead of being copy-pasted into every script
# that needs it (8 copies at 2026-08-15 survey time; the last 4 closed here).
#
# Sourced by product-repo entry points before any vendored factory script
# runs; env already set (workflows set FORGEJO_API explicitly) always wins —
# these are fallback defaults for host-mode runs only. Safe to source more
# than once.
: "${FORGEJO_API:=https://git.matou.nz/api/v1/repos/Matou/matou-app}"
: "${HEAL_WORKDIR:=$HOME/swarm/Matou/matou-app}"
: "${REPO_SLUG:=Matou/matou-app}"
