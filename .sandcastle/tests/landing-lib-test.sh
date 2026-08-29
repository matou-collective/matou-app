#!/usr/bin/env bash
# Offline tests for ../landing-lib.sh — the LANDING policy knob (#13, ADR 0002).
# No network, no real git remote: `git` and `curl` are shimmed. Proves the two
# landing modes and the ticket's acceptance:
#   - push mode (default): landing_push pushes HEAD:refs/heads/main, no PR calls;
#   - pr mode: a run pushes agent/issue-7 and opens ONE PR (closes #7); a SECOND
#     run finds that open PR and does NOT open a duplicate.
# Run: bash .sandcastle/tests/landing-lib-test.sh
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"

# git shim — record every `git push` argv line; everything else is a no-op.
cat > "$tmp/bin/git" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = push ]; then printf '%s\n' "$*" >> "$GIT_PUSHES"; fi
exit 0
SH
chmod +x "$tmp/bin/git"

# curl shim — the two Forgejo calls pr mode makes: GET /pulls?state=open (open
# PR set, from $OPEN_PULLS or empty) and POST /pulls (create, returns #101 and
# records the create). Every write body lands in $BODIES_LOG.
cat > "$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
set -u
url="" data="" method=GET prev=""
for a in "$@"; do
  [ "$prev" = -X ] && method="$a"
  [ "$prev" = -d ] && data="$a"
  prev="$a"
  case "$a" in http*) url="$a" ;; esac
