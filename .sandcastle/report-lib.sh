#!/usr/bin/env bash
# report-lib.sh — the REPORT seam of run-swarm.sh (#2): everything a run says
# about itself once the work has landed.
#
#   post-run sweep → run summary (commits, PRs, every issue touched) → self-rearm
#
# sweep-lib.sh owns the worktree/container reaping and runlog-lib.sh the
# host-side exit log — each with its own test. What lived inline in run-swarm.sh,
# and lives here, is the assembly: which sections a summary carries, and the
# per-issue reconcile loop whose 404-tolerance (#21) is load-bearing.
#
# The reconcile loop's guard is the subtle one: a commit subject can cite a
# FOREIGN `#NN` — a matou-app PR (#54), an idss issue (#664) referenced in a
# STATUS line — that does not resolve in THIS repo. The API call is `curl -sf`,
# so its 404 exits 22 and, under `set -euo pipefail`, killed the whole reconcile
# stage AFTER the work was committed, pushed and the issues closed: the summary
# and the D5 self-rearm never fired and the green run woke the healer (run 70,
# verdict `reconcile push to main` exit=22). Skipping an unresolvable number is
# strictly safer — a transient 5xx on a real own-repo issue now omits one line
# rather than reding an already-successful run.
#
# Callers must have sourced sweep-lib.sh and claim-lib.sh (rearm_dispatch).
# Offline-tested by tests/report-lib-test.sh, tests/run-swarm-landing-test.sh
# and tests/run-swarm-reconcile-summary-test.sh with shimmed git/curl/notify.

if [ -z "${__SWARM_REPORT_LIB:-}" ]; then
__SWARM_REPORT_LIB=1

_REPORT_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPORT_NOTIFY="${REPORT_NOTIFY:-$_REPORT_HERE/notify-mattermost.sh}"
# The lister the D5 self-rearm re-reads. Overridable for offline tests.
REPORT_LIST_READY="${REPORT_LIST_READY:-$_REPORT_HERE/list-ready-tasks.sh}"

_report_notify() { bash "$REPORT_NOTIFY" "$1" || true; }

# _report_api <url> — the tracker GET. `curl -sf`, so a 404 is a non-zero exit
# with no body; every caller must guard it (see the loop below).
_report_api() { curl -sf -H "Authorization: token $FORGEJO_TOKEN" "$@"; }

# ── the post-run sweep ────────────────────────────────────────────────────
# Sandcastle's merge-to-head worktrees and sandcastle/worker/* branches are never
# cleaned up, so the workdir leaked 18 worktrees (2.9 GB) and 198 orphaned
# branches by 2026-07-30 — and the stale checkouts poisoned
# `go test ./internal/wireconvention/...` with 1867 phantom findings (#187).
#
# Since #577 / ADR 0184 host capacity is a TWO-slot pool with no repo affinity,
# so a sibling swarm on this SAME repo+workdir can be live when the exit trap
# fires — sweep_worktrees/reap_containers therefore spare anything younger than a
# run-lifetime (that live sibling's checkout) and only remove provably-dead
# debris. Runs on EVERY exit (limit-pause, push-fail, normal). An unmerged worker
# branch is left intact and SURFACED, never `-D`'d away.
report_sweep() { # report_sweep <workspace> <repo-slug>
  local workspace="$1" repo_slug="$2" reaped unmerged count
  # Reap leaked worker containers older than a run-lifetime (#238) — quiet
  # housekeeping, no alert. We hold the global lock, so anything this old is dead.
  reaped="$(reap_containers)" || true
  [ -n "$reaped" ] && echo "run-swarm: reaped stale sandcastle-* container(s): $(printf '%s' "$reaped" | tr '\n' ' ')"
  # #113: close swarm.db ORPHAN runs — open rows a SIGKILLed run (a Forgejo-runner
  # CANCEL) left behind because its EXIT trap never fired. Host-global, age-floored
  # and idempotent; the durable finaliser the dead run's own trap could not be.
  # Guarded so a caller that never sourced swarm-db-lib.sh (an offline report test)
  # is unaffected. Quiet housekeeping — echo what it swept, no alert.
  if command -v swarmdb_sweep_orphans >/dev/null 2>&1; then
    local swept; swept="$(swarmdb_sweep_orphans)" || true
    [ -n "$swept" ] && echo "run-swarm: swept orphan run(s): $(printf '%s' "$swept" | tr '\n' ' ')"
  fi
  # #98: prune raw session jsonl already harvested into swarm.db (ingest-then-
  # prune). Bounds .sandcastle/logs/, which Sandcastle grows without limit.
  prune_session_logs "$workspace/.sandcastle/logs" || true
  unmerged="$(sweep_worktrees "$workspace")" || true
  [ -n "$unmerged" ] || return 0
  count="$(printf '%s' "$unmerged" | grep -c .)"
  _report_notify ":warning: **Swarm sweep left $count unmerged \`sandcastle/worker/*\` branch(es)** in \`$repo_slug\` — possible lost work, NOT deleted:
$(printf '%s' "$unmerged" | sed 's/^/- `/; s/$/`/')"
}

