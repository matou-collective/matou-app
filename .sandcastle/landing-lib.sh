#!/usr/bin/env bash
# landing-lib.sh — how a swarm worker's commits LAND, per the repo's LANDING
# policy knob (#13, ADR 0002; policy-lib.sh's policy_load exports
# SWARM_POLICY_LANDING). This promotes matou-app's branch-per-issue / PR flow
# into the core: it lived as a second copy of harness logic in matou-app's own
# .sandcastle/ (branches agent/issue-<N>, a PR body carrying `closes #N`); the
# vendored core now owns it, gated on a per-repo knob.
#
# Two modes:
#   push (default) — push HEAD straight to main. Today's byte-identical
#                    behaviour for the factory and for idss; the <N> argument is
#                    ignored (every iteration's commits land on main directly).
#   pr             — push HEAD to agent/issue-<N> and open a PR carrying
#                    `closes #<N>`; a human — or MERGE_AUTHORITY=agent-after-green
#                    — merges, and the merge closes the issue via `closes #N`.
#
# Sourceable, no side effects beyond defining functions. pr-mode PR calls go
# through forgejo-lib.sh; the push itself is a plain (never --force) `git push`
# so an existing agent/issue-<N> branch that diverged is a loud non-fast-forward
# rather than a silent overwrite of unmerged work (matou-app's PR #21→#22
# lesson). Offline-tested by tests/landing-lib-test.sh with shimmed git + curl.

if [ -z "${__SWARM_LANDING_LIB:-}" ]; then
__SWARM_LANDING_LIB=1

__landing_lib_here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=forgejo-lib.sh
. "$__landing_lib_here/forgejo-lib.sh"
# shellcheck source=model-lib.sh
. "$__landing_lib_here/model-lib.sh"   # SWARM_MODEL — swarm.config is the ONE model source (#448); before this the rebase-rescue claude call passed no --model and ran on the host user's CLI default

landing_branch_for() { # landing_branch_for <N> -> the issue's agent branch name
  printf 'agent/issue-%s\n' "${1:?landing_branch_for: issue number required}"
}

# landing_pr_body <N> [extra] -> the PR body. The FIRST line is `closes #<N>`
# (GOTCHAS 2 / matou-app: the closes-ref is what a human merge acts on to close
# the issue — an issue-PATCH `labels`/state write is a separate, ignored thing).
landing_pr_body() {
  local n="${1:?landing_pr_body: issue number required}" extra="${2:-}"
  printf 'closes #%s\n' "$n"
  [ -n "$extra" ] && printf '\n%s\n' "$extra"
  return 0
}

# landing_open_pr_for <N> -> echo the PR number and exit 0 iff an OPEN PR from
# agent/issue-<N> exists; exit 1 (no output) otherwise. The idempotency check:
# a second run must find the first run's PR and NOT open a duplicate.
landing_open_pr_for() {
  local n="${1:?landing_open_pr_for: issue number required}" num
  num="$(forgejo_open_pr_for "$(landing_branch_for "$n")")" || return 1
  [ -n "$num" ] || return 1
  printf '%s\n' "$num"
}

# landing_merged_pr_for <N> -> echo the PR number and exit 0 iff a MERGED PR from
# agent/issue-<N> exists; exit 1 (no output) otherwise. The close-report gate's
# second look (#108): no open PR but a merged one means the work already landed
# on main — a concurrent run's reconcile sweep beat the worker's close-report.
landing_merged_pr_for() {
  local n="${1:?landing_merged_pr_for: issue number required}" num
  num="$(forgejo_merged_pr_for "$(landing_branch_for "$n")")" || return 1
  [ -n "$num" ] || return 1
  printf '%s\n' "$num"
}

