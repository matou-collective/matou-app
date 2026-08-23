#!/usr/bin/env bash
# Offline tests for session-runner.sh — the workstation loop that drains the
# ready-for-session queue unattended (#538, ADR 0174). Fake curl serves
# fixture JSON and logs every API call; fake claude simulates the headless
# session. Run: bash .sandcastle/tests/session-runner-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail() { echo "FAIL: $1" >&2; exit 1; }

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/state" "$tmp/fixtures" "$tmp/checkout"
git init -q "$tmp/checkout"   # the runner only fetch/resets a REAL clone; stub git below

# ── fake curl: routes on the URL, logs every call ────────────────────────────
cat > "$tmp/bin/curl" <<'EOF'
#!/usr/bin/env bash
# Understand just enough: last arg is the URL; -X sets the method.
method=GET; url=""; reads_stdin=0
args=("$@")
for ((i=0; i<${#args[@]}; i++)); do
  case "${args[$i]}" in
    -X) method="${args[$((i+1))]}" ;;
    http*) url="${args[$i]}" ;;
    @-) reads_stdin=1 ;;
  esac
done
# Real curl DRAINS a `-d @-` body from stdin. The runner posts its claim/
# escalation bodies as `jq … | curl … -d @-` under `set -o pipefail`; if this
# fake exits without consuming that pipe, jq races to finish its write and
# often loses — SIGPIPE (141) reddens the pipeline and the runner reports
# "could not claim", non-deterministically (#586). Consume it, as real curl does.
[ "$reads_stdin" = 1 ] && cat >/dev/null
echo "$method $url" >> "${CURL_LOG:?}"
case "$method $url" in
  "GET "*"/labels?"*)            cat "${LABELS_FIXTURE:?}" ;;
  "GET "*"/issues?"*ready-for-session*) cat "${QUEUE_FIXTURE:?}" ;;
  "GET "*"/issues/"*"/dependencies"*)
      n="$(sed -E 's|.*/issues/([0-9]+)/dependencies.*|\1|' <<<"$url")"
      if [ -f "${FIXTURES_DIR:?}/deps-$n.json" ]; then cat "$FIXTURES_DIR/deps-$n.json"; else echo '[]'; fi ;;
  "GET "*"/issues/"*)
      n="$(sed -E 's|.*/issues/([0-9]+).*|\1|' <<<"$url")"
      cat "${FIXTURES_DIR:?}/issue-$n.json" ;;
  *) echo '{}' ;;
esac
exit 0
EOF
chmod +x "$tmp/bin/curl"

# ── fake claude: logs calls; CLAUDE_MODE drives the simulated session ────────
cat > "$tmp/bin/claude" <<'EOF'
#!/usr/bin/env bash
echo "call" >> "${CLAUDE_CALLS:?}"
# #19: the session's commits inherit whatever git identity the runner exports.
# Record it so the test can assert the factory identity reached the session,
# not the host user's ~/.gitconfig.
{ echo "GIT_AUTHOR_NAME=${GIT_AUTHOR_NAME:-}"
  echo "GIT_AUTHOR_EMAIL=${GIT_AUTHOR_EMAIL:-}"
  echo "GIT_COMMITTER_NAME=${GIT_COMMITTER_NAME:-}"
  echo "GIT_COMMITTER_EMAIL=${GIT_COMMITTER_EMAIL:-}"; } > "${CLAUDE_ENV:?}"
prompt="${*: -1}"
n="$(grep -oE 'Ticket #[0-9]+' <<<"$prompt" | head -1 | tr -dc 0-9)"
calls="$(wc -l < "$CLAUDE_CALLS")"
case "${CLAUDE_MODE:-advance}" in
  advance)   # the session does its job: the ticket leaves the session queue
    jq '.state = "closed"' "${FIXTURES_DIR:?}/issue-$n.json" > "$FIXTURES_DIR/issue-$n.json.new" \
      && mv "$FIXTURES_DIR/issue-$n.json.new" "$FIXTURES_DIR/issue-$n.json"
    echo "worked #$n" ;;
  noop)      # the session returns without advancing the ticket
    echo "did nothing" ;;
  limit)     # every call answers the weekly-limit refusal
    echo "You've hit your weekly limit · resets Aug 15, 8am (UTC)" ;;
  limit-then-advance)  # first call limited, second (post-failover) works
    if [ "$calls" = 1 ]; then
      echo "You've hit your weekly limit · resets Aug 15, 8am (UTC)"
    else
      jq '.state = "closed"' "${FIXTURES_DIR:?}/issue-$n.json" > "$FIXTURES_DIR/issue-$n.json.new" \
        && mv "$FIXTURES_DIR/issue-$n.json.new" "$FIXTURES_DIR/issue-$n.json"
      echo "worked #$n on the standby"
    fi ;;