# ── the run summary ───────────────────────────────────────────────────────

# report_commit_lines <start-sha> <repo-web> -> one linked line per commit.
report_commit_lines() {
  git log --format="- [\`%h\`]($2/commit/%H) %s" "$1"..HEAD
}

# report_commit_nums <start-sha> -> every `#NN` cited in this run's commit
# subjects. A closed ticket can unblock children the agent picks up in a later
# iteration; they appear here but not in the pickup snapshot.
report_commit_nums() {
  git log --format=%s "$1"..HEAD | grep -oE '#[0-9]+' | tr -d '#' || true
}

# report_pr_section <opened-prs> <repo-web> -> the LANDING=pr section (#13), one
# `closes #N` line per PR opened/refreshed this run. Empty in push mode.
report_pr_section() {
  local opened="$1" repo_web="$2" lines
  [ -n "$opened" ] || return 0
  lines="$(while read -r pnum pr; do
      [ -n "$pr" ] || continue
      printf -- '- [PR #%s](%s/pulls/%s) (closes #%s)\n' "$pr" "$repo_web" "$pr" "$pnum"
    done <<<"$opened")"
  printf '\n**PRs opened this run:**\n%s' "$lines"
}

# report_merge_section <merged-prs> -> the agent-after-green section (#15), one
# line per open agent PR this reconcile pass merged or parked. Empty under
# MERGE_AUTHORITY=human and in push mode.
report_merge_section() {
  local merged="$1" lines
  [ -n "$merged" ] || return 0
  lines="$(while read -r mnum mres; do
      [ -n "$mnum" ] || continue
      printf -- '- #%s → %s\n' "$mnum" "$mres"
    done <<<"$merged")"
  printf '\n**Agent PRs reconciled (merge-if-green):**\n%s' "$lines"
}

# report_issue_section <ready-json> <commit-nums...> -> one state line per issue
# the run touched: the pickup snapshot PLUS issues shipped mid-run. A number this
# repo cannot resolve is SKIPPED, never fatal (#21 — see the header).
report_issue_section() {
  local ready="$1"; shift
  local commit_nums="$*" out="" num issue state title labels issue_url
  while read -r num; do
    [ -n "$num" ] || continue
    issue="$(_report_api "$FORGEJO_API/issues/$num")" || continue
    state="$(jq -r .state <<<"$issue")"
    title="$(jq -r .title <<<"$issue")"
    labels="$(jq -r '[.labels[].name] | join(", ")' <<<"$issue")"
    issue_url="$(jq -r .html_url <<<"$issue")"
    out="$out
- [#$num $title]($issue_url) → **$state**${labels:+ [$labels]}"
  done < <({ jq -r '.[].number' <<<"$ready"; printf '%s\n' $commit_nums; } | sort -un)
  printf '%s' "$out"
}

# report_run_summary <repo-slug> <repo-web> <ready-count> <start-sha> <ready-json>
#                    <opened-prs> <merged-prs>
# The whole Mattermost body. RUN_URL (optional) appends the Actions run link.
report_run_summary() {
  local repo_slug="$1" repo_web="$2" n="$3" start_sha="$4" ready="$5" opened="$6" merged="$7"
  local commits summary
  commits="$(report_commit_lines "$start_sha" "$repo_web")"
  summary=":hammer_and_wrench: **Swarm run** in \`$repo_slug\` — $n task(s) picked up."
  if [ -n "$commits" ]; then
    summary="$summary
**Commits pushed:**
$commits"
  else
    summary="$summary
No commits produced (agent blocked or task left open — see issue comments)."
  fi
  summary="$summary$(report_pr_section "$opened" "$repo_web")"
  summary="$summary$(report_merge_section "$merged")"
  summary="$summary$(report_issue_section "$ready" $(report_commit_nums "$start_sha"))"
  if [ -n "${RUN_URL:-}" ]; then
    summary="$summary
[Actions run]($RUN_URL)"
  fi
  printf '%s' "$summary"
}

# report_post_summary <same args as report_run_summary> — assemble and post.
report_post_summary() { _report_notify "$(report_run_summary "$@")"; }

# ── the self-rearm (spec D5) ──────────────────────────────────────────────
# A run that did real work and left ready tickets behind dispatches its successor
# instead of waiting for the :15/:45 cron. Gated on <worker-ran> so an empty or
# coalesced run can never dispatch-loop.
report_self_rearm() { # report_self_rearm <worker-ran>
  [ -n "$1" ] || return 0
  [ "$(bash "$REPORT_LIST_READY" | jq length)" -gt 0 ] || return 0
  rearm_dispatch && echo "run-swarm: ready tickets remain — dispatched a follow-up run" || true
}

fi