# landing_push <N> [title] [extra-body] -> land HEAD for issue <N>.
#   push mode: git push origin HEAD:refs/heads/main (today's behaviour; <N> is
#              ignored). rc = git's.
#   pr mode:   push HEAD to agent/issue-<N>, then open a PR (closes #<N>) unless
#              one is already open; echo the PR number on stdout. rc non-zero if
#              the branch push or the PR-open failed.
landing_push() {
  local n="${1:?landing_push: issue number required}"
  if [ "${SWARM_POLICY_LANDING:-push}" != pr ]; then
    git push origin "HEAD:refs/heads/main"
    return
  fi
  local branch num resp
  branch="$(landing_branch_for "$n")"
  git push origin "HEAD:refs/heads/$branch" || return 1
  if num="$(landing_open_pr_for "$n")"; then
    printf '%s\n' "$num"   # refresh: branch pushed, its PR is already open
    return 0
  fi
  resp="$(forgejo_create_pr "${2:-#$n}" "$branch" main "$(landing_pr_body "$n" "${3:-}")")" || return 1
  jq -r '.number // empty' <<<"$resp"
}

# landing_reconcile <N...> -> the run-swarm reconcile fan-out for pr mode: for
# each touched issue number, landing_push it and echo one "<N> <pr-number>" line
# per opened/refreshed PR (skipping a number whose push/PR-open failed). run-swarm
# consumes this to list the PRs opened this run; push mode never calls it (it
# pushes HEAD:main directly, the rescue ladder unchanged).
#
# NB: pushes HEAD to EACH issue's branch — correct for the pool's single-issue-
# per-run reality (claim-next-task claims one ticket; a run that leaves ready
# tickets self-rearms a fresh run per ticket). A future multi-issue-per-run pr
# flow wires per-iteration branch pushes through the prompt (the render ticket).
landing_reconcile() {
  local n pr
  for n in "$@"; do
    [ -n "$n" ] || continue
    if pr="$(landing_push "$n")" && [ -n "$pr" ]; then
      printf '%s %s\n' "$n" "$pr"
    fi
  done
}

# --- MERGE_AUTHORITY=agent-after-green (#15) -------------------------------
# Ben's ruling (policy-lib.sh): whether AGENTS merge is per-repo. `human`
# (default) is today's behaviour — a person clicks merge. `agent-after-green`
# lets a repo with a trusted gate close the loop: the harness merges an open
# agent PR the moment its required checks are all `success`.

# landing_park_agent_blocked <N> <failing-check-names> -> label #N agent-blocked
# and comment the named failing check(s). Best-effort: a label/comment write
# that fails is not fatal to the reconcile pass (it must keep merging the rest).
# Resolve the label id by NAME (ids differ per repo — GOTCHAS 2).
landing_park_agent_blocked() {
  local n="${1:?landing_park_agent_blocked: issue number required}" failing="${2:-(unnamed check)}"
  local labels_json lid
  labels_json="$(forgejo_get '/labels?limit=100' 2>/dev/null || true)"
  lid="$(forgejo_label_id "$labels_json" agent-blocked)"
  [ -n "$lid" ] && forgejo_add_labels "$n" "$lid" >/dev/null 2>&1
  forgejo_comment "$n" "MERGE_AUTHORITY=agent-after-green: the PR's required checks are RED — $failing failed. Parking #$n \`agent-blocked\`; a human resolves the failing check(s) and re-arms it." 2>/dev/null || true
  return 0
}

# landing_merge_if_green <N> -> merge the issue's open agent PR iff every
# required check is green, honouring MERGE_AUTHORITY. Echoes ONE status token
# and ALWAYS returns 0 (a reconcile pass over many PRs must not abort on one):
#   not-authorized     MERGE_AUTHORITY != agent-after-green — never merges
#   no-pr              no open agent/issue-<N> PR to act on
#   pending            checks not all green yet (or none reported) — left for
#                      the next run's reconcile pass to retry
#   merged <pr>        every required check success -> PR merged (rebase|merge
#                      per the repo's Forgejo setting, never squash); the PR's
#                      `closes #<N>` closes the issue
#   merge-failed <pr> <code>  green, but the merge POST did not return 2xx
#   blocked <checks>   a required check FAILED -> #N labelled agent-blocked,
#                      the failing check(s) named
landing_merge_if_green() {
  local n="${1:?landing_merge_if_green: issue number required}"
  if [ "${SWARM_POLICY_MERGE_AUTHORITY:-human}" != agent-after-green ]; then
    printf 'not-authorized\n'; return 0
  fi
  local pr
  pr="$(landing_open_pr_for "$n")" && [ -n "$pr" ] || { printf 'no-pr\n'; return 0; }
  local combined state
  combined="$(forgejo_pr_combined_status "$pr" 2>/dev/null)" || { printf 'pending\n'; return 0; }
  state="$(jq -r '.state // "" | ascii_downcase' <<<"$combined" 2>/dev/null)"
  case "$state" in
    success)
      local style code
      style="$(forgejo_repo_default_merge_style)"
      code="$(forgejo_merge_pr "$pr" "$style")"
      case "$code" in
        2*) printf 'merged %s\n' "$pr" ;;
        *)  printf 'merge-failed %s %s\n' "$pr" "$code" ;;
      esac
      ;;
    failure|error)
      local failing
      failing="$(jq -r '[.statuses[]?
                          | (.status // "" | ascii_downcase) as $s
                          | select($s == "failure" or $s == "error")
                          | .context // empty]
                         | map(select(. != "")) | join(", ")' <<<"$combined" 2>/dev/null)"
      [ -n "$failing" ] || failing="(unnamed check)"
      landing_park_agent_blocked "$n" "$failing"
      printf 'blocked %s\n' "$failing"
      ;;
    *)
      printf 'pending\n'   # pending / empty / unknown -> the next run retries
      ;;
  esac
  return 0
}

