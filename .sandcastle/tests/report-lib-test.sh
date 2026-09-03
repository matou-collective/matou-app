#!/usr/bin/env bash
# Offline test for report-lib.sh — the REPORT seam of run-swarm.sh (#2):
# post-run sweep → run summary → self-rearm.
#
# The per-issue reconcile loop's 404-tolerance (#21) has its own dedicated
# scenario file (tests/run-swarm-reconcile-summary-test.sh, which now drives this
# same function instead of a verbatim copy of the block); this covers the sweep,
# the summary assembly and the D5 self-rearm.
#
# Run: bash .sandcastle/tests/report-lib-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sc="$here/.."

fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"

. "$sc/sweep-lib.sh"
. "$sc/report-lib.sh"

export REPORT_NOTIFY="$tmp/bin/notify.sh"
cat > "$REPORT_NOTIFY" <<'SH'
#!/usr/bin/env bash
printf '%s\n===\n' "$1" >> "${NOTIFY_LOG:?}"
SH
chmod +x "$REPORT_NOTIFY"
export NOTIFY_LOG="$tmp/notify.log"

# ── 1. the post-run sweep ─────────────────────────────────────────────────
# An unmerged worker branch is possible LOST WORK: it is surfaced, never -D'd.
reap_containers() { printf 'sandcastle-old-1\nsandcastle-old-2\n'; }
sweep_worktrees()  { printf 'sandcastle/worker/abc\nsandcastle/worker/def\n'; }
: > "$NOTIFY_LOG"
out="$(report_sweep /some/workspace Acme/widget)"
grep -q 'reaped stale factory container(s): sandcastle-old-1 sandcastle-old-2' <<<"$out" \
  || fail "reaped containers must be reported quietly to the job log: $out"
grep -q 'left 2 unmerged' "$NOTIFY_LOG" || fail "unmerged branches must be surfaced: $(cat "$NOTIFY_LOG")"
grep -q 'NOT deleted' "$NOTIFY_LOG" || fail "the notice must say the branches were not deleted"
grep -q 'sandcastle/worker/abc' "$NOTIFY_LOG" || fail "each unmerged branch must be named"
pass=$((pass+1))

# a clean sweep says nothing at all
reap_containers() { :; }
sweep_worktrees()  { :; }
: > "$NOTIFY_LOG"
[ -z "$(report_sweep /some/workspace Acme/widget)" ] || fail "a clean sweep must be silent"
[ ! -s "$NOTIFY_LOG" ] || fail "a clean sweep must not post: $(cat "$NOTIFY_LOG")"
pass=$((pass+1))

# a reap/sweep that ERRORS must not fail the caller — this runs from the EXIT
# trap, where a non-zero return would mangle the run's own exit code
reap_containers() { return 3; }
sweep_worktrees()  { return 4; }
report_sweep /some/workspace Acme/widget >/dev/null || fail "a failing sweep must never fail the run"
pass=$((pass+1))

# ── 2. commit lines + the mid-run #NN scrape ─────────────────────────────
cat > "$tmp/bin/git" <<'SH'
#!/usr/bin/env bash
case "$*" in
  *"--format=%s"*) printf 'sandcastle: land the thing (#7)\nsandcastle: unblock child (#8)\nsandcastle: note idss #664 in STATUS\n' ;;
  *--format=*)     printf -- '- [`abc1234`](WEB/commit/abc1234deadbeef) sandcastle: land the thing (#7)\n' ;;
esac
SH
chmod +x "$tmp/bin/git"
export PATH="$tmp/bin:$PATH"
[ "$(report_commit_nums start | tr '\n' ' ')" = "7 8 664 " ] \
  || fail "every #NN in the subjects must be scraped, got '$(report_commit_nums start | tr '\n' ' ')'"
grep -q 'abc1234' <<<"$(report_commit_lines start https://fj.test/Acme/widget)" \
  || fail "commit lines must link each commit"
pass=$((pass+1))

# ── 3. the PR / merge sections (#13, #15) ────────────────────────────────
web="https://fj.test/Acme/widget"
s="$(report_pr_section '7 107
8 108' "$web")"
grep -q 'PRs opened this run:' <<<"$s" || fail "the PR section needs its header"
grep -qF "[PR #107]($web/pulls/107) (closes #7)" <<<"$s" || fail "PR #107 must close #7"
grep -qF "[PR #108]($web/pulls/108) (closes #8)" <<<"$s" || fail "PR #108 must close #8"
[ -z "$(report_pr_section '' "$web")" ] || fail "push mode (no PRs) must omit the section entirely"

