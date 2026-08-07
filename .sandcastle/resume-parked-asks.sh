#!/usr/bin/env bash
# Make the parking notice's promise true: a late human reply in a parked ask
# thread re-arms its issue — without this sweep, "the next ask for this issue
# picks it up" is a dead end, because a `ready-for-human` issue is off the
# swarm's frontier and no next ask can ever run (the 2026-07-31 #203 incident).
#
# For every open issue labelled `ready-for-human`, judge its recent Mattermost
# ask threads by their CURRENT question (the thread model shared with
# ask-human.sh / post-issue-ask.sh: a bot root post starting `:raising_hand:`
# naming `#N` within $ASK_HUMAN_LOOKBACK; the current question is the newest
# bot `:raising_hand:` post in the thread; a bot `:white_check_mark:` at/after
# it consumes the round). If a round is answered but unconsumed:
#   1. the reply is copied onto the issue as the durable ruling record,
#   2. the issue is re-armed — `ready-for-agent` added (the label event fires
#      the swarm workflow), `ready-for-human` removed,
#   3. the thread is confirmed `:white_check_mark:` LAST — a crash mid-sweep
#      can park the issue re-armed with the thread unconsumed (the resumed
#      agent's own ask then recovers it), but can never consume a reply
#      without re-arming its issue.
# BACKSTOP: a parked issue the sweep did NOT re-arm gets post-issue-ask.sh —
# which posts the question thread if none is outstanding (none at all, or the
# newest thread is idle/consumed), quoting the issue's newest comment. So a
# `ready-for-human` issue ALWAYS has an answerable question in chat, and a
# design conversation keeps flowing round after round in one thread.
# Idempotent: a re-armed issue leaves the `ready-for-human` list, so it is
# never re-processed; a consumed round is never re-read; post-issue-ask.sh
# no-ops while a question is outstanding.
#
# Exit codes: 0 clean sweep (including nothing to do)
#             2 chat or tracker env unset
# Env: FORGEJO_TOKEN, FORGEJO_API (repo-scoped), MATTERMOST_URL,
#      MATTERMOST_CHANNEL_ID, MATTERMOST_BOT_TOKEN (or the bind-mounted
#      .sandcastle/secrets files — see secrets/README.md).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
lookback="${ASK_HUMAN_LOOKBACK:-172800}"

if [ -z "${MATTERMOST_BOT_TOKEN:-}" ] && [ -f /run/secrets/mattermost_bot_token ]; then
  MATTERMOST_BOT_TOKEN="$(cat /run/secrets/mattermost_bot_token)"
fi
if [ -z "${FORGEJO_TOKEN:-}" ] && [ -f /run/secrets/forgejo_token ]; then
  FORGEJO_TOKEN="$(cat /run/secrets/forgejo_token)"
fi

if [ -z "${MATTERMOST_URL:-}" ] || [ -z "${MATTERMOST_BOT_TOKEN:-}" ] ||
  [ -z "${MATTERMOST_CHANNEL_ID:-}" ] || [ -z "${FORGEJO_TOKEN:-}" ] ||
  [ -z "${FORGEJO_API:-}" ]; then
  echo "resume-parked-asks: MATTERMOST_URL/MATTERMOST_BOT_TOKEN/MATTERMOST_CHANNEL_ID/FORGEJO_TOKEN/FORGEJO_API unset — cannot sweep" >&2
  exit 2
fi

mm() { curl -sf -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" "$@"; }
fj() { curl -sf -H "Authorization: token $FORGEJO_TOKEN" "$@"; }

mm_post() { # mm_post <message> <root_id>
  jq -n --arg channel_id "$MATTERMOST_CHANNEL_ID" --arg message "$1" --arg root_id "$2" \
    '{channel_id: $channel_id, message: $message, root_id: $root_id}' |
    mm -X POST -H 'Content-Type: application/json' -d @- "$MATTERMOST_URL/api/v4/posts"
}

first_reply() { # first_reply <thread_json> <root_id> <min_ts> — earliest human reply to the current round, or empty (verbatim from ask-human.sh)
  jq -r --arg root "$2" --arg bot "$bot_id" --argjson min "$3" \
    '[.posts[] | select(.root_id == $root and .user_id != $bot and .delete_at == 0
                        and .create_at >= $min)]
     | sort_by(.create_at) | first | .message // empty' <<<"$1"
}