# landing_open_agent_issues -> newline list of issue numbers that have an OPEN
# agent/issue-<N> PR right now. The reconcile pass's work set is EVERY open
# agent PR, not only this run's touched issues — a PR whose checks went green
# AFTER its run ended must still land (#15).
landing_open_agent_issues() {
  local resp
  resp="$(forgejo_get '/pulls?state=open&limit=50')" || return 1
  jq -r '.[]? | (.head.ref // "") | select(startswith("agent/issue-")) | ltrimstr("agent/issue-")' \
    <<<"$resp" 2>/dev/null
}

# landing_merge_reconcile -> the run-swarm reconcile fan-out for agent-after-green:
# for EVERY open agent PR, attempt landing_merge_if_green and echo one
# "<N> <result>" line per PR acted on. A no-op (echoes nothing, rc 0) under
# MERGE_AUTHORITY=human. Called from run-swarm.sh's pr-mode reconcile pass so a
# PR that turned green after its own run still merges here (#15).
landing_merge_reconcile() {
  [ "${SWARM_POLICY_MERGE_AUTHORITY:-human}" = agent-after-green ] || return 0
  local n res
  while read -r n; do
    [ -n "$n" ] || continue
    res="$(landing_merge_if_green "$n")"
    printf '%s %s\n' "$n" "$res"
  done < <(landing_open_agent_issues)
}

# landing_issue_has_live_claim <N> -> rc 0 iff issue #N still carries the
# agent-working label (a LIVE claim). The janitor (schedule_janitor_rearm) runs
# at the TOP of every tick and strips agent-working off any dead claim, so the
# label's presence here means an in-flight worker owns the ticket — the idle
# sweep must leave its PR alone. Reuses the SAME agent-working predicate the
# janitor and the re-arm agree on (#114). rc 0 (assume claimed) also on an API
# read failure: the dangerous action is merging/closing an IN-FLIGHT worker's
# PR, so "can't verify" must skip, never act.
landing_issue_has_live_claim() {
  local n="${1:?landing_issue_has_live_claim: issue number required}" resp
  resp="$(forgejo_get "/issues/$n")" || return 0
  jq -e '[.labels[]?.name] | index("agent-working") != null' <<<"$resp" >/dev/null 2>&1
}

