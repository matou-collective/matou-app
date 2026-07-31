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
export FORGEJO_API="http://fj.test/api/v1/repos/Matou/matou-app"

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

# ---- T3: ask already consumed (:white_check_mark:) — never re-consume
setup
jq -n --argjson i "$(mkissue 205)" '[$i]' >"$FAKE_DIR/issues.json"
jq -n --argjson q "$(mkpost Q205 "" BOTID "$(ask_msg 205)")" '{posts:{Q205:$q}}' >"$FAKE_DIR/channel.json"
jq -n --argjson q "$(mkpost Q205 "" BOTID "$(ask_msg 205)")" \
  --argjson r "$(mkpost R1 Q205 HUMAN "B")" \
  --argjson c "$(mkpost C1 Q205 BOTID ":white_check_mark: Got it — proceeding with that answer.")" \
  '{posts:{Q205:$q, R1:$r, C1:$c}}' >"$FAKE_DIR/thread-Q205.json"
bash "$script" >/dev/null 2>&1
check "T3 consumed thread skipped" "! grep -q 'issues/205' \"\$FAKE_DIR/calls.log\""

# ---- T4: parked with NO ask thread at all (e.g. parked by triage) — skip quietly
setup
jq -n --argjson i "$(mkissue 206)" '[$i]' >"$FAKE_DIR/issues.json"
jq -n '{posts:{}}' >"$FAKE_DIR/channel.json"
bash "$script" >/dev/null 2>&1
rc=$?
check "T4 exit 0" "[ $rc -eq 0 ]"
check "T4 issue untouched" "! grep -q 'issues/206/comments\|issues/206/labels' \"\$FAKE_DIR/calls.log\""

# ---- T5: ask older than the lookback window — out of scope, untouched
setup
old_ms=$((now_ms - 200000 * 1000)) # > 48 h ago
jq -n --argjson i "$(mkissue 207)" '[$i]' >"$FAKE_DIR/issues.json"
jq -n --argjson q "$(mkpost Q207 "" BOTID "$(ask_msg 207)" "$old_ms")" '{posts:{Q207:$q}}' >"$FAKE_DIR/channel.json"
jq -n --argjson q "$(mkpost Q207 "" BOTID "$(ask_msg 207)" "$old_ms")" \
  --argjson r "$(mkpost R1 Q207 HUMAN "A")" \
  '{posts:{Q207:$q, R1:$r}}' >"$FAKE_DIR/thread-Q207.json"
bash "$script" >/dev/null 2>&1
check "T5 stale ask ignored" "! grep -q 'issues/207' \"\$FAKE_DIR/calls.log\""

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

# ---- T7: chat env unset — exit 2, tracker never touched
setup
jq -n --argjson i "$(mkissue 210)" '[$i]' >"$FAKE_DIR/issues.json"
env -u MATTERMOST_BOT_TOKEN bash "$script" >/dev/null 2>&1
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

echo "resume-parked-asks: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
