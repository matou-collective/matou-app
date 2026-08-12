#!/usr/bin/env bash
# The Sandcastle task source under the multi-host pool: list ready tickets
# (priority-first, DAG-filtered — list-ready-tasks.sh unchanged), then CLAIM
# the head before the agent ever sees it. Emits a JSON array holding exactly
# the one verified-claimed ticket, or [] when nothing is claimable. A lost
# race costs ~3 API calls and zero Claude tokens — the loser walks down the
# list. Spec: docs/superpowers/specs/2026-08-11-multihost-swarm-design.md D4.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
if [ -z "${FORGEJO_TOKEN:-}" ] && [ -f "$here/.env" ]; then . "$here/.env"; fi
if [ -z "${FORGEJO_TOKEN:-}" ] && [ -f /run/secrets/forgejo_token ]; then
  FORGEJO_TOKEN="$(cat /run/secrets/forgejo_token)"
fi
: "${FORGEJO_TOKEN:?}"
: "${FORGEJO_API:=https://git.matou.nz/api/v1/repos/Matou/matou-app}"
export FORGEJO_TOKEN FORGEJO_API
# shellcheck source=claim-lib.sh
. "$here/claim-lib.sh"

host="${SWARM_HOST:-$(hostname)}"
run="${SWARM_RUN_ID:-0}"
lister="${CLAIM_LISTER:-$here/list-ready-tasks.sh}"

ready="$(bash "$lister")"
n="$(jq length <<<"$ready")"
[ "$n" -eq 0 ] && { echo '[]'; exit 0; }

# Fail CLOSED, not open, on an alive-runs fetch failure: falling back to '[]'
# here would make claim_won's own-id short-circuit the ONLY signal it ever
# sees, so this host would look like the sole live claimant and could win a
# ticket another host already holds — a double-claim the janitor can't catch
# either, since both runs really are alive. Skip the round instead; the cost
# is one cron/self-rearm cycle, not a correctness hole. No claim comment gets
# posted, so nothing needs cleaning up. (Ben's fail-closed ruling, 2026-08-11,
# review of commit 68fb911.)
alive="$(claim_alive_runs)" || { echo '[]'; exit 0; }
for i in $(seq 0 $((n - 1))); do
  num="$(jq -r ".[$i].number" <<<"$ready")"
  cid="$(claim_post "$num" "$host" "$run")" || continue
  if claim_won "$num" "$cid" "$alive"; then
    claim_mark_working "$num" || true
    jq -c "[.[$i]]" <<<"$ready"
    exit 0
  fi
  # lost — remove our claim comment only (the winner's label stays)
  _claim_api -X DELETE "$FORGEJO_API/issues/comments/$cid" || true
done
echo '[]'