# landing_sweep_orphans -> the IDLE-path landing sweep (#114). pr-mode +
# agent-after-green only; a no-op (echoes nothing, rc 0) otherwise. run-swarm.sh
# calls it on the no-ready-tasks path, because an ORPHANED green agent PR — a
# worker SIGKILLed after opening its PR but before close-report (a runner
# restart) — hides its own issue from the ready list (an open agent PR looks
# in-flight), so n==0 and the run would otherwise exit before landing_stage's
# reconcile ever runs. That is the whole deadlock: the one thing that would merge
# the PR is gated behind having OTHER work to do.
#
# For EVERY open agent/issue-<N> PR whose issue carries NO live claim, reconcile
# it the same way landing_stage's reconcile would:
#   green + mergeable            -> merge (landing_merge_if_green; `closes #N`
#                                   closes the issue) + a one-line audit comment
#                                   noting the worker left no close-report
#   green + NOT mergeable (drift) -> close the PR so the issue re-arms for a
#                                   fresh worker on current main
#   pending                      -> left for a later tick (echoed, so the caller
#                                   still knows work exists)
#   red                          -> landing_park_agent_blocked (inside merge-if-green)
# Echoes one "<N> <result>" line per PR ACTED ON; a PR whose issue still carries
# a live claim is skipped SILENTLY (no line) so an in-flight worker's own PR is
# untouched. The caller keys the run's exit reason on whether ANY line was
# emitted — so a tick with an unclaimed open agent PR never reports
# no-ready-tasks.
landing_sweep_orphans() {
  [ "${SWARM_POLICY_LANDING:-push}" = pr ] || return 0
  [ "${SWARM_POLICY_MERGE_AUTHORITY:-human}" = agent-after-green ] || return 0
  local n res pr
  while read -r n; do
    [ -n "$n" ] || continue
    landing_issue_has_live_claim "$n" && continue
    res="$(landing_merge_if_green "$n")"
    case "$res" in
      "merged "*)
        forgejo_comment "$n" "Landed by the idle landing sweep (#114): this agent PR was green but its worker left no close-report — killed after opening the PR. The sweep merged it; \`closes #$n\` closes the issue." 2>/dev/null || true
        ;;
      "merge-failed "*)
        pr="${res#merge-failed }"; pr="${pr%% *}"
        # Green, but the merge POST failed. If the branch is no longer mergeable
        # (drifted off main — pnpm-lock.yaml / STATUS.md), close the PR so #N
        # drops back into the ready list for a fresh worker on current main. A
        # merge that failed with the branch STILL mergeable is transient — leave
        # it as merge-failed for the next tick to retry.
        if [ "$(forgejo_pr_mergeable "$pr")" = false ]; then
          forgejo_comment "$n" "Idle landing sweep (#114): this agent PR is green but no longer mergeable — its branch drifted off main. Closing PR #$pr so #$n re-arms for a fresh worker on current main." 2>/dev/null || true
          forgejo_close_pr "$pr" >/dev/null 2>&1 || true
          res="closed-drifted $pr"
        fi
        ;;
    esac
    printf '%s %s\n' "$n" "$res"
  done < <(landing_open_agent_issues)
}

# ── the LAND seam of run-swarm.sh (#2) ─────────────────────────────────────
# The two modes' whole reconcile pass, so the orchestrator carries one call
# rather than a 45-line rescue ladder inline.

LANDING_NOTIFY="${LANDING_NOTIFY:-$__landing_lib_here/notify-mattermost.sh}"

# landing_note_pr_opened <repo-slug> <ready-nums> [started-epoch] — append a
# PROVISIONAL host runlog breadcrumb (reason=pr-opened) the MOMENT a run opens/
# refreshes an agent PR, mirroring verdict_breadcrumb_write's eager-write
# discipline (#114). A SIGKILL between opening the PR and the worker's
# close-report — the runner-restart signature — cannot run the EXIT trap, so the
# run would otherwise leave NO row at all; this line is on disk before the merge
# pass, so a later kill leaves evidence rather than a missing row. A clean run
# still appends its terminal reason=completed line from on_exit, so this is an
# extra breadcrumb, not the final record. Best-effort: never fails the land seam,
# and a no-op when the runlog helpers aren't sourced (unit-test isolation).
landing_note_pr_opened() {
  command -v runlog_append >/dev/null 2>&1 || return 0
  command -v runlog_line   >/dev/null 2>&1 || return 0
  local repo_slug="$1" ready_nums="$2" started="${3:-${run_started:-}}" now
  now="$(date +%s)"
  [ -n "$started" ] || started="$now"
  runlog_append "${SWARM_RUNLOG:-$HOME/swarm/logs/run-swarm-verdicts.log}" \
    "$(runlog_line "$started" "$now" "$repo_slug" "$ready_nums" pr-opened -)"
}

# The stage's outputs (a bash function returns one rc, and both are consumed by
# the report seam).
LANDING_OPENED_PRS=""
LANDING_MERGED_PRS=""

_landing_notify() { bash "$LANDING_NOTIFY" "$1" || true; }

# landing_resolve_rebase_with_claude — hand a mid-rebase checkout to a headless
# claude. Merging both sides of a STATUS.md entry is judgement work a text merge
# can't do: its one-line header collides with any concurrent edit. rc 0 only if
# the rebase actually completed.
landing_resolve_rebase_with_claude() {
  command -v claude >/dev/null 2>&1 || return 1
  timeout 900 claude -p --model "$SWARM_MODEL" --dangerously-skip-permissions \
    "This git checkout is mid-rebase with conflicts. Finish the rebase: resolve every conflicted file preserving BOTH sides' intent — for STATUS.md keep both milestone-log entries (newest first) and merge the one-line header so it reflects the newest state plus any facts only one side carries. Then 'git add' the resolved files and 'GIT_EDITOR=true git rebase --continue'; repeat until the rebase completes. NEVER 'git rebase --abort', never force-push, never delete either side's content." \
    || return 1
  [ ! -e .git/rebase-merge ] && [ ! -e .git/rebase-apply ]
}

