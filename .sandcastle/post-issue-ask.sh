#!/usr/bin/env bash
# Ensure a human-gated issue has an OUTSTANDING Mattermost ask — the
# answerable `:raising_hand:` question whose reply the resume sweep records on
# the issue and turns back into `ready-for-agent`. The idempotent primitive
# behind "the question reaches you in chat": run-triage.sh calls it straight
# after triage parks an issue, resume-parked-asks.sh calls it as the backstop.
#
# Thread model (per issue #N, shared with ask-human.sh): ONE conversation
# thread — the newest bot root post starting `:raising_hand:` naming #N within
# $ASK_HUMAN_LOOKBACK (48 h). A QUESTION is the root or any bot thread-reply
# starting `:raising_hand:`; the CURRENT question is the newest; it is
# CONSUMED once a bot `:white_check_mark:` follows it (create_at >=). So:
#   - current question unconsumed (answered or not) -> OUTSTANDING -> no-op;
#   - thread idle (current question consumed) -> post the next question as a
#     `:raising_hand:` THREAD REPLY — a design conversation's rounds stay in
#     one thread;
#   - no thread in the lookback -> post a fresh `:raising_hand:` root.
# The question text quotes the issue's NEWEST comment (triage and agents write
# what needs deciding there), falling back to the issue body.
#
# Usage: post-issue-ask.sh <issue-number>
# Exit:  0 posted or already outstanding; 2 chat or tracker env unset.
# Env: FORGEJO_TOKEN, FORGEJO_API (repo-scoped), MATTERMOST_URL,
#      MATTERMOST_CHANNEL_ID, MATTERMOST_BOT_TOKEN (or the bind-mounted
#      .sandcastle/secrets files — see secrets/README.md).
set -euo pipefail

n="${1:?usage: post-issue-ask.sh <issue-number>}"
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
  echo "post-issue-ask: MATTERMOST_URL/MATTERMOST_BOT_TOKEN/MATTERMOST_CHANNEL_ID/FORGEJO_TOKEN/FORGEJO_API unset — cannot ask" >&2
  exit 2
fi

mm() { curl -sf -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" "$@"; }
fj() { curl -sf -H "Authorization: token $FORGEJO_TOKEN" "$@"; }

mm_post() { # mm_post <message> [root_id] — root_id makes it a thread reply
  jq -n --arg channel_id "$MATTERMOST_CHANNEL_ID" --arg message "$1" --arg root_id "${2:-}" \
    '{channel_id: $channel_id, message: $message}
     + (if $root_id != "" then {root_id: $root_id} else {} end)' |
    mm -X POST -H 'Content-Type: application/json' -d @- "$MATTERMOST_URL/api/v4/posts"
}

bot_id="$(mm "$MATTERMOST_URL/api/v4/users/me" | jq -r .id)"
chan="$(mm "$MATTERMOST_URL/api/v4/channels/$MATTERMOST_CHANNEL_ID/posts?per_page=200")"
cutoff_ms=$((($(date +%s) - lookback) * 1000))
key="#$n"

root="$(jq -r --arg bot "$bot_id" --arg key "$key" --argjson cutoff "$cutoff_ms" \
  '[.posts[] | select(.user_id == $bot and .root_id == "" and .delete_at == 0
                      and .create_at >= $cutoff
                      and (.message | startswith(":raising_hand:"))
                      and (.message | test($key + "([^0-9]|$)")))]
   | sort_by(.create_at) | last | .id // empty' <<<"$chan")"

if [ -n "$root" ]; then
  thread="$(mm "$MATTERMOST_URL/api/v4/posts/$root/thread" || true)"
  if [ -z "$thread" ]; then
    # Can't judge the thread — do NOT risk a duplicate; the next sweep retries.
    echo "post-issue-ask: thread $root unreadable — skipping #$n this round" >&2
    exit 0
  fi
  outstanding="$(jq -r --arg root "$root" --arg bot "$bot_id" '
    ([.posts[] | select((.id == $root or .root_id == $root) and .user_id == $bot
                        and .delete_at == 0
                        and (.message | startswith(":raising_hand:")))]
     | max_by(.create_at) | .create_at) as $qts
    | [.posts[] | select(.root_id == $root and .user_id == $bot
                         and .delete_at == 0 and .create_at >= $qts
                         and (.message | startswith(":white_check_mark:")))]
    | length == 0' <<<"$thread")"
  if [ "$outstanding" = "true" ]; then
    echo "post-issue-ask: #$n already has an outstanding ask ($root) — nothing to do"
    exit 0
  fi
fi

issue="$(fj "$FORGEJO_API/issues/$n")"
title="$(jq -r .title <<<"$issue")"
url="$(jq -r .html_url <<<"$issue")"
# The full decision context: the newest comment (triage/agents write what
# needs deciding there), else the issue body. Cap near Mattermost's 4000-char
# post limit and SAY SO when cut — a silent 500-char excerpt hid the actual
# question (2026-08-06).
limit="${ASK_EXCERPT_LIMIT:-3000}"
full="$(fj "$FORGEJO_API/issues/$n/comments" | jq -r 'last | .body // empty')"
[ -n "$full" ] || full="$(jq -r '.body // ""' <<<"$issue")"
excerpt="$(head -c "$limit" <<<"$full")"
if [ "$(printf %s "$full" | wc -c)" -gt "$limit" ]; then
  excerpt="$excerpt
…(truncated — the full text is on the issue)"
fi
quoted="$(sed 's/^/> /' <<<"$excerpt")"

body=":raising_hand: **Human decision needed** — reply **in this thread** to answer.
[#$n $title]($url)

$quoted

Your reply is recorded on the issue and it goes back to \`ready-for-agent\` (the resume sweep runs twice an hour)."

if [ -n "$root" ]; then
  mm_post "$body" "$root" >/dev/null
  echo "post-issue-ask: posted follow-up ask for #$n in thread $root"
else
  mm_post "$body" >/dev/null
  echo "post-issue-ask: posted new ask thread for #$n"
fi
