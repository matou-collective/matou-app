#!/usr/bin/env bash
# Scenario tests for ../post-issue-ask.sh against the fake Mattermost +
# Forgejo API (fakebin/curl). No network.
#
# Usage: .sandcastle/tests/post-issue-ask-test.sh [path-to-script]
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="${1:-$here/../post-issue-ask.sh}"
export PATH="$here/fakebin:$PATH"
export MATTERMOST_URL="http://mm.test"
export MATTERMOST_BOT_TOKEN="tok"
export MATTERMOST_CHANNEL_ID="chan"
export FORGEJO_TOKEN="ftok"
export FORGEJO_API="http://fj.test/api/v1/repos/Matou/idss"

now_ms="$(($(date +%s) * 1000))"
pass=0 fail=0

mkpost() { # mkpost <id> <root> <user> <msg> [create_at_ms]
  jq -n --arg id "$1" --arg root "$2" --arg user "$3" --arg msg "$4" \
    --argjson t "${5:-$now_ms}" \
    '{id:$id, root_id:$root, user_id:$user, message:$msg, create_at:$t, delete_at:0}'
}

mkissue() { # mkissue <number> <body> — writes issue-<n>.json
  jq -n --argjson n "$1" --arg body "$2" \
    '{number:$n, title:"widget frobnicator", html_url:("http://x/"+($n|tostring)), body:$body}' \
    >"$FAKE_DIR/issue-$1.json"
}

