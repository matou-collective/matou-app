#!/usr/bin/env bash
# Scenario test for ../close-report.sh against the fake Forgejo (fakebin/curl).
# No network. Proves the wrapper's disposition:
#   - the envelope lands on the issue as a comment in EVERY outcome (#444 AC), and
#   - the issue is PATCHed closed ONLY when the claim gates pass.
# The claim gates themselves are exercised offline in close-report-lib-test.sh;
# here we assert the network-facing behaviour ("code disposes").
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$here/fakebin:$PATH"
export FORGEJO_TOKEN="ftok"
export FORGEJO_API="http://fj.test/api/v1/repos/Matou/idss"

pass=0
fail() { echo "FAIL: $1" >&2; exit 1; }
ok()   { pass=$((pass + 1)); }

# --- a throwaway repo with one real commit on main -------------------------
repo="$(mktemp -d)"; trap 'rm -rf "$repo" "$FAKE_DIR"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
git -C "$repo" init -q -b main
printf 'a\n' > "$repo/src.go"; git -C "$repo" add -A; git -C "$repo" commit -qm c1
c1="$(git -C "$repo" rev-parse HEAD)"
export CR_MAIN_HEAD=main

run_close() { # run_close <issue> <envelope-json> [close-fail-code]; sets rc + fresh FAKE_DIR
  FAKE_DIR="$(mktemp -d)"; export FAKE_DIR
  # The claim labels the verified-close path releases (#22), resolved by NAME.
  printf '[{"id":36,"name":"ready-for-agent"},{"id":40,"name":"agent-working"}]\n' \
    > "$FAKE_DIR/labels.json"
  # A third arg makes the fake curl 403 (or the given code) the close PATCH —
  # the #20 seam: gates pass but the bot cannot write issue state.
  [ -n "${3:-}" ] && printf '%s' "$3" > "$FAKE_DIR/close-fail"
  # A fourth arg makes the label-release DELETEs 4xx (#22 seam): a failed
  # release must warn, never change the exit code.
  [ -n "${4:-}" ] && printf '%s' "$4" > "$FAKE_DIR/label-delete-fail"
  local ef="$FAKE_DIR/envelope.json"; printf '%s' "$2" > "$ef"
  ( cd "$repo" && bash "$here/../close-report.sh" "$1" "$ef" ) >"$FAKE_DIR/stdout.log" 2>&1
}

posted_comment() { grep -q '"body"' "$FAKE_DIR/forgejo.log" 2>/dev/null; }
closed_issue()   { grep -q '"state":"closed"' "$FAKE_DIR/forgejo.log" 2>/dev/null; }
# close_stuck: the issue VERIFIABLY reads closed (the fake flips it only on a
# PATCH that was not 403'd), as opposed to closed_issue() which merely proves a
# close PATCH was attempted.
close_stuck()    { [ -f "$FAKE_DIR/closed-$1" ]; }
# removed_label: the run issued a DELETE of label <id> off issue <num> (#22 —
# the claim labels released on a verified close).
removed_label()  { grep -qE "DELETE .*/issues/$1/labels/$2($|[^0-9])" "$FAKE_DIR/calls.log" 2>/dev/null; }

# T1 — an honest envelope: gates pass → comment posted AND issue closed, rc 0.
run_close 444 "$(jq -n --arg c1 "$c1" '{
  issue:444, status:"success", commits:[$c1], changed_files:["src.go"],
  tests:[{command:"t",exit_code:0}], summary:"did it", blockers:[]
}')"; rc=$?
[ "$rc" -eq 0 ] || fail "honest close should exit 0, got $rc"; ok
posted_comment || fail "honest close must post the envelope comment"; ok
closed_issue   || fail "honest close must PATCH the issue closed"; ok
close_stuck 444 || fail "honest close must VERIFY the issue is closed before posting"; ok
grep -q 'issue closed' "$FAKE_DIR/forgejo.log" || fail "honest close comment must say the issue was closed"; ok
grep -q 'close-report' "$FAKE_DIR/forgejo.log" || fail "comment should carry the close-report header"; ok
# #574: the SANDCASTLE_ATTEMPT marker — main.mts's only way to learn the
# close_outcome + issue + commits out of the combined run stdout.
grep -qE '^SANDCASTLE_ATTEMPT issue=444 outcome=success commits='"$c1"'$' "$FAKE_DIR/stdout.log" \
  || fail "honest close must emit the SANDCASTLE_ATTEMPT marker with outcome=success"; ok
