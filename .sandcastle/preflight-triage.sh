#!/usr/bin/env bash
# Zero-token pre-flight for the triage workflow: list open issues that carry
# NONE of the triage outcome labels (docs/agents/triage-labels.md) — i.e. the
# issues /triage still has to rule on. wayfinder:* process tickets, the
# no-triage escape hatch, agent-blocked issues, deferred rulings (a human
# ruling with revisit criteria in the body — docs/agents/triage-labels.md),
# and ready-for-session issues (already ruled under ADR 0174; swept and
# reclassified separately, not re-visited by /triage) are excluded.
#
# Output: JSON array of {number, title, url}. [] = nothing to triage.
# Auth: FORGEJO_TOKEN from the environment, .sandcastle/.env (host runs), or
# the bind-mounted .sandcastle/secrets/forgejo_token (see
# .sandcastle/secrets/README.md).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Source .env only when the environment doesn't already provide the token —
# in CI the workflow sets it, and the materialized .env holds empty values
# that would clobber it.
# shellcheck disable=SC1091
if [ -z "${FORGEJO_TOKEN:-}" ] && [ -f "$here/.env" ]; then . "$here/.env"; fi
if [ -z "${FORGEJO_TOKEN:-}" ] && [ -f /run/secrets/forgejo_token ]; then
  FORGEJO_TOKEN="$(cat /run/secrets/forgejo_token)"
fi

: "${FORGEJO_TOKEN:?set in .sandcastle/.env, the environment, or /run/secrets/forgejo_token}"
# shellcheck source=swarm-identity.sh
. "$here/swarm-identity.sh"   # FORGEJO_API default — this repo's identity (ADR 0180 / #571)

# Absorb transient Forgejo blips (a single 503 storm killed triage run 1637,
# #235): retry the paged calls with exponential backoff. A persistent outage
# still exhausts the attempts and fails the job (the caller runs under set -e).
api() {
  local attempt=1 max="${PREFLIGHT_RETRIES:-3}" delay="${PREFLIGHT_BACKOFF:-2}" out
  while :; do
    if out="$(curl -sf -H "Authorization: token $FORGEJO_TOKEN" "$@")"; then
      printf '%s' "$out"
      return 0
    fi
    [ "$attempt" -ge "$max" ] && return 22
    sleep "$delay"
    delay=$((delay * 2))
    attempt=$((attempt + 1))
  done
}

untriaged='[]'
page=1
while :; do
  batch="$(api "$FORGEJO_API/issues?state=open&type=issues&limit=50&page=$page")"
  count="$(jq 'length' <<<"$batch")"
  [ "$count" -eq 0 ] && break

  # $batch goes in via --slurpfile, not --argjson: spec issues carry ~40KB
  # bodies, and a full 50-issue page blows past the 128KB argv-string limit.
  untriaged="$(jq --slurpfile batch <(printf '%s' "$batch") '
    . + ($batch[0] | map(select(
        ([.labels[].name] |
          any(. == "ready-for-agent" or . == "ready-for-human" or
              . == "ready-for-session" or
              . == "needs-design"    or . == "needs-info"      or
              . == "wontfix"         or . == "no-triage"       or
              . == "agent-blocked"   or . == "deferred"        or
              startswith("wayfinder:"))
          | not)
      ) | {number, title, url: .html_url}))' <<<"$untriaged")"

  [ "$count" -lt 50 ] && break
  page=$((page + 1))
done

jq . <<<"$untriaged"