done
[ -n "$data" ] && printf '%s\n' "$data" >> "$BODIES_LOG"
printf '%s %s\n' "$method" "$url" >> "$CALLS_LOG"
case "$url" in
  */pulls?state=open*) cat "${OPEN_PULLS:-/dev/null}" 2>/dev/null || echo '[]' ;;
  */pulls?state=closed*) cat "${CLOSED_PULLS:-/dev/null}" 2>/dev/null || echo '[]' ;;
  */pulls/*/merge)     echo "MERGED" >> "$CALLS_LOG"; echo "${MERGE_CODE:-200}" ;;
  */commits/*/status)  cat "${STATUS_JSON:-/dev/null}" 2>/dev/null || echo '{"state":"","statuses":[]}' ;;
  */pulls/[0-9]*)
    prn="${url##*/}"
    if [ "$method" = PATCH ]; then echo "PR_CLOSED $prn" >> "$CALLS_LOG"; echo 200
    else echo "{\"number\":$prn,\"head\":{\"ref\":\"agent/issue-7\",\"sha\":\"headsha\"},\"mergeable\":${PR_MERGEABLE:-true}}"; fi ;;
  */pulls)             echo "PR_CREATED" >> "$CALLS_LOG"; echo '{"number":101,"head":{"ref":"agent/issue-7"}}' ;;
  */issues/*/labels)   echo "LABELED" >> "$CALLS_LOG"; echo 201 ;;
  */issues/*/comments) echo 201 ;;
  */issues/[0-9]*)     echo "{\"labels\":${ISSUE_LABELS:-[]}}" ;;
  */labels*)           echo '[{"id":48,"name":"agent-blocked"}]' ;;
  */api/v1/repos/*)    echo '{"default_merge_style":"merge"}' ;;   # bare repo root — merge-style probe
  *) echo "fake curl: unhandled $url" >&2; exit 22 ;;
esac
SH
chmod +x "$tmp/bin/curl"

export PATH="$tmp/bin:$PATH"
export FORGEJO_TOKEN=t FORGEJO_API="http://fj.test/api/v1/repos/Matou/matou-app"
export GIT_PUSHES="$tmp/pushes.log" CALLS_LOG="$tmp/calls.log" BODIES_LOG="$tmp/bodies.log"
: > "$GIT_PUSHES"; : > "$CALLS_LOG"; : > "$BODIES_LOG"

# shellcheck source=../landing-lib.sh
. "$here/../landing-lib.sh"
# runlog helpers — landing_note_pr_opened (#114) writes a host runlog breadcrumb
# through them; sourced here as run-swarm.sh does in the live shell.
# shellcheck source=../runlog-lib.sh
. "$here/../runlog-lib.sh"

pass=0 fail=0
check() { if eval "$2"; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: $1"; fi; }
reset() { : > "$GIT_PUSHES"; : > "$CALLS_LOG"; : > "$BODIES_LOG"; }

# --- landing_branch_for / landing_pr_body — the pure primitives -------------
check "landing_branch_for is agent/issue-<N>" '[ "$(landing_branch_for 7)" = "agent/issue-7" ]'
check "landing_pr_body's first line is closes #<N>" \
  '[ "$(landing_pr_body 7 | head -1)" = "closes #7" ]'
check "landing_pr_body appends the extra body" \
  '[ "$(landing_pr_body 7 "did the thing" | tail -1)" = "did the thing" ]'

# --- push mode (default): HEAD:refs/heads/main, zero PR calls ----------------
reset
( unset SWARM_POLICY_LANDING; landing_push 7 ) >/dev/null
check "push mode pushes HEAD:refs/heads/main" \
  'grep -q "push origin HEAD:refs/heads/main" "$GIT_PUSHES"'
check "push mode never pushes an agent branch" \
  '! grep -q "agent/issue-7" "$GIT_PUSHES"'
check "push mode makes no Forgejo calls" '[ ! -s "$CALLS_LOG" ]'

# --- pr mode, first run: pushes agent/issue-7 and opens ONE PR (closes #7) ---
reset
export SWARM_POLICY_LANDING=pr
prnum="$( : > "$tmp/no-pulls.json"; OPEN_PULLS="$tmp/no-pulls.json" landing_push 7 "fix it (#7)" )"
check "pr mode first run pushes the agent/issue-7 branch" \
  'grep -q "push origin HEAD:refs/heads/agent/issue-7" "$GIT_PUSHES"'
check "pr mode first run opens a PR" 'grep -q "^PR_CREATED$" "$CALLS_LOG"'
check "pr mode first run returns the new PR number" '[ "$prnum" = "101" ]'
check "the opened PR body carries closes #7" 'grep -q "closes #7" "$BODIES_LOG"'
check "the opened PR is titled as given" 'grep -q "fix it (#7)" "$BODIES_LOG"'
check "exactly one create POST /pulls this run" \
  '[ "$(grep -c "^PR_CREATED$" "$CALLS_LOG")" = "1" ]'

# --- pr mode, second run: the PR is already open -> NO duplicate -------------
reset
printf '%s\n' '[{"number":101,"head":{"ref":"agent/issue-7"}}]' > "$tmp/open.json"
prnum="$(OPEN_PULLS="$tmp/open.json" landing_push 7 "fix it (#7)")"
check "pr mode second run still pushes the branch (refresh)" \
  'grep -q "push origin HEAD:refs/heads/agent/issue-7" "$GIT_PUSHES"'
check "pr mode second run opens NO duplicate PR" '! grep -q "^PR_CREATED$" "$CALLS_LOG"'
check "pr mode second run reports the existing PR number" '[ "$prnum" = "101" ]'

# landing_open_pr_for — exit 0 + number when open, exit 1 when none
check "landing_open_pr_for finds the open PR" \
  '[ "$(OPEN_PULLS=$tmp/open.json landing_open_pr_for 7)" = "101" ]'
check "landing_open_pr_for exits 1 when no PR is open" \
  '! OPEN_PULLS=$tmp/no-pulls.json landing_open_pr_for 7 >/dev/null'

# landing_merged_pr_for (#108) — only a MERGED PR from agent/issue-<N> counts;
# the newest wins; a closed-unmerged PR (abandoned branch) is ignored.
printf '%s\n' '[{"number":5,"head":{"ref":"agent/issue-7"},"merged":true},{"number":6,"head":{"ref":"agent/issue-7"},"merged":true},{"number":9,"head":{"ref":"agent/issue-7"},"merged":false},{"number":8,"head":{"ref":"agent/issue-8"},"merged":true}]' > "$tmp/closed.json"
check "landing_merged_pr_for finds the newest merged PR for the issue" \
  '[ "$(CLOSED_PULLS=$tmp/closed.json landing_merged_pr_for 7)" = "6" ]'
printf '%s\n' '[{"number":9,"head":{"ref":"agent/issue-7"},"merged":false}]' > "$tmp/closed-unmerged.json"
check "landing_merged_pr_for ignores a closed-but-unmerged PR" \
  '! CLOSED_PULLS=$tmp/closed-unmerged.json landing_merged_pr_for 7 >/dev/null'
check "landing_merged_pr_for exits 1 when nothing is merged" \
  '! CLOSED_PULLS=$tmp/no-pulls.json landing_merged_pr_for 7 >/dev/null'

# --- landing_reconcile — one "<N> <pr>" line per opened PR (run-swarm fan-out)
reset
out="$(OPEN_PULLS=$tmp/no-pulls.json landing_reconcile 7)"
check "landing_reconcile emits '<N> <pr>' for the opened PR" '[ "$out" = "7 101" ]'
check "landing_reconcile pushed the branch" \
  'grep -q "push origin HEAD:refs/heads/agent/issue-7" "$GIT_PUSHES"'

# ===========================================================================
# MERGE_AUTHORITY=agent-after-green — landing_merge_if_green (#15). An open PR
# #88 from agent/issue-7 exists; its combined status drives the outcome.
# ===========================================================================
printf '%s\n' '[{"number":88,"head":{"ref":"agent/issue-7"}}]' > "$tmp/open88.json"
printf '%s\n' '{"state":"success","statuses":[{"status":"success","context":"ci/build"}]}' > "$tmp/green.json"
printf '%s\n' '{"state":"pending","statuses":[{"status":"pending","context":"ci/build"}]}' > "$tmp/pending.json"
printf '%s\n' '{"state":"failure","statuses":[{"status":"success","context":"ci/lint"},{"status":"failure","context":"ci/test"}]}' > "$tmp/red.json"

# MERGE_AUTHORITY=human → never merges, whatever the checks say
reset
out="$( SWARM_POLICY_MERGE_AUTHORITY=human OPEN_PULLS=$tmp/open88.json STATUS_JSON=$tmp/green.json landing_merge_if_green 7 )"
check "human authority: landing_merge_if_green reports not-authorized" '[ "$out" = "not-authorized" ]'
check "human authority: no merge POST is made" '! grep -q "^MERGED$" "$CALLS_LOG"'

# agent-after-green + green → merged, one merge POST, no agent-blocked label
reset
out="$( SWARM_POLICY_MERGE_AUTHORITY=agent-after-green OPEN_PULLS=$tmp/open88.json STATUS_JSON=$tmp/green.json landing_merge_if_green 7 )"
check "green: landing_merge_if_green reports 'merged 88'" '[ "$out" = "merged 88" ]'
check "green: exactly one merge POST to the PR" '[ "$(grep -c "^MERGED$" "$CALLS_LOG")" = "1" ]'
check "green: the merge hits pulls/88/merge" 'grep -q "POST .*/pulls/88/merge" "$CALLS_LOG"'
check "green: no agent-blocked label is written" '! grep -q "^LABELED$" "$CALLS_LOG"'

