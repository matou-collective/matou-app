#!/usr/bin/env bash
# Offline test for run-swarm.sh's LANDING=pr reconcile + summary block (#13).
#
# Until #2 this file kept a structurally-identical COPY of the block, because the
# surrounding script needs pnpm/docker/a live tracker to reach it. The reconcile
# pass now lives in landing-lib.sh as landing_stage (the LAND seam) and the two
# summary sections in report-lib.sh (the REPORT seam), so this test drives the
# REAL functions with landing_reconcile / landing_merge_reconcile / git shimmed.
#
# Proves: pr mode fans landing_reconcile over the touched-issue set (pickup ∪
# commit-subject #NN) and the summary lists one line per PR; push mode takes
# neither branch. landing_reconcile itself is covered in landing-lib-test.sh.
# Run: bash .sandcastle/tests/run-swarm-landing-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sc="$here/.."
fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0

repo_web="https://fj.test/Matou/matou-app"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
CALLS="$tmp/landing-calls"
MERGE_CALLS="$tmp/merge-calls"
mkdir -p "$tmp/bin"

. "$sc/verdict-lib.sh"
. "$sc/landing-lib.sh"
. "$sc/sweep-lib.sh"
. "$sc/report-lib.sh"

# `git log --format=%s $start..HEAD` — the mid-run #NN scrape landing_stage does.
cat > "$tmp/bin/git" <<'SH'
#!/usr/bin/env bash
case "$*" in
  *--format=%s*) printf '%s\n' "${SUBJECTS:-}" ;;
  *push*) echo "git $*" >> "${GIT_LOG:-/dev/null}" ;;
esac
SH
chmod +x "$tmp/bin/git"
export PATH="$tmp/bin:$PATH" GIT_LOG="$tmp/git.log"

# Shim landing_reconcile: record (to a file — landing_stage captures in a $()
# subshell) which issue numbers it was fanned over, and echo "<N> <pr>" for each
# (the run-swarm contract) — PR number = 100 + N.
landing_reconcile() {
  printf '%s' "$*" > "$CALLS"
  local n
  for n in "$@"; do [ -n "$n" ] && printf '%s %s\n' "$n" "$((100 + n))"; done
}

# Shim landing_merge_reconcile (#15): self-gates on MERGE_AUTHORITY (like the
# real one); records that it ran and echoes a "<N> <result>" line for the one
# open agent PR.
landing_merge_reconcile() {
  [ "${SWARM_POLICY_MERGE_AUTHORITY:-human}" = agent-after-green ] || return 0
  printf 'ran\n' > "$MERGE_CALLS"
  printf '7 merged 88\n'
}