esac
EOF
chmod +x "$tmp/bin/claude"

# git in the dedicated checkout: the runner fetch/resets a real remote we don't
# have — stub it to a quiet no-op so checkout prep never touches the network.
cat > "$tmp/bin/git" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$tmp/bin/git"

# ── fixtures ─────────────────────────────────────────────────────────────────
cat > "$tmp/fixtures/labels.json" <<'EOF'
[{"id":36,"name":"ready-for-agent"},{"id":37,"name":"ready-for-human"},
 {"id":48,"name":"agent-blocked"},{"id":99,"name":"priority"},
 {"id":103,"name":"agent-working"},{"id":106,"name":"ready-for-session"}]
EOF
mkissue() { # mkissue <n> <extra-labels-json-fragments…>
  local n="$1"; shift
  local extra=""; for l in "$@"; do extra=",$l$extra"; done
  cat > "$tmp/fixtures/issue-$n.json" <<EOF
{"number":$n,"state":"open","title":"ticket $n","body":"body of $n",
 "labels":[{"id":106,"name":"ready-for-session"}$extra]}
EOF
}
reset_queue() {
  mkissue 10 '{"id":103,"name":"agent-working"}'
  mkissue 12 '{"id":98,"name":"deferred"}'
  mkissue 20
  echo '[{"number":9,"state":"open","title":"blocker"}]' > "$tmp/fixtures/deps-20.json"
  mkissue 25 '{"id":99,"name":"priority"}'
  mkissue 30
  jq -s '.' "$tmp/fixtures/issue-10.json" "$tmp/fixtures/issue-12.json" \
    "$tmp/fixtures/issue-20.json" "$tmp/fixtures/issue-25.json" \
    "$tmp/fixtures/issue-30.json" > "$tmp/fixtures/queue.json"
}