ask_msg() { # ask_msg <number> — a plausible existing root ask
  printf ':raising_hand: **Human decision needed** — reply **in this thread** to answer.
[#%s widget frobnicator](http://x/%s)' "$1" "$1"
}

setup() {
  FAKE_DIR="$(mktemp -d)"
  export FAKE_DIR
  echo '{"posts":{}}' >"$FAKE_DIR/channel.json"
}

check() { # check <desc> <cond>
  if eval "$2"; then pass=$((pass + 1)); else
    fail=$((fail + 1))
    echo "FAIL: $1"
  fi
}

# ---- P1: no thread at all — post a fresh root quoting the newest comment
setup
mkissue 301 "issue body text"
jq -n '[{body:"triage: first note"},{body:"What colour should the bikeshed be?"}]' >"$FAKE_DIR/comments-301.json"
bash "$script" 301 >/dev/null 2>&1
rc=$?
check "P1 exit 0" "[ $rc -eq 0 ]"
check "P1 root ask posted" "grep -q raising_hand \"\$FAKE_DIR/posts.log\" && ! grep -q root_id \"\$FAKE_DIR/posts.log\""
check "P1 quotes newest comment" "grep -q 'colour should the bikeshed' \"\$FAKE_DIR/posts.log\""
check "P1 links the issue" "grep -q '#301 widget frobnicator' \"\$FAKE_DIR/posts.log\""

# ---- P2: outstanding unanswered question — no post
setup
jq -n --argjson q "$(mkpost Q302 "" BOTID "$(ask_msg 302)")" '{posts:{Q302:$q}}' >"$FAKE_DIR/channel.json"
jq -n --argjson q "$(mkpost Q302 "" BOTID "$(ask_msg 302)")" '{posts:{Q302:$q}}' >"$FAKE_DIR/thread-Q302.json"
bash "$script" 302 >/dev/null 2>&1
rc=$?
check "P2 exit 0" "[ $rc -eq 0 ]"
check "P2 nothing posted" "[ ! -s \"\$FAKE_DIR/posts.log\" ]"

# ---- P3: answered but unconsumed — still outstanding (the sweep's pickup half owns it)
setup
jq -n --argjson q "$(mkpost Q303 "" BOTID "$(ask_msg 303)")" '{posts:{Q303:$q}}' >"$FAKE_DIR/channel.json"
jq -n --argjson q "$(mkpost Q303 "" BOTID "$(ask_msg 303)")" \
  --argjson r "$(mkpost R1 Q303 HUMAN "blue")" \
  '{posts:{Q303:$q, R1:$r}}' >"$FAKE_DIR/thread-Q303.json"
bash "$script" 303 >/dev/null 2>&1
check "P3 nothing posted" "[ ! -s \"\$FAKE_DIR/posts.log\" ]"

# ---- P4: idle thread (current question consumed) — follow-up reply IN the thread
setup
mkissue 304 "issue body text"
jq -n '[{body:"agent: next I need to know the auth model — session or token?"}]' >"$FAKE_DIR/comments-304.json"
jq -n --argjson q "$(mkpost Q304 "" BOTID "$(ask_msg 304)")" '{posts:{Q304:$q}}' >"$FAKE_DIR/channel.json"
jq -n --argjson q "$(mkpost Q304 "" BOTID "$(ask_msg 304)")" \
  --argjson r "$(mkpost R1 Q304 HUMAN "blue")" \
  --argjson c "$(mkpost C1 Q304 BOTID ":white_check_mark: Got it — proceeding with that answer.")" \
  '{posts:{Q304:$q, R1:$r, C1:$c}}' >"$FAKE_DIR/thread-Q304.json"
bash "$script" 304 >/dev/null 2>&1
rc=$?
check "P4 exit 0" "[ $rc -eq 0 ]"
check "P4 follow-up posted in thread" "grep -q raising_hand \"\$FAKE_DIR/posts.log\" && grep -q '\"root_id\": *\"Q304\"' \"\$FAKE_DIR/posts.log\""
check "P4 quotes newest comment" "grep -q 'session or token' \"\$FAKE_DIR/posts.log\""

# ---- P5: no comments — fall back to the issue body
setup
mkissue 305 "the body is the only context"
bash "$script" 305 >/dev/null 2>&1
check "P5 root ask posted from body" "grep -q 'the body is the only context' \"\$FAKE_DIR/posts.log\""

# ---- P6: root older than the lookback — fresh root, not a follow-up
setup
mkissue 306 "issue body text"
old_ms=$((now_ms - 200000 * 1000)) # > 48 h ago
jq -n --argjson q "$(mkpost Q306 "" BOTID "$(ask_msg 306)" "$old_ms")" '{posts:{Q306:$q}}' >"$FAKE_DIR/channel.json"
bash "$script" 306 >/dev/null 2>&1
check "P6 fresh root posted" "grep -q raising_hand \"\$FAKE_DIR/posts.log\" && ! grep -q root_id \"\$FAKE_DIR/posts.log\""

# ---- P8: long comment (over the old 500-char cut) — quoted in full
setup
mkissue 308 "issue body text"
long_comment="$(seq -s ' ' 1 300) which of these three storage layouts do you want END-OF-QUESTION-MARKER"
jq -n --arg body "$long_comment" '[{body:$body}]' >"$FAKE_DIR/comments-308.json"
bash "$script" 308 >/dev/null 2>&1
check "P8 end of long comment present" "grep -q 'END-OF-QUESTION-MARKER' \"\$FAKE_DIR/posts.log\""
check "P8 no truncation note" "! grep -q 'truncated — the full text' \"\$FAKE_DIR/posts.log\""

# ---- P9: comment over the Mattermost-safe cap — cut, but SAYS so
setup
mkissue 309 "issue body text"
jq -n --arg body "$(seq -s ' ' 1 900)" '[{body:$body}]' >"$FAKE_DIR/comments-309.json"
bash "$script" 309 >/dev/null 2>&1
check "P9 truncation note present" "grep -q 'truncated — the full text is on the issue' \"\$FAKE_DIR/posts.log\""

# ---- P7: chat env unset — exit 2, nothing called. Scrub ALL three
# MATTERMOST_* vars, not just the token: post-issue-ask.sh falls back to
# /run/secrets/mattermost_bot_token when MATTERMOST_BOT_TOKEN is unset, so a
# host carrying that secret (every real worker does) refills the token and the
# guard never fires. MATTERMOST_URL/MATTERMOST_CHANNEL_ID have no such fallback,
# so dropping them keeps this case hermetic to the ambient chat env (#587).
setup
env -u MATTERMOST_URL -u MATTERMOST_BOT_TOKEN -u MATTERMOST_CHANNEL_ID \
  bash "$script" 307 >/dev/null 2>&1
rc=$?
check "P7 exit 2" "[ $rc -eq 2 ]"
check "P7 no calls" "[ ! -s \"\$FAKE_DIR/calls.log\" ]"

echo "post-issue-ask: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
