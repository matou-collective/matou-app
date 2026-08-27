#!/usr/bin/env bash
# Offline tests for session-runner.sh — the workstation loop that drains the
# ready-for-session queue unattended (#538, ADR 0174). Fake curl serves
# fixture JSON and logs every API call; fake claude simulates the headless
# session. Run: bash .sandcastle/tests/session-runner-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail() { echo "FAIL: $1" >&2; exit 1; }

# The rendered session-runner prompt lives at the harness root. Factory-side the
# suite runs from <factory>/tests and the rendered copy is the self-pin under
# .sandcastle/; consumer-side the suite is vendored into <repo>/.sandcastle/tests/
# and the rendered copy is its DIRECT parent (the harness dir already IS
# .sandcastle) — resolve whichever exists so the suite is green from either
# layout (#87), and fail LOUDLY (never a silent `cat` miss after group 1) if
# neither is present.
prompt_file="$here/../.sandcastle/session-runner-prompt.md"
[ -f "$prompt_file" ] || prompt_file="$here/../session-runner-prompt.md"
[ -f "$prompt_file" ] || fail "no rendered session-runner-prompt.md at $here/../.sandcastle/ or $here/../ — cannot run the suite"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/state" "$tmp/fixtures" "$tmp/checkout"
git init -q "$tmp/checkout"   # the runner only fetch/resets a REAL clone; stub git below
# Redirect host state off the live host (#58): most runs here pin every path
# explicitly, but test 13 leaves the /tmp derivations UNSET on purpose (to prove
# the repo-scoped default), so its lock + drive-defer files must derive under a
# test-owned prefix — SESSION_RUNNER_TMP — not real /tmp.
# shellcheck source=test-env.sh
. "$here/test-env.sh"; test_env_hermetic "$tmp"

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
body=""; [ "$reads_stdin" = 1 ] && body="$(cat)"
echo "$method $url" >> "${CURL_LOG:?}"
# Mattermost post (#27): record the JSON body so a test can assert the notice
# text posted verbatim; answer with a post id exactly as the real API does.
case "$url" in
  *"/api/v4/posts") printf '%s\n' "$body" >> "${MM_LOG:-/dev/null}"; echo '{"id":"post123"}'; exit 0 ;;
esac
case "$method $url" in
  "GET "*"/labels?"*)            cat "${LABELS_FIXTURE:?}" ;;
  "GET "*"/issues?"*ready-for-session*) cat "${QUEUE_FIXTURE:?}" ;;
  "GET "*"/issues/"*"/dependencies"*)
      n="$(sed -E 's|.*/issues/([0-9]+)/dependencies.*|\1|' <<<"$url")"
      if [ -f "${FIXTURES_DIR:?}/deps-$n.json" ]; then cat "$FIXTURES_DIR/deps-$n.json"; else echo '[]'; fi ;;
  "DELETE "*"/issues/"*"/labels/"*)
      # Mirror Forgejo: dropping a label id removes it from the issue AND the
      # queue fixture, so a GET later in the SAME tick sees the release — the
      # stale-claim sweep (#63) releases agent-working, then the pick re-reads
      # the queue and the freed ticket is now selectable.
      dn="$(sed -E 's|.*/issues/([0-9]+)/labels/[0-9]+.*|\1|' <<<"$url")"
      dl="$(sed -E 's|.*/issues/[0-9]+/labels/([0-9]+).*|\1|' <<<"$url")"
      for f in "${FIXTURES_DIR:?}/issue-$dn.json" "${QUEUE_FIXTURE:?}"; do
        [ -f "$f" ] || continue
        if jq --argjson l "$dl" \
             'if type=="array" then map(.labels |= map(select(.id != $l)))
              else .labels |= map(select(.id != $l)) end' "$f" > "$f.tmp" 2>/dev/null; then
          mv "$f.tmp" "$f"; else rm -f "$f.tmp"; fi
      done
      echo '{}' ;;
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
# --output-format json (#94): a completed call prints ONE result object whose
# usage block session-runner turns into a spend row. Fixed token counts so a test
# can assert them; a modelUsage key so the model passes through (#96 shape).
emit_result() { # <result-text>
  cat <<JSON
{"type":"result","subtype":"success","is_error":false,"result":"$1",
 "session_id":"sess-$n","total_cost_usd":0.01,"num_turns":3,
 "modelUsage":{"claude-opus-4-8":{"inputTokens":111}},
 "usage":{"input_tokens":111,"output_tokens":22,
          "cache_creation_input_tokens":33,"cache_read_input_tokens":44}}
JSON
}
case "${CLAUDE_MODE:-advance}" in
  advance)   # the session does its job: the ticket leaves the session queue
    jq '.state = "closed"' "${FIXTURES_DIR:?}/issue-$n.json" > "$FIXTURES_DIR/issue-$n.json.new" \
      && mv "$FIXTURES_DIR/issue-$n.json.new" "$FIXTURES_DIR/issue-$n.json"
    emit_result "worked #$n" ;;
  noop)      # the session returns without advancing the ticket
    emit_result "did nothing" ;;
  limit)     # every call answers the weekly-limit refusal
    echo "You've hit your weekly limit · resets Aug 15, 8am (UTC)" ;;
  limit-then-advance)  # first call limited, second (post-failover) works
    if [ "$calls" = 1 ]; then
      echo "You've hit your weekly limit · resets Aug 15, 8am (UTC)"
    else
      jq '.state = "closed"' "${FIXTURES_DIR:?}/issue-$n.json" > "$FIXTURES_DIR/issue-$n.json.new" \
        && mv "$FIXTURES_DIR/issue-$n.json.new" "$FIXTURES_DIR/issue-$n.json"
      emit_result "worked #$n on the standby"
    fi ;;
esac
EOF
chmod +x "$tmp/bin/claude"