run_runner() {
  env -u MATTERMOST_URL -u MATTERMOST_BOT_TOKEN -u MATTERMOST_CHANNEL_ID \
    PATH="$tmp/bin:$PATH" \
    FORGEJO_TOKEN=dummy FORGEJO_API=http://fake/api/v1/repos/x/y \
    CURL_LOG="$tmp/curl.log" CLAUDE_CALLS="$tmp/claude.calls" CLAUDE_ENV="$tmp/claude.env" \
    FIXTURES_DIR="$tmp/fixtures" \
    LABELS_FIXTURE="$tmp/fixtures/labels.json" QUEUE_FIXTURE="$tmp/fixtures/queue.json" \
    SESSION_RUNNER_STATE="$tmp/state" SESSION_RUNNER_CHECKOUT="$tmp/checkout" \
    SESSION_RUNNER_LOCK="$tmp/lock" SESSION_RUNNER_OFF_FILE="$tmp/off" \
    SESSION_RUNNER_COOLDOWN=0 SESSION_RUNNER_TIMEOUT=60 \
    CLAUDE_LIMIT_MARKER="$tmp/limit-marker" CLAUDE_ACTIVE_MARKER="$tmp/active-marker" \
    HOST_CAPACITY_SLOTS="$tmp/hc-slot1 $tmp/hc-slot2" \
    HOST_CAPACITY_DRIVE_WANTED="$tmp/hc-drive-wanted-absent-by-default" \
    SESSION_RUNNER_DRIVE_DEFER_COUNT="$tmp/hc-drive-defer-count" \
    "$@" bash "$here/../session-runner.sh" 2>&1
}
reset_case() { : > "$tmp/curl.log"; : > "$tmp/claude.calls"; rm -f "$tmp/claude.env" "$tmp/state"/* "$tmp/limit-marker" "$tmp/active-marker" "$tmp/off" "$tmp/hc-slot1" "$tmp/hc-slot2" "$tmp/drive-wanted" "$tmp/hc-drive-defer-count" 2>/dev/null || true; reset_queue; }

# 1: kill switch — env and file both stop pickup before any API call.
reset_case
out="$(run_runner SESSION_RUNNER=0)"
grep -qi "kill switch" <<<"$out" || fail "SESSION_RUNNER=0 must report the kill switch"
[ -s "$tmp/curl.log" ] && fail "kill switch (env) must stop before any API call"
touch "$tmp/off"
out="$(run_runner)"
grep -qi "kill switch" <<<"$out" || fail "the off-file must report the kill switch"
[ -s "$tmp/curl.log" ] && fail "kill switch (file) must stop before any API call"
echo "ok 1 kill switch"

# 2: pick order + filters — agent-working/deferred skipped, blocked skipped,
#    priority outranks lower numbers; the claim label lands before claude runs.
reset_case
out="$(run_runner)"
grep -q "Ticket #25" "$tmp/claude.calls" 2>/dev/null || true  # prompt not logged; assert via curl+output
grep -q "picked #25" <<<"$out" || fail "must pick the priority ticket #25 (got: $out)"
grep -q "POST http://fake/api/v1/repos/x/y/issues/25/labels" "$tmp/curl.log" \
  || fail "the agent-working claim must be POSTed before the session runs"
[ "$(wc -l < "$tmp/claude.calls")" = 1 ] || fail "exactly one claude session expected"
echo "ok 2 pick order + claim"

# 3: success — the session advanced the ticket; claim released, no fail counter.
grep -q "outcome: advanced" <<<"$out" || fail "an advanced ticket must report success (got: $out)"
grep -q "DELETE http://fake/api/v1/repos/x/y/issues/25/labels/103" "$tmp/curl.log" \
  || fail "the claim label must be released"
[ -f "$tmp/state/fail-25" ] && fail "a success must not leave a fail counter"
echo "ok 3 success path"

# 4: failure twice — second unadvanced run escalates: agent-blocked + comment.
reset_case
out="$(run_runner CLAUDE_MODE=noop)"
grep -q "outcome: not advanced" <<<"$out" || fail "a noop session must report not-advanced"
[ "$(cat "$tmp/state/fail-25")" = 1 ] || fail "first failure must count 1"
out="$(run_runner CLAUDE_MODE=noop)"
[ "$(cat "$tmp/state/fail-25")" = 2 ] || fail "second failure must count 2"
grep -qi "escalat" <<<"$out" || fail "the second failure must escalate"
grep -q "POST http://fake/api/v1/repos/x/y/issues/25/comments" "$tmp/curl.log" \
  || fail "the escalation must comment on the ticket"
echo "ok 4 fail-twice escalation"

# 5: limit without a standby — park the host, no fail counted, claim released.
reset_case
out="$(run_runner CLAUDE_MODE=limit)"
grep -qi "limit" <<<"$out" || fail "a limit refusal must be reported"
[ -f "$tmp/limit-marker" ] || fail "a limit with no standby must park the host"
[ -f "$tmp/state/fail-25" ] && fail "a limit refusal is not a ticket failure"
grep -q "DELETE http://fake/api/v1/repos/x/y/issues/25/labels/103" "$tmp/curl.log" \
  || fail "the claim must be released on a limit park"
echo "ok 5 limit park"

# 6: limit WITH a standby — failover, second call works, marker names B.
reset_case
out="$(run_runner CLAUDE_MODE=limit-then-advance \
  CLAUDE_CODE_OAUTH_TOKEN=tok-A CLAUDE_CODE_OAUTH_TOKEN_B=tok-B)"
[ "$(wc -l < "$tmp/claude.calls")" = 2 ] || fail "a failover must retry the session once"
grep -q "outcome: advanced" <<<"$out" || fail "the standby retry must complete the ticket"
[ "$(cat "$tmp/active-marker")" = "B" ] || fail "the active-account marker must name B"
[ -f "$tmp/limit-marker" ] && fail "a successful ride-over must not park the host"
echo "ok 6 limit failover"

# 7: parked host — a fresh limit marker stops pickup quietly.
reset_case
touch "$tmp/limit-marker"
out="$(run_runner)"
grep -qi "parked" <<<"$out" || fail "a parked host must be reported"
[ -s "$tmp/claude.calls" ] && fail "a parked host must not start a session"
echo "ok 7 parked host"

# 8: host capacity pool exhausted — both pooled slots already held by
#    someone else must absorb the tick before ANY API call, same shape as
#    the single-instance lock (own-lock test lives in
#    tests/host-capacity-lib-test.sh; this proves the WIRING).
reset_case
exec 7>"$tmp/hc-slot1"; flock -n 7 || fail "test setup: could not hold hc-slot1"
exec 6>"$tmp/hc-slot2"; flock -n 6 || fail "test setup: could not hold hc-slot2"
out="$(run_runner)"
exec 7>&-; exec 6>&-
grep -qi "host capacity pool exhausted" <<<"$out" || fail "an exhausted pool must be reported (got: $out)"
[ -s "$tmp/curl.log" ] && fail "pool exhaustion must stop before any API call"
echo "ok 8 host capacity pool exhausted"

# 9: drive reservation present — session-runner defers to a ready drive
#    BEFORE claiming any capacity (#663 producer / #664 consumer), and its
#    own consecutive-defer count climbs across repeated deferred ticks,
#    independent of the drive's own skip counter.
reset_case
drive_res="$tmp/drive-wanted"; defer_count="$tmp/hc-drive-defer-count"
: > "$drive_res"; rm -f "$defer_count"
out="$(run_runner HOST_CAPACITY_DRIVE_WANTED="$drive_res")"
grep -qi "deferring to a ready drive" <<<"$out" || fail "a standing reservation must be reported (got: $out)"
grep -q "skipped 1 consecutive tick(s)" <<<"$out" || fail "the first deferred tick must read skipped 1 (got: $out)"
[ -s "$tmp/curl.log" ] && fail "deferring to the drive must stop before any API call"
out2="$(run_runner HOST_CAPACITY_DRIVE_WANTED="$drive_res")"
grep -q "skipped 2 consecutive tick(s)" <<<"$out2" || fail "the count must climb on a second consecutive defer (got: $out2)"
rm -f "$drive_res"
out3="$(run_runner HOST_CAPACITY_DRIVE_WANTED="$drive_res")"
[ -f "$defer_count" ] && fail "a cleared reservation must reset the consecutive-defer counter"
grep -q "picked #25" <<<"$out3" || fail "a cleared reservation must let the tick proceed to claiming (got: $out3)"
rm -f "$defer_count"
echo "ok 9 drive reservation defers before claiming, count climbs, clears on release"

# 10: factory git identity (#19) — the session's commits must carry the
#     session-runner identity from swarm-identity.sh (naming the class + host),
#     never the host user's ~/.gitconfig. SWARM_HOST/REPO_SLUG pinned so the
#     assertion is host-independent.
reset_case
run_runner SWARM_HOST=box1 REPO_SLUG=Acme/widget >/dev/null 2>&1
[ -f "$tmp/claude.env" ] || fail "the session must run with a recorded git identity"
grep -q "^GIT_AUTHOR_NAME=Acme Swarm (session-runner@box1)$" "$tmp/claude.env" \
  || fail "the session's GIT_AUTHOR_NAME must name the session-runner class + host (got: $(cat "$tmp/claude.env"))"
grep -q "^GIT_COMMITTER_NAME=Acme Swarm (session-runner@box1)$" "$tmp/claude.env" \
  || fail "the committer identity must match the author"
grep -q "^GIT_AUTHOR_EMAIL=swarm@" "$tmp/claude.env" || fail "the session must carry a factory author email"
echo "ok 10 factory git identity reaches the session"

echo "session-runner: 10 groups passed"
