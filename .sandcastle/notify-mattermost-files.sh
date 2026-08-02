#!/usr/bin/env bash
# Post a markdown message WITH file attachments to Mattermost as the swarm bot.
# Usage: notify-mattermost-files.sh "<message>" [file ...]
# Env: same contract as notify-mattermost.sh. When creds are unset, print the
# message and file list to stderr and exit 0.
# Mattermost caps 10 attachments per post: the first 10 files attach to the
# root post; each further batch of 10 goes in a threaded reply.
# Prints the root post id on stdout.
set -euo pipefail
msg="${1:?usage: notify-mattermost-files.sh <message> [file ...]}"
shift || true
if [ -z "${MATTERMOST_BOT_TOKEN:-}" ] && [ -f /run/secrets/mattermost_bot_token ]; then
  MATTERMOST_BOT_TOKEN="$(cat /run/secrets/mattermost_bot_token)"
fi
if [ -z "${MATTERMOST_URL:-}" ] || [ -z "${MATTERMOST_BOT_TOKEN:-}" ] || [ -z "${MATTERMOST_CHANNEL_ID:-}" ]; then
  echo "notify-mattermost-files: MATTERMOST_URL/MATTERMOST_BOT_TOKEN/MATTERMOST_CHANNEL_ID unset — would have sent:" >&2
  echo "$msg" >&2
  [ "$#" -gt 0 ] && printf ' - %s\n' "$@" >&2
  exit 0
fi

ids=()
for f in "$@"; do
  [ -f "$f" ] || continue
  id="$(curl -sf --max-time 60 -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" \
    -F "files=@$f" -F "channel_id=$MATTERMOST_CHANNEL_ID" \
    "$MATTERMOST_URL/api/v4/files" 2>/dev/null | jq -r '.file_infos[0].id // empty' 2>/dev/null || echo '')"
  [ -n "$id" ] && ids+=("$id")
done

post() { # $1=message $2=json-array-of-file-ids $3=root_id ("" for root)
  jq -cn --arg channel_id "$MATTERMOST_CHANNEL_ID" --arg message "$1" \
    --argjson file_ids "$2" --arg root_id "$3" \
    '{channel_id: $channel_id, message: $message, file_ids: $file_ids}
     + (if $root_id != "" then {root_id: $root_id} else {} end)' |
  curl -sf --max-time 30 -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" \
    -H 'Content-Type: application/json' -d @- "$MATTERMOST_URL/api/v4/posts" 2>/dev/null |
  jq -r '.id // empty' 2>/dev/null || echo ''
}

slice_json() { # $1=start index — 10 ids from $ids as a JSON array
  local s=$1 out=()
  out=("${ids[@]:$s:10}")
  if [ "${#out[@]}" -eq 0 ]; then echo '[]'; else
    printf '%s\n' "${out[@]}" | jq -R . | jq -cs .
  fi
}

root="$(post "$msg" "$(slice_json 0)" "")"
if [ -n "$root" ]; then
  i=10
  while [ "$i" -lt "${#ids[@]}" ]; do
    post "(more screenshots)" "$(slice_json "$i")" "$root" >/dev/null
    i=$((i + 10))
  done
fi
printf '%s' "$root"