# agent-after-green + pending → untouched, no merge, no label
reset
out="$( SWARM_POLICY_MERGE_AUTHORITY=agent-after-green OPEN_PULLS=$tmp/open88.json STATUS_JSON=$tmp/pending.json landing_merge_if_green 7 )"
check "pending: landing_merge_if_green reports pending" '[ "$out" = "pending" ]'
check "pending: the PR is left untouched (no merge)" '! grep -q "^MERGED$" "$CALLS_LOG"'
check "pending: nothing is parked agent-blocked" '! grep -q "^LABELED$" "$CALLS_LOG"'

# agent-after-green + failure → NOT merged, parked agent-blocked, failing check named
reset
out="$( SWARM_POLICY_MERGE_AUTHORITY=agent-after-green OPEN_PULLS=$tmp/open88.json STATUS_JSON=$tmp/red.json landing_merge_if_green 7 )"
check "failure: landing_merge_if_green reports 'blocked' + the failing check" '[ "$out" = "blocked ci/test" ]'
check "failure: the red PR is NOT merged" '! grep -q "^MERGED$" "$CALLS_LOG"'
check "failure: the issue is labelled agent-blocked" 'grep -q "^LABELED$" "$CALLS_LOG"'
check "failure: the agent-blocked label id (48) is the one POSTed" \
  'grep -q "\"labels\":\[48\]" "$BODIES_LOG"'

