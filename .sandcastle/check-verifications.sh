#!/usr/bin/env bash
# Promote awaiting-verification issues per Mattermost thread replies.
# approve → ready-for-agent; reject → wontfix+closed; chatter → issue comment.
# Idempotent: every processed reply id is embedded in a bot thread post.
# Env: FORGEJO_TOKEN, FORGEJO_API, MATTERMOST_URL/MATTERMOST_BOT_TOKEN/
#      MATTERMOST_CHANNEL_ID (unset → log and exit 0).
set -euo pipefail
: "${FORGEJO_TOKEN:?}"
: "${FORGEJO_API:=https://git.matou.nz/api/v1/repos/Matou/matou-app}"

if [ -z "${MATTERMOST_BOT_TOKEN:-}" ] && [ -f /run/secrets/mattermost_bot_token ]; then
  MATTERMOST_BOT_TOKEN="$(cat /run/secrets/mattermost_bot_token)"
fi
if [ -z "${MATTERMOST_URL:-}" ] || [ -z "${MATTERMOST_BOT_TOKEN:-}" ] || [ -z "${MATTERMOST_CHANNEL_ID:-}" ]; then
  echo "check-verifications: MATTERMOST_URL/MATTERMOST_BOT_TOKEN/MATTERMOST_CHANNEL_ID unset — cannot poll" >&2
  exit 0
fi

fapi() { curl -sf -H "Authorization: token $FORGEJO_TOKEN" "$@"; }
mapi() { curl -sf -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" "$@"; }

post() { # post <message> [root_id] — root_id makes it a thread reply (verbatim from ask-human.sh)
  jq -n --arg channel_id "$MATTERMOST_CHANNEL_ID" --arg message "$1" --arg root_id "${2:-}" \
    '{channel_id: $channel_id, message: $message}
     + (if $root_id != "" then {root_id: $root_id} else {} end)' |
    mapi -X POST -H 'Content-Type: application/json' -d @- "$MATTERMOST_URL/api/v4/posts"
}

bot_id="$(mapi "$MATTERMOST_URL/api/v4/users/me" | jq -r .id)"

awaiting="$(fapi "$FORGEJO_API/issues?state=open&type=issues&labels=awaiting-verification&limit=50")"
count="$(jq 'length' <<<"$awaiting")"
if [ "$count" -eq 0 ]; then
  echo "check-verifications: nothing awaiting verification" >&2
  exit 0
fi

repo_labels="$(fapi "$FORGEJO_API/labels?limit=50")"
awaiting_id="$(jq -r '.[] | select(.name == "awaiting-verification") | .id' <<<"$repo_labels")"
ready_id="$(jq -r '.[] | select(.name == "ready-for-agent") | .id' <<<"$repo_labels")"
wontfix_id="$(jq -r '.[] | select(.name == "wontfix") | .id' <<<"$repo_labels")"

# One channel scan for the whole run — same approach as ask-human.sh /
# resume-parked-asks.sh: cheaper than a per-issue fetch and avoids racing
# against posts made mid-run.
chan="$(mapi "$MATTERMOST_URL/api/v4/channels/$MATTERMOST_CHANNEL_ID/posts?per_page=200")"

processed=0
while IFS= read -r issue; do
  [ -z "$issue" ] && continue
  n="$(jq -r '.number' <<<"$issue")"
  title="$(jq -r '.title' <<<"$issue")"
  url="$(jq -r '.html_url' <<<"$issue")"
  body="$(jq -r '.body // ""' <<<"$issue")"
  key="#$n"

  # Newest bot root post starting :mag: and naming this issue — same
  # test($key + "([^0-9]|$)") guard ask-human.sh uses for #N matching.
  thread_id="$(jq -r --arg bot "$bot_id" --arg key "$key" \
    '[.posts[] | select(.user_id == $bot and .root_id == "" and .delete_at == 0
                        and (.message | startswith(":mag:"))
                        and (.message | test($key + "([^0-9]|$)")))]
     | sort_by(.create_at) | reverse | .[0].id // empty' <<<"$chan")"

  if [ -z "$thread_id" ]; then
    excerpt="$(printf '%s' "$body" | head -c 500)"
    post ":mag: **Verify $key** — $title
