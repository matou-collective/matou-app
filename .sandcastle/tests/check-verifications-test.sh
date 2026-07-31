#!/usr/bin/env bash
# Scenario tests for ../check-verifications.sh against the fake Mattermost +
# Forgejo API (fakebin/curl). No network.
#
# Usage: .sandcastle/tests/check-verifications-test.sh [path-to-script]
#
# For every open awaiting-verification issue, finds its ':mag: **Verify #N**'
# thread (posting a fresh one if missing) and walks unconsumed human replies
# oldest-first: approve → ready-for-agent, reject → wontfix+closed, anything
# else → copied to the issue as a comment. A reply is "consumed" once its post
# id is embedded (backtick-quoted) in a bot post in the thread — that's the
# whole idempotency contract, so a rerun over state reflecting a prior run's
# confirmations must be a no-op.
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="${1:-$here/../check-verifications.sh}"
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

mkissue() { # mkissue <number> <title> — an open awaiting-verification issue
  jq -n --argjson n "$1" --arg title "$2" \
    '{number:$n, title:$title, html_url:("http://x/" + ($n|tostring)), body:"issue body",
      labels:[{id:50,name:"awaiting-verification"}]}'
}

verify_msg() { # verify_msg <number> <title>
  printf ':mag: **Verify #%s** — %s\nhttp://x/%s\n\nissue body\n\nReply **approve** (optionally followed by guidance for the agent) or **reject** (optionally a reason) in this thread. Anything else is copied to the issue as a comment.' "$1" "$2" "$1"
}

setup() {
  FAKE_DIR="$(mktemp -d)"
  export FAKE_DIR
  jq -n '[{"id":50,"name":"awaiting-verification"},{"id":36,"name":"ready-for-agent"},{"id":44,"name":"wontfix"}]' \
    >"$FAKE_DIR/labels.json"
}

check() { # check <desc> <cond>
  if eval "$2"; then pass=$((pass + 1)); else
    fail=$((fail + 1))
    echo "FAIL: $1"
  fi
}

# ---- S1: approve-promotes — one awaiting issue #7, human reply "approve"
setup
jq -n --argjson i "$(mkissue 7 "Widget bug")" '[$i]' >"$FAKE_DIR/issues.json"
jq -n --argjson t "$(mkpost T7 "" BOTID "$(verify_msg 7 "Widget bug")")" '{posts:{T7:$t}}' >"$FAKE_DIR/channel.json"
jq -n --argjson t "$(mkpost T7 "" BOTID "$(verify_msg 7 "Widget bug")")" \
  --argjson r "$(mkpost R1 T7 HUMAN "approve")" \
  '{posts:{T7:$t, R1:$r}}' >"$FAKE_DIR/thread-T7.json"
bash "$script" >/dev/null 2>&1
rc=$?
check "S1 exit 0" "[ $rc -eq 0 ]"
check "S1 removes awaiting label" "grep -q 'DELETE .*/issues/7/labels/50' \"\$FAKE_DIR/calls.log\""
check "S1 adds ready-for-agent label" "grep -q 'POST .*/issues/7/labels\$' \"\$FAKE_DIR/calls.log\" && grep -q '\"labels\": *\\[36\\]' \"\$FAKE_DIR/forgejo.log\""
check "S1 no comment posted" "! grep -q 'issues/7/comments' \"\$FAKE_DIR/calls.log\""
check "S1 thread reply has checkmark and reply id" "grep -q white_check_mark \"\$FAKE_DIR/posts.log\" && grep -q '\`R1\`' \"\$FAKE_DIR/posts.log\""

# ---- S2: approve-with-guidance — reply carries extra text beyond the keyword
setup
jq -n --argjson i "$(mkissue 8 "Another bug")" '[$i]' >"$FAKE_DIR/issues.json"
jq -n --argjson t "$(mkpost T8 "" BOTID "$(verify_msg 8 "Another bug")")" '{posts:{T8:$t}}' >"$FAKE_DIR/channel.json"
jq -n --argjson t "$(mkpost T8 "" BOTID "$(verify_msg 8 "Another bug")")" \
  --argjson r "$(mkpost R1 T8 HUMAN "approve check the dark theme too")" \
  '{posts:{T8:$t, R1:$r}}' >"$FAKE_DIR/thread-T8.json"
bash "$script" >/dev/null 2>&1
check "S2 label swap" "grep -q 'DELETE .*/issues/8/labels/50' \"\$FAKE_DIR/calls.log\" && grep -q '\"labels\": *\\[36\\]' \"\$FAKE_DIR/forgejo.log\""
check "S2 guidance comment posted" "grep -q 'POST .*/issues/8/comments' \"\$FAKE_DIR/calls.log\" && grep -q '\\*\\*Verification guidance:\\*\\* check the dark theme too' \"\$FAKE_DIR/forgejo.log\""

# ---- S3: reject-closes — reply carries a reason
setup
jq -n --argjson i "$(mkissue 9 "Dup issue")" '[$i]' >"$FAKE_DIR/issues.json"
jq -n --argjson t "$(mkpost T9 "" BOTID "$(verify_msg 9 "Dup issue")")" '{posts:{T9:$t}}' >"$FAKE_DIR/channel.json"
jq -n --argjson t "$(mkpost T9 "" BOTID "$(verify_msg 9 "Dup issue")")" \
  --argjson r "$(mkpost R1 T9 HUMAN "reject duplicate of #3")" \
  '{posts:{T9:$t, R1:$r}}' >"$FAKE_DIR/thread-T9.json"
