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

# The host session-runner.sh/heal.sh run on (#1's prompt-render pipeline names
# it in session-runner-prompt.md/rehearsal-heal-prompt.md). No cross-product
# default — each consumer states its own.
: "${RUNNER_HOST:=matou-workstation}"

# Factory git identity for every headless commit path (dev-factory #19):
# without it, commits from session-runner.sh, heal.sh's clone, run-swarm.sh's
# reconcile, or a worker container inherit the host user's ~/.gitconfig —
# provenance lost. Base name/email derive from REPO_SLUG's owner and
# FORGEJO_API's host so no product literal is pinned here; override
# SWARM_GIT_NAME / SWARM_GIT_EMAIL (or the GIT_* vars directly) for a
# different identity.
: "${SWARM_GIT_NAME:=${REPO_SLUG%%/*} Swarm}"
_swarm_api_host="${FORGEJO_API#*://}"; _swarm_api_host="${_swarm_api_host%%/*}"
: "${SWARM_GIT_EMAIL:=swarm@${_swarm_api_host#git.}}"
unset _swarm_api_host

# swarm_git_identity <worker-class> — export the four GIT_* vars so a headless
# commit records WHICH machinery made it, on WHICH host (e.g. "Matou Swarm
# (healer@<host>)"). Every headless commit path calls this before its Claude
# session / reconcile commits; main.mts forwards the exported vars into the
# worker container. Host follows the pool-claim convention (SWARM_HOST, else
# `hostname`) so `git log` provenance matches the claim identity.
swarm_git_identity() {
  local class="${1:-worker}" host
  host="${SWARM_HOST:-$(hostname 2>/dev/null || echo unknown)}"
  GIT_AUTHOR_NAME="$SWARM_GIT_NAME ($class@$host)"
  GIT_AUTHOR_EMAIL="$SWARM_GIT_EMAIL"
  GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
  GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
  export GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL
}
