#!/usr/bin/env bash
# policy-lib.sh — the loader + validator for the per-repo POLICY layer (#12,
# ADR 0002). Per-repo behaviour that used to be prose in prompt.md or hardcoded
# in the harness (push-to-main in run-swarm.sh, matou-app's PR-per-issue flow in
# its own .sandcastle/) becomes a small set of declarative knobs a consumer
# writes in swarm-policy.sh, beside swarm-identity.sh — the same plain KEY=value
# discipline as swarm.config, sourceable by bash and parseable by node.
#
# Ben's rulings this file encodes (2026-08-22): landing and merge authority are
# per-repo knobs; loop-in is the human-LABEL state machine (per-repo label
# definitions + trigger rules, not a level ladder); enforcement is built NOW.
#
# The knobs (swarm-policy.sh — the consumer's identity layer, ABSENT by default):
#   LANDING=push|pr                        push: rebase + push HEAD:refs/heads/main
#                                          (today's behaviour). pr: branch + PR.
#   MERGE_AUTHORITY=human|agent-after-green only meaningful when LANDING=pr.
#   HUMAN_LABELS="name:trigger ..."        the loop-in state machine — each entry
#                                          maps a repo label to ONE trigger key
#                                          from the fixed vocabulary below.
#   PROTECTED_PATHS=".sandcastle .forgejo" overrides PP_PROTECTED_DIRS_DEFAULT.
#
# The trigger vocabulary (fixed — a policy naming any other trigger fails LOUD):
#   one-way-door    an irreversible / one-way-door decision (ADR 0174) that needs
#                   a human ruling — the agent must NOT rule it itself.
#   cannot-proceed  a hard blocker the agent hit and cannot work around this run.
#   missing-context required context (a spec, a dependency answer, a fixture) is
#                   absent, so the slice is not yet implementable.
#
# When swarm-policy.sh is ABSENT the defaults reproduce today's byte-identical
# behaviour for the factory itself and for idss: LANDING=push, MERGE_AUTHORITY=
# human, the core label set with today's triggers, today's protected dirs.
#
# Sourceable, no side effects beyond defining functions. policy_load must run
# before policy_validate / policy_human_labels (it populates SWARM_POLICY_*).
# Pure logic + at most ONE tracker GET (the label-minted check, custom file
# only); offline-tested by tests/policy-lib-test.sh. Vendored from
# Matou/dev-factory (ADR 0180) so it propagates to every product repo and
# check-harness-drift.sh covers it.

if [ -z "${__SWARM_POLICY_LIB:-}" ]; then
__SWARM_POLICY_LIB=1

__policy_lib_here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The label-minted check speaks to the tracker; forgejo-lib.sh is safe to source
# more than once (defines functions only, no side effects).
# shellcheck source=forgejo-lib.sh
. "$__policy_lib_here/forgejo-lib.sh"

# policy_load [file] — source the policy file (if present) OVER the defaults and
# export the resolved SWARM_POLICY_* namespace. The file uses bare KEY=value; we
# declare the bare names local, source into them, then copy to the namespace so
# a stray global never leaks. SWARM_POLICY_FILE_PRESENT records which path ran.
policy_load() {
  local file="${1:-$__policy_lib_here/swarm-policy.sh}"
  # Defaults — byte-identical behaviour when the file is absent.
  local LANDING=push
  local MERGE_AUTHORITY=human
  local HUMAN_LABELS="ready-for-human:one-way-door agent-blocked:cannot-proceed needs-info:missing-context"
  local PROTECTED_PATHS="${PP_PROTECTED_DIRS_DEFAULT:-.sandcastle .forgejo}"
  SWARM_POLICY_FILE_PRESENT=false
  if [ -f "$file" ]; then
    SWARM_POLICY_FILE_PRESENT=true
    # shellcheck disable=SC1090
    . "$file"
  fi
  SWARM_POLICY_LANDING="$LANDING"
  SWARM_POLICY_MERGE_AUTHORITY="$MERGE_AUTHORITY"
  SWARM_POLICY_HUMAN_LABELS="$HUMAN_LABELS"
  SWARM_POLICY_PROTECTED_PATHS="$PROTECTED_PATHS"
  export SWARM_POLICY_LANDING SWARM_POLICY_MERGE_AUTHORITY \
         SWARM_POLICY_HUMAN_LABELS SWARM_POLICY_PROTECTED_PATHS SWARM_POLICY_FILE_PRESENT
}

