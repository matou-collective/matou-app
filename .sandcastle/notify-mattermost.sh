#!/usr/bin/env bash
# Post a markdown message to Mattermost as the swarm bot.
# Usage: notify-mattermost.sh "<message>" [root_post_id]
# Env: MATTERMOST_URL (e.g. https://chat.example.nz), MATTERMOST_CHANNEL_ID,
#      and MATTERMOST_BOT_TOKEN — preferably via the bind-mounted
#      .sandcastle/secrets/mattermost_bot_token (see secrets/README.md) rather
#      than as an env var. When any is unset, print the message to stderr and
#      exit 0 so callers behave identically with or without chat wired up.
set -euo pipefail
msg="${1:?usage: notify-mattermost.sh <message>}"
if [ -z "${MATTERMOST_BOT_TOKEN:-}" ] && [ -f /run/secrets/mattermost_bot_token ]; then
  MATTERMOST_BOT_TOKEN="$(cat /run/secrets/mattermost_bot_token)"
fi
if [ -z "${MATTERMOST_URL:-}" ] || [ -z "${MATTERMOST_BOT_TOKEN:-}" ] || [ -z "${MATTERMOST_CHANNEL_ID:-}" ]; then
  # printf '%s\n', never echo: the message is DATA — a leading '-' or a
  # ':shortcode:' must reach stderr verbatim, not be read as an echo flag (#27).
  printf '%s\n' "notify-mattermost: MATTERMOST_URL/MATTERMOST_BOT_TOKEN/MATTERMOST_CHANNEL_ID unset — would have sent:" >&2
  printf '%s\n' "$msg" >&2
  exit 0
fi
root="${2:-}"
resp="$(jq -n --arg channel_id "$MATTERMOST_CHANNEL_ID" --arg message "$msg" --arg root_id "$root" \
    '{channel_id: $channel_id, message: $message, props: {remove_link_preview: "true"}} + (if $root_id != "" then {root_id: $root_id} else {} end)' |
  curl -sf --max-time 30 -X POST -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" -H 'Content-Type: application/json' \
    -d @- "$MATTERMOST_URL/api/v4/posts")"
# Print the created post id — heal.sh threads recurrences under it.
printf '%s' "$resp" | jq -r '.id // empty'