# agent-after-green + no open PR → no-pr, no merge
reset
out="$( SWARM_POLICY_MERGE_AUTHORITY=agent-after-green OPEN_PULLS=$tmp/no-pulls.json landing_merge_if_green 7 )"
check "no PR: landing_merge_if_green reports no-pr" '[ "$out" = "no-pr" ]'
check "no PR: no merge POST is made" '! grep -q "^MERGED$" "$CALLS_LOG"'

# --- landing_open_agent_issues — every open agent PR's issue number ----------
printf '%s\n' '[{"number":88,"head":{"ref":"agent/issue-7"}},{"number":90,"head":{"ref":"agent/issue-12"}},{"number":91,"head":{"ref":"feature/x"}}]' > "$tmp/mixed.json"
reset
out="$( OPEN_PULLS=$tmp/mixed.json landing_open_agent_issues | tr '\n' ' ' )"
check "landing_open_agent_issues lists only agent/issue-<N> PRs' numbers" '[ "$out" = "7 12 " ]'

# --- landing_merge_reconcile — fans merge-if-green over EVERY open agent PR --
reset
out="$( SWARM_POLICY_MERGE_AUTHORITY=agent-after-green OPEN_PULLS=$tmp/open88.json STATUS_JSON=$tmp/green.json landing_merge_reconcile )"
check "landing_merge_reconcile emits '<N> <result>' for the open agent PR" '[ "$out" = "7 merged 88" ]'
reset
out="$( SWARM_POLICY_MERGE_AUTHORITY=human OPEN_PULLS=$tmp/open88.json landing_merge_reconcile )"
check "landing_merge_reconcile is a no-op under MERGE_AUTHORITY=human" '[ -z "$out" ]'
check "human reconcile makes no merge POST" '! grep -q "^MERGED$" "$CALLS_LOG"'

# ===========================================================================
# #114 — the ORPHANED green agent PR deadlock. A worker SIGKILLed after opening
# its PR (before close-report) hides its issue from the ready list, so n==0 and
# landing_stage's reconcile never runs. landing_sweep_orphans is the idle-path
# sweep run-swarm.sh fires on the no-ready-tasks tick to break that deadlock.
# ===========================================================================

# --- landing_note_pr_opened: a provisional pr-opened runlog breadcrumb -------
reset
runlog="$tmp/runlog.txt"; : > "$runlog"
SWARM_RUNLOG="$runlog" landing_note_pr_opened Matou/coa "7,9" 1000
check "landing_note_pr_opened writes exactly ONE runlog line" '[ "$(wc -l < "$runlog")" = "1" ]'
check "the breadcrumb reason is pr-opened" 'grep -q "reason=pr-opened" "$runlog"'
check "the breadcrumb carries the repo + ready set" 'grep -q "repo=Matou/coa ready=\[7,9\]" "$runlog"'

# --- landing_issue_has_live_claim: the janitor-agreeing unclaimed predicate ---
reset
CLAIMED='[{"name":"agent-working"},{"name":"ready-for-agent"}]'
FREE='[{"name":"ready-for-agent"}]'
check "live claim: agent-working present -> rc 0 (leave the PR alone)" \
  'ISSUE_LABELS=$CLAIMED landing_issue_has_live_claim 7'
check "no claim: agent-working absent -> rc 1 (the sweep may act)" \
  '! ISSUE_LABELS=$FREE landing_issue_has_live_claim 7'

# open agent PR #88 (agent/issue-7); its combined status + claim state drive the sweep.
# --- landing_sweep_orphans -----------------------------------------------------
# no-op outside pr + agent-after-green (push-mode / human repos are untouched)
reset
out="$( SWARM_POLICY_LANDING=push SWARM_POLICY_MERGE_AUTHORITY=agent-after-green OPEN_PULLS=$tmp/open88.json landing_sweep_orphans )"
check "sweep is a no-op under push-mode" '[ -z "$out" ]'
out="$( SWARM_POLICY_LANDING=pr SWARM_POLICY_MERGE_AUTHORITY=human OPEN_PULLS=$tmp/open88.json landing_sweep_orphans )"
check "sweep is a no-op under MERGE_AUTHORITY=human" '[ -z "$out" ]'

