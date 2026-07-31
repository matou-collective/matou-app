#!/usr/bin/env bash
# Scenario tests for ../ask-human.sh against a fake Mattermost API
# (fakebin/curl routes API calls to canned JSON under $FAKE_DIR and records
# created posts in $FAKE_DIR/posts.log). No network, no real channel.
#
# Usage: .sandcastle/tests/test-ask-human.sh [path-to-ask-human.sh]
#
# Covers the 2026-07-27 duplicate-ask incident (b5fa537 + b35c686): killed
# pollers must not spawn duplicate questions, and late replies in ANY open
# thread for the issue must be recovered.
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="${1:-$here/../ask-human.sh}"
export PATH="$here/fakebin:$PATH"
export MATTERMOST_URL="http://mm.test"
export MATTERMOST_BOT_TOKEN="tok"
export MATTERMOST_CHANNEL_ID="chan"
export ASK_HUMAN_POLL=1

now_ms="$(($(date +%s) * 1000))"
pass=0 fail=0

mkpost() { # mkpost <id> <root> <user> <msg>
  jq -n --arg id "$1" --arg root "$2" --arg user "$3" --arg msg "$4" --argjson t "$now_ms" \
    '{id:$id, root_id:$root, user_id:$user, message:$msg, create_at:$t, delete_at:0}'
}