# #22: a verified close releases BOTH claim labels — the timeline shows the bot
# DELETE the agent-working and ready-for-agent labels off the closed issue.
removed_label 444 40 || fail "honest close must release the agent-working label"; ok
removed_label 444 36 || fail "honest close must release the ready-for-agent label"; ok

# T2 — a fabricated SHA: gates refuse → comment posted, issue NOT closed, rc 1.
run_close 444 "$(jq -n '{
  issue:444, status:"success", commits:["deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"],
  changed_files:["src.go"], summary:"lie"
}')"; rc=$?
[ "$rc" -eq 1 ] || fail "a refuted close should exit 1, got $rc"; ok
posted_comment || fail "a refuted close must STILL post the envelope comment (evidence trail)"; ok
! closed_issue || fail "a refuted close must NOT close the issue"; ok
grep -q 'REFUSED' "$FAKE_DIR/forgejo.log" || fail "the refusal comment must say REFUSED"; ok
# #574: close_outcome is the GATE's verdict, not the envelope's self-declared
# status — the envelope claimed "success" but the gates refused, so the
# marker must say outcome=refused, never outcome=success.
grep -qE '^SANDCASTLE_ATTEMPT issue=444 outcome=refused ' "$FAKE_DIR/stdout.log" \
  || fail "a refuted close must emit outcome=refused (never the envelope's claimed status)"; ok

# T3 — a reasonless refusal: gates refuse → posted, NOT closed, rc 1.
run_close 444 "$(jq -n '{issue:444, status:"refused", summary:"nope"}')"; rc=$?
[ "$rc" -eq 1 ] || fail "reasonless refusal should exit 1, got $rc"; ok
posted_comment || fail "reasonless refusal must post the envelope comment"; ok
! closed_issue || fail "reasonless refusal must NOT close the issue"; ok

# T5 (#20) — gates PASS but the close PATCH 403s (bot lacks repo.issues write):
# the envelope STILL posts, its wording says the close FAILED with the HTTP code
# (never "closing"), the issue is NOT flipped closed, and the script exits 1 so
# the worker's blocked path names it instead of retrying blind.
run_close 444 "$(jq -n --arg c1 "$c1" '{
  issue:444, status:"success", commits:[$c1], changed_files:["src.go"],
  tests:[{command:"t",exit_code:0}], summary:"did it", blockers:[]
}')" 403; rc=$?
[ "$rc" -eq 1 ] || fail "a gates-pass-but-close-403 must exit 1, got $rc"; ok
posted_comment || fail "a failed close must STILL post the envelope comment (evidence trail)"; ok
! close_stuck 444 || fail "a 403 close must NOT leave the issue verified-closed"; ok
grep -q 'close FAILED: HTTP 403' "$FAKE_DIR/forgejo.log" \
  || fail "the failed-close comment must name the close failure and HTTP code"; ok
! grep -qi 'closing' "$FAKE_DIR/forgejo.log" \
  || fail "a failed close must not post the old 'closing' wording"; ok
grep -q 'close PATCH FAILED (HTTP 403)' "$FAKE_DIR/stdout.log" \
  || fail "a failed close must print a one-line reason to stderr for the blocked path"; ok