# git in the dedicated checkout: the runner fetch/resets a real remote we don't
# have — stub it to a quiet no-op so checkout prep never touches the network.
# Log every invocation to GIT_LOG so a test can assert the checkout prep did (or,
# for the owned-checkout belt #78, did NOT) run fetch/reset/clean against the tree.
cat > "$tmp/bin/git" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${GIT_LOG:-/dev/null}"
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
mkissue_body() { # mkissue_body <n> <body> — same shape, a body the test chooses (#89 markers)
  local n="$1" b="$2"
  jq -n --argjson n "$n" --arg b "$b" \
    '{number:$n, state:"open", title:"ticket \($n)", body:$b,
      labels:[{id:106, name:"ready-for-session"}]}' > "$tmp/fixtures/issue-$n.json"
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
  # -u REPO_SLUG: every swarm worker runs with REPO_SLUG exported (run-swarm.sh
  # forwards it into each container; the three Forgejo workflows set it too), so
  # an inherited value would leak into the runner. Group 12's fixture identity
  # layer sets its slug with `: "${REPO_SLUG:=Acme/widget}"` — an ambient value
  # wins that `:=` and the seam then names the inherited slug, not the fixture's,
  # reddening group 12's hard-coded assertion (#50). Neutralise it here so the
  # fixture default applies; the two groups that need a specific slug (10, and
  # 12 itself via the fixture) get it after this `-u`, which env honours.
  env -u MATTERMOST_URL -u MATTERMOST_BOT_TOKEN -u MATTERMOST_CHANNEL_ID -u REPO_SLUG \
    PATH="$tmp/bin:$PATH" \
    FORGEJO_TOKEN=dummy FORGEJO_API=http://fake/api/v1/repos/x/y \
    CURL_LOG="$tmp/curl.log" CLAUDE_CALLS="$tmp/claude.calls" CLAUDE_ENV="$tmp/claude.env" \
    FIXTURES_DIR="$tmp/fixtures" \
    LABELS_FIXTURE="$tmp/fixtures/labels.json" QUEUE_FIXTURE="$tmp/fixtures/queue.json" \
    SESSION_RUNNER_STATE="$tmp/state" SESSION_RUNNER_CHECKOUT="$tmp/checkout" \
    SESSION_RUNNER_LOCK="$tmp/lock" SESSION_RUNNER_OWNER_LOCK="$tmp/owner-lock" \
    SESSION_RUNNER_OFF_FILE="$tmp/off" GIT_LOG="$tmp/git.log" \
    SESSION_RUNNER_PROMPT_FILE="$prompt_file" \
    SESSION_RUNNER_COOLDOWN=0 SESSION_RUNNER_TIMEOUT=60 \
    CLAUDE_LIMIT_MARKER="$tmp/limit-marker" CLAUDE_ACTIVE_MARKER="$tmp/active-marker" \
    HOST_CAPACITY_SLOTS="$tmp/hc-slot1 $tmp/hc-slot2" \
    HOST_CAPACITY_DRIVE_WANTED="$tmp/hc-drive-wanted-absent-by-default" \
    SESSION_RUNNER_DRIVE_DEFER_COUNT="$tmp/hc-drive-defer-count" \
    SWARM_DB="$tmp/swarm.db" \
    "$@" bash "$here/../session-runner.sh" 2>&1
}
# swarm.db assertions (#81): the mirror is a plain SQLite file — read it back
# directly with python3 (the same engine swarm-db.py uses; the sqlite3 CLI is
# not guaranteed). dbq <sql> prints tab-separated rows.
dbq() {
  python3 - "$tmp/swarm.db" "$1" <<'PY'
import sqlite3, sys
try:
    c = sqlite3.connect(sys.argv[1])
    for r in c.execute(sys.argv[2]):
        print("\t".join("" if x is None else str(x) for x in r))
except sqlite3.OperationalError:
    pass   # no db yet (an empty tick wrote nothing) — no rows
PY
}
reset_case() { : > "$tmp/curl.log"; : > "$tmp/claude.calls"; : > "$tmp/git.log"; rm -f "$tmp/claude.env" "$tmp/mm.log" "$tmp/state"/* "$tmp/limit-marker" "$tmp/active-marker" "$tmp/off" "$tmp/owner-lock" "$tmp/hc-slot1" "$tmp/hc-slot2" "$tmp/drive-wanted" "$tmp/hc-drive-defer-count" "$tmp/swarm.db" "$tmp/swarm.db-wal" "$tmp/swarm.db-shm" 2>/dev/null || true; reset_queue; }

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

# 11: limit-park notice posts verbatim (#27) — with chat WIRED (shimmed curl),
#     the parked message must POST byte-for-byte AND no fragment of the
#     ':hourglass_flowing_sand:' shortcode may reach the shell as a command.
#     Regression guard for the workstation log line
#     `session-runner.sh: line …: urglass_flowing_sand:: command not found`:
#     the notify path treats the message as data, never evaluates it. Runs with
#     MATTERMOST_* SET (the other cases run chat-unset), so the notify path
#     exercises the real jq|curl POST rather than the stderr-print short-circuit.
reset_case
: > "$tmp/mm.log"
out="$(env PATH="$tmp/bin:$PATH" \
  MATTERMOST_URL=http://chat MATTERMOST_BOT_TOKEN=tok MATTERMOST_CHANNEL_ID=cid \
  FORGEJO_TOKEN=dummy FORGEJO_API=http://fake/api/v1/repos/x/y \
  CURL_LOG="$tmp/curl.log" MM_LOG="$tmp/mm.log" \
  CLAUDE_CALLS="$tmp/claude.calls" CLAUDE_ENV="$tmp/claude.env" FIXTURES_DIR="$tmp/fixtures" \
  LABELS_FIXTURE="$tmp/fixtures/labels.json" QUEUE_FIXTURE="$tmp/fixtures/queue.json" \
  SESSION_RUNNER_STATE="$tmp/state" SESSION_RUNNER_CHECKOUT="$tmp/checkout" \
  SESSION_RUNNER_LOCK="$tmp/lock" SESSION_RUNNER_OWNER_LOCK="$tmp/owner-lock" \
  SESSION_RUNNER_OFF_FILE="$tmp/off" GIT_LOG="$tmp/git.log" \
  SESSION_RUNNER_PROMPT_FILE="$prompt_file" \
  SESSION_RUNNER_COOLDOWN=0 SESSION_RUNNER_TIMEOUT=60 \
  CLAUDE_LIMIT_MARKER="$tmp/limit-marker" CLAUDE_ACTIVE_MARKER="$tmp/active-marker" \
  HOST_CAPACITY_SLOTS="$tmp/hc-slot1 $tmp/hc-slot2" \
  HOST_CAPACITY_DRIVE_WANTED="$tmp/hc-drive-wanted-absent-by-default" \
  SESSION_RUNNER_DRIVE_DEFER_COUNT="$tmp/hc-drive-defer-count" \
  SWARM_DB="$tmp/swarm.db" \
  CLAUDE_MODE=limit \
  bash "$here/../session-runner.sh" 2>&1)"
grep -q "command not found" <<<"$out" \
  && fail "the limit-park notice must not evaluate any part of the message (got: $out)"
[ -s "$tmp/mm.log" ] || fail "the limit-park path must POST the parked notice"
posted="$(jq -r '.message' "$tmp/mm.log")"
[ "$posted" = ":hourglass_flowing_sand: **session-runner parked — Claude limit** while holding #25; claim released, the ticket re-queues after the window." ] \
  || fail "the parked notice must post the full message text verbatim (got: $posted)"
echo "ok 11 limit-park notice posts verbatim, evaluates nothing"

# 12: identity contract seam (#31) — a pin bump made the harness call
#     swarm_git_identity (defined in the consumer-owned swarm-identity.sh), but
#     an OLD identity file has neither the function nor the SWARM_IDENTITY_CONTRACT
#     stamp: every tick died mid-run on `command not found`, ~15 silent ticks, no
#     claim, no post. The seam must now exit 2 BEFORE any API call, name the
#     regenerate command, and post ONE rate-limited alarm (not once per tick).
reset_case
cat > "$tmp/old-identity.sh" <<'EOF'
#!/usr/bin/env bash
# a pre-#19 identity layer: FORGEJO_API/REPO_SLUG only — no SWARM_IDENTITY_CONTRACT,
# no swarm_git_identity.
: "${FORGEJO_API:=http://fake/api/v1/repos/x/y}"
: "${REPO_SLUG:=Acme/widget}"
EOF
set +e
out="$(run_runner SWARM_IDENTITY_FILE="$tmp/old-identity.sh")"; rc=$?
set -e
[ "$rc" = 2 ] || fail "an old identity layer must exit 2 (got rc=$rc: $out)"
grep -q "swarm-identity.sh is contract 0, this harness needs 1" <<<"$out" \
  || fail "the seam must name have=0/need=1 (got: $out)"
grep -q "re-run: onboard.sh identity Acme/widget .sandcastle/swarm-identity.sh" <<<"$out" \
  || fail "the seam must name the regenerate command (got: $out)"
[ -s "$tmp/curl.log" ] && fail "the identity seam must fail before any API call/claim"
[ -s "$tmp/claude.calls" ] && fail "the identity seam must fail before any claude session"
# the alarm stamped state on the first failing tick; a second identical tick
# within the cooldown must NOT re-post — rate-limited per signature.
out2="$(run_runner SWARM_IDENTITY_FILE="$tmp/old-identity.sh" 2>&1 || true)"
grep -q "within cooldown, not reposting" <<<"$out2" \
  || fail "the dead-tick alarm must rate-limit per signature (got: $out2)"
echo "ok 12 identity contract seam exits 2 before claiming, names the fix, rate-limits the alarm"

# 13: repo-scoped host state (#35) — two enrolled repos on one host must NOT
#     share a lock nor a state dir. Leave SESSION_RUNNER_LOCK/STATE UNSET so the
#     repo-scoped DEFAULTS apply; key REPO_SLUG to this test's pid so the /tmp
#     lock paths never collide with a parallel run, and HOME-scope the state dir.
#     Proof: while repo A's derived lock is held (a session in flight), repo A's
#     own tick is absorbed but repo B's tick sails past the lock — which can
#     only happen if the two default paths differ. The old host-global lock
#     absorbed B for a whole SESSION_RUNNER_TIMEOUT; this is that fix.
reset_case
sr_home="$tmp/home"; mkdir -p "$sr_home"
slug_a="Acme/widget-$$-a"; slug_b="Acme/widget-$$-b"
# The /tmp derivations resolve under SESSION_RUNNER_TMP (test_env_hermetic pointed
# it at a test-owned dir, #58) — so exercising the repo-scoped DEFAULT lock/
# drive-defer paths never touches the live host's real /tmp. The prefix is passed
# through below, but the derivation logic itself is session-runner.sh's own.
lock_a="$SESSION_RUNNER_TMP/matou-session-runner-Acme-widget-$$-a.lock"
lock_b="$SESSION_RUNNER_TMP/matou-session-runner-Acme-widget-$$-b.lock"
defer_b="$SESSION_RUNNER_TMP/matou-session-runner-Acme-widget-$$-b-drive-defer-count"
state_a="$sr_home/.local/state/matou-session-runner-Acme-widget-$$-a"
state_b="$sr_home/.local/state/matou-session-runner-Acme-widget-$$-b"
run_scoped() { # <slug> [extra env…] — repo-scoped DEFAULTS (no LOCK/STATE override)
  local slug="$1"; shift
  env -u MATTERMOST_URL -u MATTERMOST_BOT_TOKEN -u MATTERMOST_CHANNEL_ID \
    -u SESSION_RUNNER_LOCK -u SESSION_RUNNER_STATE -u SESSION_RUNNER_DRIVE_DEFER_COUNT \
    PATH="$tmp/bin:$PATH" HOME="$sr_home" REPO_SLUG="$slug" \
    FORGEJO_TOKEN=dummy FORGEJO_API=http://fake/api/v1/repos/x/y \
    CURL_LOG="$tmp/curl.log" CLAUDE_CALLS="$tmp/claude.calls" CLAUDE_ENV="$tmp/claude.env" \
    FIXTURES_DIR="$tmp/fixtures" \
    LABELS_FIXTURE="$tmp/fixtures/labels.json" QUEUE_FIXTURE="$tmp/fixtures/queue.json" \
    SESSION_RUNNER_CHECKOUT="$tmp/checkout" SESSION_RUNNER_OWNER_LOCK="$tmp/owner-lock" \
    SESSION_RUNNER_OFF_FILE="$tmp/off" GIT_LOG="$tmp/git.log" \
    SESSION_RUNNER_PROMPT_FILE="$prompt_file" \
    SESSION_RUNNER_COOLDOWN=0 SESSION_RUNNER_TIMEOUT=60 \
    CLAUDE_LIMIT_MARKER="$tmp/limit-marker" CLAUDE_ACTIVE_MARKER="$tmp/active-marker" \
    HOST_CAPACITY_SLOTS="$tmp/hc-slot1 $tmp/hc-slot2" \
    HOST_CAPACITY_DRIVE_WANTED="$tmp/hc-drive-wanted-absent-by-default" \
    SWARM_DB="$tmp/swarm.db" \
    "$@" bash "$here/../session-runner.sh" 2>&1
}
rm -f "$lock_a"
exec 8>"$lock_a"; flock -n 8 || fail "test setup: could not hold repo A's lock"
# repo A, same lock held → its OWN tick is absorbed (same-repo still serializes)
out="$(run_scoped "$slug_a")"
grep -qi "session in flight" <<<"$out" || fail "repo A's own second tick must be absorbed while its lock is held (got: $out)"
[ -s "$tmp/curl.log" ] && fail "an absorbed same-repo tick must stop before any API call"
# repo B, repo A's lock STILL held → repo B is NOT blocked (distinct lock path)
: > "$tmp/curl.log"; : > "$tmp/claude.calls"
out="$(run_scoped "$slug_b")"
exec 8>&-; rm -f "$lock_a"
grep -qi "session in flight" <<<"$out" && fail "repo B must NOT be absorbed by repo A's lock (host-global starvation regressed): $out"
grep -q "picked #25" <<<"$out" || fail "repo B's tick must sail past repo A's held lock and pick a ticket (got: $out)"
# repo B derived its OWN lock path (the file #58 used to leak into real /tmp),
# distinct from repo A's — the repo-scoped LOCK derivation, proven.
[ -e "$lock_b" ] || fail "repo B must derive its own repo-scoped lock, got none at $lock_b"
[ "$lock_a" != "$lock_b" ] || fail "two repos must not share a lock path"
# each repo's fail-$n/attempt-$n counters live under its OWN state dir
[ -d "$state_b" ] || fail "repo B must resolve a repo-scoped state dir of its own"
[ "$state_a" != "$state_b" ] || fail "two repos must not share a state dir"
# and the DRIVE-DEFER counter (#664) is repo-scoped too — a fresh drive
# reservation defers repo B's tick, bumping ITS derived counter under the prefix.
: > "$tmp/drive-now"
out="$(run_scoped "$slug_b" HOST_CAPACITY_DRIVE_WANTED="$tmp/drive-now")"
grep -q "deferring to a ready drive" <<<"$out" || fail "a fresh drive reservation must defer repo B's tick (got: $out)"
[ -e "$defer_b" ] || fail "repo B must derive its own drive-defer counter, got none at $defer_b"
# ALL three derivations resolved under the test prefix — nothing leaked into the
# live host's real /tmp (the #58 leak, closed by SESSION_RUNNER_TMP).
if ls /tmp/matou-session-runner-Acme-widget-$$-* >/dev/null 2>&1; then
  fail "test 13 must not leak repo-scoped files into real /tmp (#58)"
fi
echo "ok 13 repo-scoped lock + state + drive-defer: one repo's session cannot starve another, and nothing leaks to real /tmp"

# 14: REHEARSAL_DRIVE_ISSUE defaults EMPTY (#43) — a product's drive number must
#     NOT be baked in, or it silently filters that issue out of EVERY consumer's
#     queue. Build a queue whose only ready ticket carries the old default number
#     (492): with the var UNSET the tick MUST pick it; with the var SET to that
#     number the same tick must skip it (filtered as the standing drive).
reset_case
mkissue 492
jq -s '.' "$tmp/fixtures/issue-492.json" > "$tmp/fixtures/queue.json"
out="$(run_runner)"   # REHEARSAL_DRIVE_ISSUE is never exported: the empty default applies
grep -q "picked #492" <<<"$out" \
  || fail "with REHEARSAL_DRIVE_ISSUE unset, no issue may be filtered as a drive (got: $out)"
reset_case
mkissue 492
jq -s '.' "$tmp/fixtures/issue-492.json" > "$tmp/fixtures/queue.json"
out="$(run_runner REHEARSAL_DRIVE_ISSUE=492)"
grep -q "picked #492" <<<"$out" \
  && fail "a repo that DECLARES its drive number must have it filtered out of the session queue (got: $out)"
grep -qi "nothing workable" <<<"$out" \
  || fail "the declared drive being the only candidate must leave nothing workable (got: $out)"
echo "ok 14 REHEARSAL_DRIVE_ISSUE defaults empty; a declared number filters only that repo's drive"

# 15: release-path nudge (#45) — a COMPLETED session (slot freed) fires EXACTLY
#     ONE backstop nudge; a yielded (drive) / absorbed (pool) / limit-parked tick
#     fires NONE. The nudge command is host state (the empty default nudges
#     nothing), so drive it through a stub that appends one line per fire.
cat > "$tmp/nudge.sh" <<'EOF'
#!/usr/bin/env bash
echo nudged >> "$1"
EOF
chmod +x "$tmp/nudge.sh"
nudge_cmd="$tmp/nudge.sh $tmp/nudge.log"

# advanced session → exactly one nudge, and only AFTER the session ran.
reset_case; : > "$tmp/nudge.log"
run_runner SESSION_RUNNER_NUDGE="$nudge_cmd" >/dev/null
[ "$(wc -l < "$tmp/nudge.log")" = 1 ] || fail "an advanced session must nudge exactly once (got: $(wc -l < "$tmp/nudge.log"))"

# noop session (ran but did not advance) is still a session end → one nudge.
reset_case; : > "$tmp/nudge.log"
run_runner CLAUDE_MODE=noop SESSION_RUNNER_NUDGE="$nudge_cmd" >/dev/null
[ "$(wc -l < "$tmp/nudge.log")" = 1 ] || fail "a not-advanced session end must still nudge exactly once"

# absorbed tick (both pooled slots held) → the tick never runs a session → NO nudge.
reset_case; : > "$tmp/nudge.log"
exec 7>"$tmp/hc-slot1"; flock -n 7 || fail "test setup: could not hold hc-slot1"
exec 6>"$tmp/hc-slot2"; flock -n 6 || fail "test setup: could not hold hc-slot2"
run_runner SESSION_RUNNER_NUDGE="$nudge_cmd" >/dev/null
exec 7>&-; exec 6>&-
[ ! -s "$tmp/nudge.log" ] || fail "an absorbed (pool-exhausted) tick must NOT nudge"

# yielded tick (drive reservation) → deferred before claiming → NO nudge.
reset_case; : > "$tmp/nudge.log"
: > "$tmp/drive-wanted"
run_runner HOST_CAPACITY_DRIVE_WANTED="$tmp/drive-wanted" SESSION_RUNNER_NUDGE="$nudge_cmd" >/dev/null
rm -f "$tmp/drive-wanted"
[ ! -s "$tmp/nudge.log" ] || fail "a yielded (drive-reservation) tick must NOT nudge"

# limit-parked session → the host is parked, so the freed slot helps no one → NO nudge.
reset_case; : > "$tmp/nudge.log"
run_runner CLAUDE_MODE=limit SESSION_RUNNER_NUDGE="$nudge_cmd" >/dev/null
[ ! -s "$tmp/nudge.log" ] || fail "a limit-parked tick must NOT nudge (host is parked)"
echo "ok 15 release-path nudge fires once per session end, never on a yielded/absorbed/parked tick"

# 16: stale-claim sweep (#63) — a SIGKILLed/OOM/rebooted session leaves its
#     agent-working claim on the ticket with the EXIT trap never firing; the
#     picker excludes agent-working, so the ticket goes invisible to every
#     future tick, forever. The sweep, before the pick, reclaims a stale claim
#     THIS host owns (proven by a stale local attempt-$n marker), counts the
#     failed attempt, and never touches a peer/other-repo claim (no local
#     marker) nor a fresh one (a live session on a slow ticket).
old_ts="@$(( $(date +%s) - 100000 ))"   # far older than TIMEOUT(60)+slack(300)

# 16a: a stale claim (#40) is released + counted; a claim with NO local marker
#      (#10, a peer's/other repo's) and a FRESH claim (#41, a live slow session)
#      are BOTH left untouched; the tick still picks the priority ticket #25.
reset_case
mkissue 40 '{"id":103,"name":"agent-working"}'
mkissue 41 '{"id":103,"name":"agent-working"}'
jq -s '.' "$tmp/fixtures/issue-10.json" "$tmp/fixtures/issue-12.json" \
  "$tmp/fixtures/issue-20.json" "$tmp/fixtures/issue-25.json" \
  "$tmp/fixtures/issue-30.json" "$tmp/fixtures/issue-40.json" \
  "$tmp/fixtures/issue-41.json" > "$tmp/fixtures/queue.json"
touch -d "$old_ts" "$tmp/state/attempt-40"   # stale → THIS host's dead session
touch "$tmp/state/attempt-41"                 # fresh → a live slow session
# NOTE: #10 carries agent-working but gets NO attempt marker (a peer host's slot)
out="$(run_runner)"
grep -q "stale agent-working claim" <<<"$out" || fail "16a: the sweep must report the stale claim (got: $out)"
grep -q "DELETE http://fake/api/v1/repos/x/y/issues/40/labels/103" "$tmp/curl.log" \
  || fail "16a: the stale claim on #40 must be released"
[ "$(cat "$tmp/state/fail-40")" = 1 ] || fail "16a: the reclaimed attempt on #40 must count as a failure"
grep -q "DELETE http://fake/api/v1/repos/x/y/issues/10/labels" "$tmp/curl.log" \
  && fail "16a: a claim with NO local marker (#10) must be left untouched"
[ -f "$tmp/state/fail-10" ] && fail "16a: a foreign claim must not be counted a failure"
grep -q "DELETE http://fake/api/v1/repos/x/y/issues/41/labels" "$tmp/curl.log" \
  && fail "16a: a FRESH claim (#41, a live slow session) must be left untouched"
[ -f "$tmp/state/fail-41" ] && fail "16a: a fresh claim must not be counted a failure"
grep -q "picked #25" <<<"$out" || fail "16a: the tick must still pick the priority ticket (got: $out)"
echo "ok 16a stale claim released+counted; foreign + fresh claims untouched; tick still picks"

# 16b: the ONLY ticket carries a stale claim — one tick releases it and then
#      picks the same freed ticket (the sweep runs before the pick, the pick
#      re-reads the queue).
reset_case
mkissue 40 '{"id":103,"name":"agent-working"}'
jq -s '.' "$tmp/fixtures/issue-40.json" > "$tmp/fixtures/queue.json"
touch -d "$old_ts" "$tmp/state/attempt-40"
out="$(run_runner)"
grep -q "DELETE http://fake/api/v1/repos/x/y/issues/40/labels/103" "$tmp/curl.log" \
  || fail "16b: the stale claim must be released"
grep -q "picked #40" <<<"$out" || fail "16b: the freed ticket must be picked in the same tick (got: $out)"
grep -q "outcome: advanced" <<<"$out" || fail "16b: the freed ticket must be worked to completion (got: $out)"
echo "ok 16b a lone stale ticket is released then picked in one tick"

# 16c: the SECOND death (a pre-existing fail counter of 1) — the sweep bumps to
#      2 and escalates exactly like the outcome path: agent-blocked + comment;
#      the fail-cap then keeps the ticket out of the pick.
reset_case
mkissue 40 '{"id":103,"name":"agent-working"}'
jq -s '.' "$tmp/fixtures/issue-40.json" > "$tmp/fixtures/queue.json"
touch -d "$old_ts" "$tmp/state/attempt-40"
echo 1 > "$tmp/state/fail-40"
out="$(run_runner)"
[ "$(cat "$tmp/state/fail-40")" = 2 ] || fail "16c: the second death must count 2"
grep -q "escalating #40" <<<"$out" || fail "16c: the second death must escalate (got: $out)"
grep -q "POST http://fake/api/v1/repos/x/y/issues/40/labels" "$tmp/curl.log" \
  || fail "16c: the escalation must add agent-blocked"
grep -q "POST http://fake/api/v1/repos/x/y/issues/40/comments" "$tmp/curl.log" \
  || fail "16c: the escalation must comment on the ticket"
grep -qi "nothing workable" <<<"$out" || fail "16c: an escalated ticket must fall out of the pick (got: $out)"
[ -s "$tmp/claude.calls" ] && fail "16c: an escalated-on-sweep ticket must not start a session"
echo "ok 16c a second death escalates on the sweep and drops out of the pick"

# 17: swarm.db trace (#81) — a session it ACTUALLY starts records a run row
#     (trigger `session`, verdict on exit), a live-session process row (kind
#     `session`, closed by the EXIT trap), and an attempt row (issue known at
#     claim; success EARNED only on the advanced outcome). An empty tick that
#     starts NO session records NOTHING — no per-cron-tick noise.

# 17a: an advanced session — run verdict `advanced`, process row closed,
#      attempt issue=25 status `success`.
reset_case
run_runner >/dev/null
[ "$(dbq "SELECT trigger FROM runs")" = session ] \
  || fail "17a: the run row must carry trigger 'session' (got: $(dbq "SELECT trigger FROM runs"))"
[ "$(dbq "SELECT verdict FROM runs")" = advanced ] \
  || fail "17a: an advanced session must record verdict 'advanced' (got: $(dbq "SELECT verdict FROM runs"))"
[ "$(dbq "SELECT ended_at IS NOT NULL FROM runs")" = 1 ] \
  || fail "17a: the run row must be finalised on exit (ended_at set)"
[ -n "$(dbq "SELECT repo FROM runs WHERE repo IS NOT NULL")" ] \
  || fail "17a: the run row must be repo-scoped (the fleet monitor filters by runs.repo)"
[ "$(dbq "SELECT kind FROM processes")" = session ] \
  || fail "17a: the live-session process row must be kind 'session' (got: $(dbq "SELECT kind FROM processes"))"
[ "$(dbq "SELECT ended_at IS NOT NULL FROM processes")" = 1 ] \
  || fail "17a: a graceful exit must CLOSE the process row (else a false wedge)"
[ "$(dbq "SELECT issue||':'||status FROM attempts")" = "25:success" ] \
  || fail "17a: the attempt must record issue 25 status success (got: $(dbq "SELECT issue||':'||status FROM attempts"))"
echo "ok 17a advanced session records run/process/attempt; success earned, process closed"

# 17b: a not-advanced (noop) session — verdict `not-advanced`, attempt keeps the
#      DB DEFAULT 'fail' (invariant 1: a session that did nothing never reads green).
reset_case
run_runner CLAUDE_MODE=noop >/dev/null
[ "$(dbq "SELECT verdict FROM runs")" = not-advanced ] \
  || fail "17b: a noop session must record verdict 'not-advanced' (got: $(dbq "SELECT verdict FROM runs"))"
[ "$(dbq "SELECT status FROM attempts")" = fail ] \
  || fail "17b: a not-advanced session's attempt must stay 'fail' (got: $(dbq "SELECT status FROM attempts"))"
[ "$(dbq "SELECT ended_at IS NOT NULL FROM processes")" = 1 ] \
  || fail "17b: the process row must close on exit"
echo "ok 17b not-advanced session records verdict + fail attempt, closes its process row"

# 17c: a limit-parked session — the session STARTED (claude ran, got refused), so
#      it IS recorded; verdict `limit-parked` (not counted a ticket failure).
reset_case
run_runner CLAUDE_MODE=limit >/dev/null
[ "$(dbq "SELECT verdict FROM runs")" = limit-parked ] \
  || fail "17c: a limit-parked session must record verdict 'limit-parked' (got: $(dbq "SELECT verdict FROM runs"))"
[ "$(dbq "SELECT ended_at IS NOT NULL FROM processes")" = 1 ] \
  || fail "17c: the process row must close even on a limit park"
echo "ok 17c limit-parked session records verdict, closes its process row"

# 17d: an EMPTY tick that starts NO session writes NOTHING (both pooled slots
#      held → absorbed before any session begins). Zero run rows.
reset_case
exec 7>"$tmp/hc-slot1"; flock -n 7 || fail "17d setup: could not hold hc-slot1"
exec 6>"$tmp/hc-slot2"; flock -n 6 || fail "17d setup: could not hold hc-slot2"
run_runner >/dev/null
exec 7>&-; exec 6>&-
[ -z "$(dbq "SELECT run_id FROM runs")" ] \
  || fail "17d: an absorbed (no-session) tick must record NO run row (got: $(dbq "SELECT run_id FROM runs"))"
echo "ok 17d an absorbed tick records nothing (no per-cron-tick noise)"

# 17e: a nothing-workable tick (queue is only a deferred + a dep-blocked ticket)
#      records nothing too — proving the gate is 'a session started', not 'a tick ran'.
reset_case
mkissue 12 '{"id":98,"name":"deferred"}'
mkissue 20
echo '[{"number":9,"state":"open","title":"blocker"}]' > "$tmp/fixtures/deps-20.json"
jq -s '.' "$tmp/fixtures/issue-12.json" "$tmp/fixtures/issue-20.json" > "$tmp/fixtures/queue.json"
out="$(run_runner)"
grep -qi "nothing workable" <<<"$out" || fail "17e setup: the queue must leave nothing workable (got: $out)"
[ -z "$(dbq "SELECT run_id FROM runs")" ] \
  || fail "17e: a nothing-workable tick must record NO run row (got: $(dbq "SELECT run_id FROM runs"))"
echo "ok 17e a nothing-workable tick records nothing"

# 18: the checkout-owner belt (#78) — a second tick must NEVER reset/clean a tree
#     a live session owns. The outer lock (SESSION_RUNNER_LOCK) is keyed by slug;
#     this belt is keyed by the CHECKOUT, so a tick that slipped past a
#     differently-keyed outer lock (a divergent slug spelling, or one caller with
#     SESSION_RUNNER_LOCK pinned and one on the default) still stands down before
#     touching the tree. flock releases on the owner's death, so a crashed session
#     never wedges a later tick.

# 18a: a LIVE owner (this shell holds the owner lock, standing in for an in-flight
#      session) → the tick absorbs with NO git fetch/reset/clean and NO API call,
#      exit 0. The ownership check runs BEFORE the reset: on a build that reset
#      first and detected the conflict after, the git log would carry a reset/
#      clean here and this assertion would fail — which is exactly the belt's
#      acceptance ("the tree is unchanged" must fail if the reset runs first).
reset_case
exec 5>"$tmp/owner-lock"; flock -n 5 || fail "18a setup: could not hold the owner lock"
set +e
out="$(run_runner)"; rc=$?
set -e
exec 5>&-
[ "$rc" = 0 ] || fail "18a: an owned-checkout tick must exit 0 quietly (got rc=$rc: $out)"
grep -qi "owns the checkout" <<<"$out" || fail "18a: the belt must report the owned checkout (got: $out)"
[ -s "$tmp/curl.log" ] && fail "18a: an owned-checkout tick must stop before any API call"
[ -s "$tmp/git.log" ] && fail "18a: an owned-checkout tick must run NO git against the tree — no reset ran (got: $(cat "$tmp/git.log"))"
[ -s "$tmp/claude.calls" ] && fail "18a: an owned-checkout tick must not start a session"
echo "ok 18a a live owner absorbs the tick before any fetch/reset/clean or API call"

# 18b: the belt is keyed off the CHECKOUT, not the slug — two invocations that
#      resolve the SAME SESSION_RUNNER_CHECKOUT contend on the same owner lock
#      even when their REPO_SLUG spelling differs AND their (slug-keyed) outer
#      SESSION_RUNNER_LOCK paths differ. Let the owner-lock DEFAULT apply
#      (SESSION_RUNNER_OWNER_LOCK= forces the ${:=} derivation) and hold it at the
#      path the checkout derives; both differing slugs must absorb. The derived
#      path rides the SESSION_RUNNER_TMP prefix (test_env_hermetic, #58), so this
#      probe exercises the real ${:=} derivation inside the test's own dir rather
#      than holding — and leaking — a lock in the live host's real /tmp.
reset_case
chk="$tmp/checkout"; owner_default="$SESSION_RUNNER_TMP/matou-session-runner-owner${chk//\//-}.lock"
rm -f "$owner_default"
exec 5>"$owner_default"; flock -n 5 || fail "18b setup: could not hold the derived owner lock"
out="$(run_runner REPO_SLUG=Owner/spelling-one SESSION_RUNNER_LOCK="$tmp/lock-one" SESSION_RUNNER_OWNER_LOCK=)"
grep -qi "owns the checkout" <<<"$out" \
  || fail "18b: a differing slug + its own outer lock must still contend on the checkout-keyed owner lock (got: $out)"
out="$(run_runner REPO_SLUG=Other/spelling-two SESSION_RUNNER_LOCK="$tmp/lock-two" SESSION_RUNNER_OWNER_LOCK=)"
grep -qi "owns the checkout" <<<"$out" \
  || fail "18b: a second differing slug + a distinct outer lock must still contend (got: $out)"
exec 5>&-; rm -f "$owner_default" "$tmp/lock-one" "$tmp/lock-two"
echo "ok 18b the belt keys off the checkout — differing slug/outer-lock spellings still contend"

# 18c: a STALE owner (the file exists but NO live process holds the flock — a
#      crashed session) must NOT block a later tick: flock takes an unheld file
#      and the tick proceeds to pick. This is the stale-owner recovery — no human
#      needed, no wedge.
reset_case
: > "$tmp/owner-lock"   # a leftover owner-lock FILE, unlocked (the holder is gone)
out="$(run_runner)"
grep -qi "owns the checkout" <<<"$out" && fail "18c: a stale (unheld) owner lock must not read as owned (got: $out)"
grep -q "picked #25" <<<"$out" || fail "18c: a stale (unheld) owner lock must not wedge the tick (got: $out)"
echo "ok 18c a stale (unheld) owner lock does not wedge a later tick"

# 19: host affinity (#89) — `ready-for-session` says a host's standing is needed
#     but not WHICH host, so whichever host ticks first claims work it cannot do.
#     The reported case (Matou/idss#743): a ticket whose evidence lived on a host
#     that runs no session-runner at all was unclaimable by the only host that
#     could do it and claimable by the two that could not — two attempts burned,
#     escalated to a human who was never the blocker. An OPT-IN
#     `<!-- session-host: … -->` body marker pins a ticket; no marker means any
#     host, so every pre-#89 ticket is unaffected. Pure-core cases live in
#     tests/session-host-lib-test.sh; these assert the WIRING.

# 19a: the wrong host skips a pinned ticket — and the skip must NOT burn an
#      attempt (the runner's fail counter cannot tell "this host can't do it"
#      from "this work is hard", so a wrong-host skip must never reach it).
reset_case
mkissue_body 55 $'needs the laptop\'s own evidence dir\n<!-- session-host: box1 -->'
jq -s '.' "$tmp/fixtures/issue-55.json" > "$tmp/fixtures/queue.json"
out="$(run_runner SESSION_RUNNER_HOST=box2)"
grep -q "picked #55" <<<"$out" && fail "19a: a host the ticket does not name must NOT pick it (got: $out)"
grep -qi "declared for host" <<<"$out" || fail "19a: the skip must say why (got: $out)"
grep -qi "nothing workable" <<<"$out" || fail "19a: a queue of only foreign tickets leaves nothing workable (got: $out)"
grep -q "POST http://fake/api/v1/repos/x/y/issues/55/labels" "$tmp/curl.log" \
  && fail "19a: a wrong-host skip must never claim the ticket"
[ -s "$tmp/claude.calls" ] && fail "19a: a wrong-host skip must not start a session"
[ -f "$tmp/state/attempt-55" ] && fail "19a: a wrong-host skip must not stamp an attempt marker"
[ -f "$tmp/state/fail-55" ] && fail "19a: a wrong-host skip must NOT burn an attempt (#89)"
[ -z "$(dbq "SELECT run_id FROM runs")" ] || fail "19a: a wrong-host skip starts no session, so records no run row"
echo "ok 19a a pinned ticket is skipped by every host it does not name, burning no attempt"

# 19b: the host the ticket NAMES picks it and works it to completion.
reset_case
mkissue_body 55 $'needs the laptop\'s own evidence dir\n<!-- session-host: box1 -->'
jq -s '.' "$tmp/fixtures/issue-55.json" > "$tmp/fixtures/queue.json"
out="$(run_runner SESSION_RUNNER_HOST=box1)"
grep -q "picked #55" <<<"$out" || fail "19b: the named host must pick its own ticket (got: $out)"
grep -q "outcome: advanced" <<<"$out" || fail "19b: the named host must work it (got: $out)"
echo "ok 19b the named host picks and works the pinned ticket"

# 19c: opt-in — an UNMARKED ticket is claimable by any host, so a foreign pinned
#      ticket is stepped over rather than blocking the queue behind it.
reset_case
mkissue_body 15 $'<!-- session-host: box1 -->\nfor the laptop only'
mkissue 30
jq -s '.' "$tmp/fixtures/issue-15.json" "$tmp/fixtures/issue-30.json" > "$tmp/fixtures/queue.json"
out="$(run_runner SESSION_RUNNER_HOST=box2)"
grep -q "picked #30" <<<"$out" \
  || fail "19c: an unmarked ticket must still be picked past a foreign pinned one (got: $out)"
[ -f "$tmp/state/fail-15" ] && fail "19c: stepping over a foreign ticket must not count against it"
echo "ok 19c an unmarked ticket is unaffected; a foreign pinned one is stepped over, not blocking"

# 19d: a marker naming SEVERAL hosts matches any of them — and the rule holds on
#      the SESSION_RUNNER_PICK rollout path too, where the queue read is skipped
#      entirely and the body must come from the issue itself.
reset_case
mkissue_body 55 '<!-- session-host: box1, box2 -->'
jq -s '.' "$tmp/fixtures/issue-55.json" > "$tmp/fixtures/queue.json"
out="$(run_runner SESSION_RUNNER_HOST=box2)"
grep -q "picked #55" <<<"$out" || fail "19d: a listed host must match (got: $out)"
reset_case
mkissue_body 55 '<!-- session-host: box1 -->'
jq -s '.' "$tmp/fixtures/issue-55.json" > "$tmp/fixtures/queue.json"
out="$(run_runner SESSION_RUNNER_PICK=55 SESSION_RUNNER_HOST=box3)"
grep -q "picked #55" <<<"$out" && fail "19d: a pinned PICK on the wrong host must still be skipped (got: $out)"
grep -qi "declared for host" <<<"$out" || fail "19d: the PICK path must name the mismatch (got: $out)"
out="$(run_runner SESSION_RUNNER_PICK=55 SESSION_RUNNER_HOST=box1)"
grep -q "picked #55" <<<"$out" || fail "19d: SESSION_RUNNER_HOST is the operator's escape hatch (got: $out)"
echo "ok 19d a host list matches any member; the rule holds on the PICK path, overridable by host"

# 20: spend recorded (#94) — #81 gave the session run/process/attempt rows but no
#     spend, so a session's real account budget was invisible to the Usage tab.
#     A completed session's `--output-format json` usage block must now become ONE
#     aggregate spend row: fresh input/output + cache classes split (#96 columns),
#     attributed to the active account, and joined to the same run row.

# 20a: an advanced session writes a spend row with the real token counts + account.
reset_case
out="$(run_runner)"
grep -q "recorded the session's token spend" <<<"$out" || fail "20a: a completed session must report it recorded spend (got: $out)"
[ "$(dbq "SELECT count(*) FROM spend")" = 1 ] \
  || fail "20a: a completed session must write exactly one spend row (got: $(dbq "SELECT count(*) FROM spend"))"
[ "$(dbq "SELECT input_tokens||'/'||output_tokens||'/'||cache_creation_tokens||'/'||cache_read_tokens FROM spend")" = "111/22/33/44" ] \
  || fail "20a: the spend row must carry the real input/output/cache token counts (got: $(dbq "SELECT input_tokens||'/'||output_tokens||'/'||cache_creation_tokens||'/'||cache_read_tokens FROM spend"))"
[ "$(dbq "SELECT account FROM spend")" = A ] \
  || fail "20a: the spend row must be attributed to the active account (got: $(dbq "SELECT account FROM spend"))"
[ "$(dbq "SELECT model FROM spend")" = "claude-opus-4-8" ] \
  || fail "20a: the spend row must pass through the model when the result exposes one (got: $(dbq "SELECT model FROM spend"))"
[ "$(dbq "SELECT s.run_id = r.run_id FROM spend s JOIN runs r")" = 1 ] \
  || fail "20a: the spend row must join the session's own run row"
echo "ok 20a an advanced session records one account-attributed spend row with real token counts"

# 20b: a not-advanced (noop) session still consumed budget — it too records spend
#      (the token cost is real whether or not the ticket moved).
reset_case
run_runner CLAUDE_MODE=noop >/dev/null
[ "$(dbq "SELECT count(*) FROM spend")" = 1 ] \
  || fail "20b: a not-advanced session still burned tokens and must record spend (got: $(dbq "SELECT count(*) FROM spend"))"
echo "ok 20b a not-advanced session still records its spend"

# 20c: a limit-parked session never completed a call — the usage-less refusal
#      writes NO spend row (best-effort: nothing to attribute).
reset_case
run_runner CLAUDE_MODE=limit >/dev/null
[ "$(dbq "SELECT count(*) FROM spend")" = 0 ] \
  || fail "20c: a limit-parked (no completed call) session must record no spend (got: $(dbq "SELECT count(*) FROM spend"))"
echo "ok 20c a limit-parked session records no spend"

echo "session-runner: 20 groups passed"