# landing_push_main_with_rescue <repo-slug> — push mode's ladder.
#
# A human may have pushed to main during the (long) sandcastle run. The agent's
# commits are freshly authored, so rebase-and-retry is safe — and necessary: the
# issues are already closed, so abandoned commits would otherwise be silently
# discarded by the next run's reset --hard. (Agents also push per iteration —
# prompt step 6 — so this final push is usually a no-op; the rebase deduplicates
# patch-identical commits.)
#
# If even claude can't land the push, NEVER die with the commits stranded: park
# HEAD on a rescue branch, alert, and fail — a human cherry-picks from there.
# (Run 330 lost three closed-issue commits before this ladder existed.)
# rc 1 + SWARM_EXIT_REASON=push-parked-on-rescue when it parks.
landing_push_main_with_rescue() {
  local repo_slug="$1" pushed="" rescue
  git push origin HEAD:main && return 0
  git fetch origin main
  if git rebase origin/main; then
    git push origin HEAD:main && pushed=1
  elif landing_resolve_rebase_with_claude; then
    git push origin HEAD:main && pushed=1
  fi
  [ -z "$pushed" ] || return 0
  git rebase --abort 2>/dev/null || true
  rescue="sandcastle/rescue-$(date -u +%Y%m%d-%H%M%S)"
  git push origin "HEAD:refs/heads/$rescue"
  _landing_notify ":rotating_light: **Swarm push failed after issues were closed** in \`$repo_slug\` — commits parked on \`$rescue\`. Cherry-pick them onto main or the work is lost (the issues will NOT retry)."
  SWARM_EXIT_REASON="push-parked-on-rescue"
  return 1
}

# landing_stage <repo-slug> <ready-json> <start-sha> — the whole land seam.
#
# pr mode (#13): land each issue this run touched on its own agent/issue-<N>
# branch and open/refresh its PR (closes #<N>); a human — or agent-after-green —
# merges. No push to main here (that would bypass the PR); the rescue ladder is
# the push-mode path only. Touched = the pickup set + any #NN scraped from this
# run's commit subjects (a mid-run close can unblock a child).
#
# Sets LANDING_OPENED_PRS / LANDING_MERGED_PRS for the report seam. rc 1 only
# when push mode parked on a rescue branch.
landing_stage() {
  local repo_slug="$1" ready="$2" start_sha="$3" nums
  LANDING_OPENED_PRS=""; LANDING_MERGED_PRS=""
  if [ "${SWARM_POLICY_LANDING:-push}" = pr ]; then
    verdict_stage "reconcile landing (pr — branch + PR per issue)"
    # `|| true` on the scrape: a run whose commit subjects cite NO `#NN` makes
    # grep exit 1, and under the caller's `set -o pipefail` that non-zero rippled
    # out of the command substitution and killed the whole reconcile stage —
    # after the work was already committed. Same class as #21's foreign-`#NN`
    # 404; surfaced by the #2 decomposition's test for this seam.
    nums="$({ jq -r '.[].number' <<<"$ready";
        git log --format=%s "$start_sha"..HEAD | grep -oE '#[0-9]+' | tr -d '#' || true; } | sort -un)"
    # shellcheck disable=SC2086 — the number list is deliberately word-split.
    LANDING_OPENED_PRS="$(landing_reconcile $nums || true)"
    # #114: a provisional pr-opened runlog breadcrumb the instant a PR is
    # open/refreshed, BEFORE the (possibly slow) merge pass — so a runner-restart
    # SIGKILL between here and the worker's close-report leaves evidence on disk.
    [ -n "$LANDING_OPENED_PRS" ] && \
      landing_note_pr_opened "$repo_slug" "$(jq -r '[.[].number]|join(",")' <<<"$ready" 2>/dev/null)"
    # agent-after-green (#15): merge EVERY open agent PR whose required checks are
    # green — including PRs from EARLIER runs that only went green after their own
    # run ended. A no-op under MERGE_AUTHORITY=human.
    LANDING_MERGED_PRS="$(landing_merge_reconcile || true)"
    return 0
  fi
  verdict_stage "reconcile push to main"
  landing_push_main_with_rescue "$repo_slug"
}

fi
