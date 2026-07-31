#!/usr/bin/env bash
# Headless triage: when untriaged issues exist, run the /triage skill via
# claude -p (labels get applied exactly as in an interactive session), then
# post to Mattermost every issue newly routed to a human gate.
# Run from the repo checkout root.
#
# Env: FORGEJO_TOKEN, FORGEJO_API, CLAUDE_CODE_OAUTH_TOKEN,
#      MATTERMOST_URL/MATTERMOST_BOT_TOKEN/MATTERMOST_CHANNEL_ID (optional),
#      REPO_SLUG (optional).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${FORGEJO_TOKEN:?}"
: "${FORGEJO_API:?}"
repo_slug="${REPO_SLUG:-${FORGEJO_API##*/repos/}}"

api() { curl -sf -H "Authorization: token $FORGEJO_TOKEN" "$@"; }

untriaged="$(bash "$here/preflight-triage.sh")"
n="$(jq 'length' <<<"$untriaged")"
if [ "$n" -eq 0 ]; then
  echo "run-triage: nothing to triage"
  exit 0
fi
echo "run-triage: $n untriaged issue(s):"
jq -r '.[] | "  #\(.number) \(.title)"' <<<"$untriaged"

# Open issues currently sitting at a human gate, as "number<TAB>label" lines.
human_gated() {
  for label in ready-for-human; do
    page=1
    while :; do
      batch="$(api "$FORGEJO_API/issues?state=open&type=issues&labels=$label&limit=50&page=$page")"
      count="$(jq 'length' <<<"$batch")"
      [ "$count" -eq 0 ] && break
      jq -r --arg l "$label" '.[] | "\(.number)\t\($l)"' <<<"$batch"
      [ "$count" -lt 50 ] && break
      page=$((page + 1))
    done
  done | sort -u
}

before="$(human_gated)"
# Snapshot awaiting-verification BEFORE the claude call (cap: 50 open
# awaiting-verification issues per snapshot is far beyond realistic volume).
await_before="$(api "$FORGEJO_API/issues?state=open&type=issues&labels=awaiting-verification&limit=50" | jq -r '.[].number' | sort -u)"
timeout 2700 claude -p "/triage You are running headless in CI: no human can answer questions, so never ask any. Every untriaged issue must leave this run carrying a triage label. This repo has a HUMAN VERIFICATION GATE: never apply the ready-for-agent label — where the default /triage flow would mark an issue ready-for-agent, apply awaiting-verification instead and post a comment summarizing your assessment (what the issue asks, whether it is reproducible/actionable, suggested approach). A human promotes it to ready-for-agent via Mattermost. When you hit ambiguity or a judgement call, label the issue ready-for-human (or needs-info if the reporter must supply missing information) and post a comment explaining what needs deciding." --dangerously-skip-permissions
after="$(human_gated)"
await_after="$(api "$FORGEJO_API/issues?state=open&type=issues&labels=awaiting-verification&limit=50" | jq -r '.[].number' | sort -u)"

new="$(comm -13 <(printf '%s\n' "$before") <(printf '%s\n' "$after"))"
if [ -n "$new" ]; then
  msg=":wave: **Triage needs you** in \`$repo_slug\`:"
  while IFS=$'\t' read -r num label; do
    [ -z "$num" ] && continue
    issue="$(api "$FORGEJO_API/issues/$num")"
    title="$(jq -r .title <<<"$issue")"
    url="$(jq -r .html_url <<<"$issue")"
    msg="$msg
- [#$num $title]($url) → \`$label\`"
  done <<<"$new"
  bash "$here/notify-mattermost.sh" "$msg"
fi

# One verification thread per newly-gated issue — the poller
# (check-verifications.sh) keys on the ':mag: **Verify #N**' marker.
new_await="$(comm -13 <(printf '%s\n' "$await_before") <(printf '%s\n' "$await_after"))"
for num in $new_await; do
  [ -n "$num" ] || continue
  issue="$(api "$FORGEJO_API/issues/$num")"
  title="$(jq -r .title <<<"$issue")"
  url="$(jq -r .html_url <<<"$issue")"
  body_excerpt="$(jq -r '.body // ""' <<<"$issue" | head -c 500)"
  bash "$here/notify-mattermost.sh" ":mag: **Verify #$num** — $title
$url

$body_excerpt

Reply **approve** (optionally followed by guidance for the agent) or **reject** (optionally a reason) in this thread. Anything else is copied to the issue as a comment." || true
done

still="$(bash "$here/preflight-triage.sh" | jq 'length')"
if [ "$still" -gt 0 ]; then
  echo "run-triage: $still issue(s) still untriaged (next tick retries)" >&2
fi
exit 0
