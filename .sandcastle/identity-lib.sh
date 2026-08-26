#!/usr/bin/env bash
# identity-lib.sh — the contract seam between the vendored harness and the
# consumer-owned identity layer (swarm-identity.sh, vendor-exclude). #19 made the
# harness CALL swarm_git_identity, a function defined in swarm-identity.sh — but
# a pin bump reaches a consumer's harness scripts (vendored) WITHOUT touching
# their identity file, so an OLD identity file with no swarm_git_identity made
# every session-runner tick die mid-run with bash's `command not found` — ~15
# silent ticks, no claim, no post, found only by reading the host log (#31).
#
# This lib turns that silent seam into a LOUD, named contract: swarm-identity.sh
# stamps SWARM_IDENTITY_CONTRACT, the harness declares the contract it needs
# (IDENTITY_CONTRACT below), and every harness entry point calls identity_require
# right after sourcing the identity file — exit 2 with the exact regenerate
# command instead of a later `command not found`.
#
# Bump IDENTITY_CONTRACT whenever the harness starts REQUIRING a NEW symbol from
# swarm-identity.sh, and bump the matching SWARM_IDENTITY_CONTRACT the generator
# stamps (onboard-lib.sh onboard_gen_identity) in the SAME change, so a consumer
# who regenerates gets the newer stamp. Contract history:
#   1  swarm_git_identity (the four GIT_* vars) — #19.
#
# Sourceable, no side effects beyond defining the constant + functions. Offline-
# tested by tests/identity-lib-test.sh. Vendored from Matou/dev-factory (ADR
# 0180) so it propagates to every product repo and check-harness-drift.sh
# covers it.

if [ -z "${__SWARM_IDENTITY_LIB:-}" ]; then
__SWARM_IDENTITY_LIB=1

# The identity contract THIS harness requires of swarm-identity.sh. Bump on a
# newly-required symbol (see the history above).
IDENTITY_CONTRACT=1

# identity_require [need] — fail LOUD (return 2, the exact regenerate command
# named) when the sourced swarm-identity.sh satisfies an OLDER contract than the
# harness needs. `have` is the file's SWARM_IDENTITY_CONTRACT stamp (absent or
# non-numeric = 0, the pre-#19 identity layer); `need` defaults to the harness's
# IDENTITY_CONTRACT so a caller just writes `identity_require`.
identity_require() {
  local need="${1:-$IDENTITY_CONTRACT}" have="${SWARM_IDENTITY_CONTRACT:-0}" slug="${REPO_SLUG:-<owner/repo>}"
  case "$have" in ''|*[!0-9]*) have=0 ;; esac
  case "$need" in ''|*[!0-9]*) need="$IDENTITY_CONTRACT" ;; esac
  if [ "$have" -lt "$need" ]; then
    echo "identity: swarm-identity.sh is contract $have, this harness needs $need — re-run: onboard.sh identity $slug .sandcastle/swarm-identity.sh" >&2
    return 2
  fi
}

# identity_apply <class> — the IDENTITY seam of run-swarm.sh (#2), in one call:
# check the contract, keep a belt-to-the-braces `command -v` guard at the call
# site (the exact failure #31 exists to prevent, so it is asserted twice), and
# stamp GIT_AUTHOR_*/GIT_COMMITTER_* from the ONE place that owns them. rc 2 on
# either failure, with the regenerate command named, so an entry point can
# `identity_apply worker || exit 2`.
#
# <class> names the machinery making the commits — `worker` covers a host's
# reconcile/rescue commits AND the value main.mts forwards into each worker
# container; `healer` and `session-runner` are the other two.
identity_apply() {
  identity_require || return 2
  command -v swarm_git_identity >/dev/null || {
    echo "identity: swarm_git_identity missing from swarm-identity.sh — re-run: onboard.sh identity ${REPO_SLUG:-<owner/repo>} .sandcastle/swarm-identity.sh" >&2
    return 2
  }
  swarm_git_identity "$1"
}

fi
