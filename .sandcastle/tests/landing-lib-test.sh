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

# git shim — record every `git push` argv line; the rebase-rescue ladder (#207)
# drives rebase/push/merge-base outcomes off env knobs; everything else is a
# benign no-op (fetch, add, status, rebase --abort).
cat > "$tmp/bin/git" <<'SH'
#!/usr/bin/env bash
case "${1:-}" in
  push)
    printf '%s\n' "$*" >> "$GIT_PUSHES"
    case "$*" in
      *HEAD:main|*HEAD:refs/heads/main) exit "${MAIN_PUSH_RC:-0}" ;;   # clean push / initial attempt
      *refs/heads/sandcastle/rescue-*)  exit "${RESCUE_PUSH_RC:-0}" ;; # the park/PR branch push
      *) exit 0 ;;                                                     # agent/issue-<N>, …
    esac ;;
  # the empty-shell guard's probe (matou-app#145): $AHEAD commits beyond main
  rev-list)   printf '%s\n' "${AHEAD:-1}"; exit 0 ;;
  rebase)     [ "${2:-}" = --abort ] && exit 0; exit "${REBASE_RC:-0}" ;;  # conflict iff REBASE_RC!=0
  merge-base) exit "${ANCESTOR_RC:-1}" ;;        # --is-ancestor: default NOT an ancestor (HEAD ahead)
  rev-parse)  echo "deadbee"; exit 0 ;;
  diff)       printf '%s' "${DIFF_OUT:-}"; exit 0 ;;
  *)          exit 0 ;;
esac
SH
chmod +x "$tmp/bin/git"

# claude shim — the rebase resolver (#207). Record its argv (so the test proves
# the allowlist and the dropped --dangerously-skip-permissions) and, when asked,
# print a usage-limit/auth refusal line that landing_resolve_classified reads.
cat > "$tmp/bin/claude" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${CLAUDE_ARGV:-/dev/null}"
[ -n "${CLAUDE_REFUSAL:-}" ] && printf '%s\n' "$CLAUDE_REFUSAL"
exit 0
SH
chmod +x "$tmp/bin/claude"

# notify shim — capture every landing alert instead of posting it.
cat > "$tmp/bin/notify" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$1" >> "$NOTIFY_LOG"
exit 0
SH
chmod +x "$tmp/bin/notify"

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
  */issues/*/comments)
    # GET -> the PR's comment set (for the gates-passed marker check, #206),
    # from $PR_COMMENTS or empty; POST (a write) -> 201.
    if [ "$method" = GET ]; then cat "${PR_COMMENTS:-/dev/null}" 2>/dev/null || echo '[]'
    else echo 201; fi ;;
  */issues/[0-9]*)     echo "{\"labels\":${ISSUE_LABELS:-[]},\"state\":\"${ISSUE_STATE:-open}\"}" ;;
  */labels*)           echo "$LABELS_JSON" ;;
  */api/v1/repos/*)    echo '{"default_merge_style":"merge"}' ;;   # bare repo root — merge-style probe
  *) echo "fake curl: unhandled $url" >&2; exit 22 ;;
esac
SH
chmod +x "$tmp/bin/curl"

export PATH="$tmp/bin:$PATH"
export FORGEJO_TOKEN=t FORGEJO_API="http://fj.test/api/v1/repos/Matou/matou-app"
export GIT_PUSHES="$tmp/pushes.log" CALLS_LOG="$tmp/calls.log" BODIES_LOG="$tmp/bodies.log"
# #207: route every landing alert to the notify shim (read at call time by
# _landing_notify) rather than Mattermost; captured in $NOTIFY_LOG.
export LANDING_NOTIFY="$tmp/bin/notify" NOTIFY_LOG="$tmp/notify.log" CLAUDE_ARGV="$tmp/argv.log"
# The tracker's label set the curl shim serves (#114 blocked path reads id 48;
# the #283 reconcile overrides it to add ready-for-session). Default here so the
# single-quoted JSON keeps its real double quotes (a `<<'SH'` heredoc would turn
# any escaped quote literal).
export LABELS_JSON='[{"id":48,"name":"agent-blocked"}]'
: > "$GIT_PUSHES"; : > "$CALLS_LOG"; : > "$BODIES_LOG"; : > "$NOTIFY_LOG"; : > "$CLAUDE_ARGV"

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
# idss ADR 0267: landing is resolved PER TICKET, so a push-default repo reads the
# ticket's labels once (is it `landing-pr`?) — that ONE GET is the feature. It
# still opens no PR and writes nothing.
check "push mode makes exactly one Forgejo call — the ticket's label read — and no write" \
  '[ "$(wc -l < "$CALLS_LOG")" -eq 1 ] && grep -q "^GET .*/issues/7$" "$CALLS_LOG"'

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