bash "$script" >/dev/null 2>&1
check "S3 removes awaiting label" "grep -q 'DELETE .*/issues/9/labels/50' \"\$FAKE_DIR/calls.log\""
check "S3 adds wontfix label" "grep -q 'POST .*/issues/9/labels\$' \"\$FAKE_DIR/calls.log\" && grep -q '\"labels\": *\\[44\\]' \"\$FAKE_DIR/forgejo.log\""
check "S3 closes the issue" "grep -q 'PATCH .*/issues/9\$' \"\$FAKE_DIR/calls.log\" && grep -q '\"state\": *\"closed\"' \"\$FAKE_DIR/forgejo.log\""
check "S3 rejected comment" "grep -q '\\*\\*Rejected:\\*\\* duplicate of #3' \"\$FAKE_DIR/forgejo.log\""

# ---- S4: chatter-copied-once — reply already has a bot confirmation in-thread
setup
jq -n --argjson i "$(mkissue 10 "Chatter issue")" '[$i]' >"$FAKE_DIR/issues.json"
jq -n --argjson t "$(mkpost T10 "" BOTID "$(verify_msg 10 "Chatter issue")")" '{posts:{T10:$t}}' >"$FAKE_DIR/channel.json"
jq -n --argjson t "$(mkpost T10 "" BOTID "$(verify_msg 10 "Chatter issue")")" \
  --argjson r "$(mkpost R1 T10 HUMAN "hmm can you add a screenshot?")" \
  --argjson c "$(mkpost C1 T10 BOTID ":speech_balloon: Copied to the issue. (\`R1\`)")" \
  '{posts:{T10:$t, R1:$r, C1:$c}}' >"$FAKE_DIR/thread-T10.json"
bash "$script" >/dev/null 2>&1
check "S4 no label ops" "! grep -q 'issues/10/labels' \"\$FAKE_DIR/calls.log\""
check "S4 no comment posted (already consumed)" "! grep -q 'issues/10/comments' \"\$FAKE_DIR/calls.log\""

# ---- S5: chatter-fresh — same reply, no bot confirmation yet
setup
jq -n --argjson i "$(mkissue 11 "Chatter issue 2")" '[$i]' >"$FAKE_DIR/issues.json"
jq -n --argjson t "$(mkpost T11 "" BOTID "$(verify_msg 11 "Chatter issue 2")")" '{posts:{T11:$t}}' >"$FAKE_DIR/channel.json"
jq -n --argjson t "$(mkpost T11 "" BOTID "$(verify_msg 11 "Chatter issue 2")")" \
  --argjson r "$(mkpost R1 T11 HUMAN "hmm can you add a screenshot?")" \
  '{posts:{T11:$t, R1:$r}}' >"$FAKE_DIR/thread-T11.json"
bash "$script" >/dev/null 2>&1
check "S5 comment posted" "grep -q 'POST .*/issues/11/comments' \"\$FAKE_DIR/calls.log\" && grep -q '\\*\\*From Mattermost:\\*\\*' \"\$FAKE_DIR/forgejo.log\""
check "S5 thread reply posted" "grep -q speech_balloon \"\$FAKE_DIR/posts.log\" && grep -q '\`R1\`' \"\$FAKE_DIR/posts.log\""
check "S5 no label ops" "! grep -q 'issues/11/labels' \"\$FAKE_DIR/calls.log\""

# ---- S6: no-thread-reposts — awaiting issue #9(different fixture), no ':mag:' post
setup
jq -n --argjson i "$(mkissue 9 "Fresh issue")" '[$i]' >"$FAKE_DIR/issues.json"
jq -n '{posts:{}}' >"$FAKE_DIR/channel.json"
bash "$script" >/dev/null 2>&1
check "S6 posts a fresh verify root" "grep -q ':mag: \\*\\*Verify #9\\*\\*' \"\$FAKE_DIR/posts.log\""
check "S6 no label ops" "! grep -q 'issues/9/labels' \"\$FAKE_DIR/calls.log\""

# ---- S7: idempotent-rerun — second poll after S1's confirmations: zero label ops
setup
jq -n --argjson i "$(mkissue 7 "Widget bug")" '[$i]' >"$FAKE_DIR/issues.json"
jq -n --argjson t "$(mkpost T7 "" BOTID "$(verify_msg 7 "Widget bug")")" '{posts:{T7:$t}}' >"$FAKE_DIR/channel.json"
jq -n --argjson t "$(mkpost T7 "" BOTID "$(verify_msg 7 "Widget bug")")" \
  --argjson r "$(mkpost R1 T7 HUMAN "approve")" \
  '{posts:{T7:$t, R1:$r}}' >"$FAKE_DIR/thread-T7.json"
bash "$script" >/dev/null 2>&1
first_calls="$(wc -l <"$FAKE_DIR/calls.log")"
# Reflect the first run's confirmation reply back into the thread, as a real
# Mattermost server would once the bot's POST lands. posts.log holds
# pretty-printed (multi-line) JSON objects back-to-back — jq -s parses the
# concatenated stream regardless.
confirm_msg="$(jq -s '.[-1].message' "$FAKE_DIR/posts.log" | jq -r .)"
confirm="$(mkpost CONF1 T7 BOTID "$confirm_msg")"
jq --argjson c "$confirm" '.posts.CONF1 = $c' "$FAKE_DIR/thread-T7.json" >"$FAKE_DIR/thread-T7.json.tmp"
mv "$FAKE_DIR/thread-T7.json.tmp" "$FAKE_DIR/thread-T7.json"
bash "$script" >/dev/null 2>&1
check "S7 second run performs zero new label ops" \
  "! tail -n +$((first_calls + 1)) \"\$FAKE_DIR/calls.log\" | grep -q 'issues/7/labels'"

echo "check-verifications: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