# T6 (#22) — the close verifies and the issue closes, but the label-release
# DELETEs 4xx (a transient tracker refusal): the close still succeeds (rc 0),
# both DELETEs were still attempted, and a warning names the failure.
run_close 444 "$(jq -n --arg c1 "$c1" '{
  issue:444, status:"success", commits:[$c1], changed_files:["src.go"],
  tests:[{command:"t",exit_code:0}], summary:"did it", blockers:[]
}')" "" 404; rc=$?
[ "$rc" -eq 0 ] || fail "a 4xx label release must NOT change the exit code, got $rc"; ok
close_stuck 444 || fail "a 4xx label release must not stop the issue closing"; ok
removed_label 444 40 || fail "a 4xx label release must still ATTEMPT the agent-working DELETE"; ok
removed_label 444 36 || fail "a 4xx label release must still ATTEMPT the ready-for-agent DELETE"; ok
grep -q "could not release label" "$FAKE_DIR/stdout.log" \
  || fail "a failed label release must print a warning line"; ok

# T4 — a malformed envelope file: nothing is posted, nothing closed, rc 2.
run_close 444 'not json {'; rc=$?
[ "$rc" -eq 2 ] || fail "malformed envelope should exit 2, got $rc"; ok
! posted_comment || fail "malformed envelope must touch NOTHING on the issue"; ok
! closed_issue   || fail "malformed envelope must not close the issue"; ok

# ==========================================================================
# LANDING=pr (#13): gate 1 checks reachability from the issue's OPEN PR head,
# and a green close does NOT PATCH the issue closed — the PR's merge does. Under
# MERGE_AUTHORITY=human the issue is left OPEN with the PR linked; under
# agent-after-green close-report merges and the merge closes it.
# ==========================================================================
merged_pr()      { grep -q "POST .*/pulls/[0-9]*/merge" "$FAKE_DIR/calls.log" 2>/dev/null; }

run_close_pr() { # run_close_pr <issue> <envelope> <merge-authority> [pr-head-sha] [closes-issue] [ci-state]
  FAKE_DIR="$(mktemp -d)"; export FAKE_DIR
  printf 'LANDING=pr\nMERGE_AUTHORITY=%s\n' "$3" > "$FAKE_DIR/swarm-policy.sh"
  export SWARM_POLICY_FILE="$FAKE_DIR/swarm-policy.sh"
  # an open PR #88 from agent/issue-<issue>, head at the given sha
  printf '[{"number":88,"head":{"ref":"agent/issue-%s"}}]\n' "$1" > "$FAKE_DIR/open-pulls.json"
  printf '{"number":88,"head":{"ref":"agent/issue-%s","sha":"%s"},"html_url":"u/pr/88"}\n' \
    "$1" "${4:-}" > "$FAKE_DIR/pr-88.json"
  [ -n "${5:-}" ] && printf '%s' "$5" > "$FAKE_DIR/pr-88-closes"
  # the labels agent-after-green may release on a merge (#22) or park on a red
  # PR (#15) — resolved by NAME
  printf '[{"id":36,"name":"ready-for-agent"},{"id":40,"name":"agent-working"},{"id":48,"name":"agent-blocked"}]\n' \
    > "$FAKE_DIR/labels.json"
  # the PR head's combined CI status (#15): green unless a state is given
  case "${6:-success}" in
    failure) printf '{"state":"failure","statuses":[{"status":"failure","context":"ci/test"}]}\n' > "$FAKE_DIR/commit-status.json" ;;
    pending) printf '{"state":"pending","statuses":[{"status":"pending","context":"ci/build"}]}\n' > "$FAKE_DIR/commit-status.json" ;;
    *)       printf '{"state":"success","statuses":[{"status":"success","context":"ci/build"}]}\n' > "$FAKE_DIR/commit-status.json" ;;
  esac
  local ef="$FAKE_DIR/envelope.json"; printf '%s' "$2" > "$ef"
  ( cd "$repo" && bash "$here/../close-report.sh" "$1" "$ef" ) >"$FAKE_DIR/stdout.log" 2>&1
}
labeled_agent_blocked() { grep -q '"labels":\[48\]' "$FAKE_DIR/forgejo.log" 2>/dev/null; }
# no open PR at all → the pr-mode close must refuse (nothing landed)
run_close_pr_nopr() { # run_close_pr_nopr <issue> <envelope>
  FAKE_DIR="$(mktemp -d)"; export FAKE_DIR
  printf 'LANDING=pr\n' > "$FAKE_DIR/swarm-policy.sh"
  export SWARM_POLICY_FILE="$FAKE_DIR/swarm-policy.sh"
  printf '[]\n' > "$FAKE_DIR/open-pulls.json"
  local ef="$FAKE_DIR/envelope.json"; printf '%s' "$2" > "$ef"
  ( cd "$repo" && bash "$here/../close-report.sh" "$1" "$ef" ) >"$FAKE_DIR/stdout.log" 2>&1
}