# --- 1. pr mode: landing_reconcile is fanned over pickup ∪ commit #NN --------
rm -f "$CALLS" "$MERGE_CALLS"
SUBJECTS='sandcastle: do a thing (#7)
sandcastle: unblock child (#8)' \
  SWARM_POLICY_LANDING=pr landing_stage Matou/matou-app '[{"number":7}]' start
[ "$(cat "$CALLS")" = "7 8" ] || fail "pr mode must fan landing over the touched set (pickup 7 + subject 8); got '$(cat "$CALLS")'"
grep -q '^7 107$' <<<"$LANDING_OPENED_PRS" || fail "pr mode must carry each issue's opened PR (7 -> 107)"
grep -q '^8 108$' <<<"$LANDING_OPENED_PRS" || fail "pr mode must carry the mid-run child's PR (8 -> 108)"
[ ! -s "$GIT_LOG" ] || fail "pr mode must NOT push to main — that would bypass the PR: $(cat "$GIT_LOG")"
pass=$((pass+1))

# --- 2. the summary lists one 'closes #N' line per opened PR ----------------
sm="$(report_pr_section "$LANDING_OPENED_PRS" "$repo_web")"
grep -q 'PRs opened this run:' <<<"$sm" || fail "pr summary must have a 'PRs opened this run' header"
grep -qF "[PR #107]($repo_web/pulls/107) (closes #7)" <<<"$sm" || fail "pr summary must link PR #107 closing #7"
grep -qF "[PR #108]($repo_web/pulls/108) (closes #8)" <<<"$sm" || fail "pr summary must link PR #108 closing #8"
pass=$((pass+1))

# --- 3. push mode: neither pr branch runs — no landing fan-out, empty summary,
#        and the push to main happens instead ------------------------------
rm -f "$CALLS"; : > "$GIT_LOG"
SUBJECTS='sandcastle: do a thing (#7)' \
  SWARM_POLICY_LANDING=push landing_stage Matou/matou-app '[{"number":7}]' start
[ ! -f "$CALLS" ] || fail "push mode must NOT call landing_reconcile"
[ -z "$LANDING_OPENED_PRS" ] || fail "push mode must produce no opened_prs"
[ -z "$(report_pr_section "$LANDING_OPENED_PRS" "$repo_web")" ] || fail "push mode summary must omit the PRs section entirely"
grep -q 'push origin HEAD:main' "$GIT_LOG" || fail "push mode must push HEAD to main: $(cat "$GIT_LOG")"
pass=$((pass+1))

# --- 4. agent-after-green (#15): the reconcile pass merges & the summary lists it
rm -f "$MERGE_CALLS"
SUBJECTS='' SWARM_POLICY_LANDING=pr SWARM_POLICY_MERGE_AUTHORITY=agent-after-green \
  landing_stage Matou/matou-app '[{"number":7}]' start
[ -f "$MERGE_CALLS" ] || fail "agent-after-green must run the merge-if-green reconcile pass"
grep -q '^7 merged 88$' <<<"$LANDING_MERGED_PRS" || fail "the merge pass must carry '<N> <result>' lines"
ms="$(report_merge_section "$LANDING_MERGED_PRS")"
grep -q 'Agent PRs reconciled (merge-if-green):' <<<"$ms" || fail "the summary must list the merge-if-green section"
grep -qF -- '- #7 → merged 88' <<<"$ms" || fail "the summary must show '#7 → merged 88'"
pass=$((pass+1))

# --- 5. MERGE_AUTHORITY=human: no merge pass, no merge section ---------------
rm -f "$MERGE_CALLS"
SUBJECTS='' SWARM_POLICY_LANDING=pr SWARM_POLICY_MERGE_AUTHORITY=human \
  landing_stage Matou/matou-app '[{"number":7}]' start
[ ! -f "$MERGE_CALLS" ] || fail "human authority must NOT run the merge-if-green pass"
[ -z "$(report_merge_section "$LANDING_MERGED_PRS")" ] || fail "human authority summary must omit the merge section"
pass=$((pass+1))

# --- 6. push mode's rescue ladder: when nothing lands the commits are PARKED,
#        never stranded (run 330 lost three closed-issue commits) -----------
cat > "$tmp/bin/git" <<'SH'
#!/usr/bin/env bash
echo "git $*" >> "${GIT_LOG:?}"
case "$*" in
  "push origin HEAD:main") exit 1 ;;      # main moved under us, and stays moved
  "rebase origin/main")    exit 1 ;;      # ...with a conflict claude can't fix
esac
exit 0
SH
chmod +x "$tmp/bin/git"
export LANDING_NOTIFY="$tmp/bin/notify.sh"
cat > "$LANDING_NOTIFY" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$1" >> "${NOTIFY_LOG:?}"
SH
chmod +x "$LANDING_NOTIFY"
export NOTIFY_LOG="$tmp/notify.log"
: > "$GIT_LOG"; : > "$NOTIFY_LOG"; SWARM_EXIT_REASON=""
RC=0
PATH="$tmp/bin:/usr/bin:/bin" SWARM_POLICY_LANDING=push \
  landing_stage Matou/matou-app '[{"number":7}]' start || RC=$?
[ "$RC" = 1 ] || fail "an unlandable push must fail the run, got $RC"
[ "$SWARM_EXIT_REASON" = "push-parked-on-rescue" ] || fail "the reason must name the park, got '$SWARM_EXIT_REASON'"
grep -q 'push origin HEAD:refs/heads/sandcastle/rescue-' "$GIT_LOG" \
  || fail "the commits must be parked on a rescue branch: $(cat "$GIT_LOG")"
grep -q 'commits parked on' "$NOTIFY_LOG" || fail "the park must alarm so a human cherry-picks: $(cat "$NOTIFY_LOG")"
grep -q 'will NOT retry' "$NOTIFY_LOG" || fail "the alarm must say the issues will not retry"
pass=$((pass+1))

echo "run-swarm-landing: $pass scenarios passed"