$url

$excerpt

Reply **approve** (optionally followed by guidance for the agent) or **reject** (optionally a reason) in this thread. Anything else is copied to the issue as a comment." >/dev/null
    echo "check-verifications: $key has no verify thread — posted a new one" >&2
    continue
  fi

  thread="$(mapi "$MATTERMOST_URL/api/v4/posts/$thread_id/thread" || true)"
  [ -z "$thread" ] && continue

  replies="$(jq -r --arg tid "$thread_id" --arg bot "$bot_id" \
    '[.posts[] | select(.root_id == $tid and .user_id != $bot and .delete_at == 0)]
     | sort_by(.create_at) | .[].id' <<<"$thread")"

  for rid in $replies; do
    # Consumption check: has ANY bot post in the thread already embedded this
    # reply's id, fixed-string `<post_id>`?
    consumed="$(jq -r --arg rid "$rid" --arg bot "$bot_id" \
      '[.posts[] | select(.user_id == $bot and (.message | contains("`" + $rid + "`")))] | length' <<<"$thread")"
    [ "$consumed" -gt 0 ] && continue

    msg="$(jq -r --arg rid "$rid" '.posts[$rid].message' <<<"$thread")"
    word="$(awk '{print tolower($1)}' <<<"$msg")"
    remainder="$(awk '{$1=""; print}' <<<"$msg" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"

    case "$word" in
      approve)
        # POST the new label before DELETE-ing the old one — same
        # crash-safety order resume-parked-asks.sh uses: a transient failure
        # between the two calls must never leave the issue in neither label
        # set (invisible to every future sweep).
        jq -nc --argjson id "$ready_id" '{labels: [$id]}' |
          fapi -X POST -H 'Content-Type: application/json' -d @- "$FORGEJO_API/issues/$n/labels" >/dev/null
        fapi -X DELETE "$FORGEJO_API/issues/$n/labels/$awaiting_id" >/dev/null
        if [ -n "$remainder" ]; then
          jq -n --arg body "**Verification guidance:** $remainder" '{body: $body}' |
            fapi -X POST -H 'Content-Type: application/json' -d @- "$FORGEJO_API/issues/$n/comments" >/dev/null
        fi
        post ":white_check_mark: Approved — $key is now ready-for-agent. (\`$rid\`)" "$thread_id" >/dev/null
        processed=$((processed + 1))
        break
        ;;
      reject)
        # Same POST-before-DELETE ordering as the approve path.
        jq -nc --argjson id "$wontfix_id" '{labels: [$id]}' |
          fapi -X POST -H 'Content-Type: application/json' -d @- "$FORGEJO_API/issues/$n/labels" >/dev/null
        fapi -X DELETE "$FORGEJO_API/issues/$n/labels/$awaiting_id" >/dev/null
        jq -nc '{state: "closed"}' |
          fapi -X PATCH -H 'Content-Type: application/json' -d @- "$FORGEJO_API/issues/$n" >/dev/null
        if [ -n "$remainder" ]; then
          jq -n --arg body "**Rejected:** $remainder" '{body: $body}' |
            fapi -X POST -H 'Content-Type: application/json' -d @- "$FORGEJO_API/issues/$n/comments" >/dev/null
        fi
        post ":white_check_mark: Rejected — $key closed as wontfix. (\`$rid\`)" "$thread_id" >/dev/null
        processed=$((processed + 1))
        break
        ;;
      *)
        jq -n --arg body "**From Mattermost:** $msg" '{body: $body}' |
          fapi -X POST -H 'Content-Type: application/json' -d @- "$FORGEJO_API/issues/$n/comments" >/dev/null
        post ":speech_balloon: Copied to the issue. (\`$rid\`)" "$thread_id" >/dev/null
        processed=$((processed + 1))
        ;;
    esac
  done
done < <(jq -c '.[]' <<<"$awaiting")

echo "check-verifications: processed $processed reply/replies across $count awaiting issue(s)" >&2