# an issue that STILL carries a live claim (an in-flight worker) is left alone
reset
out="$( SWARM_POLICY_LANDING=pr SWARM_POLICY_MERGE_AUTHORITY=agent-after-green \
        OPEN_PULLS=$tmp/open88.json STATUS_JSON=$tmp/green.json \
        ISSUE_LABELS='[{"name":"agent-working"}]' landing_sweep_orphans )"
check "sweep SKIPS an issue with a live claim (no line emitted)" '[ -z "$out" ]'
check "sweep makes NO merge on a claimed issue" '! grep -q "^MERGED$" "$CALLS_LOG"'

# green + UNCLAIMED -> merged, and an audit comment records the missing close-report
reset
out="$( SWARM_POLICY_LANDING=pr SWARM_POLICY_MERGE_AUTHORITY=agent-after-green \
        OPEN_PULLS=$tmp/open88.json STATUS_JSON=$tmp/green.json \
        ISSUE_LABELS='[{"name":"ready-for-agent"}]' landing_sweep_orphans )"
check "sweep merges a green UNCLAIMED orphan PR" '[ "$out" = "7 merged 88" ]'
check "sweep POSTs the merge to pulls/88/merge" 'grep -q "POST .*/pulls/88/merge" "$CALLS_LOG"'
check "sweep leaves an audit comment naming the sweep" 'grep -q "idle landing sweep (#114)" "$BODIES_LOG"'

# green but DRIFTED (merge POST fails, PR no longer mergeable) -> close the PR so #N re-arms
reset
out="$( SWARM_POLICY_LANDING=pr SWARM_POLICY_MERGE_AUTHORITY=agent-after-green \
        OPEN_PULLS=$tmp/open88.json STATUS_JSON=$tmp/green.json MERGE_CODE=405 PR_MERGEABLE=false \
        ISSUE_LABELS='[{"name":"ready-for-agent"}]' landing_sweep_orphans )"
check "sweep reports closed-drifted for a green-but-unmergeable PR" '[ "$out" = "7 closed-drifted 88" ]'
check "sweep PATCH-closes the drifted PR #88" 'grep -q "PR_CLOSED 88" "$CALLS_LOG"'
check "the drift-close comment names the re-arm" 'grep -q "re-arms for a fresh worker" "$BODIES_LOG"'

# a TRANSIENT merge failure (branch still mergeable) is NOT closed — retried next tick
reset
out="$( SWARM_POLICY_LANDING=pr SWARM_POLICY_MERGE_AUTHORITY=agent-after-green \
        OPEN_PULLS=$tmp/open88.json STATUS_JSON=$tmp/green.json MERGE_CODE=500 PR_MERGEABLE=true \
        ISSUE_LABELS='[{"name":"ready-for-agent"}]' landing_sweep_orphans )"
check "a transient merge failure (still mergeable) is left as merge-failed" '[ "$out" = "7 merge-failed 88 500" ]'
check "no PR close on a transient merge failure" '! grep -q "PR_CLOSED" "$CALLS_LOG"'

# a PENDING unclaimed PR still emits a line — so the caller knows work exists and
# never reports no-ready-tasks while an unclaimed open agent PR is around
reset
out="$( SWARM_POLICY_LANDING=pr SWARM_POLICY_MERGE_AUTHORITY=agent-after-green \
        OPEN_PULLS=$tmp/open88.json STATUS_JSON=$tmp/pending.json \
        ISSUE_LABELS='[{"name":"ready-for-agent"}]' landing_sweep_orphans )"
check "sweep emits a line for a PENDING unclaimed PR (work still exists)" '[ "$out" = "7 pending" ]'
check "sweep makes no merge on a pending PR" '! grep -q "^MERGED$" "$CALLS_LOG"'

echo "landing-lib: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
