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

# heal_workdir_literal_home <value> — TRUE (rc 0) when a HEAL_WORKDIR value is a
# LITERAL single-host home path (begins `/home/`) instead of the per-host
# `$HOME/...` form the generator writes (#352). HEAL_WORKDIR is read on EVERY
# pool host — healer.yml is `runs-on: swarm`, and swarm.yml/triage.yml call
# heal.sh wherever a failed run landed — so a literal home MEASURED on one host
# (say `/home/dev/...`) dies on every host whose runner user home differs, at
# `mkdir -p "$HEALER_STATE"` with Permission denied (a ~10s red). This operates
# on the UNEXPANDED source text, never a sourced value: `$HOME/swarm/<slug>` is
# correct and never matches; `/home/dev/swarm/<slug>` is the trap and does.
heal_workdir_literal_home() {
  case "${1:-}" in
    /home/*) return 0 ;;
    *)       return 1 ;;
  esac
}

# identity_heal_workdir_value <swarm-identity.sh> — echo the RHS of the file's
# HEAL_WORKDIR default assignment, UNEXPANDED, or nothing when the file has no
# such line. Reads the committed source text rather than sourcing the file —
# sourcing would expand `$HOME`, hiding the very literal this hunts. Accepts the
# generated default form `: "${HEAL_WORKDIR:=...}"` and a plain `HEAL_WORKDIR=...`.
identity_heal_workdir_value() {
  [ -f "${1:-}" ] || return 0
  sed -n -e 's/.*HEAL_WORKDIR:=\([^}"]*\).*/\1/p' \
         -e 's/^[[:space:]]*HEAL_WORKDIR=\([^"]*\).*/\1/p' "$1" | head -1
}

# identity_check_heal_workdir <swarm-identity.sh> — the shared #352 guard behind
# `onboard-host enrol`'s preflight AND check-harness-drift.sh. rc 1 (loud, to
# stderr, the offending value and the portable form named) when the committed
# HEAL_WORKDIR default is a literal `/home/...` path; rc 0 when it is the
# per-host `$HOME/...` form or absent.
identity_check_heal_workdir() {
  local file="${1:-}" val
  val="$(identity_heal_workdir_value "$file")"
  if [ -n "$val" ] && heal_workdir_literal_home "$val"; then
    echo "identity: HEAL_WORKDIR default '$val' in $file is a literal home path — HEAL_WORKDIR is evaluated on EVERY pool host (healer.yml is runs-on: swarm; swarm.yml/triage.yml run heal.sh wherever a run failed), so a one-host home path dies elsewhere at mkdir with Permission denied. Use \$HOME/swarm/<slug> (#352)." >&2
    return 1
  fi
  return 0
}

fi
