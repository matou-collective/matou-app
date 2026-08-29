#!/usr/bin/env bash
# Publish a feature-e2e verdict + screenshots ON THE PR (Forgejo), so the
# reviewer sees the evidence where they review, not only in Mattermost.
# Usage: post-pr-screenshots.sh <pr_number> "<status markdown>" [png ...]
# Env: FORGEJO_TOKEN, FORGEJO_API (…/api/v1/repos/<owner>/<repo>).
# Each PNG is uploaded as an issue attachment (POST issues/<n>/assets) and
# embedded by its browser_download_url. One comment per PR, identified by
# PR_E2E_COMMENT_MARKER: a rerun edits it in place. Best-effort throughout —
# an upload that fails is skipped, and a comment failure never fails the
# caller (the verdict also went to Mattermost).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$here/pr-e2e-lib.sh"
pr="${1:?usage: post-pr-screenshots.sh <pr_number> <status markdown> [png ...]}"
status="${2:?usage: post-pr-screenshots.sh <pr_number> <status markdown> [png ...]}"
shift 2
: "${FORGEJO_TOKEN:?}" "${FORGEJO_API:?}"

api() { curl -sf --max-time 60 -H "Authorization: token $FORGEJO_TOKEN" "$@"; }

pairs=()
for f in "$@"; do
  [ -f "$f" ] || continue
  url="$(api -X POST -F "attachment=@$f" \
    "$FORGEJO_API/issues/$pr/assets?name=$(basename "$f")" 2>/dev/null \
    | jq -r '.browser_download_url // empty' 2>/dev/null || true)"
  if [ -n "$url" ]; then
    pairs+=("$(screenshot_label "$f")	$url")
  else
    echo "post-pr-screenshots: upload failed for $f — skipped" >&2
  fi
done

body="$(build_pr_comment "$status" "${pairs[@]+"${pairs[@]}"}")"
payload="$(jq -n --arg body "$body" '{body: $body}')"

existing="$(api "$FORGEJO_API/issues/$pr/comments?limit=100" 2>/dev/null \
  | jq -r --arg m "$PR_E2E_COMMENT_MARKER" '[.[] | select(.body | contains($m))] | last | .id // empty' 2>/dev/null || true)"

if [ -n "$existing" ]; then
  api -X PATCH -H 'Content-Type: application/json' -d "$payload" \
    "$FORGEJO_API/issues/comments/$existing" >/dev/null \
    || echo "post-pr-screenshots: could not edit comment $existing on PR #$pr" >&2
else
  api -X POST -H 'Content-Type: application/json' -d "$payload" \
    "$FORGEJO_API/issues/$pr/comments" >/dev/null \
    || echo "post-pr-screenshots: could not comment on PR #$pr" >&2
fi
echo "${#pairs[@]}"
