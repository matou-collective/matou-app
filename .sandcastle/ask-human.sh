#!/usr/bin/env bash
# Ask a human a question in Mattermost and wait for a DIRECT reply in the
# question's own thread. On success the reply text is printed to stdout.
#
# Usage: ask-human.sh "<question>" [timeout_seconds]
#   timeout defaults to $ASK_HUMAN_TIMEOUT or 1200 (20 min); polls every
#   $ASK_HUMAN_POLL (20) seconds.
#
# Questions are RESUMABLE, keyed by the first issue reference (`#N`) in the
# question text. Before posting, the script scans every recent (within
# $ASK_HUMAN_LOOKBACK, default 48 h) unconsumed ask for the same issue —
# "unconsumed" meaning its thread has no bot :white_check_mark:
# confirmation yet — newest first:
#   - if any such thread already holds a human reply (e.g. it arrived after
#     the previous poller died, in whichever duplicate thread the human
#     happened to answer), the reply is returned immediately;
#   - otherwise polling resumes on the newest such thread — no duplicate
#     question is posted, and an :eyes: note marks that thread as the live
#     one to answer. (2026-07-27: seven duplicate asks for #129 because
#     every killed poller left the issue re-askable and the late reply
#     unread.)
#
# Only posts whose root_id is the question post — i.e. replies inside its
# thread — and whose author is not the bot count as answers. Channel chatter
# and other threads are never picked up. The bot must be a MEMBER of the
# channel (posting works without membership; reading the thread does not).
#
# Exit codes: 0 reply received (stdout = reply text)
#             2 Mattermost env unset (chat not wired up)
#             3 timed out (parking notice posted) or interrupted/killed —
#               either way the thread stays open and a later ask for the
#               same issue resumes it, so late replies are never lost.
# Env: MATTERMOST_URL, MATTERMOST_CHANNEL_ID, and MATTERMOST_BOT_TOKEN — the
# last one preferably via the bind-mounted .sandcastle/secrets/mattermost_bot_token
# (see .sandcastle/secrets/README.md) rather than as an env var.
set -euo pipefail

question="${1:?usage: ask-human.sh <question> [timeout_seconds]}"
timeout="${2:-${ASK_HUMAN_TIMEOUT:-1200}}"
poll="${ASK_HUMAN_POLL:-20}"
lookback="${ASK_HUMAN_LOOKBACK:-172800}"

if [ -z "${MATTERMOST_BOT_TOKEN:-}" ] && [ -f /run/secrets/mattermost_bot_token ]; then
  MATTERMOST_BOT_TOKEN="$(cat /run/secrets/mattermost_bot_token)"
fi

if [ -z "${MATTERMOST_URL:-}" ] || [ -z "${MATTERMOST_BOT_TOKEN:-}" ] || [ -z "${MATTERMOST_CHANNEL_ID:-}" ]; then
  echo "ask-human: MATTERMOST_URL/MATTERMOST_BOT_TOKEN/MATTERMOST_CHANNEL_ID unset — cannot ask" >&2
  exit 2
fi

trap 'echo "ask-human: interrupted — the question thread stays open; the next ask for the same issue resumes it and picks up late replies" >&2; exit 3' TERM INT

api() { curl -sf -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" "$@"; }

post() { # post <message> [root_id] — root_id makes it a thread reply
  jq -n --arg channel_id "$MATTERMOST_CHANNEL_ID" --arg message "$1" --arg root_id "${2:-}" \
    '{channel_id: $channel_id, message: $message}
     + (if $root_id != "" then {root_id: $root_id} else {} end)' |
    api -X POST -H 'Content-Type: application/json' -d @- "$MATTERMOST_URL/api/v4/posts"
}

first_reply() { # first_reply <thread_json> <qid> — earliest human reply, or empty
  jq -r --arg qid "$2" --arg bot "$bot_id" \
    '[.posts[] | select(.root_id == $qid and .user_id != $bot and .delete_at == 0)]
     | sort_by(.create_at) | first | .message // empty' <<<"$1"
}

bot_id="$(api "$MATTERMOST_URL/api/v4/users/me" | jq -r .id)"

# Resume path: scan recent unconsumed asks for the same issue, newest first.
# A late reply in ANY of them wins; otherwise resume the newest.
key="$(grep -oE '#[0-9]+' <<<"$question" | head -1 || true)"
qid=""
if [ -n "$key" ]; then
  chan="$(api "$MATTERMOST_URL/api/v4/channels/$MATTERMOST_CHANNEL_ID/posts?per_page=200" || true)"
  if [ -n "$chan" ]; then
    cutoff_ms=$((($(date +%s) - lookback) * 1000))
    cands="$(jq -r --arg bot "$bot_id" --arg key "$key" --argjson cutoff "$cutoff_ms" \
      '[.posts[] | select(.user_id == $bot and .root_id == "" and .delete_at == 0
                          and .create_at >= $cutoff
                          and (.message | startswith(":raising_hand:"))
                          and (.message | test($key + "([^0-9]|$)")))]
       | sort_by(.create_at) | reverse | .[].id' <<<"$chan")"
    for cand in $cands; do
      thread="$(api "$MATTERMOST_URL/api/v4/posts/$cand/thread" || true)"
      [ -z "$thread" ] && continue
      consumed="$(jq -r --arg qid "$cand" --arg bot "$bot_id" \
        '[.posts[] | select(.root_id == $qid and .user_id == $bot
                            and (.message | startswith(":white_check_mark:")))] | length' <<<"$thread")"
      [ "$consumed" -gt 0 ] && continue
      reply="$(first_reply "$thread" "$cand")"
      if [ -n "$reply" ]; then
        post ":white_check_mark: Got it — picked up this earlier reply; proceeding with it." "$cand" >/dev/null
        printf '%s\n' "$reply"
        exit 0
      fi
      [ -z "$qid" ] && qid="$cand"
    done
    if [ -n "$qid" ]; then
      post ":eyes: Waiting on **this thread** again (up to $((timeout / 60)) min) — reply here." "$qid" >/dev/null
      echo "ask-human: resuming open question $qid for $key — no duplicate posted" >&2
    fi
  fi
fi

if [ -z "$qid" ]; then
  qid="$(post ":raising_hand: **Human decision needed** — reply **in this thread** to answer (waiting $((timeout / 60)) min).
$question" | jq -r .id)"
  echo "ask-human: posted question $qid" >&2
fi
echo "ask-human: waiting up to ${timeout}s for a thread reply on $qid" >&2

waited=0
while [ "$waited" -lt "$timeout" ]; do
  sleep "$poll"
  waited=$((waited + poll))
  # Tolerate transient fetch failures — just try again next poll.
  thread="$(api "$MATTERMOST_URL/api/v4/posts/$qid/thread" || true)"
  [ -z "$thread" ] && continue
  reply="$(first_reply "$thread" "$qid")"
  if [ -n "$reply" ]; then
    post ":white_check_mark: Got it — proceeding with that answer." "$qid" >/dev/null
    printf '%s\n' "$reply"
    exit 0
  fi
done

post ":hourglass: No reply after $((timeout / 60)) min — parking the issue as \`ready-for-human\`. You can still answer **in this thread**: the resume sweep (runs twice an hour) records your reply on the issue and re-adds \`ready-for-agent\`. Or answer on the linked issue and re-add \`ready-for-agent\` yourself." "$qid" >/dev/null
echo "ask-human: timed out after ${timeout}s" >&2
exit 3