latest_question_ts() { # latest_question_ts <thread_json> <root_id> — create_at of the CURRENT question (verbatim from ask-human.sh)
  jq -r --arg root "$2" --arg bot "$bot_id" \
    '[.posts[] | select((.id == $root or .root_id == $root) and .user_id == $bot
                        and .delete_at == 0
                        and (.message | startswith(":raising_hand:")))]
     | max_by(.create_at) | .create_at // 0' <<<"$1"
}

consumed_after() { # consumed_after <thread_json> <root_id> <min_ts> — bot :white_check_mark: count at/after min_ts (verbatim from ask-human.sh)
  jq -r --arg root "$2" --arg bot "$bot_id" --argjson min "$3" \
    '[.posts[] | select(.root_id == $root and .user_id == $bot and .delete_at == 0
                        and .create_at >= $min
                        and (.message | startswith(":white_check_mark:")))] | length' <<<"$1"
}

parked="$(fj "$FORGEJO_API/issues?state=open&type=issues&labels=ready-for-human&limit=50")"
numbers="$(jq -r '.[].number' <<<"$parked")"
if [ -z "$numbers" ]; then
  echo "resume-parked-asks: nothing parked" >&2
  exit 0
fi

bot_id="$(mm "$MATTERMOST_URL/api/v4/users/me" | jq -r .id)"
chan="$(mm "$MATTERMOST_URL/api/v4/channels/$MATTERMOST_CHANNEL_ID/posts?per_page=200")"
cutoff_ms=$((($(date +%s) - lookback) * 1000))

repo_labels="$(fj "$FORGEJO_API/labels?limit=50")"
agent_id="$(jq -r '.[] | select(.name == "ready-for-agent") | .id' <<<"$repo_labels")"
human_id="$(jq -r '.[] | select(.name == "ready-for-human") | .id' <<<"$repo_labels")"

rearmed=0
for n in $numbers; do
  key="#$n"
  hit=0
  # Candidate ask threads, newest first — same selection as ask-human.sh.
  cands="$(jq -r --arg bot "$bot_id" --arg key "$key" --argjson cutoff "$cutoff_ms" \
    '[.posts[] | select(.user_id == $bot and .root_id == "" and .delete_at == 0
                        and .create_at >= $cutoff
                        and (.message | startswith(":raising_hand:"))
                        and (.message | test($key + "([^0-9]|$)")))]
     | sort_by(.create_at) | reverse | .[].id' <<<"$chan")"
  for cand in $cands; do
    thread="$(mm "$MATTERMOST_URL/api/v4/posts/$cand/thread" || true)"
    [ -z "$thread" ] && continue
    qts="$(latest_question_ts "$thread" "$cand")"
    [ "$(consumed_after "$thread" "$cand" "$qts")" -gt 0 ] && continue
    reply="$(first_reply "$thread" "$cand" "$qts")"
    [ -z "$reply" ] && continue

    # 1. Durable record first — the ruling must outlive chat history.
    quoted="$(sed 's/^/> /' <<<"$reply")"
    jq -n --arg body "**Human ruling — picked up from the parked chat ask by the resume sweep:**

$quoted

Re-armed \`ready-for-agent\`. Next agent: this is the recorded ruling for the decision the parked run asked about — follow it, do not re-ask." \
      '{body: $body}' |
      fj -X POST -H 'Content-Type: application/json' -d @- "$FORGEJO_API/issues/$n/comments" >/dev/null

    # 2. Re-arm: add ready-for-agent (fires the swarm), drop ready-for-human.
    jq -nc --argjson id "$agent_id" '{labels: [$id]}' |
      fj -X POST -H 'Content-Type: application/json' -d @- "$FORGEJO_API/issues/$n/labels" >/dev/null
    fj -X DELETE "$FORGEJO_API/issues/$n/labels/$human_id" >/dev/null

    # 3. Consume the thread LAST.
    mm_post ":white_check_mark: Got it — picked up this reply, recorded it on the issue, and re-armed \`ready-for-agent\`. The next agent follows it." "$cand" >/dev/null

    echo "resume-parked-asks: re-armed #$n from thread $cand"
    rearmed=$((rearmed + 1))
    hit=1
    break
  done
  if [ "$hit" -eq 0 ]; then
    # Backstop: still parked, nothing picked up — make sure an answerable
    # question is outstanding (post-issue-ask no-ops if one already is).
    bash "$here/post-issue-ask.sh" "$n" || true
  fi
done
echo "resume-parked-asks: swept $(wc -w <<<"$numbers") parked, re-armed $rearmed" >&2
