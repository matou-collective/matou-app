#!/usr/bin/env bash
# Scenario tests for ../resume-parked-asks.sh against the fake Mattermost +
# Forgejo API (fakebin/curl). No network.
#
# Usage: .sandcastle/tests/resume-parked-asks-test.sh [path-to-script]
#
# Covers the 2026-07-31 #203 incident: a late reply in a parked ask thread was
# never read, because "the next ask picks it up" requires the issue back on the
# frontier — which only a human re-label could cause. The sweep closes that
# loop: parked issue + unconsumed ask thread + human reply → durable ruling
# comment on the issue, re-armed `ready-for-agent`, thread confirmed LAST.
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="${1:-$here/../resume-parked-asks.sh}"
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

mkissue() { # mkissue <number> — an open ready-for-human issue
  jq -n --argjson n "$1" '{number:$n, labels:[{id:41,name:"enhancement"},{id:37,name:"ready-for-human"}]}'
}

mkissue_json() { # mkissue_json <number> — issue-<n>.json for post-issue-ask
  jq -n --argjson n "$1" \
    '{number:$n, title:"backup: movement-compose", html_url:("http://x/"+($n|tostring)), body:"fixture issue body"}' \
    >"$FAKE_DIR/issue-$1.json"
}

ask_msg() { # ask_msg <number>
  printf ':raising_hand: **Human decision needed** — reply **in this thread** to answer (waiting 20 min).
[#%s backup: movement-compose](http://x/%s)
A, B or C?' "$1" "$1"
}

setup() {
  FAKE_DIR="$(mktemp -d)"
  export FAKE_DIR
  jq -n '[{"id":36,"name":"ready-for-agent"},{"id":37,"name":"ready-for-human"}]' >"$FAKE_DIR/labels.json"
}

check() { # check <desc> <cond>
  if eval "$2"; then pass=$((pass + 1)); else
    fail=$((fail + 1))
    echo "FAIL: $1"
  fi
}

# ---- T1: the incident — parked #203, unconsumed ask, human replied late
setup
jq -n --argjson i "$(mkissue 203)" '[$i]' >"$FAKE_DIR/issues.json"
jq -n --argjson q "$(mkpost Q203 "" BOTID "$(ask_msg 203)")" '{posts:{Q203:$q}}' >"$FAKE_DIR/channel.json"
jq -n --argjson q "$(mkpost Q203 "" BOTID "$(ask_msg 203)")" \
  --argjson r "$(mkpost R1 Q203 HUMAN "Option A - seed the 5th crown-jewel var")" \
  '{posts:{Q203:$q, R1:$r}}' >"$FAKE_DIR/thread-Q203.json"
bash "$script" >/dev/null 2>&1
rc=$?
check "T1 exit 0" "[ $rc -eq 0 ]"
check "T1 ruling comment on issue" "grep -q 'POST .*/issues/203/comments' \"\$FAKE_DIR/calls.log\" && grep -q 'Option A - seed the 5th crown-jewel var' \"\$FAKE_DIR/forgejo.log\""
check "T1 ready-for-agent added" "grep -q 'POST .*/issues/203/labels\$' \"\$FAKE_DIR/calls.log\" && grep -q '\"labels\": *\\[36\\]' \"\$FAKE_DIR/forgejo.log\""
check "T1 ready-for-human removed" "grep -q 'DELETE .*/issues/203/labels/37' \"\$FAKE_DIR/calls.log\""
check "T1 thread confirmed" "grep -q white_check_mark \"\$FAKE_DIR/posts.log\" && grep -q '\"root_id\": *\"Q203\"' \"\$FAKE_DIR/posts.log\""
check "T1 confirmation is the LAST act" "tail -1 \"\$FAKE_DIR/calls.log\" | grep -q '/api/v4/posts\$'"
check "T1 comment lands before the re-arm" "grep -n 'issues/203' \"\$FAKE_DIR/calls.log\" | grep comments | cut -d: -f1 | head -1 | xargs -I{} test {} -lt \"\$(grep -n 'issues/203/labels\$' \"\$FAKE_DIR/calls.log\" | cut -d: -f1 | head -1)\""

# ---- T2: parked, ask open, but no human reply yet — sweep must not touch it
setup
jq -n --argjson i "$(mkissue 204)" '[$i]' >"$FAKE_DIR/issues.json"
jq -n --argjson q "$(mkpost Q204 "" BOTID "$(ask_msg 204)")" '{posts:{Q204:$q}}' >"$FAKE_DIR/channel.json"
jq -n --argjson q "$(mkpost Q204 "" BOTID "$(ask_msg 204)")" '{posts:{Q204:$q}}' >"$FAKE_DIR/thread-Q204.json"
bash "$script" >/dev/null 2>&1
rc=$?
check "T2 exit 0" "[ $rc -eq 0 ]"
check "T2 issue untouched" "! grep -q 'issues/204/comments\|issues/204/labels' \"\$FAKE_DIR/calls.log\""
check "T2 nothing posted to chat" "! grep -q white_check_mark \"\$FAKE_DIR/posts.log\" 2>/dev/null"

# ---- T3: round consumed (:white_check_mark:) — never re-consume; the
# backstop posts the NEXT round's question into the same (idle) thread
setup
mkissue_json 205
jq -n '[{body:"triage: which storage backend do you want?"}]' >"$FAKE_DIR/comments-205.json"
jq -n --argjson i "$(mkissue 205)" '[$i]' >"$FAKE_DIR/issues.json"
jq -n --argjson q "$(mkpost Q205 "" BOTID "$(ask_msg 205)")" '{posts:{Q205:$q}}' >"$FAKE_DIR/channel.json"
jq -n --argjson q "$(mkpost Q205 "" BOTID "$(ask_msg 205)")" \
  --argjson r "$(mkpost R1 Q205 HUMAN "B")" \
  --argjson c "$(mkpost C1 Q205 BOTID ":white_check_mark: Got it — proceeding with that answer.")" \
  '{posts:{Q205:$q, R1:$r, C1:$c}}' >"$FAKE_DIR/thread-Q205.json"
bash "$script" >/dev/null 2>&1
check "T3 consumed round not re-consumed" "! grep -q 'issues/205/labels' \"\$FAKE_DIR/calls.log\" && ! grep -q 'POST .*issues/205/comments' \"\$FAKE_DIR/calls.log\""
check "T3 follow-up ask posted in the idle thread" "jq -se '[.[] | select(.message | startswith(\":raising_hand:\"))] | length == 1 and all(.root_id == \"Q205\")' \"\$FAKE_DIR/posts.log\" >/dev/null"
check "T3 follow-up quotes newest comment" "grep -q 'which storage backend' \"\$FAKE_DIR/posts.log\""

# ---- T4: parked with NO ask thread at all (e.g. parked by triage) — the
# backstop posts the question thread, but never touches the issue itself
setup
mkissue_json 206
jq -n '[{body:"triage: is this in scope for v1?"}]' >"$FAKE_DIR/comments-206.json"
jq -n --argjson i "$(mkissue 206)" '[$i]' >"$FAKE_DIR/issues.json"
jq -n '{posts:{}}' >"$FAKE_DIR/channel.json"
bash "$script" >/dev/null 2>&1
rc=$?
check "T4 exit 0" "[ $rc -eq 0 ]"
check "T4 no issue writes" "! grep -q 'POST .*issues/206/comments' \"\$FAKE_DIR/calls.log\" && ! grep -q 'issues/206/labels' \"\$FAKE_DIR/calls.log\""
check "T4 root ask posted" "grep -q raising_hand \"\$FAKE_DIR/posts.log\" && ! grep -q root_id \"\$FAKE_DIR/posts.log\""
check "T4 ask quotes the triage comment" "grep -q 'in scope for v1' \"\$FAKE_DIR/posts.log\""

# ---- T5: ask older than the lookback window — its stale reply is never
# recorded; the backstop starts a FRESH thread
setup
mkissue_json 207
old_ms=$((now_ms - 200000 * 1000)) # > 48 h ago
jq -n --argjson i "$(mkissue 207)" '[$i]' >"$FAKE_DIR/issues.json"
jq -n --argjson q "$(mkpost Q207 "" BOTID "$(ask_msg 207)" "$old_ms")" '{posts:{Q207:$q}}' >"$FAKE_DIR/channel.json"
jq -n --argjson q "$(mkpost Q207 "" BOTID "$(ask_msg 207)" "$old_ms")" \
  --argjson r "$(mkpost R1 Q207 HUMAN "A")" \
  '{posts:{Q207:$q, R1:$r}}' >"$FAKE_DIR/thread-Q207.json"
bash "$script" >/dev/null 2>&1
check "T5 stale reply not recorded" "! grep -q 'POST .*issues/207/comments' \"\$FAKE_DIR/calls.log\" && ! grep -q 'issues/207/labels' \"\$FAKE_DIR/calls.log\""
check "T5 fresh root ask posted" "grep -q raising_hand \"\$FAKE_DIR/posts.log\" && ! grep -q root_id \"\$FAKE_DIR/posts.log\""

# ---- T6: two parked issues, only one answered — re-arm exactly that one
setup
jq -n --argjson a "$(mkissue 208)" --argjson b "$(mkissue 209)" '[$a,$b]' >"$FAKE_DIR/issues.json"
jq -n --argjson qa "$(mkpost Q208 "" BOTID "$(ask_msg 208)")" \
  --argjson qb "$(mkpost Q209 "" BOTID "$(ask_msg 209)")" \
  '{posts:{Q208:$qa, Q209:$qb}}' >"$FAKE_DIR/channel.json"
jq -n --argjson q "$(mkpost Q208 "" BOTID "$(ask_msg 208)")" '{posts:{Q208:$q}}' >"$FAKE_DIR/thread-Q208.json"
jq -n --argjson q "$(mkpost Q209 "" BOTID "$(ask_msg 209)")" \
  --argjson r "$(mkpost R1 Q209 HUMAN "C please")" \
  '{posts:{Q209:$q, R1:$r}}' >"$FAKE_DIR/thread-Q209.json"
bash "$script" >/dev/null 2>&1
check "T6 answered issue re-armed" "grep -q 'issues/209/labels\$' \"\$FAKE_DIR/calls.log\" && grep -q 'C please' \"\$FAKE_DIR/forgejo.log\""
check "T6 unanswered issue untouched" "! grep -q 'issues/208/comments\|issues/208/labels' \"\$FAKE_DIR/calls.log\""
check "T6 no extra ask posted" "! grep -q raising_hand \"\$FAKE_DIR/posts.log\""

# ---- T7: chat env unset — exit 2, tracker never touched. Scrub ALL three
# MATTERMOST_* vars, not just the token: resume-parked-asks.sh falls back to
# /run/secrets/mattermost_bot_token when MATTERMOST_BOT_TOKEN is unset, so a
# host carrying that secret (every real worker does) refills the token and the
# guard never fires. MATTERMOST_URL/MATTERMOST_CHANNEL_ID have no such fallback,
# so dropping them keeps this case hermetic to the ambient chat env (#587).
setup
jq -n --argjson i "$(mkissue 210)" '[$i]' >"$FAKE_DIR/issues.json"
env -u MATTERMOST_URL -u MATTERMOST_BOT_TOKEN -u MATTERMOST_CHANNEL_ID \
  bash "$script" >/dev/null 2>&1
rc=$?
check "T7 exit 2 without chat env" "[ $rc -eq 2 ]"
check "T7 no calls made" "[ ! -s \"\$FAKE_DIR/calls.log\" ]"

# ---- T8: nothing parked — clean no-op
setup
jq -n '[]' >"$FAKE_DIR/issues.json"
bash "$script" >/dev/null 2>&1
rc=$?
check "T8 exit 0 on empty frontier" "[ $rc -eq 0 ]"
check "T8 channel never fetched" "! grep -q '/api/v4/channels/' \"\$FAKE_DIR/calls.log\" 2>/dev/null"

# ---- T9: multi-round — round 1 consumed, round 2 (follow-up) answered:
# record ROUND 2's answer, never round 1's
setup
t0=$now_ms t1=$((now_ms + 1000)) t2=$((now_ms + 2000)) t3=$((now_ms + 3000)) t4=$((now_ms + 4000))
jq -n --argjson i "$(mkissue 211)" '[$i]' >"$FAKE_DIR/issues.json"
jq -n --argjson q "$(mkpost Q211 "" BOTID "$(ask_msg 211)" "$t0")" '{posts:{Q211:$q}}' >"$FAKE_DIR/channel.json"
jq -n --argjson q "$(mkpost Q211 "" BOTID "$(ask_msg 211)" "$t0")" \
  --argjson a1 "$(mkpost A1 Q211 HUMAN "round one: option A" "$t1")" \
  --argjson c1 "$(mkpost C1 Q211 BOTID ":white_check_mark: Got it — proceeding with that answer." "$t2")" \
  --argjson q2 "$(mkpost Q2 Q211 BOTID ":raising_hand: **Follow-up** — which auth model?" "$t3")" \
  --argjson a2 "$(mkpost A2 Q211 HUMAN "round two: token auth" "$t4")" \
  '{posts:{Q211:$q, A1:$a1, C1:$c1, Q2:$q2, A2:$a2}}' >"$FAKE_DIR/thread-Q211.json"
bash "$script" >/dev/null 2>&1
rc=$?
check "T9 exit 0" "[ $rc -eq 0 ]"
check "T9 round-2 answer recorded" "grep -q 'round two: token auth' \"\$FAKE_DIR/forgejo.log\""
check "T9 round-1 answer NOT re-recorded" "! grep -q 'round one: option A' \"\$FAKE_DIR/forgejo.log\""
check "T9 re-armed" "grep -q 'issues/211/labels\$' \"\$FAKE_DIR/calls.log\" && grep -q '\"labels\": *\\[36\\]' \"\$FAKE_DIR/forgejo.log\""
check "T9 confirmation last" "tail -1 \"\$FAKE_DIR/calls.log\" | grep -q '/api/v4/posts\$'"

echo "resume-parked-asks: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