# --- pr mode, empty-shell guard (matou-app#145): HEAD==main -> no push, no PR
reset
rc=0; AHEAD=0 OPEN_PULLS="$tmp/no-pulls.json" landing_push 7 "fix it (#7)" >/dev/null 2>"$tmp/guard.err" || rc=$?
check "empty-shell guard refuses to push a workless branch" '[ ! -s "$GIT_PUSHES" ]'
check "empty-shell guard opens NO PR" '! grep -q "^PR_CREATED$" "$CALLS_LOG"'
check "empty-shell guard fails the call (rc=1)" '[ "$rc" = 1 ]'
check "empty-shell guard names the branch and the tracker issue" \
  'grep -q "agent/issue-7" "$tmp/guard.err" && grep -q "matou-app#145" "$tmp/guard.err"'
# fail-open: an unanswerable rev-list (no origin/main) must NOT block a landing
reset
prnum="$(AHEAD="" OPEN_PULLS="$tmp/no-pulls.json" landing_push 7 "fix it (#7)")"
check "guard fails open when rev-list cannot answer" '[ "$prnum" = "101" ]'
# push mode is untouched by the guard (HEAD:main has its own rescue ladder)
reset
( unset SWARM_POLICY_LANDING; AHEAD=0 landing_push 7 ) >/dev/null
check "push mode ignores the empty-shell guard" \
  'grep -q "push origin HEAD:refs/heads/main" "$GIT_PUSHES"'

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

# landing_superseded_by_pr_for (#151) — a multi-host race winner merged the work
# on a branch OTHER than agent/issue-<N>, and its `closes #N` closed the issue.
# The loser reads it to self-close as superseded. It fires ONLY when the issue is
# closed AND a merged non-agent PR with a `closes #N` ref exists.
printf '%s\n' '[{"number":70,"head":{"ref":"sandcastle/worker/x"},"merged":true,"body":"closes #7\nfix"},{"number":71,"head":{"ref":"agent/issue-7"},"merged":true,"body":"closes #7"},{"number":72,"head":{"ref":"other"},"merged":false,"body":"closes #7"}]' > "$tmp/race.json"
check "landing_superseded_by_pr_for returns the winner's non-agent PR when the issue is closed" \
  '[ "$(ISSUE_STATE=closed CLOSED_PULLS=$tmp/race.json landing_superseded_by_pr_for 7)" = "70" ]'
check "landing_superseded_by_pr_for exits 1 while the issue is still OPEN (no self-close of live work)" \
  '! ISSUE_STATE=open CLOSED_PULLS=$tmp/race.json landing_superseded_by_pr_for 7 >/dev/null'
check "landing_superseded_by_pr_for exits 1 when only the OWN agent PR merged (that is the #108 path)" \
  '! ISSUE_STATE=closed CLOSED_PULLS=$tmp/closed.json landing_superseded_by_pr_for 7 >/dev/null'
# a PR that merely MENTIONS a longer number must not match (#28 vs #280) and a
# non-closing mention must not match either
printf '%s\n' '[{"number":73,"head":{"ref":"z"},"merged":true,"body":"see #70 for context"},{"number":74,"head":{"ref":"y"},"merged":true,"body":"mentions #700 only"}]' > "$tmp/race-nomatch.json"
check "landing_superseded_by_pr_for ignores a non-closing mention / a longer number" \
  '! ISSUE_STATE=closed CLOSED_PULLS=$tmp/race-nomatch.json landing_superseded_by_pr_for 70 >/dev/null'

# forgejo_closing_merged_pr (#151) — the raw lookup: newest merged PR whose body
# carries a `closes #N` ref, excluding the caller's agent branch.
check "forgejo_closing_merged_pr finds the merged non-agent closing PR" \
  '[ "$(CLOSED_PULLS=$tmp/race.json forgejo_closing_merged_pr 7 agent/issue-7)" = "70" ]'
check "forgejo_closing_merged_pr excludes the named agent branch" \
  '[ "$(CLOSED_PULLS=$tmp/race.json forgejo_closing_merged_pr 7 sandcastle/worker/x)" = "71" ]'

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
# #206: an agent merge requires close-report's gates-passed marker on the PR.
# $marked carries it (fence-aware HTML comment); $unmarked is a PR with ordinary
# comments but no marker (an orphan whose worker never ran a verified close-report).
printf '%s\n' '[{"body":"<!-- close-report: gates-passed --> cleared to merge"}]' > "$tmp/marked.json"
printf '%s\n' '[{"body":"just a normal review note"}]' > "$tmp/unmarked.json"

# MERGE_AUTHORITY=human → never merges, whatever the checks say
reset
out="$( SWARM_POLICY_MERGE_AUTHORITY=human OPEN_PULLS=$tmp/open88.json STATUS_JSON=$tmp/green.json landing_merge_if_green 7 )"
check "human authority: landing_merge_if_green reports not-authorized" '[ "$out" = "not-authorized" ]'
check "human authority: no merge POST is made" '! grep -q "^MERGED$" "$CALLS_LOG"'

# agent-after-green + green + gates-passed marker → merged, one merge POST, no label
reset
out="$( SWARM_POLICY_MERGE_AUTHORITY=agent-after-green OPEN_PULLS=$tmp/open88.json STATUS_JSON=$tmp/green.json PR_COMMENTS=$tmp/marked.json landing_merge_if_green 7 )"
check "green + marker: landing_merge_if_green reports 'merged 88'" '[ "$out" = "merged 88" ]'
check "green + marker: exactly one merge POST to the PR" '[ "$(grep -c "^MERGED$" "$CALLS_LOG")" = "1" ]'
check "green + marker: the merge hits pulls/88/merge" 'grep -q "POST .*/pulls/88/merge" "$CALLS_LOG"'
check "green + marker: no agent-blocked label is written" '! grep -q "^LABELED$" "$CALLS_LOG"'

# agent-after-green + green but NO gates-passed marker → NOT merged (#206 acceptance)
reset
out="$( SWARM_POLICY_MERGE_AUTHORITY=agent-after-green OPEN_PULLS=$tmp/open88.json STATUS_JSON=$tmp/green.json PR_COMMENTS=$tmp/unmarked.json landing_merge_if_green 7 )"
check "green, no marker: reports no-close-report" '[ "$out" = "no-close-report" ]'
check "green, no marker: the PR is NOT merged" '! grep -q "^MERGED$" "$CALLS_LOG"'
# with no comments at all (the GET returns []) the same holds — fail closed
reset
out="$( SWARM_POLICY_MERGE_AUTHORITY=agent-after-green OPEN_PULLS=$tmp/open88.json STATUS_JSON=$tmp/green.json landing_merge_if_green 7 )"
check "green, no comments: fails closed to no-close-report" '[ "$out" = "no-close-report" ]'
check "green, no comments: no merge POST" '! grep -q "^MERGED$" "$CALLS_LOG"'

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
out="$( SWARM_POLICY_MERGE_AUTHORITY=agent-after-green OPEN_PULLS=$tmp/open88.json STATUS_JSON=$tmp/green.json PR_COMMENTS=$tmp/marked.json landing_merge_reconcile )"
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

# green + UNCLAIMED but NO gates-passed marker (the orphan whose worker was
# killed before close-report) -> NOT merged (#206). The sweep still emits a line
# so the caller knows work exists, but a bare green orphan is never auto-merged.
reset
out="$( SWARM_POLICY_LANDING=pr SWARM_POLICY_MERGE_AUTHORITY=agent-after-green \
        OPEN_PULLS=$tmp/open88.json STATUS_JSON=$tmp/green.json PR_COMMENTS=$tmp/unmarked.json \
        ISSUE_LABELS='[{"name":"ready-for-agent"}]' landing_sweep_orphans )"
check "sweep does NOT merge a green orphan lacking the gates-passed marker" '[ "$out" = "7 no-close-report" ]'
check "sweep makes NO merge POST on an unmarked orphan" '! grep -q "^MERGED$" "$CALLS_LOG"'

# green + UNCLAIMED + gates-passed marker -> merged (a verified PR whose merge was
# left for a later pass), with an audit comment naming the sweep
reset
out="$( SWARM_POLICY_LANDING=pr SWARM_POLICY_MERGE_AUTHORITY=agent-after-green \
        OPEN_PULLS=$tmp/open88.json STATUS_JSON=$tmp/green.json PR_COMMENTS=$tmp/marked.json \
        ISSUE_LABELS='[{"name":"ready-for-agent"}]' landing_sweep_orphans )"
check "sweep merges a green marked UNCLAIMED PR" '[ "$out" = "7 merged 88" ]'
check "sweep POSTs the merge to pulls/88/merge" 'grep -q "POST .*/pulls/88/merge" "$CALLS_LOG"'
check "sweep leaves an audit comment naming the sweep" 'grep -q "idle landing sweep (#114)" "$BODIES_LOG"'

# green + marked but DRIFTED (merge POST fails, PR no longer mergeable) -> close the PR so #N re-arms
reset
out="$( SWARM_POLICY_LANDING=pr SWARM_POLICY_MERGE_AUTHORITY=agent-after-green \
        OPEN_PULLS=$tmp/open88.json STATUS_JSON=$tmp/green.json PR_COMMENTS=$tmp/marked.json MERGE_CODE=405 PR_MERGEABLE=false \
        ISSUE_LABELS='[{"name":"ready-for-agent"}]' landing_sweep_orphans )"
check "sweep reports closed-drifted for a green-but-unmergeable PR" '[ "$out" = "7 closed-drifted 88" ]'
check "sweep PATCH-closes the drifted PR #88" 'grep -q "PR_CLOSED 88" "$CALLS_LOG"'
check "the drift-close comment names the re-arm" 'grep -q "re-arms for a fresh worker" "$BODIES_LOG"'

# a TRANSIENT merge failure (branch still mergeable) is NOT closed — retried next tick
reset
out="$( SWARM_POLICY_LANDING=pr SWARM_POLICY_MERGE_AUTHORITY=agent-after-green \
        OPEN_PULLS=$tmp/open88.json STATUS_JSON=$tmp/green.json PR_COMMENTS=$tmp/marked.json MERGE_CODE=500 PR_MERGEABLE=true \
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

# ===========================================================================
# #207 — the push-mode rebase-conflict ladder (landing_push_main_with_rescue). A
# conflict-resolved HEAD must NEVER go straight to main: re-test on the pinned
# suite, route GREEN → a rescue PR, RED → a park; a limit/auth refusal defers
# quietly. push / rebase / claude / notify are all shimmed.
# ===========================================================================
# A drivable completion seam for the resolver: $REBASE_IN_PROGRESS says whether
# the headless claude actually finished the rebase.
landing_rebase_in_progress() { [ "${REBASE_IN_PROGRESS:-}" = 1 ]; }
clear207() { : > "$GIT_PUSHES"; : > "$CALLS_LOG"; : > "$BODIES_LOG"; : > "$NOTIFY_LOG"; : > "$CLAUDE_ARGV"; }

# --- clean push: the first push to main succeeds -> lands, no rebase, no claude
clear207
rc=0; ( MAIN_PUSH_RC=0 landing_push_main_with_rescue coa ) >/dev/null 2>&1 || rc=$?
check "#207 clean push lands HEAD on main (rc 0)" '[ "$rc" = 0 ]'
check "#207 clean push pushes HEAD:main" 'grep -q "push origin HEAD:main" "$GIT_PUSHES"'
check "#207 clean push invokes no resolver, parks nothing, opens no PR" \
  '[ ! -s "$CLAUDE_ARGV" ] && ! grep -q "rescue-" "$GIT_PUSHES" && ! grep -q "^PR_CREATED$" "$CALLS_LOG"'

# --- conflict -> PR: push-to-main fails, rebase conflicts, claude resolves, GREEN
clear207
rc=0; ( MAIN_PUSH_RC=1 REBASE_RC=1 REBASE_IN_PROGRESS=0 LANDING_TEST_CMD=true \
        OPEN_PULLS="$tmp/no-pulls.json" landing_push_main_with_rescue coa ) >/dev/null 2>&1 || rc=$?
check "#207 conflict+green opens a rescue PR" 'grep -q "^PR_CREATED$" "$CALLS_LOG"'
check "#207 conflict+green pushes the rescue branch" \
  'grep -q "push origin HEAD:refs/heads/sandcastle/rescue-" "$GIT_PUSHES"'
check "#207 conflict+green NEVER pushes the conflict HEAD to main (only the initial failed attempt)" \
  '[ "$(grep -c "push origin HEAD:main" "$GIT_PUSHES")" = "1" ]'
check "#207 conflict+green's PR carries the #207 rescue title" 'grep -q "Rebase-conflict rescue" "$BODIES_LOG"'
check "#207 conflict+green notifies the PR route" 'grep -q "resolved → PR" "$NOTIFY_LOG"'
check "#207 conflict+green fails the land so main is untouched (rc 1)" '[ "$rc" = 1 ]'

# --- conflict + RED tests -> parked on rescue, paged, NOT pushed, NO PR
clear207
rc=0; ( MAIN_PUSH_RC=1 REBASE_RC=1 REBASE_IN_PROGRESS=0 LANDING_TEST_CMD=false \
        landing_push_main_with_rescue coa ) >/dev/null 2>&1 || rc=$?
check "#207 conflict+red parks on a rescue branch" \
  'grep -q "push origin HEAD:refs/heads/sandcastle/rescue-" "$GIT_PUSHES"'
check "#207 conflict+red opens NO PR" '! grep -q "^PR_CREATED$" "$CALLS_LOG"'
check "#207 conflict+red never pushes the resolved HEAD to main" \
  '[ "$(grep -c "push origin HEAD:main" "$GIT_PUSHES")" = "1" ]'
check "#207 conflict+red pages a FAILED re-test" 'grep -q "FAILED its re-test" "$NOTIFY_LOG"'
check "#207 conflict+red fails the land (rc 1)" '[ "$rc" = 1 ]'

# --- limit refusal -> quiet DEFER, nothing pushed, no PR, no rescue branch
clear207
rc=0; ( MAIN_PUSH_RC=1 REBASE_RC=1 REBASE_IN_PROGRESS=1 \
        CLAUDE_REFUSAL="You've hit your weekly limit · resets Aug 1" \
        landing_push_main_with_rescue coa ) >/dev/null 2>&1 || rc=$?
check "#207 limit refusal pushes nothing to main beyond the initial attempt" \
  '[ "$(grep -c "push origin HEAD:main" "$GIT_PUSHES")" = "1" ]'
check "#207 limit refusal parks on NO rescue branch (defer, not a page)" '! grep -q "rescue-" "$GIT_PUSHES"'
check "#207 limit refusal opens no PR" '! grep -q "^PR_CREATED$" "$CALLS_LOG"'
check "#207 limit refusal defers quietly (hourglass, never a rotating_light page)" \
  'grep -q "deferred — Claude usage limit" "$NOTIFY_LOG" && ! grep -q "rotating_light" "$NOTIFY_LOG"'
check "#207 limit refusal fails the land (rc 1)" '[ "$rc" = 1 ]'

# --- no pinned test command -> cannot verify -> park, never land (fail closed)
clear207
rc=0; ( MAIN_PUSH_RC=1 REBASE_RC=1 REBASE_IN_PROGRESS=0 landing_push_main_with_rescue coa ) >/dev/null 2>&1 || rc=$?
check "#207 unset LANDING_TEST_CMD parks on a rescue branch, never main (fail closed)" \
  'grep -q "push origin HEAD:refs/heads/sandcastle/rescue-" "$GIT_PUSHES" && [ "$(grep -c "push origin HEAD:main" "$GIT_PUSHES")" = "1" ]'
check "#207 unset LANDING_TEST_CMD opens no PR" '! grep -q "^PR_CREATED$" "$CALLS_LOG"'

# --- resolver ran but could NOT finish the rebase (not a limit) -> honest park
clear207
rc=0; ( MAIN_PUSH_RC=1 REBASE_RC=1 REBASE_IN_PROGRESS=1 ANCESTOR_RC=1 \
        landing_push_main_with_rescue coa ) >/dev/null 2>&1 || rc=$?
check "#207 resolver-failed falls through to the honest rescue park" \
  'grep -q "push origin HEAD:refs/heads/sandcastle/rescue-" "$GIT_PUSHES"'
check "#207 resolver-failed opens no PR, never pushes the HEAD to main" \
  '! grep -q "^PR_CREATED$" "$CALLS_LOG" && [ "$(grep -c "push origin HEAD:main" "$GIT_PUSHES")" = "1" ]'
check "#207 resolver-failed fails the land (rc 1)" '[ "$rc" = 1 ]'

# --- the resolver's invocation: a bounded allowlist, NO --dangerously-skip-permissions
check "#207 resolver passes --allowedTools" 'grep -q -- "--allowedTools" "$CLAUDE_ARGV"'
check "#207 resolver passes --permission-mode acceptEdits" 'grep -q -- "--permission-mode acceptEdits" "$CLAUDE_ARGV"'
check "#207 resolver NEVER passes --dangerously-skip-permissions" \
  '! grep -q "dangerously-skip-permissions" "$CLAUDE_ARGV"'

# ===========================================================================
# #193 — the push-mode HOST-LAND boundary. The worker pushes a per-run worker
# branch; the HOST promotes it to main ONLY after verify. When verify flagged a
# protected-path breach (VERIFY_PP_VIOLATION=1), the land seam must NOT push main
# — it parks HEAD on a rescue branch and reds the run. git/push/notify shimmed.
# landing_stage calls verdict_stage (verdict-lib is NOT sourced here); no-op it.
# ===========================================================================
verdict_stage() { :; }
clear207; SWARM_EXIT_REASON=""; rc=0
VERIFY_PP_VIOLATION=1 SWARM_POLICY_LANDING=push landing_stage coa '[{"number":7}]' start >/dev/null 2>&1 || rc=$?
check "#193 breach: the land seam fails the run (rc 1)" '[ "$rc" = 1 ]'
check "#193 breach: NOTHING is pushed to main" '! grep -q "push origin HEAD:main" "$GIT_PUSHES"'
check "#193 breach: the worker's commits are PARKED on a rescue branch (never lost)" \
  'grep -q "push origin HEAD:refs/heads/sandcastle/rescue-" "$GIT_PUSHES"'
check "#193 breach: the exit reason names the protected-path violation" \
  '[ "$SWARM_EXIT_REASON" = "protected-path-violation" ]'
check "#193 breach: the refusal alarms so a human triages" 'grep -q "did NOT land" "$NOTIFY_LOG"'
# no breach flagged -> the guard is transparent (a clean push-mode land proceeds)
clear207; SWARM_EXIT_REASON=""
VERIFY_PP_VIOLATION="" SWARM_POLICY_LANDING=push MAIN_PUSH_RC=0 \
  landing_stage coa '[{"number":7}]' start >/dev/null 2>&1 || true
check "#193 no breach: the land seam pushes HEAD to main as usual" \
  'grep -q "push origin HEAD:main" "$GIT_PUSHES"'
check "#193 no breach: no rescue branch is parked on a clean land" \
  '! grep -q "refs/heads/sandcastle/rescue-" "$GIT_PUSHES"'

# ===========================================================================
# #283 — the false-green reconcile. A push-mode close-report closes its issue
# against the PUSHED worker branch INSIDE the sandbox, before the HOST lands main.
# When the host's land rolls back (a protected-path breach, a push that parked),
# main never carries the commits yet the issue reads `closed` with a success
# comment. landing_reopen_stranded_closes must REOPEN only the genuinely stranded
# close (commits NOT on main) and only while it still reads `closed`. git/curl
# shimmed; merge-base --is-ancestor exits ANCESTOR_RC (default 1 = NOT on main).
# ===========================================================================
reopen_setup() { # reopen_setup — a fresh attempts file + the ready-for-session label on the tracker
  reset
  export LABELS_JSON='[{"id":48,"name":"agent-blocked"},{"id":70,"name":"ready-for-session"}]'
  ATTEMPTS="$tmp/attempts.log"
}

# stranded: commits NOT on main (ANCESTOR_RC=1) AND the issue reads closed ->
# reopen (PATCH state:open), relabel ready-for-session, comment, echo "<N> reopened".
reopen_setup
printf 'SANDCASTLE_ATTEMPT issue=444 outcome=success commits=deadbee\n' > "$ATTEMPTS"
out="$(ISSUE_STATE=closed ANCESTOR_RC=1 SWARM_EXIT_REASON=protected-path-violation \
  landing_reopen_stranded_closes "$ATTEMPTS" coa origin/main 2>/dev/null)"
check "#283 stranded close reopens its issue (PATCH state:open)" \
  'grep -qE "PATCH .*/issues/444$" "$CALLS_LOG"'
check "#283 the reopen PATCH body carries state:open" \
  'grep -q "\"state\":\"open\"" "$BODIES_LOG"'
check "#283 the reopened issue is relabelled ready-for-session" \
  'grep -q "^LABELED$" "$CALLS_LOG" && grep -q "\"labels\":\[70\]" "$BODIES_LOG"'
check "#283 the reopen comment names the false-green seam and the stranded commit" \
  'grep -q "did NOT land" "$BODIES_LOG" && grep -q "deadbee" "$BODIES_LOG"'
check "#283 the reconcile echoes the reopened issue" '[ "$out" = "444 reopened" ]'

# landed: the SAME closed issue but its commits ARE on main (ANCESTOR_RC=0) ->
# the close genuinely landed, so it is LEFT closed (no reopen, no echo).
reopen_setup
printf 'SANDCASTLE_ATTEMPT issue=444 outcome=success commits=deadbee\n' > "$ATTEMPTS"
out="$(ISSUE_STATE=closed ANCESTOR_RC=0 landing_reopen_stranded_closes "$ATTEMPTS" coa origin/main 2>/dev/null)"
check "#283 a close whose commits landed on main is NOT reopened" \
  '! grep -qE "PATCH .*/issues/444$" "$CALLS_LOG" && [ -z "$out" ]'

# already open: stranded commits but the issue is not closed -> never re-PATCH.
reopen_setup
printf 'SANDCASTLE_ATTEMPT issue=444 outcome=success commits=deadbee\n' > "$ATTEMPTS"
out="$(ISSUE_STATE=open ANCESTOR_RC=1 landing_reopen_stranded_closes "$ATTEMPTS" coa origin/main 2>/dev/null)"
check "#283 an already-open issue is left untouched" \
  '! grep -qE "PATCH .*/issues/444$" "$CALLS_LOG" && [ -z "$out" ]'

# a non-success attempt (refused/parked) is never reopened.
reopen_setup
printf 'SANDCASTLE_ATTEMPT issue=444 outcome=refused commits=deadbee\n' > "$ATTEMPTS"
out="$(ISSUE_STATE=closed ANCESTOR_RC=1 landing_reopen_stranded_closes "$ATTEMPTS" coa origin/main 2>/dev/null)"
check "#283 a non-success attempt line is ignored" \
  '! grep -qE "PATCH .*/issues/444$" "$CALLS_LOG" && [ -z "$out" ]'

# an absent/empty attempts file -> a clean no-op, rc 0.
reset; rc=0
landing_reopen_stranded_closes "$tmp/does-not-exist" coa origin/main >/dev/null 2>&1 || rc=$?
check "#283 an absent attempts file is a clean no-op (rc 0)" '[ "$rc" = 0 ]'
unset LABELS_JSON

echo "landing-lib: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
