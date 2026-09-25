#!/usr/bin/env bash
# Offline tests for the per-ticket landing override's HOST side (idss ADR 0267):
# schedule-lib's two pure helpers, preflight_landing_gate, and (Task 8) the
# per-ticket resolvers in landing-lib.sh. No network: curl is shimmed.
# Run: bash tests/ticket-landing-test.sh
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sc="$here/.."
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
pass=0 fail=0
check() { if eval "$2"; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: $1"; fi; }

cat > "$tmp/notify.sh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$1" >> "$NOTIFY_LOG"
SH
export NOTIFY_LOG="$tmp/notify.log" PREFLIGHT_NOTIFY="$tmp/notify.sh"
: > "$NOTIFY_LOG"

# shellcheck source=../verdict-lib.sh
. "$sc/verdict-lib.sh"
# shellcheck source=../model-lib.sh
. "$sc/model-lib.sh"
# shellcheck source=../policy-lib.sh
. "$sc/policy-lib.sh"
# shellcheck source=../schedule-lib.sh
. "$sc/schedule-lib.sh"
# shellcheck source=../preflight-lib.sh
. "$sc/preflight-lib.sh"

mixed='[{"number":802,"landing_label":"pr","landing":"pr"},{"number":801,"landing_label":null,"landing":"push"}]'
plain='[{"number":801,"landing_label":null,"landing":"push"},{"number":802,"landing_label":"pr","landing":"pr"}]'
bad='[{"number":801,"landing_label":null,"landing":"push"},{"number":803,"landing_label":"squash","landing":"squash"}]'

# --- schedule_bad_landing_labels ---------------------------------------------
check "a clean queue names no offender" '[ -z "$(schedule_bad_landing_labels "$mixed")" ]'
check "an unknown landing-* label is named with its ticket — even when it is NOT the head ticket" \
  '[ "$(schedule_bad_landing_labels "$bad")" = "803 landing-squash" ]'

# --- schedule_run_landing ------------------------------------------------------
SWARM_POLICY_LANDING=push
check "head ticket lands by PR -> the run is that ticket alone" '[ "$(schedule_run_landing "$mixed")" = "pr 802" ]'
check "head ticket lands by push -> a push run (the PR ticket waits for its own run)" '[ "$(schedule_run_landing "$plain")" = "push" ]'
SWARM_POLICY_LANDING=pr
check "a LANDING=pr repo needs no parity" '[ "$(schedule_run_landing "$mixed")" = "repo-pr" ]'
SWARM_POLICY_LANDING=push

# --- preflight_landing_gate ----------------------------------------------------
export SWARM_HOST_SIGNALS_DIR="$tmp/signals"
: > "$NOTIFY_LOG"; SWARM_EXIT_REASON=""
preflight_landing_gate Acme/widget "$mixed" >"$tmp/g.out" 2>&1; rc=$?
check "a resolvable queue passes the gate" '[ "$rc" -eq 0 ]'
check "the gate exports the run landing" '[ "${SWARM_RUN_LANDING:-}" = "pr 802" ]'
check "the gate writes the sandbox signal file" '[ "$(cat "$tmp/signals/run-landing")" = "pr 802" ]'
check "the job log says which ticket fixed the landing" 'grep -q "landing for this run: pr 802" "$tmp/g.out"'
check "a passing gate posts nothing" '[ ! -s "$NOTIFY_LOG" ]'

: > "$NOTIFY_LOG"; SWARM_EXIT_REASON=""
preflight_landing_gate Acme/widget "$bad" >/dev/null 2>&1; rc=$?
check "an unknown landing-* label aborts before any worker spawns" '[ "$rc" -eq 1 ]'
check "the exit reason is named" '[ "$SWARM_EXIT_REASON" = "unknown-landing" ]'
check "the alarm quotes the ticket and the label so it can be fixed" 'grep -q "#803" "$NOTIFY_LOG" && grep -q "landing-squash" "$NOTIFY_LOG"'

# A signal dir that cannot be written must abort a PR run: the sandbox would
# otherwise fail safe to push parity, hide the ticket, and idle forever.
export SWARM_HOST_SIGNALS_DIR="$tmp/ro/signals"; mkdir -p "$tmp/ro"; chmod 555 "$tmp/ro"
: > "$NOTIFY_LOG"; SWARM_EXIT_REASON=""
preflight_landing_gate Acme/widget "$mixed" >/dev/null 2>&1; rc=$?
chmod 755 "$tmp/ro"
check "an unwritable signal dir aborts the run loud" '[ "$rc" -eq 1 ] && [ "$SWARM_EXIT_REASON" = "landing-signal-unwritable" ]'

# --- run-swarm.sh wiring (static — the orchestrator is not runnable offline) ---
check "run-swarm exports the signals dir BEFORE the gates run" \
  'awk "/export SWARM_HOST_SIGNALS_DIR/{a=NR} /preflight_landing_gate /{b=NR} END{exit !(a && b && a<b)}" "$sc/run-swarm.sh"'
check "run-swarm runs the landing gate right after the model gate" \
  'awk "/^preflight_model_gate /{a=NR} /^preflight_landing_gate /{b=NR} END{exit !(a && b && b==a+1)}" "$sc/run-swarm.sh"'

# ═════ Task 8: landing-lib.sh resolves the mode per ticket ═════════════════════
mkdir -p "$tmp/bin"
cat > "$tmp/bin/git" <<'SH'
#!/usr/bin/env bash
case "${1:-}" in
  push)       printf '%s\n' "$*" >> "$GIT_PUSHES"; exit "${PUSH_RC:-0}" ;;
  rev-list)   printf '%s\n' "${AHEAD:-1}" ;;
  log)        printf '%s\n' "${LOG_SUBJECTS:-}" ;;
  merge-base) exit "${IS_ANCESTOR_RC:-1}" ;;
