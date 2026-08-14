#!/usr/bin/env bash
# The Sandcastle task source — injected into prompt.md via a shell expression,
# evaluated INSIDE the sandbox at the start of every iteration.
#
# Surfaces ONLY issues that are all of:
#   1. open and labelled `ready-for-agent`,
#   2. unblocked — every Forgejo issue-dependency ("blocked by") is closed —
#      so the swarm honours the slice-map DAG (docs/slices/*.yaml),
#   3. not already in review — no open PR from an `agent/issue-<n>` branch.
#      Re-dispatching an issue whose PR just awaits a human costs a full agent
#      run to stand down (issue #6 / PR #7, 2026-08-02) and risks a force-push
#      over a branch mid-review, and
#   4. NOT labelled `agent-working` — claimed by a live run on another host
#      under the multi-host pool (claim-next-task.sh, spec
#      2026-08-11-multihost-swarm-design.md D4; #250 sync from ourcloud); a
#      claimed ticket must vanish from every other host's queue immediately,
#      not just get lost to the claim race once an agent sees it.
#
# depends_on lives as NATIVE Forgejo issue dependencies (the repo has
# enable_issue_dependencies on), not as body text — see
# docs/agents/issue-tracker.md for how to set them.
#
# Output: a JSON array of {number, title, body, url} — the shape Sandcastle's
# built-in trackers emit. An empty array means done.
#
# Auth: FORGEJO_TOKEN from the environment, from .sandcastle/.env (host runs),
# or from the read-only file .sandcastle/secrets/forgejo_token that Sandcastle
# bind-mounts at /run/secrets/forgejo_token inside the sandbox (see
# .sandcastle/secrets/README.md — the token isn't forwarded as an env var
# because that lands in `docker inspect .Config.Env`).
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
: "${FORGEJO_API:=https://git.matou.nz/api/v1/repos/Matou/matou-app}"
export FORGEJO_TOKEN FORGEJO_API

api() { curl -sf -H "Authorization: token $FORGEJO_TOKEN" "$@"; }

ready='[]'
page=1
while :; do
  batch="$(api "$FORGEJO_API/issues?state=open&type=issues&labels=ready-for-agent&limit=50&page=$page")"
  count="$(jq 'length' <<<"$batch")"
  [ "$count" -eq 0 ] && break

  # Dependency checks run 10-wide: with the whole DAG labelled ready-for-agent
  # (70+ issues), serial curls take ~90s — past Sandcastle's 30s shell-expression
  # timeout. A failed check aborts the whole script (xargs propagates the
  # subshell's failure), matching the old serial strictness: never emit an
  # issue whose blockers could not be verified closed.
  unblocked="$(jq -r '.[].number' <<<"$batch" | xargs -P 10 -n 1 bash -c '
    set -euo pipefail
    open="$(curl -sf -H "Authorization: token $FORGEJO_TOKEN" \
        "$FORGEJO_API/issues/$0/dependencies?limit=50" |
      jq "[.[] | select(.state == \"open\")] | length")"
    case "$open" in
      0) echo "$0" ;;
      "" | *[!0-9]*) exit 1 ;;
    esac
  ')"

  # $batch goes in via --slurpfile, not --argjson: spec issues carry ~40KB
  # bodies, and a full 50-issue page blows past the 128KB argv-string limit.
  # Membership select keeps the batch's original order.
  nums="$(printf '%s\n' "$unblocked" | jq -Rn '[inputs | select(length > 0) | tonumber]')"
  ready="$(jq --slurpfile batch <(printf '%s' "$batch") --argjson nums "$nums" \
    '. + [$batch[0][] | select(.number as $n | $nums | index($n) != null)
      | select(((.labels // []) | map(.name) | index("agent-working")) == null)
      | {number, title, body, url: .html_url}]' \
    <<<"$ready")"

  [ "$count" -lt 50 ] && break
  page=$((page + 1))
done

# Condition 3: drop issues whose fix is already up for review. An open PR from
# `agent/issue-<n>` puts <n> in a human's court until it merges (auto-closing
# the issue via "closes #n") or is closed. `set -e` + `curl -sf` keep the old
# strictness: if the PR list can't be fetched, emit nothing rather than risk
# re-dispatching an in-review issue.
in_review='[]'
page=1
while :; do
  prs="$(api "$FORGEJO_API/pulls?state=open&limit=50&page=$page")"
  count="$(jq 'length' <<<"$prs")"
  [ "$count" -eq 0 ] && break
  in_review="$(jq --argjson new "$(jq '[.[].head.ref
      | select(test("^agent/issue-[0-9]+$"))
      | sub("^agent/issue-"; "") | tonumber]' <<<"$prs")" \
    '. + $new' <<<"$in_review")"
  [ "$count" -lt 50 ] && break
  page=$((page + 1))
done
ready="$(jq --argjson prnums "$in_review" \
  '[.[] | select(.number as $n | $prnums | index($n) == null)]' <<<"$ready")"

jq . <<<"$ready"