s="$(report_merge_section '7 merged 88
9 pending')"
grep -q 'Agent PRs reconciled (merge-if-green):' <<<"$s" || fail "the merge section needs its header"
grep -qF -- '- #7 → merged 88' <<<"$s" || fail "a merged PR must be listed"
grep -qF -- '- #9 → pending' <<<"$s" || fail "a pending PR must be listed"
[ -z "$(report_merge_section '')" ] || fail "MERGE_AUTHORITY=human must omit the merge section"
pass=$((pass+1))

# ── 4. the whole summary ─────────────────────────────────────────────────
export FORGEJO_API=https://fj.test/api/v1/repos/Acme/widget
_report_api() {
  case "${1##*/}" in
    7) printf '{"state":"closed","title":"seven","html_url":"u/7","labels":[{"name":"enhancement"}]}' ;;
    8) printf '{"state":"open","title":"eight","html_url":"u/8","labels":[]}' ;;
    *) return 22 ;;   # a foreign #NN, exactly as curl -sf 404s
  esac
}
sm="$(RUN_URL=https://ci.test/run/9 report_run_summary Acme/widget "$web" 2 start '[{"number":7}]' '7 107' '7 merged 88')"
grep -q 'Swarm run.*Acme/widget.*2 task(s) picked up' <<<"$sm" || fail "the headline must name the repo + count: $sm"
grep -q 'Commits pushed:' <<<"$sm" || fail "commits must be listed"
grep -q 'PRs opened this run:' <<<"$sm" || fail "the PR section must be spliced in"
grep -q 'Agent PRs reconciled' <<<"$sm" || fail "the merge section must be spliced in"
grep -qF '[#7 seven](u/7) → **closed** [enhancement]' <<<"$sm" || fail "the pickup issue's state + labels must be reported: $sm"
grep -qF '[#8 eight](u/8) → **open**' <<<"$sm" || fail "a mid-run child from a commit subject must be reported too"
grep -q '#664' <<<"$sm" && fail "a FOREIGN #NN that 404s must be omitted, never red the stage (#21)"
grep -qF '[Actions run](https://ci.test/run/9)' <<<"$sm" || fail "RUN_URL must be linked when set"
pass=$((pass+1))

# no commits: the summary says so plainly rather than showing an empty section
git() { case "$*" in *--format=%s*) : ;; *--format=*) : ;; esac; }
sm="$(env -u RUN_URL bash -c '
  . '"$sc"'/sweep-lib.sh; . '"$sc"'/report-lib.sh
  report_commit_lines() { :; }; report_commit_nums() { :; }
  _report_api() { return 22; }
  report_run_summary Acme/widget web 1 start "[]" "" ""')"
grep -q 'No commits produced' <<<"$sm" || fail "an empty run must say so: $sm"
grep -q 'Actions run' <<<"$sm" && fail "an unset RUN_URL must add no link"
unset -f git
pass=$((pass+1))

# ── 5. the D5 self-rearm ─────────────────────────────────────────────────
# Gated on worker_ran so an empty or coalesced run can never dispatch-loop.
cat > "$tmp/ready-some" <<'SH'
#!/usr/bin/env bash
printf '[{"number":9}]'
SH
cat > "$tmp/ready-none" <<'SH'
#!/usr/bin/env bash
printf '[]'
SH
chmod +x "$tmp/ready-some" "$tmp/ready-none"
rearm_dispatch() { printf 'dispatched\n' >> "$tmp/rearm.log"; }

rm -f "$tmp/rearm.log"
REPORT_LIST_READY="$tmp/ready-some" report_self_rearm "" >/dev/null
[ ! -f "$tmp/rearm.log" ] || fail "a run with NO worker must never dispatch a successor (the dispatch-loop guard)"

REPORT_LIST_READY="$tmp/ready-none" report_self_rearm 1 >/dev/null
[ ! -f "$tmp/rearm.log" ] || fail "an empty ready set must not dispatch a successor"

out="$(REPORT_LIST_READY="$tmp/ready-some" report_self_rearm 1)"
[ -f "$tmp/rearm.log" ] || fail "real work + tickets remaining must dispatch the successor"
grep -q 'dispatched a follow-up run' <<<"$out" || fail "the dispatch must be logged: $out"

# a dispatch that fails is not a run failure — the :15/:45 cron is the backstop
rearm_dispatch() { return 1; }
REPORT_LIST_READY="$tmp/ready-some" report_self_rearm 1 >/dev/null \
  || fail "a failed re-arm must not fail the run (the cron backstop covers it)"
pass=$((pass+1))

echo "report-lib: $pass groups passed"