esac
exit 0
SH
cat > "$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
set -u
url="" method=GET prev=""
for a in "$@"; do
  [ "$prev" = -X ] && method="$a"
  prev="$a"
  case "$a" in http*) url="$a" ;; esac
done
printf '%s %s\n' "$method" "$url" >> "$CALLS_LOG"
[ "${API_DOWN:-0}" = 1 ] && exit 22
case "$url" in
  */pulls?state=open*)   cat "${OPEN_PULLS:-/dev/null}" 2>/dev/null || echo '[]' ;;
  */pulls/[0-9]*/merge)  echo 200 ;;
  */commits/*/status)    echo '{"state":"success","statuses":[]}' ;;
  */pulls/[0-9]*)        printf '{"number":%s,"head":{"ref":"agent/issue-7","sha":"headsha"},"body":%s}\n' "${url##*/}" "${PR_BODY_JSON:-\"closes #7\"}" ;;
  */pulls)               echo '{"number":101}' ;;
  */issues/*/assets)     echo "${ASSETS_JSON:-[]}" ;;
  */issues/*/labels)     echo LABELED >> "$CALLS_LOG"; echo 200 ;;
  */issues/*/comments)   echo 201 ;;
  */issues/[0-9]*)       n="${url##*/}"; v="ISSUE_LABELS_$n"; printf '{"number":%s,"state":"open","labels":%s}\n' "$n" "${!v:-[]}" ;;
  */labels*)             echo '[{"id":48,"name":"agent-blocked"}]' ;;
  */api/v1/repos/*)      echo '{"default_merge_style":"merge"}' ;;
  *) echo "fake curl: unhandled $url" >&2; exit 22 ;;
esac
SH
chmod +x "$tmp/bin/git" "$tmp/bin/curl"
export PATH="$tmp/bin:$PATH" FORGEJO_TOKEN=t FORGEJO_API="http://fj.test/api/v1/repos/Acme/widget"
export GIT_PUSHES="$tmp/pushes.log" CALLS_LOG="$tmp/calls.log" LANDING_NOTIFY="$tmp/notify.sh"
reset8() { : > "$GIT_PUSHES"; : > "$CALLS_LOG"; : > "$NOTIFY_LOG"; }
export ISSUE_LABELS_7='[{"name":"ready-for-agent"},{"name":"landing-pr"}]'
export ISSUE_LABELS_8='[{"name":"ready-for-agent"}]'
export ISSUE_LABELS_9='[{"name":"landing-squash"}]'

# shellcheck source=../landing-lib.sh
. "$sc/landing-lib.sh"
# shellcheck source=../runlog-lib.sh
. "$sc/runlog-lib.sh"
export SWARM_RUNLOG="$tmp/runlog"

# --- the resolvers -------------------------------------------------------------
SWARM_POLICY_LANDING=push SWARM_POLICY_MERGE_AUTHORITY=human
check "a landing-pr ticket resolves to pr in a push repo" '[ "$(landing_mode_for 7)" = pr ]'
check "an unlabelled ticket resolves to the repo default" '[ "$(landing_mode_for 8)" = push ]'
landing_mode_for 9 >/dev/null 2>&1; rc=$?
check "an unknown landing-* label is a refusal, never a silent default" '[ "$rc" -ne 0 ]'
API_DOWN=1 landing_mode_for 7 >/dev/null 2>&1; rc=$?
check "an unreadable ticket is a refusal — never a guess" '[ "$rc" -ne 0 ]'
reset8; SWARM_POLICY_LANDING=pr
check "a LANDING=pr repo answers pr" '[ "$(landing_mode_for 8)" = pr ]'
check "…without touching the tracker" '[ ! -s "$CALLS_LOG" ]'
SWARM_POLICY_LANDING=push

reset8
check "a human-authority repo answers human" '[ "$(landing_merge_authority_for 8)" = human ]'
check "…without touching the tracker" '[ ! -s "$CALLS_LOG" ]'
SWARM_POLICY_MERGE_AUTHORITY=agent-after-green
check "agent-after-green survives for an unlabelled ticket" '[ "$(landing_merge_authority_for 8)" = agent-after-green ]'
check "a landing-pr ticket is human-merged even under agent-after-green" '[ "$(landing_merge_authority_for 7)" = human ]'
check "an unreadable ticket fails CLOSED to human" '[ "$(API_DOWN=1 landing_merge_authority_for 7 2>/dev/null)" = human ]'

# --- landing_merge_if_green never merges a landing-pr ticket's PR ---------------
printf '%s\n' '[{"number":88,"head":{"ref":"agent/issue-7"}}]' > "$tmp/open7.json"
reset8
check "a green PR for a landing-pr ticket is NOT merged under agent-after-green" \
  '[ "$(OPEN_PULLS="$tmp/open7.json" landing_merge_if_green 7)" = not-authorized ] && ! grep -q "/merge" "$CALLS_LOG"'
SWARM_POLICY_MERGE_AUTHORITY=human

# --- landing_push per ticket ----------------------------------------------------
reset8; landing_push 8 >/dev/null 2>&1
check "an unlabelled ticket in a push repo still pushes main" 'grep -q "HEAD:refs/heads/main" "$GIT_PUSHES"'
reset8; out="$(landing_push 7 "fix (#7)" "**Screenshots:** none — nothing renders")"
check "a landing-pr ticket pushes agent/issue-7, never main" 'grep -q "HEAD:refs/heads/agent/issue-7" "$GIT_PUSHES" && ! grep -q "refs/heads/main" "$GIT_PUSHES"'
check "…and opens its PR" '[ "$out" = 101 ]'
reset8; LANDING_PUSH_REMOTE="https://x@fj.test/Acme/widget.git" landing_push 7 >/dev/null 2>&1
check "LANDING_PUSH_REMOTE replaces origin (the sandbox pushes by token URL)" 'grep -q "^push https://x@fj.test/Acme/widget.git HEAD:refs/heads/agent/issue-7" "$GIT_PUSHES"'
reset8; API_DOWN=1 landing_push 7 >/dev/null 2>&1; rc=$?
check "an unreadable ticket pushes NOTHING" '[ "$rc" -ne 0 ] && [ ! -s "$GIT_PUSHES" ]'

# --- the evidence gate ----------------------------------------------------------
PR_BODY_JSON='"closes #7\n\nfixed the rail foot"' ASSETS_JSON='[]' landing_evidence_gate 7 88 >"$tmp/ev.out"; rc=$?
check "no image and no waiver line -> missing (rc 1), with a reason" '[ "$rc" -eq 1 ] && grep -q "Screenshots" "$tmp/ev.out"'
PR_BODY_JSON='"closes #7"' ASSETS_JSON='[{"name":"after-rail-foot.png"}]' landing_evidence_gate 7 88 >/dev/null; rc=$?
check "one image asset on the PR satisfies the gate" '[ "$rc" -eq 0 ]'
PR_BODY_JSON='"closes #7"' ASSETS_JSON='[{"name":"trace.zip"}]' landing_evidence_gate 7 88 >/dev/null; rc=$?
check "a non-image asset does not" '[ "$rc" -eq 1 ]'
PR_BODY_JSON='"closes #7\n\n**Screenshots:** none — Go-side fix in the broker client, nothing renders\n"' ASSETS_JSON='[]' landing_evidence_gate 7 88 >/dev/null; rc=$?
check "the exact waiver line with a reason satisfies the gate" '[ "$rc" -eq 0 ]'
PR_BODY_JSON='"closes #7\n\n**Screenshots:** none — \n"' ASSETS_JSON='[]' landing_evidence_gate 7 88 >/dev/null; rc=$?
check "a waiver with an empty reason does not" '[ "$rc" -eq 1 ]'
PR_BODY_JSON='"closes #7\n\n**Screenshots:** none - hyphen, not the em dash\n"' ASSETS_JSON='[]' landing_evidence_gate 7 88 >/dev/null; rc=$?
check "a near-miss waiver (hyphen for the em dash) does not" '[ "$rc" -eq 1 ]'
API_DOWN=1 landing_evidence_gate 7 88 >/dev/null 2>&1; rc=$?
check "an unreadable PR is 'could not verify' (rc 2), distinct from missing" '[ "$rc" -eq 2 ]'

# --- landing_stage: a `pr <N>` run in a push repo --------------------------------
verdict_stage() { :; }
reset8; SWARM_RUN_LANDING="pr 7" SWARM_POLICY_LANDING=push
PR_BODY_JSON='"closes #7"' ASSETS_JSON='[{"name":"after.png"}]' OPEN_PULLS="$tmp/open7.json" \
  landing_stage Acme/widget '[{"number":7}]' startsha >/dev/null 2>&1; rc=$?
check "a pr-run lands on the ticket's branch and NEVER pushes main" \
  '[ "$rc" -eq 0 ] && grep -q "agent/issue-7" "$GIT_PUSHES" && ! grep -q "HEAD:main\|refs/heads/main" "$GIT_PUSHES"'
check "evidence present -> nothing is parked" '! grep -q LABELED "$CALLS_LOG"'
reset8
PR_BODY_JSON='"closes #7"' ASSETS_JSON='[]' OPEN_PULLS="$tmp/open7.json" \
  landing_stage Acme/widget '[{"number":7}]' startsha >/dev/null 2>&1
check "a bare PR left by a dead worker is parked agent-blocked host-side" 'grep -q LABELED "$CALLS_LOG"'

# --- landing_stage: the push-run guard -------------------------------------------
reset8; SWARM_RUN_LANDING=push
LOG_SUBJECTS="sandcastle: #8 ordinary work" landing_stage Acme/widget '[{"number":8}]' startsha >/dev/null 2>&1; rc=$?
check "a push run citing only push tickets lands on main as before" '[ "$rc" -eq 0 ] && grep -q "HEAD:main" "$GIT_PUSHES"'
reset8
LOG_SUBJECTS="sandcastle: #7 slipped into a push run" IS_ANCESTOR_RC=1 landing_stage Acme/widget '[{"number":8}]' startsha >/dev/null 2>&1; rc=$?
check "a push run whose commits cite a landing-pr ticket does NOT push main" '[ "$rc" -eq 1 ] && ! grep -q "HEAD:main" "$GIT_PUSHES"'
check "…it parks HEAD on a rescue branch and alarms" 'grep -q "sandcastle/rescue-" "$GIT_PUSHES" && grep -q "landing-pr" "$NOTIFY_LOG"'
check "…and names the exit reason" '[ "$SWARM_EXIT_REASON" = "pr-ticket-in-push-run" ]'
reset8
LOG_SUBJECTS="sandcastle: #7 slipped into a push run" API_DOWN=1 landing_stage Acme/widget '[{"number":8}]' startsha >/dev/null 2>&1
check "the guard fails OPEN when the tracker is unreadable (stranding closed work is worse; the tripwire catches a leak)" 'grep -q "HEAD:main" "$GIT_PUSHES"'
unset SWARM_RUN_LANDING

# --- claim-next-task.sh prints the claimed ticket's OWN landing ------------------
check "print_landing takes the ticket's landing, not only the repo's" \
  'grep -q "print_landing \"\$num\" \"\$(jq -r \".\[\$i\].landing // empty\" <<<\"\$ready\")\"" "$sc/claim-next-task.sh"'

echo "ticket-landing: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
