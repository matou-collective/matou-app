#!/usr/bin/env bash
# land-pr.sh — the ONE command a worker runs to land a ticket that carries
# `landing-pr` (idss ADR 0267; policy-lib.sh's policy_landing_guidance names it).
# A page of hand-typed curl is how a PR lands without its `closes #N`, or a
# branch gets force-pushed; this does the whole landing, in order, and refuses
# early rather than half-landing:
#   1. the ticket must actually land by PR (else: exit 2, nothing touched);
#   2. the evidence must be IN HAND — ≥1 screenshot file, or the waiver line in
#      the body file — before anything is pushed (exit 2);
#   3. push HEAD to agent/issue-<N> (never --force) and open the PR with
#      `closes #<N>` first — or, on a retry, refresh the open PR's body;
#   4. attach each screenshot to the PR and embed them in one comment;
#   5. re-read the PR and verify the evidence rule the way close-report will.
#
# Usage: land-pr.sh <issue> "<title>" <body-file> [screenshot ...]
# Env:   FORGEJO_API (or swarm-identity.sh's default), FORGEJO_TOKEN or
#        /run/secrets/forgejo_token; LANDING_PUSH_REMOTE overrides the push URL.
# Out:   the PR number on stdout (last line). Exit 0 landed+verified · 2 refused
#        before touching anything · 1 the push / PR / evidence check failed.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
usage="usage: land-pr.sh <issue> \"<title>\" <body-file> [screenshot ...]"
issue="${1:-}"; title="${2:-}"; body_file="${3:-}"
if [ -z "$issue" ] || [ -z "$title" ] || [ -z "$body_file" ]; then echo "$usage" >&2; exit 2; fi
shift 3
[ -r "$body_file" ] || { echo "land-pr: cannot read body file '$body_file'" >&2; exit 2; }

if [ -z "${FORGEJO_TOKEN:-}" ] && [ -f /run/secrets/forgejo_token ]; then
  FORGEJO_TOKEN="$(cat /run/secrets/forgejo_token)"
fi
: "${FORGEJO_TOKEN:?land-pr: FORGEJO_TOKEN is not set and /run/secrets/forgejo_token is absent}"
# shellcheck source=swarm-identity.sh
. "$here/swarm-identity.sh"
export FORGEJO_TOKEN FORGEJO_API
# shellcheck source=policy-lib.sh
. "$here/policy-lib.sh"
# shellcheck source=landing-lib.sh
. "$here/landing-lib.sh"
policy_load "${SWARM_POLICY_FILE:-}"

mode="$(landing_mode_for "$issue")" || exit 1
if [ "$mode" != pr ]; then
  echo "land-pr: #$issue lands by push (it does not carry landing-pr) — follow the workflow's push step, not this script" >&2
  exit 2
fi

body="$(cat "$body_file")"
waiver=0
if printf '%s\n' "$body" | tr -d '\r' | grep -Eq '^\*\*Screenshots:\*\* none — [^[:space:]].*$'; then waiver=1; fi
shots=()
for f in "$@"; do
  [ -f "$f" ] || { echo "land-pr: screenshot '$f' does not exist — refusing (a named screenshot is never silently skipped)" >&2; exit 2; }
  case "${f,,}" in
    *.png|*.jpg|*.jpeg|*.webp|*.gif) shots+=("$f") ;;
    *) echo "land-pr: '$f' is not an image (png/jpg/jpeg/webp/gif) — refusing" >&2; exit 2 ;;
  esac
done
if [ "$waiver" -eq 0 ] && [ "${#shots[@]}" -eq 0 ]; then
  {
    echo "land-pr: #$issue carries landing-pr — its PR needs evidence. Pass at least one screenshot taken AFTER your fix,"
    echo "or, only when the fix has no visible surface, put this line in $body_file on a line of its own:"
    echo "    **Screenshots:** none — <reason>"
  } >&2
  exit 2
fi

# Inside the sandbox `origin` is unauthenticated; push by token URL. An explicit
# LANDING_PUSH_REMOTE (a session on a host with its own credentials) wins.
if [ -z "${LANDING_PUSH_REMOTE:-}" ]; then
  scheme="${FORGEJO_API%%://*}"; host="${FORGEJO_API#*://}"; host="${host%%/*}"
  LANDING_PUSH_REMOTE="$scheme://swarm:$FORGEJO_TOKEN@$host/$(forgejo_repo_slug).git"
fi
export LANDING_PUSH_REMOTE

existing="$(landing_open_pr_for "$issue" 2>/dev/null || true)"
if ! pr="$(landing_push "$issue" "$title" "$body")" || [ -z "$pr" ]; then
  {
    echo "land-pr: could not push $(landing_branch_for "$issue") or open its PR."
    echo "If the branch already holds commits that are not yours, STOP — never force-push over unmerged work; follow the blocked path."
  } >&2
  exit 1
fi
# A retry: landing_push found the PR already open and left its body alone. Refresh
# it, so a waiver line (or better words) added on the second attempt really lands.
if [ -n "$existing" ]; then
  code="$(_forgejo_code -X PATCH -H 'Content-Type: application/json' "$FORGEJO_API/pulls/$pr" \
    -d "$(jq -n --arg b "$(landing_pr_body "$issue" "$body")" '{body:$b}')")"
  case "$code" in 2*) ;; *) echo "land-pr: warning: could not refresh PR #$pr's body (HTTP $code)" >&2 ;; esac
fi

md=""
for f in ${shots[@]+"${shots[@]}"}; do
  name="$(basename "$f")"
  url="$(forgejo_attach_issue_asset_url "$pr" "$f" "$name")"
  if [ -n "$url" ]; then
    md="${md}**${name}**"$'\n'"![${name}](${url})"$'\n\n'
  else
    echo "land-pr: warning: could not attach $f to PR #$pr" >&2
  fi
done
if [ -n "$md" ]; then
  forgejo_comment "$pr" ":camera: **Evidence for #$issue** — taken after the fix unless the name says otherwise."$'\n\n'"$md" \
    || echo "land-pr: warning: the screenshots are attached to PR #$pr but the embedding comment failed" >&2
fi

ev_rc=0; ev_msg="$(landing_evidence_gate "$issue" "$pr")" || ev_rc=$?
case "$ev_rc" in
  0) echo "land-pr: PR #$pr is open for #$issue with its evidence — now run the close-report gate; a human merges." >&2 ;;
  1) echo "land-pr: $ev_msg — the uploads did not land; re-run this command" >&2; exit 1 ;;
  *) echo "land-pr: could not re-read PR #$pr to verify its evidence — re-run this command" >&2; exit 1 ;;
esac
printf '%s\n' "$pr"
