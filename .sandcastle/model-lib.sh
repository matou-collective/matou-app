#!/usr/bin/env bash
# model-lib.sh — the ONE source of truth for which Claude model the swarm and
# healer run on (#448, learning L6). BEFORE this, the model was hardcoded in two
# unrelated places — main.mts's `claudeCode("claude-opus-4-8")` and heal.sh's
# `claude -p --model claude-opus-4-8` — which could drift apart silently.
#
# Sourceable, no side effects beyond defining SWARM_MODEL / SWARM_MODEL_MAP (read
# from swarm.config, beside this file) and the resolver functions. Consumers:
#   - heal.sh                sources this, launches `claude --model "$SWARM_MODEL"`
#   - run-swarm.sh           sources this, resolves the first ready ticket's
#                            model-<name> label per-run and exports SWARM_MODEL
#   - main.mts               parses swarm.config directly (node can't source bash),
#                            so the SAME default/allowlist bytes drive it too
#
# Pure logic; offline-tested by tests/model-lib-test.sh. On the harness-manifest
# (with swarm.config) so both propagate to matou-app and check-harness-drift.sh
# covers them.

if [ -z "${__SWARM_MODEL_LIB:-}" ]; then
__SWARM_MODEL_LIB=1

__model_lib_here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The shared data. Plain KEY=value — the same file main.mts parses, so bash and
# node can never resolve to different models.
# shellcheck source=swarm.config
. "$__model_lib_here/swarm.config"
: "${SWARM_MODEL:?swarm.config must set SWARM_MODEL}"
: "${SWARM_MODEL_MAP:?swarm.config must set SWARM_MODEL_MAP}"
export SWARM_MODEL SWARM_MODEL_MAP

# swarm_model_names — echo the short label suffixes (map keys), one per line.
swarm_model_names() {
  local pair
  for pair in $SWARM_MODEL_MAP; do printf '%s\n' "${pair%%=*}"; done
}

# swarm_model_ids — echo the allowed full model ids (map values), one per line.
swarm_model_ids() {
  local pair
  for pair in $SWARM_MODEL_MAP; do printf '%s\n' "${pair#*=}"; done
}

# swarm_resolve_model <selector> — echo the full model id a selector resolves to,
# or fail LOUD (return 1, message on stderr) if it names no allowed model. This
# is the fail-fast gate: callers run it BEFORE spawning any worker.
#   ""              -> SWARM_MODEL (the fleet default; an unlabelled ticket)
#   "model-haiku"   -> the map value for `haiku` (the tracker-label form)
#   "haiku"         -> the map value for `haiku` (the bare suffix)
#   "claude-..."    -> itself, iff it is already an allowed map value
# Anything else NEVER silently falls back to the default — it fails.
swarm_resolve_model() {
  local sel="${1:-}"
  if [ -z "$sel" ]; then printf '%s\n' "$SWARM_MODEL"; return 0; fi
  local key="${sel#model-}"          # strip the `model-` label prefix if present
  local pair
  for pair in $SWARM_MODEL_MAP; do
    [ "${pair%%=*}" = "$key" ] && { printf '%s\n' "${pair#*=}"; return 0; }
  done
  for pair in $SWARM_MODEL_MAP; do   # a full model id that is already allowed
    [ "${pair#*=}" = "$sel" ] && { printf '%s\n' "$sel"; return 0; }
  done
  {
    printf 'swarm model resolution FAILED: %s is not an allowed model.\n' "$sel"
    printf 'Allowed labels (model-<name>): %s\n' "$(swarm_model_names | tr '\n' ' ')"
    printf 'Allowed model ids: %s\n' "$(swarm_model_ids | tr '\n' ' ')"
    printf 'Fix the ticket model-* label or add the model to .sandcastle/swarm.config; never launch on an unlisted model.\n'
  } >&2
  return 1
}

fi