pr_env="$(jq -n --arg c1 "$c1" '{
  issue:444, status:"success", commits:[$c1], changed_files:["src.go"],
  tests:[{command:"t",exit_code:0}], summary:"did it", blockers:[]
}')"

# PR-1 — MERGE_AUTHORITY=human: gates pass against the PR head (c1), the envelope
# posts, the issue is NOT closed and NOT merged, exit 0. A human merges later.
run_close_pr 444 "$pr_env" human "$c1"; rc=$?
[ "$rc" -eq 0 ] || fail "pr+human green close should exit 0, got $rc"; ok
posted_comment || fail "pr+human close must post the envelope comment"; ok
! close_stuck 444 || fail "pr+human close must NOT close the issue (the merge does)"; ok
! merged_pr || fail "pr+human close must NOT merge the PR (human merges)"; ok
grep -q 'awaiting human merge\|a human merges' "$FAKE_DIR/stdout.log" \
  || fail "pr+human close comment must say the issue awaits a human merge"; ok
grep -qE '^SANDCASTLE_ATTEMPT issue=444 outcome=success ' "$FAKE_DIR/stdout.log" \
  || fail "pr+human green close must emit outcome=success"; ok

# PR-2 — MERGE_AUTHORITY=agent-after-green + GREEN checks: gates pass, close-report
# MERGES the PR, the merge closes the issue (closes #444), exit 0.
run_close_pr 444 "$pr_env" agent-after-green "$c1" 444 success; rc=$?
[ "$rc" -eq 0 ] || fail "pr+agent-after-green green close should exit 0, got $rc"; ok
merged_pr || fail "agent-after-green + green must merge the PR"; ok
close_stuck 444 || fail "agent-after-green merge must close the issue (closes #444)"; ok
grep -q 'merged' "$FAKE_DIR/forgejo.log" || fail "agent-after-green comment must say the PR merged"; ok
! labeled_agent_blocked || fail "a green agent-after-green close must NOT park agent-blocked"; ok

# PR-2b — agent-after-green + RED checks (#15): gates pass but the PR's checks
# are red — it must NOT merge, must park the issue agent-blocked naming the check.
run_close_pr 444 "$pr_env" agent-after-green "$c1" 444 failure; rc=$?
[ "$rc" -eq 0 ] || fail "pr+agent-after-green red close should still exit 0, got $rc"; ok
! merged_pr || fail "agent-after-green must NOT merge a red PR"; ok
! close_stuck 444 || fail "a red agent-after-green PR must not close the issue"; ok
labeled_agent_blocked || fail "a red agent-after-green PR must be parked agent-blocked"; ok
grep -q 'RED' "$FAKE_DIR/stdout.log" || fail "the red-close comment must name the RED checks"; ok

# PR-2c — agent-after-green + PENDING checks (#15): gates pass, checks not green
# yet — leave the PR unmerged and the issue open for a later reconcile pass.
run_close_pr 444 "$pr_env" agent-after-green "$c1" 444 pending; rc=$?
[ "$rc" -eq 0 ] || fail "pr+agent-after-green pending close should exit 0, got $rc"; ok
! merged_pr || fail "agent-after-green must NOT merge a PR whose checks are pending"; ok
! close_stuck 444 || fail "a pending agent-after-green PR must not close the issue"; ok
! labeled_agent_blocked || fail "a pending PR must not be parked agent-blocked"; ok