# _policy_check_structure [file] — the network-free half of validation: an
# unknown key in the file, a bad LANDING/MERGE_AUTHORITY enum, or a malformed /
# unknown-trigger HUMAN_LABELS entry each exit 2 with the offending token named.
_policy_check_structure() {
  local file="${1:-$__policy_lib_here/swarm-policy.sh}"
  if [ -f "$file" ]; then
    local line key
    while IFS= read -r line; do
      line="${line#"${line%%[![:space:]]*}"}"   # ltrim leading whitespace
      case "$line" in ''|'#'*) continue ;; esac
      case "$line" in *=*) key="${line%%=*}" ;; *) continue ;; esac
      key="${key%%[[:space:]]*}"
      case "$key" in
        LANDING|MERGE_AUTHORITY|HUMAN_LABELS|PROTECTED_PATHS) : ;;
        *) echo "policy: unknown key $key (allowed: LANDING MERGE_AUTHORITY HUMAN_LABELS PROTECTED_PATHS)" >&2; return 2 ;;
      esac
    done < "$file"
  fi
  case "$SWARM_POLICY_LANDING" in
    push|pr) : ;;
    *) echo "policy: LANDING must be push|pr (got $SWARM_POLICY_LANDING)" >&2; return 2 ;;
  esac
  case "$SWARM_POLICY_MERGE_AUTHORITY" in
    human|agent-after-green) : ;;
    *) echo "policy: MERGE_AUTHORITY must be human|agent-after-green (got $SWARM_POLICY_MERGE_AUTHORITY)" >&2; return 2 ;;
  esac
  local pair trigger
  for pair in $SWARM_POLICY_HUMAN_LABELS; do
    case "$pair" in
      *:*) trigger="${pair#*:}" ;;
      *) echo "policy: HUMAN_LABELS entry $pair must be name:trigger" >&2; return 2 ;;
    esac
    case "$trigger" in
      one-way-door|cannot-proceed|missing-context) : ;;
      *) echo "policy: HUMAN_LABELS trigger $trigger unknown (allowed: one-way-door cannot-proceed missing-context)" >&2; return 2 ;;
    esac
  done
}

# policy_validate [file] — fail LOUD (exit 2, offending token named) before any
# worker spawns, like swarm_resolve_model: structure first, then the live check
# that every HUMAN_LABELS name is actually MINTED in the repo's label set. The
# label check needs the tracker and can only ever fail on a CUSTOM policy file
# (the defaults name core labels onboarding always mints), so the absent-file
# path stays network-free and byte-identical.
policy_validate() {
  local file="${1:-$__policy_lib_here/swarm-policy.sh}"
  _policy_check_structure "$file" || return 2
  [ -f "$file" ] || return 0
  local labelset pair name
  labelset="$(forgejo_get '/labels?limit=100')" \
    || { echo "policy: could not list the repo's labels to validate HUMAN_LABELS" >&2; return 2; }
  for pair in $SWARM_POLICY_HUMAN_LABELS; do
    name="${pair%%:*}"
    if ! jq -e --arg n "$name" 'any(.[]?; .name == $n)' >/dev/null 2>&1 <<<"$labelset"; then
      echo "policy: HUMAN_LABELS label $name is not minted in this repo (mint it before it can gate)" >&2
      return 2
    fi
  done
}

# policy_human_labels — emit the loop-in state machine as "name<TAB>trigger"
# lines, one per label, for renderers (the prompt-render pipeline, #1) that turn
# the knob into per-repo prose. Reads the loaded SWARM_POLICY_HUMAN_LABELS.
policy_human_labels() {
  local pair
  for pair in $SWARM_POLICY_HUMAN_LABELS; do
    printf '%s\t%s\n' "${pair%%:*}" "${pair#*:}"
  done
}

fi
