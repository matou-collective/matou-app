#!/usr/bin/env bash
# Offline test for the rehearsal reporter: signature dedup (append, not
# re-file), the 2-new-issues cap, and label/marker hygiene. Drives the REAL
# script with shimmed curl/claude. Run: bash .sandcastle/tests/rehearsal-report-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/run/artifacts" "$tmp/run/logs"
export PATH="$tmp/bin:$PATH" FORGEJO_TOKEN=t REHEARSAL_STATE="$tmp/state"
# Hermetic claude-limit marker: never touch the host-global one (limit-lib).
export CLAUDE_LIMIT_MARKER="$tmp/claude-limit"
# The healer skips cleanly when it cannot clone its dedicated checkout — these
# legacy cases pin the CLASSIC reporter behaviour, so point the clone source
# at a local path that does not exist (healer inert, no network, no hang).
export REHEARSAL_CHECKOUT="$tmp/nonexistent"
export REHEARSAL_HEAL_REPO="$tmp/no-such-origin.git"

# curl shim: records every call; answers the issue-list query from a fixture
# file; answers POSTs with a minted number. The dependency POST is answered as
# `-w '%{http_code}'` would (a status code), and its IssueMeta body is asserted
# to name owner+repo — the live-Forgejo shape a bare {"index": n} 404s (#381).
# DEP_CODE overrides the code so a test can force a wiring failure/409.
cat > "$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
echo "$@" >> "${CURL_LOG:?}"
want_code=false; is_dep=false; is_lab=false; is_comment_asset=false; is_issue_asset=false; is_comment=false; prev=""; body=""
for a in "$@"; do
  [ "$prev" = "-d" ] && body="$a"
  case "$a" in
    -w) want_code=true;;
    */dependencies) is_dep=true;;
    */issues/*/labels) is_lab=true;;
    */dispatches) is_disp=true;;
    # #596 asset-attach routes — the more specific comment-asset pattern MUST
    # be checked before the generic issue-asset one (both match a comment
    # asset URL; case takes the first hit).
    */issues/comments/*/assets) is_comment_asset=true;;
    */issues/*/assets) is_issue_asset=true;;
    */issues/*/comments) is_comment=true;;
  esac
  prev="$a"
done
if ${is_disp:-false}; then $want_code && echo "${DISPATCH_CODE:-204}"; exit 0; fi
if $is_dep; then
  case "$body" in
    *'"owner"'*'"repo"'*|*'"repo"'*'"owner"'*) : ;;
    *) echo "SHIM: dependency body missing owner/repo: $body" >&2
       $want_code && echo 000; exit 0;;
  esac
  $want_code && echo "${DEP_CODE:-201}"
  exit 0
fi
if $is_lab; then $want_code && echo "${LABEL_CODE:-204}"; exit 0; fi
if $is_comment_asset || $is_issue_asset; then $want_code && echo "${ASSET_CODE:-201}"; exit 0; fi
if $is_comment; then echo '{"id": 12345}'; exit 0; fi
for a in "$@"; do case "$a" in
  *labels=rehearsal-183*)
    # The open-issues snapshot. #403 defect 3 (stale snapshot): a sig-matched
    # issue can be filed by a concurrent drive DURING the diagnosis, so the
    # reporter re-fetches immediately before filing. When ISSUE_FIXTURE_AFTER is
    # set, serve it on the 2nd+ list fetch to simulate that concurrent filing.
    n=1; [ -f "$LIST_COUNT" ] && n=$(( $(cat "$LIST_COUNT") + 1 )); echo "$n" > "$LIST_COUNT"
    if [ "$n" -ge 2 ] && [ -n "${ISSUE_FIXTURE_AFTER:-}" ]; then cat "$ISSUE_FIXTURE_AFTER"; else cat "${ISSUE_FIXTURE:?}"; fi
    exit 0;;
  *labels\?limit=100*)
    # #495: LABELS_FAIL_FIRST=<n> makes the first n repo-labels fetches fail
    # (curl -f style rc 22, no output) so the retry path is testable.
    if [ -n "${LABELS_COUNT:-}" ]; then
      c=1; [ -f "$LABELS_COUNT" ] && c=$(( $(cat "$LABELS_COUNT") + 1 )); echo "$c" > "$LABELS_COUNT"
      if [ -n "${LABELS_FAIL_FIRST:-}" ] && [ "$c" -le "${LABELS_FAIL_FIRST}" ]; then exit 22; fi
    fi
    echo '[{"id":36,"name":"ready-for-agent"},{"id":37,"name":"ready-for-human"},{"id":38,"name":"ready-for-session"},{"id":40,"name":"bug"},{"id":97,"name":"rehearsal-183"},{"id":99,"name":"priority"}]'; exit 0;;
esac; done
echo '{"number": 991}'
SH
chmod +x "$tmp/bin/curl"
# claude shim: a fixed confident diagnosis.
cat > "$tmp/bin/claude" <<'SH'
#!/usr/bin/env bash
echo '{"title":"rehearsal: pairing never flips on the droplet","body":"diagnosis body","confident":true}'
SH
chmod +x "$tmp/bin/claude"
export CURL_LOG="$tmp/curl.log" ISSUE_FIXTURE="$tmp/issues.json" LIST_COUNT="$tmp/list-count"
export LABELS_COUNT="$tmp/labels-count" REPORTER_LABELS_RETRY_DELAY=0

red_run() { # red_run <error-line> — a minimal red run dir
  cat > "$tmp/run/artifacts/legs.json" <<EOF
[{"leg":"found","status":"red","ms":1,"error":"$1"}]
EOF
}

# 1: fresh signature files a NEW issue carrying label + sig marker
echo '[]' > "$ISSUE_FIXTURE"; : > "$CURL_LOG"
red_run "pairing timeout after 900000ms"
bash "$here/../rehearsal-report.sh" "$tmp/run" || fail "reporter exited non-zero"
grep -q 'issues' "$CURL_LOG" || fail "no issue POST"
grep -q 'rehearsal-183' "$CURL_LOG" || fail "label missing from POST"
grep -q 'rehearsal-sig:' "$CURL_LOG" || fail "sig marker missing"
pass=$((pass+1))

# 2: same signature again → COMMENT on the existing issue, no new issue
# created (a match still wires the drive-issue dependency — case 5 pins that).
sig_body="$(grep -o 'rehearsal-sig: [a-f0-9]*' "$CURL_LOG" | head -1)"
printf '[{"number": 991, "body": "x\\n%s"}]' "$sig_body" > "$ISSUE_FIXTURE"
: > "$CURL_LOG"
bash "$here/../rehearsal-report.sh" "$tmp/run" || fail "reporter exited non-zero (dedup)"
grep -q '991/comments' "$CURL_LOG" || fail "no comment on the matched issue"
[ "$(grep -c '/issues -d' "$CURL_LOG" || true)" -eq 0 ] || fail "dedup path must never create a new issue"
pass=$((pass+1))

# 3: run-specific noise (hex, ports) does NOT mint a fresh signature
: > "$CURL_LOG"
red_run "pairing timeout after 900000ms run 7f3a9c worker 41213"
bash "$here/../rehearsal-report.sh" "$tmp/run" || fail "reporter exited non-zero (noise)"
grep -q '991/comments' "$CURL_LOG" || fail "noisy variant of the same fault re-filed instead of appending"
pass=$((pass+1))

# 4: the cap — a run with 3 distinct red legs files at most 2 new issues
echo '[]' > "$ISSUE_FIXTURE"; : > "$CURL_LOG"
cat > "$tmp/run/artifacts/legs.json" <<'EOF'
[{"leg":"a","status":"red","ms":1,"error":"alpha fault"},
 {"leg":"b","status":"red","ms":1,"error":"beta fault"},
 {"leg":"c","status":"red","ms":1,"error":"gamma fault"}]
EOF
bash "$here/../rehearsal-report.sh" "$tmp/run" || fail "reporter exited non-zero (cap)"
[ "$(grep -c '/issues -d' "$CURL_LOG" || true)" -le 2 ] || fail "cap breached: more than 2 new issues"
pass=$((pass+1))

# 5: the drive-issue loop (Ben's ruling): every red wires its issue as a
#    native dependency of REHEARSAL_DRIVE_ISSUE and ONE evidence comment
#    lands there — the blocked invariant that stops a hot loop.
export REHEARSAL_DRIVE_ISSUE=500
echo '[]' > "$ISSUE_FIXTURE"; : > "$CURL_LOG"
red_run "pairing timeout after 900000ms"
bash "$here/../rehearsal-report.sh" "$tmp/run" || fail "reporter exited non-zero (deps)"
grep -q '500/dependencies' "$CURL_LOG" || fail "no dependency wired onto the drive issue"
grep -q '500/comments' "$CURL_LOG" || fail "no evidence comment on the drive issue"
pass=$((pass+1))

# 6: the blocked invariant's fallback — a red where NOTHING files or matches
#    (claude parked, no signature match) must flip the drive issue
#    ready-for-agent → ready-for-human, never leave it ready and undepended.
#    Stays ready-for-human (not ready-for-session, #531): the standing drive
#    issue is explicitly excluded from session-runner.sh's ready-for-session
#    queue (`select(.number != $drive)`), so this is the only way it ever
#    reaches anyone — Ben's digest, by design.
date > "$CLAUDE_LIMIT_MARKER"   # fresh marker = host parked (limit-lib)
echo '[]' > "$ISSUE_FIXTURE"; : > "$CURL_LOG"
red_run "some entirely new fault"
bash "$here/../rehearsal-report.sh" "$tmp/run" || fail "reporter exited non-zero (invariant)"
grep -q 'X DELETE.*500/labels/36' "$CURL_LOG" || fail "ready-for-agent not removed from the drive issue"
grep -Eq '500/labels -d.*37' "$CURL_LOG" || fail "ready-for-human not added to the drive issue"
grep -q '500/dependencies' "$CURL_LOG" && fail "nothing was filed — no dependency should be wired"
rm -f "$CLAUDE_LIMIT_MARKER"
pass=$((pass+1))

# 7: the dependency POST names the target repo (owner+repo) — the live-Forgejo
#    IssueMeta shape. A bare {"index": n} 404s (IsErrRepoNotExist, #381); pin
#    the shape on the wire so a regression to the bare body reds here.
export REHEARSAL_DRIVE_ISSUE=500
echo '[]' > "$ISSUE_FIXTURE"; : > "$CURL_LOG"
red_run "pairing timeout after 900000ms"
bash "$here/../rehearsal-report.sh" "$tmp/run" || fail "reporter exited non-zero (dep shape)"
dep_line="$(grep '500/dependencies' "$CURL_LOG" | head -1)"
[ -n "$dep_line" ] || fail "no dependency POST to inspect"
grep -q '"owner"' <<<"$dep_line" || fail "dependency body missing owner (live Forgejo 404s a bare index)"
grep -q '"repo"'  <<<"$dep_line" || fail "dependency body missing repo"
pass=$((pass+1))

# 8: the blocked invariant on a wiring FAILURE — if the dependency POST does
#    not land (404 bad shape, 5xx), the drive must flip ready-for-human, never
#    stay ready-and-undepended (the #381 hot-loop state). No blind `|| true`.
export REHEARSAL_DRIVE_ISSUE=500 DEP_CODE=404
echo '[]' > "$ISSUE_FIXTURE"; : > "$CURL_LOG"
red_run "pairing timeout after 900000ms"
bash "$here/../rehearsal-report.sh" "$tmp/run" || fail "reporter exited non-zero (wire-fail)"
grep -q 'X DELETE.*500/labels/36' "$CURL_LOG" || fail "wiring failure did not remove ready-for-agent"
grep -Eq '500/labels -d.*37'      "$CURL_LOG" || fail "wiring failure did not add ready-for-human"
unset DEP_CODE
pass=$((pass+1))

# 9: an already-present dependency answers 409 — tolerated, the blocker IS
#    landed, so the drive stays blocked (evidence comment), not flipped.
export REHEARSAL_DRIVE_ISSUE=500 DEP_CODE=409
echo '[]' > "$ISSUE_FIXTURE"; : > "$CURL_LOG"
red_run "pairing timeout after 900000ms"
bash "$here/../rehearsal-report.sh" "$tmp/run" || fail "reporter exited non-zero (dep 409)"
grep -q '500/comments' "$CURL_LOG" || fail "409 dep should keep the drive blocked with an evidence comment"
grep -q 'X DELETE.*500/labels/36' "$CURL_LOG" && fail "409 is tolerated — must not flip ready-for-human"
unset DEP_CODE
pass=$((pass+1))

# 10: the #392 invariant — a RED drive with ZERO red legs (the wizard died
#     before driveLegs ran, so legs.json is empty) must still file a
#     drive-red-at-wizard issue AND block the drive. The caller passes the
#     drive's exit code as arg 2; a non-zero rc with no red legs is a wizard red.
export REHEARSAL_DRIVE_ISSUE=500
echo '[]' > "$ISSUE_FIXTURE"; : > "$CURL_LOG"
echo '[]' > "$tmp/run/artifacts/legs.json"
printf 'wizard.ts:117 TimeoutError: locator.click: Timeout 30000ms exceeded\n' > "$tmp/run/logs/e2e.txt"
bash "$here/../rehearsal-report.sh" "$tmp/run" 1 || fail "reporter exited non-zero (wizard red)"
grep -q '/issues -d' "$CURL_LOG" || fail "wizard-stage red filed no issue"
grep -q '500/dependencies' "$CURL_LOG" || fail "wizard-stage red did not block the drive issue"
pass=$((pass+1))

# 11: a GREEN drive (rc 0) with zero red legs files nothing — the reporter must
#     not mistake a real green for a wizard-stage red (or the drive never closes).
: > "$CURL_LOG"
echo '[]' > "$tmp/run/artifacts/legs.json"
bash "$here/../rehearsal-report.sh" "$tmp/run" 0 || fail "reporter exited non-zero (green)"
[ "$(grep -c '/issues -d' "$CURL_LOG" || true)" -eq 0 ] || fail "green drive must file nothing"
grep -q '500/dependencies' "$CURL_LOG" && fail "green drive must wire no dependency"
pass=$((pass+1))

# 12: the raw claude stdout is saved unconditionally (#403 defect 1) — every
#     silent flake today left reporter-claude.err at 0 bytes with nothing
#     recording what claude emitted, so a parse flake was undiagnosable.
unset DEP_CODE
echo '[]' > "$ISSUE_FIXTURE"; : > "$CURL_LOG"; rm -f "$LIST_COUNT"
rm -f "$tmp/run/logs/reporter-claude.out"
red_run "pairing timeout after 900000ms"
bash "$here/../rehearsal-report.sh" "$tmp/run" || fail "reporter exited non-zero (raw save)"
[ -f "$tmp/run/logs/reporter-claude.out" ] || fail "raw claude stdout not saved to reporter-claude.out"
grep -q 'pairing never flips' "$tmp/run/logs/reporter-claude.out" || fail "saved stdout missing claude's output"
pass=$((pass+1))

# 13: claude wrapping its JSON in a markdown code fence (the in-pipeline
#     corruption a manual run never shows) is still parsed — the reporter files
#     a confident bug + ready-for-agent, not a generic ready-for-human (#403 d2).
cat > "$tmp/bin/claude" <<'SH'
#!/usr/bin/env bash
printf '```json\n{"title":"found: droplet never paired","body":"b","confident":true}\n```\n'
SH
chmod +x "$tmp/bin/claude"
echo '[]' > "$ISSUE_FIXTURE"; : > "$CURL_LOG"; rm -f "$LIST_COUNT"
red_run "pairing timeout after 900000ms"
bash "$here/../rehearsal-report.sh" "$tmp/run" || fail "reporter exited non-zero (fenced json)"
# jq pretty-prints the create payload, so title/labels land on their own log
# lines: search the (per-case reset) whole log, and match a label id alone.
grep -q '/issues -d' "$CURL_LOG" || fail "fenced json filed no issue"
grep -q 'droplet never paired' "$CURL_LOG" || fail "fenced json title not parsed (degraded to the generic fallback title)"
grep -Eq '^[[:space:]]*40,?[[:space:]]*$' "$CURL_LOG" || fail "fenced json confident diagnosis missing bug label (parse silently degraded to a generic filing)"
grep -Eq '^[[:space:]]*36,?[[:space:]]*$' "$CURL_LOG" || fail "fenced json confident diagnosis missing ready-for-agent"
pass=$((pass+1))

# 14: a still-unparseable diagnosis (no JSON at all) is SAVED raw and filed as
#     unconfident — fallback title + ready-for-session (ADR 0174, #531: a
#     session diagnoses from the workstation evidence bundle, escalating to
#     ready-for-human itself only on a one-way door), never dropped (#403 d1+d2).
cat > "$tmp/bin/claude" <<'SH'
#!/usr/bin/env bash
echo "I could not read the run directory, sorry - no JSON here."
SH
chmod +x "$tmp/bin/claude"
echo '[]' > "$ISSUE_FIXTURE"; : > "$CURL_LOG"; rm -f "$LIST_COUNT"
rm -f "$tmp/run/logs/reporter-claude.out"
red_run "brand new fault xyz"
bash "$here/../rehearsal-report.sh" "$tmp/run" || fail "reporter exited non-zero (unparseable)"
grep -q 'could not read the run directory' "$tmp/run/logs/reporter-claude.out" || fail "unparseable stdout not saved"
grep -q '/issues -d' "$CURL_LOG" || fail "unparseable diagnosis filed no issue"
grep -q 'rehearsal drive red at' "$CURL_LOG" || fail "unparseable diagnosis missing the fallback title"
grep -Eq '^[[:space:]]*38,?[[:space:]]*$' "$CURL_LOG" || fail "unparseable diagnosis not filed ready-for-session"
grep -Eq '^[[:space:]]*37,?[[:space:]]*$' "$CURL_LOG" && fail "unparseable diagnosis wrongly filed ready-for-human (ADR 0174 narrows this to Ben-only)"
grep -Eq '^[[:space:]]*40,?[[:space:]]*$' "$CURL_LOG" && fail "unparseable diagnosis wrongly marked confident (bug label)"
pass=$((pass+1))

# 14b (#531): an explicit unconfident diagnosis (valid JSON, "confident":false)
#     — not just a totally unparseable one — also files ready-for-session, not
#     ready-for-human. Pins the general branch, not just the unparseable edge.
cat > "$tmp/bin/claude" <<'SH'
#!/usr/bin/env bash
echo '{"title":"rehearsal: cause unclear","body":"diagnosis body","confident":false}'
SH
chmod +x "$tmp/bin/claude"
echo '[]' > "$ISSUE_FIXTURE"; : > "$CURL_LOG"; rm -f "$LIST_COUNT"
red_run "another brand new fault"
bash "$here/../rehearsal-report.sh" "$tmp/run" || fail "reporter exited non-zero (explicit unconfident)"
grep -q '/issues -d' "$CURL_LOG" || fail "explicit unconfident diagnosis filed no issue"
grep -q 'cause unclear' "$CURL_LOG" || fail "explicit unconfident diagnosis title not parsed"
grep -Eq '^[[:space:]]*38,?[[:space:]]*$' "$CURL_LOG" || fail "explicit unconfident diagnosis not filed ready-for-session"
grep -Eq '^[[:space:]]*37,?[[:space:]]*$' "$CURL_LOG" && fail "explicit unconfident diagnosis wrongly filed ready-for-human"
pass=$((pass+1))

# 15: the stale-snapshot dup (#403 defect 3, the #402→#400 bug). The start-of-run
#     snapshot is empty, but a concurrent drive files the sig-matched issue
#     DURING the up-to-15-min diagnosis. The reporter must re-check the sig
#     immediately before filing and APPEND to it, never file a duplicate.
cat > "$tmp/bin/claude" <<'SH'
#!/usr/bin/env bash
echo '{"title":"rehearsal: pairing never flips on the droplet","body":"diagnosis body","confident":true}'
SH
chmod +x "$tmp/bin/claude"
# Capture the leg-keyed sig by filing once against an empty snapshot.
echo '[]' > "$ISSUE_FIXTURE"; : > "$CURL_LOG"; rm -f "$LIST_COUNT"
red_run "pairing timeout after 900000ms"
bash "$here/../rehearsal-report.sh" "$tmp/run" >/dev/null || fail "reporter exited non-zero (sig capture)"
sig15="$(grep -o 'rehearsal-sig: [a-f0-9]*' "$CURL_LOG" | head -1)"
[ -n "$sig15" ] || fail "could not capture sig for stale-snapshot case"
# Start snapshot empty (stale); the AFTER fixture carries the sig on #402.
echo '[]' > "$ISSUE_FIXTURE"; rm -f "$LIST_COUNT"; : > "$CURL_LOG"
printf '[{"number": 402, "body": "x\\n%s"}]' "$sig15" > "$tmp/issues-after.json"
export ISSUE_FIXTURE_AFTER="$tmp/issues-after.json"
red_run "pairing timeout after 900000ms"
bash "$here/../rehearsal-report.sh" "$tmp/run" || fail "reporter exited non-zero (stale snapshot)"
grep -q '402/comments' "$CURL_LOG" || fail "sig filed during diagnosis not appended — the #402 duplicate bug"
[ "$(grep -c '/issues -d' "$CURL_LOG" || true)" -eq 0 ] || fail "re-check before filing failed — filed a duplicate of #402"
unset ISSUE_FIXTURE_AFTER; rm -f "$LIST_COUNT"
pass=$((pass+1))

# 16: every drive blocker gets the `priority` label — list-ready-tasks.sh
#     floats priority issues to the head of the swarm queue, so a red's fix
#     is worked before ordinary backlog. NEWLY-FILED path: the minted issue
#     (#991 from the POST shim) must receive a POST to its /labels with the
#     priority id (99). POST adds without replacing the set.
echo '[]' > "$ISSUE_FIXTURE"; : > "$CURL_LOG"; rm -f "$LIST_COUNT"
red_run "pairing timeout after 900000ms"
bash "$here/../rehearsal-report.sh" "$tmp/run" || fail "reporter exited non-zero (priority new)"
grep '991/labels' "$CURL_LOG" | grep -q '\[99\]' \
  || fail "newly-filed drive blocker did not receive the priority label"
pass=$((pass+1))

# 17: MATCHED path — a sig-matched EXISTING issue re-blocking the drive is
#     also priority-labelled (it may have been filed before the label existed,
#     or had it removed while closed).
sig17="$(grep -o 'rehearsal-sig: [a-f0-9]*' "$CURL_LOG" | head -1)"
[ -n "$sig17" ] || fail "could not capture sig for priority-match case"
printf '[{"number": 991, "body": "x\\n%s"}]' "$sig17" > "$ISSUE_FIXTURE"
: > "$CURL_LOG"; rm -f "$LIST_COUNT"
bash "$here/../rehearsal-report.sh" "$tmp/run" || fail "reporter exited non-zero (priority match)"
grep '991/labels' "$CURL_LOG" | grep -q '\[99\]' \
  || fail "matched drive blocker did not receive the priority label"
pass=$((pass+1))

# 18: a refused priority-label POST is LOUD (WARN naming the HTTP code), never
#     silent — and never stops the dep wiring or reds the reporter. (#438
#     arrived unlabelled with zero forensic trail; silence is the enemy.)
export LABEL_CODE=500
echo '[]' > "$ISSUE_FIXTURE"; : > "$CURL_LOG"; rm -f "$LIST_COUNT"
red_run "pairing timeout after 900000ms"
out18="$(bash "$here/../rehearsal-report.sh" "$tmp/run")" || fail "reporter exited non-zero (label 500)"
grep -q 'WARN priority label' <<<"$out18" || fail "refused priority-label POST was silent"
grep -q '500/dependencies' "$CURL_LOG" || fail "label failure must not stop dep wiring"
unset LABEL_CODE
pass=$((pass+1))

# 19: a filed+wired red kicks the swarm immediately (workflow_dispatch on
#     swarm.yml) — an issue CREATED with labels inline fires no label event,
#     so without the kick the blocker sits until the :15/:45 cron (up to 30
#     idle minutes per red, and Forgejo's scheduler has silently died before).
echo '[]' > "$ISSUE_FIXTURE"; : > "$CURL_LOG"; rm -f "$LIST_COUNT"
red_run "pairing timeout after 900000ms"
out19="$(bash "$here/../rehearsal-report.sh" "$tmp/run")" || fail "reporter exited non-zero (dispatch)"
grep -q 'swarm.yml/dispatches' "$CURL_LOG" || fail "filed+wired red did not dispatch the swarm"
grep -q 'swarm dispatched' <<<"$out19" || fail "dispatch happened but was not announced"
pass=$((pass+1))

# 20: a refused dispatch is LOUD (WARN naming the HTTP code) and degrades to
#     the old cron cadence — never reds the reporter, never undoes the block.
export DISPATCH_CODE=500
echo '[]' > "$ISSUE_FIXTURE"; : > "$CURL_LOG"; rm -f "$LIST_COUNT"
red_run "pairing timeout after 900000ms"
out20="$(bash "$here/../rehearsal-report.sh" "$tmp/run")" || fail "reporter exited non-zero (dispatch 500)"
grep -q 'WARN swarm dispatch' <<<"$out20" || fail "refused dispatch was silent"
grep -q '500/dependencies' "$CURL_LOG" || fail "dispatch failure must not stop dep wiring"
unset DISPATCH_CODE
pass=$((pass+1))

# 21 (#495): ONE transient labels fetch failure must not degrade the run's
#     label ops — the fetch WARNs loud, retries once, and the filed issue
#     still carries its labels (rehearsal-183 id 97 on the wire).
export LABELS_FAIL_FIRST=1
echo '[]' > "$ISSUE_FIXTURE"; : > "$CURL_LOG"; rm -f "$LIST_COUNT" "$LABELS_COUNT"
red_run "pairing timeout after 900000ms"
out21="$(bash "$here/../rehearsal-report.sh" "$tmp/run")" || fail "reporter exited non-zero (labels retry)"
grep -q 'WARN labels fetch failed' <<<"$out21" || fail "transient labels failure was silent (#495's exact hole)"
grep -q 'labels re-fetch succeeded' <<<"$out21" || fail "retry success not announced"
grep -Eq '^[[:space:]]*97,?[[:space:]]*$' "$CURL_LOG" || fail "retry did not restore label ops — issue filed without rehearsal-183"
unset LABELS_FAIL_FIRST
pass=$((pass+1))

# 22 (#495): BOTH fetches down → degradation is named LOUD, and fail-open
#     holds: the blocker still files (unlabelled) and still wires the drive
#     dependency — a dead tracker-labels endpoint never suppresses filing.
export LABELS_FAIL_FIRST=2
echo '[]' > "$ISSUE_FIXTURE"; : > "$CURL_LOG"; rm -f "$LIST_COUNT" "$LABELS_COUNT"
red_run "pairing timeout after 900000ms"
out22="$(bash "$here/../rehearsal-report.sh" "$tmp/run")" || fail "reporter exited non-zero (labels degraded)"
grep -q 'label ops DEGRADED' <<<"$out22" || fail "double labels failure not named"
grep -q '/issues -d' "$CURL_LOG" || fail "fail-open broken: degraded labels suppressed the filing"
grep -q '500/dependencies' "$CURL_LOG" || fail "degraded labels must not stop dep wiring"
unset LABELS_FAIL_FIRST
pass=$((pass+1))

# 23 (#540): a droplet IP (arg 3) grants the reporter Bash and adds the live
#     door to its prompt — the ssh line names the exact IP. The claude shim
#     below logs its own argv so the grant + prompt content are checkable.
cat > "$tmp/bin/claude" <<'SH'
#!/usr/bin/env bash
echo "claude $*" >> "${CLAUDE_LOG:?}"
echo '{"title":"rehearsal: pairing never flips on the droplet","body":"diagnosis body","confident":true}'
SH
chmod +x "$tmp/bin/claude"
export CLAUDE_LOG="$tmp/claude.log"
echo '[]' > "$ISSUE_FIXTURE"; : > "$CURL_LOG"; rm -f "$LIST_COUNT"; : > "$CLAUDE_LOG"
red_run "pairing timeout after 900000ms"
bash "$here/../rehearsal-report.sh" "$tmp/run" 1 "10.0.0.9" || fail "reporter exited non-zero (live door)"
grep -q -- '--allowedTools Bash' "$CLAUDE_LOG" || fail "a droplet IP must grant the reporter Bash access"
grep -q 'root@10.0.0.9' "$CLAUDE_LOG" || fail "the live-door prompt must name the droplet IP"
pass=$((pass+1))

# 24 (#540): no droplet IP (today's callers, or a manual run) stays text-only
#     — no Bash grant, no ssh line — byte-identical to before #540.
echo '[]' > "$ISSUE_FIXTURE"; : > "$CURL_LOG"; rm -f "$LIST_COUNT"; : > "$CLAUDE_LOG"
red_run "pairing timeout after 900000ms"
bash "$here/../rehearsal-report.sh" "$tmp/run" 1 || fail "reporter exited non-zero (no live door)"
grep -q -- '--allowedTools' "$CLAUDE_LOG" && fail "no droplet IP must never grant Bash"
grep -q 'root@' "$CLAUDE_LOG" && fail "no droplet IP must never add an ssh line"
pass=$((pass+1))

# 25 (#574): verdict.json says red — even with NO drive-rc arg at all (the
#     caller-passes-rc hazard clause 5 closes) and zero red legs — the reporter
#     must still file drive-red-at-wizard, exactly like case 10's explicit rc=1.
echo '[]' > "$ISSUE_FIXTURE"; : > "$CURL_LOG"; rm -f "$LIST_COUNT"
echo '[]' > "$tmp/run/artifacts/legs.json"
cat > "$tmp/run/artifacts/verdict.json" <<'EOF'
{"verdict":"red","target":"droplet","startedAt":"t0","endedAt":"t1","legs":{"total":0,"green":0,"red":0,"skip":0},"firstRedLeg":null}
EOF
printf 'wizard.ts:117 TimeoutError: locator.click: Timeout 30000ms exceeded\n' > "$tmp/run/logs/e2e.txt"
bash "$here/../rehearsal-report.sh" "$tmp/run" || fail "reporter exited non-zero (verdict.json red, no rc arg)"
grep -q '/issues -d' "$CURL_LOG" || fail "verdict.json red with no rc arg filed no issue"
grep -q '500/dependencies' "$CURL_LOG" || fail "verdict.json red with no rc arg did not block the drive issue"
rm -f "$tmp/run/artifacts/verdict.json"
pass=$((pass+1))

# 26 (#574): verdict.json says green — files nothing, same as an explicit rc=0
#     (case 11). Confirms the file does not spuriously force a red.
: > "$CURL_LOG"
echo '[]' > "$tmp/run/artifacts/legs.json"
cat > "$tmp/run/artifacts/verdict.json" <<'EOF'
{"verdict":"green","target":"droplet","startedAt":"t0","endedAt":"t1","legs":{"total":5,"green":5,"red":0,"skip":0},"firstRedLeg":null}
EOF
bash "$here/../rehearsal-report.sh" "$tmp/run" || fail "reporter exited non-zero (verdict.json green)"
[ "$(grep -c '/issues -d' "$CURL_LOG" || true)" -eq 0 ] || fail "verdict.json green must file nothing"
grep -q '500/dependencies' "$CURL_LOG" && fail "verdict.json green must wire no dependency"
rm -f "$tmp/run/artifacts/verdict.json"
pass=$((pass+1))

# 27 (#596): a fresh filing attaches one representative screenshot to the
#     NEW issue via the issue-asset endpoint (there's no prior comment to key
#     off — the initial body isn't a comment).
cat > "$tmp/bin/claude" <<'SH'
#!/usr/bin/env bash
echo '{"title":"rehearsal: pairing never flips on the droplet","body":"diagnosis body","confident":true}'
SH
chmod +x "$tmp/bin/claude"
mkdir -p "$tmp/run/artifacts/ceremony"
: > "$tmp/run/artifacts/ceremony/finish.png"
echo '[]' > "$ISSUE_FIXTURE"; : > "$CURL_LOG"; rm -f "$LIST_COUNT"
red_run "pairing timeout after 900000ms"
bash "$here/../rehearsal-report.sh" "$tmp/run" || fail "reporter exited non-zero (screenshot on new filing)"
grep -q '991/assets' "$CURL_LOG" || fail "new filing did not attach a screenshot to the issue"
grep -q 'attachment=@.*finish\.png' "$CURL_LOG" || fail "attach call did not name the representative screenshot"
pass=$((pass+1))

# 28 (#596): the MATCHED path — a comment appended to an EXISTING issue also
#     attaches the screenshot, to the SAME comment (comment-asset endpoint,
#     keyed off the comment's own id — 12345 per the shim's fixture).
sig27="$(grep -o 'rehearsal-sig: [a-f0-9]*' "$CURL_LOG" | head -1)"
[ -n "$sig27" ] || fail "could not capture sig for the screenshot-match case"
printf '[{"number": 991, "body": "x\\n%s"}]' "$sig27" > "$ISSUE_FIXTURE"
: > "$CURL_LOG"
bash "$here/../rehearsal-report.sh" "$tmp/run" || fail "reporter exited non-zero (screenshot on match)"
grep -q '991/comments' "$CURL_LOG" || fail "no comment posted on the matched issue"
grep -q 'comments/12345/assets' "$CURL_LOG" || fail "matched-issue comment did not attach a screenshot"
grep -q 'attachment=@.*finish\.png' "$CURL_LOG" || fail "attach call did not name the representative screenshot"
pass=$((pass+1))

# 29 (#596): no screenshot captured (a run dir with no *.png anywhere) —
#     filing/appending still succeeds, and no asset-attach call is even
#     attempted (never a failed upload, just skipped).
rm -f "$tmp/run/artifacts/ceremony/finish.png"
echo '[]' > "$ISSUE_FIXTURE"; : > "$CURL_LOG"; rm -f "$LIST_COUNT"
red_run "pairing timeout after 900000ms"
bash "$here/../rehearsal-report.sh" "$tmp/run" || fail "reporter exited non-zero (no screenshot)"
grep -q '/issues -d' "$CURL_LOG" || fail "filing without a screenshot still must file"
grep -q '/assets' "$CURL_LOG" && fail "no screenshot present — no asset-attach call should have been attempted"
pass=$((pass+1))

# 30 (#610): the evidence note must show the REAL error text to a human/agent
# -- not normalize_error_line's signature fold. Digits (port/timeout) survive,
# and ANSI color codes (Playwright's TimeoutError coloring) are stripped
# clean rather than garbled into "[Nm" junk. The dedup signature itself is
# unaffected (case 3 already pins that normalization still drives it).
echo '[]' > "$ISSUE_FIXTURE"; : > "$CURL_LOG"; rm -f "$LIST_COUNT"
red_run '\u001b[31mTimeoutError\u001b[0m: locator.click: Timeout 30000ms exceeded, port 127.0.0.1:8443'
bash "$here/../rehearsal-report.sh" "$tmp/run" || fail "reporter exited non-zero (evidence display)"
grep -q 'Timeout 30000ms exceeded, port 127.0.0.1:8443' "$CURL_LOG" || fail "evidence note redacted the real port/timeout digits"
grep -Eq '\[[0-9]*m' "$CURL_LOG" && fail "evidence note leaked ANSI/garbled [Nm noise"
pass=$((pass+1))

echo "PASS ($pass cases)"