# PR-3 — gate 1 refutes a commit NOT reachable from the PR head. The PR head is
# a fabricated sha, so the real, main-reachable c1 is not an ancestor of it.
run_close_pr 444 "$pr_env" human "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"; rc=$?
[ "$rc" -eq 1 ] || fail "pr close whose commit is not under the PR head must exit 1, got $rc"; ok
! close_stuck 444 || fail "a refuted pr close must not close the issue"; ok

# PR-4 — no open PR in pr mode: the close is refused (the work never landed).
run_close_pr_nopr 444 "$pr_env"; rc=$?
[ "$rc" -eq 1 ] || fail "pr close with no open PR must exit 1, got $rc"; ok
grep -q 'no open agent PR' "$FAKE_DIR/forgejo.log" \
  || fail "a no-PR pr close must name the missing PR in the refusal"; ok

# PR-5 (#108) — no OPEN PR, but a MERGED one from agent/issue-444 and the issue
# already closed by its `closes #444`: a reconcile sweep landed it before this
# close-report ran. The close is VERIFIED (gates run against main, where the
# work now is), the comment says so, the claim labels are swept, exit 0.
run_close_pr_merged() { # run_close_pr_merged <issue> <envelope> [already-closed]
  FAKE_DIR="$(mktemp -d)"; export FAKE_DIR
  printf 'LANDING=pr\nMERGE_AUTHORITY=agent-after-green\n' > "$FAKE_DIR/swarm-policy.sh"
  export SWARM_POLICY_FILE="$FAKE_DIR/swarm-policy.sh"
  printf '[]\n' > "$FAKE_DIR/open-pulls.json"
  printf '[{"number":5,"head":{"ref":"sandcastle/worker/x"},"merged":false},{"number":6,"head":{"ref":"agent/issue-%s"},"merged":true}]\n' "$1" > "$FAKE_DIR/closed-pulls.json"
  printf '{"number":6,"head":{"ref":"agent/issue-%s"},"html_url":"u/pr/6"}\n' "$1" > "$FAKE_DIR/pr-6.json"
  printf '[{"id":36,"name":"ready-for-agent"},{"id":40,"name":"agent-working"}]\n' > "$FAKE_DIR/labels.json"
  [ -n "${3:-}" ] && touch "$FAKE_DIR/closed-$1"
  local ef="$FAKE_DIR/envelope.json"; printf '%s' "$2" > "$ef"
  ( cd "$repo" && bash "$here/../close-report.sh" "$1" "$ef" ) >"$FAKE_DIR/stdout.log" 2>&1
}
run_close_pr_merged 444 "$pr_env" closed; rc=$?
[ "$rc" -eq 0 ] || fail "pr close after an earlier merge must exit 0, got $rc (#108)"; ok
! grep -q 'no open agent PR' "$FAKE_DIR/forgejo.log" \
  || fail "a merged PR must NOT be reported as 'no open agent PR' (#108)"; ok
grep -q 'already merged' "$FAKE_DIR/forgejo.log" \
  || fail "the comment must say the PR was already merged (#108)"; ok
! merged_pr || fail "an already-merged PR must not be merged again"; ok
removed_label 444 40 || fail "the earlier merge's close must sweep agent-working (#108/#22)"; ok
removed_label 444 36 || fail "the earlier merge's close must sweep ready-for-agent (#108/#22)"; ok
grep -qE '^SANDCASTLE_ATTEMPT issue=444 outcome=success ' "$FAKE_DIR/stdout.log" \
  || fail "an already-merged close must emit outcome=success, not refused (#108)"; ok

# PR-6 (#108) — merged PR but the issue is somehow still OPEN (no closes-ref
# took): the verified work is on main, so close it directly like push mode.
run_close_pr_merged 444 "$pr_env"; rc=$?
[ "$rc" -eq 0 ] || fail "merged-but-open close must exit 0, got $rc (#108)"; ok
close_stuck 444 || fail "merged-but-open must PATCH the issue closed and verify it (#108)"; ok
removed_label 444 40 || fail "merged-but-open close must sweep agent-working (#108)"; ok
unset SWARM_POLICY_FILE

echo "close-report: $pass checks passed"