ask_msg=':raising_hand: **Human decision needed** — reply **in this thread** to answer (waiting 20 min).
[#129 transport: provisioning-updates-live](http://x/129)
Which do you want? A or B'

setup() {
  FAKE_DIR="$(mktemp -d)"
  export FAKE_DIR
}

check() { # check <desc> <cond>
  if eval "$2"; then pass=$((pass + 1)); else
    fail=$((fail + 1))
    echo "FAIL: $1"
  fi
}

# ---- T1: recovery — earlier ask for #129 has a late human reply, no confirmation
setup
jq -n --argjson q "$(mkpost OLDQ "" BOTID "$ask_msg")" '{posts:{OLDQ:$q}}' >"$FAKE_DIR/channel.json"
jq -n --argjson q "$(mkpost OLDQ "" BOTID "$ask_msg")" \
  --argjson r "$(mkpost R1 OLDQ HUMAN "B implement fully")" \
  '{posts:{OLDQ:$q, R1:$r}}' >"$FAKE_DIR/thread-OLDQ.json"
out="$(ASK_HUMAN_TIMEOUT=3 bash "$script" "question about [#129 x](u)" 2>/dev/null)"
rc=$?
check "T1 exit 0" "[ $rc -eq 0 ]"
check "T1 returns late reply" "[ \"$out\" = 'B implement fully' ]"
check "T1 confirms in old thread" "grep -q '\"root_id\": *\"OLDQ\"' \"\$FAKE_DIR/posts.log\" && grep -q white_check_mark \"\$FAKE_DIR/posts.log\""
check "T1 no duplicate question" "! grep -q raising_hand \"\$FAKE_DIR/posts.log\""

# ---- T2: resume — earlier ask for #129 unanswered: poll its thread, no duplicate post
setup
jq -n --argjson q "$(mkpost OLDQ "" BOTID "$ask_msg")" '{posts:{OLDQ:$q}}' >"$FAKE_DIR/channel.json"
jq -n --argjson q "$(mkpost OLDQ "" BOTID "$ask_msg")" '{posts:{OLDQ:$q}}' >"$FAKE_DIR/thread-OLDQ.json"
ASK_HUMAN_TIMEOUT=2 bash "$script" "question about [#129 x](u)" >/dev/null 2>&1
rc=$?
check "T2 exit 3 on timeout" "[ $rc -eq 3 ]"
check "T2 no duplicate question" "! grep -q raising_hand \"\$FAKE_DIR/posts.log\""
check "T2 parking notice in old thread" "grep -q hourglass \"\$FAKE_DIR/posts.log\" && grep -q '\"root_id\": *\"OLDQ\"' \"\$FAKE_DIR/posts.log\""
check "T2 resume note marks live thread" "grep -q eyes \"\$FAKE_DIR/posts.log\""

# ---- T3: fresh — only an ask for a DIFFERENT issue exists: post new question
setup
other_msg="${ask_msg//#129/#130}"
jq -n --argjson q "$(mkpost OTHQ "" BOTID "$other_msg")" '{posts:{OTHQ:$q}}' >"$FAKE_DIR/channel.json"
ASK_HUMAN_TIMEOUT=2 bash "$script" "question about [#129 x](u)" >/dev/null 2>&1
rc=$?
check "T3 exit 3 on timeout" "[ $rc -eq 3 ]"
check "T3 posts a new question" "grep -q raising_hand \"\$FAKE_DIR/posts.log\""
check "T3 parking notice on new thread" "grep -q '\"root_id\": *\"NEWQ1\"' \"\$FAKE_DIR/posts.log\""

# ---- T4: consumed — earlier ask was answered AND confirmed: ask fresh
setup
jq -n --argjson q "$(mkpost OLDQ "" BOTID "$ask_msg")" '{posts:{OLDQ:$q}}' >"$FAKE_DIR/channel.json"
jq -n --argjson q "$(mkpost OLDQ "" BOTID "$ask_msg")" \
  --argjson r "$(mkpost R1 OLDQ HUMAN "A")" \
  --argjson c "$(mkpost C1 OLDQ BOTID ":white_check_mark: Got it — proceeding with that answer.")" \
  '{posts:{OLDQ:$q, R1:$r, C1:$c}}' >"$FAKE_DIR/thread-OLDQ.json"
ASK_HUMAN_TIMEOUT=2 bash "$script" "question about [#129 x](u)" >/dev/null 2>&1
rc=$?
check "T4 exit 3 (old answer not reused)" "[ $rc -eq 3 ]"
check "T4 posts a new question" "grep -q raising_hand \"\$FAKE_DIR/posts.log\""

# ---- T5: normal flow — fresh question answered while polling
setup
echo '{"posts":{}}' >"$FAKE_DIR/channel.json"
jq -n --argjson q "$(mkpost NEWQ1 "" BOTID "$ask_msg")" \
  --argjson r "$(mkpost R1 NEWQ1 HUMAN "A please")" \
  '{posts:{NEWQ1:$q, R1:$r}}' >"$FAKE_DIR/thread-NEWQ1.json"
out="$(ASK_HUMAN_TIMEOUT=5 bash "$script" "question about [#129 x](u)" 2>/dev/null)"
rc=$?
check "T5 exit 0" "[ $rc -eq 0 ]"
check "T5 returns reply" "[ \"$out\" = 'A please' ]"
check "T5 confirms" "grep -q white_check_mark \"\$FAKE_DIR/posts.log\""

# ---- T6: two open threads for #129, human replied to the OLDER one
setup
old2_ms=$((now_ms - 60000))
q1="$(mkpost OLDQ1 "" BOTID "$ask_msg" | jq --argjson t "$old2_ms" '.create_at=$t')"
q2="$(mkpost OLDQ2 "" BOTID "$ask_msg")"
jq -n --argjson a "$q1" --argjson b "$q2" '{posts:{OLDQ1:$a, OLDQ2:$b}}' >"$FAKE_DIR/channel.json"
jq -n --argjson q "$q1" --argjson r "$(mkpost R1 OLDQ1 HUMAN "pick C")" \
  '{posts:{OLDQ1:$q, R1:$r}}' >"$FAKE_DIR/thread-OLDQ1.json"
jq -n --argjson q "$q2" '{posts:{OLDQ2:$q}}' >"$FAKE_DIR/thread-OLDQ2.json"
out="$(ASK_HUMAN_TIMEOUT=3 bash "$script" "question about [#129 x](u)" 2>/dev/null)"
rc=$?
check "T6 exit 0" "[ $rc -eq 0 ]"
check "T6 returns reply from older thread" "[ \"$out\" = 'pick C' ]"
check "T6 confirms in the answered thread" "grep -q '\"root_id\": *\"OLDQ1\"' \"\$FAKE_DIR/posts.log\""
check "T6 no duplicate question" "! grep -q raising_hand \"\$FAKE_DIR/posts.log\""

echo
echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
