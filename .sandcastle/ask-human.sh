#!/usr/bin/env bash
# Ask a human a question in Mattermost and wait for a DIRECT reply in the
# question's own thread. On success the reply text is printed to stdout.
#
# Usage: ask-human.sh "<question>" [timeout_seconds]
#   timeout defaults to $ASK_HUMAN_TIMEOUT or 1200 (20 min); polls every
#   $ASK_HUMAN_POLL (20) seconds.
#
# Questions are RESUMABLE and MULTI-ROUND, keyed by the first issue reference
# (`#N`) in the question text. An issue's conversation lives in ONE thread:
# the newest bot root post starting `:raising_hand:` naming `#N` (within
# $ASK_HUMAN_LOOKBACK, default 48 h). Within a thread, a QUESTION is the root
# or any bot reply starting `:raising_hand:`; the CURRENT question is the
# newest; it is CONSUMED once a bot `:white_check_mark:` follows it. Before
# posting, every recent thread for the issue is judged by its current
# question, newest thread first:
#   - answered but not consumed (e.g. the reply arrived after the previous
#     poller died, in whichever thread the human happened to answer) — the
#     reply is returned immediately;
#   - unanswered and not consumed — polling resumes there; no duplicate
#     question is posted, an :eyes: note marks the live thread (2026-07-27:
#     seven duplicate asks for #129);
#   - consumed — the thread is idle; the NEW question is posted INTO it as a
#     `:raising_hand:` thread reply, so a design conversation's rounds stay
#     in one thread. Only when no thread exists at all does a fresh root get
#     posted.
# Replies are matched per ROUND: only thread posts at/after the current
# question's create_at count, so an earlier round's answer is never re-read.
#
# Only posts whose root_id is the thread root — i.e. replies inside its
# thread — and whose author is not the bot count as answers. Channel chatter
# and other threads are never picked up. The bot must be a MEMBER of the
# channel (posting works without membership; reading the thread does not).
#
# Exit codes: 0 reply received (stdout = reply text)
#             2 Mattermost env unset (chat not wired up)
#             3 timed out (parking notice posted) or interrupted/killed —
#               either way the round stays open and a later ask for the
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

first_reply() { # first_reply <thread_json> <root_id> <min_ts> — earliest human reply to the current round, or empty
  jq -r --arg root "$2" --arg bot "$bot_id" --argjson min "$3" \
    '[.posts[] | select(.root_id == $root and .user_id != $bot and .delete_at == 0
                        and .create_at >= $min)]
     | sort_by(.create_at) | first | .message // empty' <<<"$1"
}

latest_question_ts() { # latest_question_ts <thread_json> <root_id> — create_at of the CURRENT question
  jq -r --arg root "$2" --arg bot "$bot_id" \
    '[.posts[] | select((.id == $root or .root_id == $root) and .user_id == $bot
                        and .delete_at == 0
                        and (.message | startswith(":raising_hand:")))]
     | max_by(.create_at) | .create_at // 0' <<<"$1"
}

consumed_after() { # consumed_after <thread_json> <root_id> <min_ts> — bot :white_check_mark: count at/after min_ts
  jq -r --arg root "$2" --arg bot "$bot_id" --argjson min "$3" \
    '[.posts[] | select(.root_id == $root and .user_id == $bot and .delete_at == 0
                        and .create_at >= $min
                        and (.message | startswith(":white_check_mark:")))] | length' <<<"$1"
}

bot_id="$(api "$MATTERMOST_URL/api/v4/users/me" | jq -r .id)"

# Resume path: judge every recent thread for the issue by its CURRENT question,
# newest thread first. A late reply anywhere wins; an open round resumes; the
# newest idle (fully-consumed) thread is where a follow-up question goes.
key="$(grep -oE '#[0-9]+' <<<"$question" | head -1 || true)"
qid=""
q_ts=0
idle=""
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
      qts="$(latest_question_ts "$thread" "$cand")"
      if [ "$(consumed_after "$thread" "$cand" "$qts")" -gt 0 ]; then
        [ -z "$idle" ] && idle="$cand"
        continue
      fi
      reply="$(first_reply "$thread" "$cand" "$qts")"
      if [ -n "$reply" ]; then
        post ":white_check_mark: Got it — picked up this earlier reply; proceeding with it." "$cand" >/dev/null
        printf '%s\n' "$reply"
        exit 0
      fi
      if [ -z "$qid" ]; then
        qid="$cand"
        q_ts="$qts"
      fi
    done
    if [ -n "$qid" ]; then
      post ":eyes: Waiting on **this thread** again (up to $((timeout / 60)) min) — reply here." "$qid" >/dev/null
      echo "ask-human: resuming open question $qid for $key — no duplicate posted" >&2
    fi
  fi
fi

if [ -z "$qid" ] && [ -n "$idle" ]; then
  # Idle conversation thread: the next round continues THERE, not in a new root.
  qpost="$(post ":raising_hand: **Follow-up** — reply **in this thread** to answer (waiting $((timeout / 60)) min).
$question" "$idle")"
  qid="$idle"
  q_ts="$(jq -r '.create_at // 0' <<<"$qpost")"
  echo "ask-human: posted follow-up question in thread $idle" >&2
elif [ -z "$qid" ]; then
  qpost="$(post ":raising_hand: **Human decision needed** — reply **in this thread** to answer (waiting $((timeout / 60)) min).
$question")"
  qid="$(jq -r .id <<<"$qpost")"
  q_ts="$(jq -r '.create_at // 0' <<<"$qpost")"
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
  reply="$(first_reply "$thread" "$qid" "$q_ts")"
  if [ -n "$reply" ]; then
    post ":white_check_mark: Got it — proceeding with that answer." "$qid" >/dev/null
    printf '%s\n' "$reply"
    exit 0
  fi
done

post ":hourglass: No reply after $((timeout / 60)) min — parking the issue as \`ready-for-human\`. You can still answer **in this thread**: the resume sweep (runs twice an hour) records your reply on the issue and re-adds \`ready-for-agent\`. Or answer on the linked issue and re-add \`ready-for-agent\` yourself." "$qid" >/dev/null
echo "ask-human: timed out after ${timeout}s" >&2
exit 3
