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
# shellcheck source=policy-lib.sh
. "$__landing_lib_here/policy-lib.sh"   # policy_ticket_landing / _merge_authority — the per-ticket override's allowlist (idss ADR 0267); safe to source twice
# shellcheck source=limit-lib.sh
. "$__landing_lib_here/limit-lib.sh"   # claude_limit_hit / claude_auth_failed — the rebase resolver is classified like every other claude caller (#207); pure, safe to source twice
# shellcheck source=body-marker-lib.sh
. "$__landing_lib_here/body-marker-lib.sh"   # body_marker — the fence-aware gates-passed marker check (#206)

# The marker close-report.sh stamps on a PR once its claim gates pass (#206). An
# agent merge (landing_merge_if_green) requires it, so a green PR whose worker
# never ran a verified close-report — an orphan, or a bare green branch — is no
# longer merged on green alone. HTML-comment form so body-marker-lib reads it
# fence-aware (key `close-report`, value `gates-passed`).
LANDING_GATES_MARKER='<!-- close-report: gates-passed -->'

# landing_pr_gates_passed <pr> -> rc 0 iff a comment on the PR carries the
# close-report gates-passed marker OUTSIDE any fenced block. Fails CLOSED (rc 1)
# when the comments cannot be read: the dangerous action is merging an
# unverified PR, so "can't tell" must never merge.
landing_pr_gates_passed() {
  local pr="${1:?landing_pr_gates_passed: pr number required}" comments n i body
  comments="$(forgejo_get "/issues/$pr/comments" 2>/dev/null)" || return 1
  n="$(jq 'length' <<<"$comments" 2>/dev/null)" || return 1
  [ -n "$n" ] || return 1
  for ((i = 0; i < n; i++)); do
    body="$(jq -r ".[$i].body // \"\"" <<<"$comments" 2>/dev/null)"
    [ "$(body_marker "$body" close-report 2>/dev/null)" = gates-passed ] && return 0
  done
  return 1
}

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

# landing_superseded_by_pr_for <N> -> echo the number of a MERGED PR (from a
# branch OTHER than agent/issue-<N>) that closed issue N via `closes #N`, and
# exit 0, iff the issue is now CLOSED and such a PR exists; exit 1 (no output)
# otherwise. #151: a multi-host race lets two hosts each complete the same
# ticket — the winner merges (often on a sandcastle/worker/* branch, which
# landing_merged_pr_for, agent-branch-only by #108 design, never sees) and its
# `closes #N` closes the issue on main. The loser's close-report consults this
# to recognise the work already landed and self-close as SUPERSEDED, rather than
# dead-end `agent-blocked`. Gated on the issue reading `closed`: a still-open
# issue is never superseded (the #13 no-open-PR refusal must still fire), so the
# body-scan alone can never self-close live work.
landing_superseded_by_pr_for() {
  local n="${1:?landing_superseded_by_pr_for: issue number required}" state num
  state="$(forgejo_get "/issues/$n" 2>/dev/null | jq -r '.state // ""' 2>/dev/null)" || return 1
  [ "$state" = closed ] || return 1
  num="$(forgejo_closing_merged_pr "$n" "$(landing_branch_for "$n")")" || return 1
  [ -n "$num" ] || return 1
  printf '%s\n' "$num"
}

# ── the per-ticket override (idss ADR 0267) ─────────────────────────────────
# SWARM_POLICY_LANDING / _MERGE_AUTHORITY are the repo's DEFAULT. A ticket
# carrying `landing-pr` lands as pr + human merge whatever the default. Every
# seam below asks THESE functions, never the repo knob directly.

# landing_ticket_label <N> -> the ticket's first `landing-*` label name on
# stdout (empty when it carries none); rc 1, loud, when the tracker cannot be
# read. Raw-capture then filter (never curl|jq). No cache on purpose: every
# caller is a `$(…)` subshell, where a cache would be thrown away anyway.
landing_ticket_label() {
  local n="${1:?landing_ticket_label: issue number required}" resp
  resp="$(forgejo_get "/issues/$n" 2>/dev/null)" \
    || { echo "landing: could not read #$n's labels — refusing to guess how it lands" >&2; return 1; }
  jq -r '[.labels[]?.name | select(startswith("landing-"))][0] // ""' <<<"$resp" 2>/dev/null
}

# landing_mode_for <N> -> push|pr. A LANDING=pr repo answers without a tracker
# call (no override can loosen it). rc 1 when the ticket cannot be read or
# carries a landing-* label off the allowlist — the caller must NOT land.
landing_mode_for() {
  local n="${1:?landing_mode_for: issue number required}" label
  if [ "${SWARM_POLICY_LANDING:-push}" = pr ]; then printf 'pr\n'; return 0; fi
  label="$(landing_ticket_label "$n")" || return 1
  policy_ticket_landing "$label" push
}

# landing_merge_authority_for <N> -> human|agent-after-green. A human-authority
# repo answers without a tracker call. An unreadable ticket fails CLOSED to
# human: the dangerous action is an agent merging a PR a person was owed.
landing_merge_authority_for() {
  local n="${1:?landing_merge_authority_for: issue number required}" label
  local repo="${SWARM_POLICY_MERGE_AUTHORITY:-human}"
  if [ "$repo" = human ]; then printf 'human\n'; return 0; fi
  label="$(landing_ticket_label "$n" 2>/dev/null)" || { printf 'human\n'; return 0; }
  policy_ticket_merge_authority "$label" "$repo"
}

# landing_pr_tickets_cited <start-sha> -> the numbers (one per line) of tickets
# named in this run's commit SUBJECTS that land by PR. Subjects only — the
# `sandcastle: #N …` convention names the ticket worked; a body's "see #N" is a
# reference. Fail-OPEN per ticket: an unreadable or foreign #N is skipped.
landing_pr_tickets_cited() {
  local start="${1:?landing_pr_tickets_cited: start sha required}" nums n mode
  nums="$(git log --format=%s "$start"..HEAD 2>/dev/null | grep -oE '#[0-9]+' | tr -d '#' | sort -un || true)"
  for n in $nums; do
    mode="$(landing_mode_for "$n" 2>/dev/null)" || continue
    [ "$mode" = pr ] && printf '%s\n' "$n"
  done
  return 0
}

# landing_evidence_gate <N> <pr> -> rc 0 when the PR carries its evidence:
# at least ONE image asset attached to the PR, or a body line reading exactly
#     **Screenshots:** none — <reason>
# (em dash, non-empty reason — the waiver for a fix with no visible surface).
# rc 1 = missing (one reason line on stdout); rc 2 = could not verify.
landing_evidence_gate() {
  local n="${1:?landing_evidence_gate: issue number required}" pr="${2:?landing_evidence_gate: pr number required}"
  local prj assets nimg
  prj="$(forgejo_get "/pulls/$pr" 2>/dev/null)" || return 2
  if jq -r '.body // ""' <<<"$prj" 2>/dev/null | tr -d '\r' \
       | grep -Eq '^\*\*Screenshots:\*\* none — [^[:space:]].*$'; then
    return 0
  fi
  assets="$(forgejo_get "/issues/$pr/assets" 2>/dev/null)" || return 2
  nimg="$(jq '[.[]? | select((.name // "") | test("\\.(png|jpe?g|webp|gif)$"; "i"))] | length' <<<"$assets" 2>/dev/null)"
  [ "${nimg:-0}" -gt 0 ] && return 0
  printf 'PR #%s for #%s carries no screenshot and no `**Screenshots:** none — <reason>` line\n' "$pr" "$n"
  return 1
}

# landing_park_evidence_blocked <N> <pr> -> label #N agent-blocked and say why on
# both threads. Best-effort (rc 0): the reconcile pass must not die on a label
# write. Skips a ticket already parked, so a re-run does not stack comments.
landing_park_evidence_blocked() {
  local n="${1:?landing_park_evidence_blocked: issue number required}" pr="${2:?}" issue labels_json lid
  issue="$(forgejo_get "/issues/$n" 2>/dev/null || true)"
  if jq -e '[.labels[]?.name] | index("agent-blocked") != null' <<<"$issue" >/dev/null 2>&1; then return 0; fi
  labels_json="$(forgejo_get '/labels?limit=100' 2>/dev/null || true)"
  lid="$(forgejo_label_id "$labels_json" agent-blocked)"
  [ -n "$lid" ] && forgejo_add_labels "$n" "$lid" >/dev/null 2>&1
  local why="This ticket carries \`landing-pr\`: its PR (#$pr) must show after-fix screenshots, or the line \`**Screenshots:** none — <reason>\` when the fix has no visible surface. It has neither, so it is parked \`agent-blocked\` BEFORE anyone is asked to review it. Attach the evidence (\`bash .sandcastle/land-pr.sh $n … <screenshot.png>\`) and re-arm."
  forgejo_comment "$n" "$why" 2>/dev/null || true
  forgejo_comment "$pr" "$why" 2>/dev/null || true
  return 0
}

# landing_push <N> [title] [extra-body] -> land HEAD for issue <N>.
#   a ticket that resolves to push: git push <remote> HEAD:refs/heads/main
#              (today's behaviour). rc = git's.
#   a ticket that resolves to pr:   push HEAD to agent/issue-<N>, then open a PR
#              (closes #<N>) unless one is already open; echo the PR number on
#              stdout. rc non-zero if the branch push or the PR-open failed.
# <remote> is LANDING_PUSH_REMOTE (default origin) — land-pr.sh sets it to a
# token URL inside the sandbox.
landing_push() {
  local n="${1:?landing_push: issue number required}" mode
  local remote="${LANDING_PUSH_REMOTE:-origin}"
  # Per ticket (idss ADR 0267): the repo knob is only the default. An unreadable
  # ticket lands NOWHERE — better a loud failure than a PR ticket on main.
  mode="$(landing_mode_for "$n")" || return 1
  if [ "$mode" != pr ]; then
    git push "$remote" "HEAD:refs/heads/main"
    return
  fi
  local branch num resp ahead
  branch="$(landing_branch_for "$n")"
  # Empty-shell guard (matou-app#145): a worker that dies before committing
  # still reaches the reconcile with HEAD == origin/main. Pushing that branch
  # and opening a PR makes a zero-commit shell whose CI runs green (it is main
  # re-tested), and list-ready-tasks then drops the ticket as "being landed" —
  # starving it until a human closes the shell. No commits, no branch, no PR.
  # Fail-open when rev-list itself cannot answer (no origin/main in an odd
  # checkout): the guard only refuses on a provable empty range.
  ahead="$(git rev-list --count origin/main..HEAD 2>/dev/null)" || ahead=""
  if [ "$ahead" = 0 ]; then
    echo "landing_push: refusing $branch — HEAD has no commits beyond origin/main (empty-shell guard, matou-app#145)" >&2
    return 1
  fi
  git push "$remote" "HEAD:refs/heads/$branch" || return 1
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
#   no-close-report    green, but the PR carries no close-report gates-passed
#                      marker (#206) — an orphan / unverified PR is NOT merged
#   merged <pr>        every required check success AND the gates-passed marker
#                      present -> PR merged (rebase|merge per the repo's Forgejo
#                      setting, never squash); the PR's `closes #<N>` closes it
#   merge-failed <pr> <code>  green + marked, but the merge POST did not return 2xx
#   blocked <checks>   a required check FAILED -> #N labelled agent-blocked,
#                      the failing check(s) named
landing_merge_if_green() {
  local n="${1:?landing_merge_if_green: issue number required}"
  # Per ticket (idss ADR 0267): a landing-pr ticket is merged by a HUMAN even in
  # an agent-after-green repo.
  if [ "$(landing_merge_authority_for "$n")" != agent-after-green ]; then
    printf 'not-authorized\n'; return 0
  fi
  local pr
  pr="$(landing_open_pr_for "$n")" && [ -n "$pr" ] || { printf 'no-pr\n'; return 0; }
  local combined state
  combined="$(forgejo_pr_combined_status "$pr" 2>/dev/null)" || { printf 'pending\n'; return 0; }
  state="$(jq -r '.state // "" | ascii_downcase' <<<"$combined" 2>/dev/null)"
  case "$state" in
    success)
      # #206: green is necessary but not sufficient — merge only a PR whose
      # worker ran a verified close-report (the gates-passed marker). A killed
      # worker's orphan PR, or any green branch that never closed a report, is
      # left for a human (or a fresh worker), never auto-merged on green alone.
      if ! landing_pr_gates_passed "$pr"; then
        printf 'no-close-report\n'; return 0
      fi
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
        forgejo_comment "$n" "Landed by the idle landing sweep (#114): this agent PR's close-report gates had passed and its required checks are now green, so the sweep merged it (the worker's close-report left the merge for a later pass); \`closes #$n\` closes the issue." 2>/dev/null || true
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
    "$(runlog_line "$started" "$now" "$repo_slug" "$ready_nums" pr-opened - "${SWARM_RUN_ID:-}")"
}

# The stage's outputs (a bash function returns one rc, and both are consumed by
# the report seam).
LANDING_OPENED_PRS=""
LANDING_MERGED_PRS=""

_landing_notify() { bash "$LANDING_NOTIFY" "$1" || true; }

# The rebase resolver's tool allowlist (#207). It resolves conflict markers and
# drives the rebase forward — nothing more — so it carries EXACTLY the file-edit
# and git verbs that needs, never the old `--dangerously-skip-permissions` blanket
# that let a headless resolver run any tool and whose result then went STRAIGHT to
# main. `git push` is deliberately absent: the resolver resolves, it never lands —
# the harness re-tests and routes the result (to a PR, or a park).
LANDING_RESOLVE_ALLOWED_TOOLS="${LANDING_RESOLVE_ALLOWED_TOOLS:-Edit,Write,Bash(git add:*),Bash(git rebase:*),Bash(git status:*),Bash(git diff:*)}"

# landing_rebase_in_progress — 0 iff a rebase is still mid-flight (the on-disk
# rebase state). A seam so the resolver's completion test is drivable offline.
landing_rebase_in_progress() {
  [ -e .git/rebase-merge ] || [ -e .git/rebase-apply ]
}

# landing_resolve_rebase_with_claude [log] — hand a mid-rebase checkout to a
# headless claude under a BOUNDED allowlist (no push). Merging both sides of a
# STATUS.md entry is judgement work a text merge can't do: its one-line header
# collides with any concurrent edit. Output is tee'd to <log> (default /dev/null)
# so the caller can classify a refusal. rc 0 only if the rebase actually completed.
landing_resolve_rebase_with_claude() {
  local log="${1:-/dev/null}"
  command -v claude >/dev/null 2>&1 || return 1
  timeout 900 claude -p --model "$SWARM_MODEL" \
    --permission-mode acceptEdits --allowedTools "$LANDING_RESOLVE_ALLOWED_TOOLS" \
    "This git checkout is mid-rebase with conflicts. Finish the rebase: resolve every conflicted file preserving BOTH sides' intent — for STATUS.md keep both milestone-log entries (newest first) and merge the one-line header so it reflects the newest state plus any facts only one side carries. Then 'git add' the resolved files and 'GIT_EDITOR=true git rebase --continue'; repeat until the rebase completes. NEVER 'git rebase --abort', never force-push, never delete either side's content, and NEVER 'git push' — resolving is all you do; the harness re-tests the result and lands it." \
    2>&1 | tee "$log" >/dev/null
  ! landing_rebase_in_progress
}

# landing_resolve_classified <log> -> resolved | refused | failed
#   resolved  the rebase completed
#   refused   the resolver hit a usage limit or an auth-dead refusal (the log says
#             so) — a quiet DEFER, never a page: it rides the same classify
#             contract every other claude caller does (execute-lib #510/#632)
#   failed    claude ran but the rebase is still unresolved — a genuine red
landing_resolve_classified() {
  local log="$1"
  if landing_resolve_rebase_with_claude "$log"; then echo resolved; return 0; fi
  if claude_auth_failed "$log" || claude_limit_hit "$log"; then echo refused; return 0; fi
  echo failed
}

# landing_run_pinned_tests — run the repo's pinned HOST test command before a
# conflict-resolved HEAD may land anywhere (#207). LANDING_TEST_CMD is set by the
# consumer's identity layer; it is NEVER defaulted to any product's command. An
# UNSET command cannot verify, so it fails CLOSED (rc 1): an unverifiable
# resolution must park, never land. rc 0 = green.
landing_run_pinned_tests() {
  if [ -z "${LANDING_TEST_CMD:-}" ]; then
    echo "landing: no LANDING_TEST_CMD set — a rebase-conflict resolution cannot be re-tested on the host, so it must NOT land; parking it (#207)" >&2
    return 1
  fi
  ( eval "$LANDING_TEST_CMD" )
}

# landing_rescue_pr_body <repo-slug> — the rescue PR's body, built from the LIVE
# conflict state (call it BEFORE the resolver erases the markers): the conflicted
# file list (the review's confined-diff bound) and the conflict hunks quoted, so a
# human reviews the resolution rather than trusting an unattended agent's merge.
landing_rescue_pr_body() {
  local repo_slug="$1" files hunks
  files="$(git diff --name-only --diff-filter=U 2>/dev/null)"
  hunks="$(git diff 2>/dev/null | head -400)"
  printf 'A rebase conflict landing work on `main` in `%s` was resolved by a headless Claude under a bounded tool allowlist (#207), re-tested on the pinned host suite, and routed HERE rather than pushed straight to main.\n\n' "$repo_slug"
  printf 'Review before merge: confirm the resolution preserved BOTH sides and is confined to the conflicted files.\n\n'
  if [ -n "$files" ]; then
    printf 'Conflicted files:\n'; printf '%s\n' "$files" | sed 's/^/- `/; s/$/`/'; printf '\n'
  fi
  [ -n "$hunks" ] && printf 'Conflict hunks:\n```diff\n%s\n```\n' "$hunks"
  return 0
}

# landing_land_resolved_conflict <repo-slug> <pr-body> — the resolved HEAD is a
# post-conflict tree: NEVER push it to main (#207). Park it on a rescue branch
# (so the work is never lost), re-test on the pinned suite, then route a GREEN
# result to a PR for human review — or leave a RED one parked and page. rc 1 on
# every path (nothing ever lands on main here); SWARM_EXIT_REASON names which.
landing_land_resolved_conflict() {
  local repo_slug="$1" body="$2" rescue pr
  rescue="sandcastle/rescue-$(date -u +%Y%m%d-%H%M%S)"
  if ! git push origin "HEAD:refs/heads/$rescue"; then
    _landing_notify ":rotating_light: **Swarm resolved a rebase conflict but could NOT push the rescue branch** in \`$repo_slug\` — the forge is unreachable, so \`$rescue\` does NOT exist. The resolved commits live ONLY in the runner workdir \`$(pwd)\` at \`$(git rev-parse --short HEAD 2>/dev/null)\`; do NOT let it reset. Nothing was pushed to main."
    SWARM_EXIT_REASON="rebase-resolved-rescue-unreachable"
    return 1
  fi
  if landing_run_pinned_tests; then
    if pr="$(forgejo_create_pr "Rebase-conflict rescue — $repo_slug (#207)" "$rescue" main "$body" 2>/dev/null)" \
         && [ -n "$(jq -r '.number // empty' <<<"$pr" 2>/dev/null)" ]; then
      _landing_notify ":twisted_rightwards_arrows: **Swarm rebase conflict resolved → PR** in \`$repo_slug\` — a Claude-resolved rebase re-tested GREEN and was opened as a PR from \`$rescue\` for human review. It was NOT pushed to main."
      SWARM_EXIT_REASON="rebase-resolved-to-pr"
      return 1
    fi
    _landing_notify ":rotating_light: **Swarm resolved a rebase conflict (tests GREEN) but could NOT open its PR** in \`$repo_slug\` — the resolved commits are parked on \`$rescue\`. Open the PR from there by hand; they were NOT pushed to main."
    SWARM_EXIT_REASON="rebase-resolved-pr-open-failed"
    return 1
  fi
  _landing_notify ":rotating_light: **Swarm rebase-conflict resolution FAILED its re-test** in \`$repo_slug\` — a Claude-resolved rebase went RED on the pinned host suite. Parked on \`$rescue\` and NOT pushed. A human reviews the resolution before it can land."
  SWARM_EXIT_REASON="rebase-resolved-red-parked"
  return 1
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
# A CLEAN rebase (no conflict — no LLM touched the tree) still pushes straight to
# main. A rebase CONFLICT does NOT (#207): the resolver runs under a bounded
# allowlist and is classified like every other claude caller, and its resolved
# HEAD is re-tested and routed to a rescue PR (or parked) — NEVER pushed to main
# unverified. A limit/auth refusal defers quietly; a resolver that simply can't
# finish the rebase falls through to the park ladder below.
#
# If a clean push can't land, NEVER die with the commits stranded: park HEAD on a
# rescue branch, alert, and fail — a human cherry-picks from there. (Run 330 lost
# three closed-issue commits before this ladder existed.)
#
# The alarm must describe what is TRUE, not what the ladder intended. Two ways
# the old unconditional park lied — both seen in run 22240 (2026-09-12), when
# Forgejo flapped 503 for ~25m and every git op in the ladder failed:
#   - nothing to park (HEAD already on origin/main — only the transport failed),
#     yet it cried "cherry-pick them or the work is lost";
#   - the rescue push ALSO failed, so the named branch never existed, yet the
#     alarm sent a human hunting it while the commits sat in the workdir the
#     next run resets --hard.
# rc 1 on every non-landing path; SWARM_EXIT_REASON names which one.
landing_push_main_with_rescue() {
  local repo_slug="$1" pushed="" rescue body log
  git push origin HEAD:main && return 0
  git fetch origin main
  if git rebase origin/main; then
    # CLEAN rebase — the text merge needed no judgement, so no LLM touched the
    # tree. Safe to push, as before (#207 governs the CONFLICT path only).
    git push origin HEAD:main && pushed=1
  else
    # Rebase CONFLICT (#207). A conflict-resolved HEAD must NEVER go straight to
    # main: capture the PR body from the LIVE conflict state, resolve under a
    # bounded allowlist (classified like every other claude caller), then route
    # the result to a re-test + rescue PR — or a park — but never a direct push.
    body="$(landing_rescue_pr_body "$repo_slug")"
    log="$(mktemp 2>/dev/null || echo "/tmp/landing-resolve.$$.log")"
    case "$(landing_resolve_classified "$log")" in
      resolved)
        rm -f "$log"
        landing_land_resolved_conflict "$repo_slug" "$body"
        return ;;
      refused)
        rm -f "$log"
        git rebase --abort 2>/dev/null || true
        _landing_notify ":hourglass_flowing_sand: **Swarm rebase-rescue deferred — Claude usage limit / auth** in \`$repo_slug\` — the rebase conflict was NOT resolved and NOTHING was pushed. The commits stay in the runner workdir; the next run retries once the window resets."
        SWARM_EXIT_REASON="rebase-rescue-limit-parked"
        return 1 ;;
      *)
        # claude ran but could not finish the rebase — a genuine red. Fall through
        # to the honest-alarm park ladder below (it parks HEAD + pages).
        rm -f "$log"
        ;;
    esac
  fi
  [ -z "$pushed" ] || return 0
  git rebase --abort 2>/dev/null || true
  # Nothing of OURS to park: HEAD is contained in (the last known) origin/main,
  # so the push carried no commits and only the transport failed. Staleness is
  # safe here — a commit of ours could not already be in origin/main — so this
  # only ever skips a park that would have been empty. Fail honestly; the ready
  # issues are untouched and the next run retries.
  if git merge-base --is-ancestor HEAD origin/main 2>/dev/null; then
    _landing_notify ":warning: **Swarm push to main failed with nothing to land** in \`$repo_slug\` — HEAD is already on \`origin/main\`, so no commits are at risk (the forge was most likely unreachable). The next run retries."
    SWARM_EXIT_REASON="push-failed-nothing-to-land"
    return 1
  fi
  rescue="sandcastle/rescue-$(date -u +%Y%m%d-%H%M%S)"
  if git push origin "HEAD:refs/heads/$rescue"; then
    _landing_notify ":rotating_light: **Swarm push failed after issues were closed** in \`$repo_slug\` — commits parked on \`$rescue\`. Cherry-pick them onto main or the work is lost (the issues will NOT retry)."
    SWARM_EXIT_REASON="push-parked-on-rescue"
  else
    # The park itself could not reach the forge. NOTHING is on origin — name
    # where the commits actually are, and that the next run's reset --hard is
    # what destroys them.
    _landing_notify ":rotating_light: **Swarm push failed after issues were closed AND the rescue branch could not be pushed** in \`$repo_slug\` — the forge is unreachable, so \`$rescue\` does NOT exist. The commits live ONLY in the runner workdir \`$(pwd)\` at \`$(git rev-parse --short HEAD 2>/dev/null)\` — do NOT let it reset; push or cherry-pick from there once the forge answers (the issues will NOT retry)."
    SWARM_EXIT_REASON="push-rescue-unreachable"
  fi
  return 1
}

# landing_pp_breach_guard <repo-slug> — the landing seam's last-line-of-defense
# (#193). The HOST promotes a push-mode worker branch to `main` only AFTER the
# verify stage; verify_protected_paths rolls a machinery edit back and raises
# VERIFY_PP_VIOLATION. run-swarm's ordering already reds the run before this seam
# on a breach (`verify_protected_paths … || exit 1`), but the single most
# dangerous operation in the harness is a push to `main`, so the land seam
# refuses it independently: if a breach is flagged, park HEAD on a rescue branch
# (never lose the commits), alarm, and fail — NEVER push `main`. rc 0 = no breach,
# proceed; rc 1 = breach, parked, do not land. SWARM_EXIT_REASON names it.
landing_pp_breach_guard() {
  local repo_slug="$1" rescue
  [ "${VERIFY_PP_VIOLATION:-}" = 1 ] || return 0
  rescue="sandcastle/rescue-$(date -u +%Y%m%d-%H%M%S)"
  git push origin "HEAD:refs/heads/$rescue" 2>/dev/null || true
  _landing_notify ":rotating_light: **Swarm did NOT land \`main\`** in \`$repo_slug\` — a protected-path breach was flagged this run (#193/#445), so the land seam refused to push \`main\`. HEAD is parked on \`$rescue\` for a human to triage; the machinery edit was already rolled back by verify."
  SWARM_EXIT_REASON="protected-path-violation"
  return 1
}

# The label the false-green reconcile reopens a stranded close ONTO (#283). A
# human-adjacent standing session (the session-runner drainer) drains this queue
# and lands direct, so a close whose machinery-adjacent work the worker swarm
# could not land (the #280 protected-path deadlock) is redone where it can land,
# rather than looped straight back at the swarm that keeps tripping. Overridable
# for a repo whose reopen queue differs.
LANDING_REOPEN_LABEL="${LANDING_REOPEN_LABEL:-ready-for-session}"

# landing_reopen_stranded_closes <attempts-file> <repo-slug> [main-ref] — the
# false-green reconcile (#283). A push-mode close-report (close-report.sh) runs
# INSIDE the worker sandbox and closes its issue against the PUSHED worker branch,
# BEFORE the HOST lands `main`. When the host's post-run verify rolls the land
# back — a protected-path breach (landing_pp_breach_guard / verify_protected_paths,
# #193/#445), or a push that could not land (landing_push_main_with_rescue parked
# it) — `main` never gains the commits the issue was closed against, yet the issue
# reads `closed` with a comment claiming success. Nothing else ever reopens it:
# this is the inverse of #244 (false refusal) at the same seam, and it silently
# loses landed-looking work (#272/#273/#278 on every run of the #280 deadlock).
#
# <attempts-file> carries this run's SANDCASTLE_ATTEMPT protocol lines (execute-lib
# captures them before cleaning the sandcastle log). For each `outcome=success`
# line whose claimed commits are NOT all reachable from <main-ref> (default
# origin/main) AND whose issue currently reads `closed`, REOPEN it: PATCH
# state:open, relabel LANDING_REOPEN_LABEL, and comment exactly why. The
# reachability guard is the safety: a close whose commits DID land (a clean push
# earlier in the ladder, or an already-on-main prior run) is left closed — only a
# genuinely stranded close is reopened, so this can never reopen honest work.
# Echoes one "<N> reopened" line per issue reopened; rc 0 always (a reconcile over
# many must never abort on one). A no-op (echoes nothing) when the file is absent
# or empty — a run whose worker closed nothing.
landing_reopen_stranded_closes() {
  local attempts="${1:-}" repo_slug="${2:-}" main_ref="${3:-origin/main}"
  [ -n "$attempts" ] && [ -r "$attempts" ] || return 0
  local line issue commits_csv c stranded state labels_json lid old_ifs
  while IFS= read -r line; do
    case "$line" in "SANDCASTLE_ATTEMPT "*) ;; *) continue ;; esac
    case "$line" in *" outcome=success "*) ;; *) continue ;; esac
    issue="$(printf '%s\n' "$line" | sed -n 's/.*issue=\([0-9][0-9]*\).*/\1/p')"
    [ -n "$issue" ] || continue
    commits_csv="$(printf '%s\n' "$line" | sed -n 's/.*commits=\([^ ]*\).*/\1/p')"
    [ -n "$commits_csv" ] || continue   # an empty-commit close cannot be judged here
    # Stranded iff ANY claimed commit is not an ancestor of main_ref. All-reachable
    # means the close genuinely landed — leave it closed.
    stranded=""; old_ifs="$IFS"; IFS=','
    for c in $commits_csv; do
      [ -n "$c" ] || continue
      git merge-base --is-ancestor "$c" "$main_ref" 2>/dev/null || { stranded=1; break; }
    done
    IFS="$old_ifs"
    [ -n "$stranded" ] || continue
    # Only reopen a currently-CLOSED issue — never disturb one a human already
    # reopened, and never re-PATCH one still open.
    state="$(forgejo_get "/issues/$issue" 2>/dev/null | jq -r '.state // ""' 2>/dev/null || true)"
    [ "$state" = closed ] || continue
    forgejo_reopen_issue "$issue" >/dev/null 2>&1 || true
    labels_json="$(forgejo_get '/labels?limit=100' 2>/dev/null || true)"
    lid="$(forgejo_label_id "$labels_json" "$LANDING_REOPEN_LABEL")"
    if [ -n "$lid" ]; then
      forgejo_add_labels "$issue" "$lid" >/dev/null 2>&1 || true
    else
      echo "landing: warning: label '$LANDING_REOPEN_LABEL' not on the tracker — reopened #$issue but could not re-queue it" >&2
    fi
    forgejo_comment "$issue" ":rotating_light: **Reopened — a push-mode close did NOT land on \`main\` (#283).** close-report closed this issue against the pushed worker branch, but the host's post-run verify rolled the land back (\`${SWARM_EXIT_REASON:-the land did not advance main}\`), so \`$main_ref\` never carried the commits (\`$commits_csv\`). The gates-passed comment above is therefore NOT true of \`main\`. Reopening and relabelling \`$LANDING_REOPEN_LABEL\` so the work is redone where it can land; the commits are parked on a rescue branch for triage (see this run's alarm)." 2>/dev/null || true
    printf '%s reopened\n' "$issue"
  done < "$attempts"
  return 0
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
# when push mode could not land (parked, or could not even park).
landing_stage() {
  local repo_slug="$1" ready="$2" start_sha="$3" nums
  LANDING_OPENED_PRS=""; LANDING_MERGED_PRS=""
  # idss ADR 0267 — a push-default repo whose run was fixed to ONE landing-pr
  # ticket (preflight_landing_gate). HEAD carries that ticket's commits, so this
  # run NEVER pushes main: refresh the ticket's branch + PR (the worker's
  # land-pr.sh normally did both already — idempotent), then look at the evidence
  # host-side, because a worker killed before close-report never ran its gate.
  case "${SWARM_RUN_LANDING:-}" in
    "pr "[0-9]*)
      local prn="${SWARM_RUN_LANDING#pr }" pr ev_rc
      verdict_stage "reconcile landing (pr — #$prn carries landing-pr)"
      LANDING_OPENED_PRS="$(landing_reconcile "$prn" || true)"
      [ -n "$LANDING_OPENED_PRS" ] && landing_note_pr_opened "$repo_slug" "$prn"
      if pr="$(landing_open_pr_for "$prn")" && [ -n "$pr" ]; then
        ev_rc=0; landing_evidence_gate "$prn" "$pr" >/dev/null 2>&1 || ev_rc=$?
        [ "$ev_rc" -eq 1 ] && landing_park_evidence_blocked "$prn" "$pr"
      elif [ "$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)" != 0 ]; then
        # Commits exist and no PR could be opened (the tracker was unreadable, or
        # the branch push was refused). Never strand them, never push them to main.
        local rescue; rescue="sandcastle/rescue-$(date -u +%Y%m%d-%H%M%S)"
        if git push origin "HEAD:refs/heads/$rescue"; then
          _landing_notify ":rotating_light: **A landing-pr ticket's work could not be opened as a PR** in \`$repo_slug\` (#$prn) — commits parked on \`$rescue\`. Open the PR from there; do NOT push them to main."
        else
          _landing_notify ":rotating_light: **A landing-pr ticket's work could not be opened as a PR AND the rescue branch could not be pushed** in \`$repo_slug\` (#$prn) — the commits live ONLY in the runner workdir \`$(pwd)\`; do NOT let it reset."
        fi
        SWARM_EXIT_REASON="pr-landing-parked-on-rescue"
        return 1
      fi
      return 0 ;;
  esac
  if [ "${SWARM_POLICY_LANDING:-push}" = pr ]; then
    verdict_stage "reconcile landing (pr — branch + PR per issue)"
    # `|| true` on the scrape: a run whose commit subjects cite NO `#NN` makes
    # grep exit 1, and under the caller's `set -o pipefail` that non-zero rippled
    # out of the command substitution and killed the whole reconcile stage —
    # after the work was already committed. Same class as #21's foreign-`#NN`
    # 404; surfaced by the #2 decomposition's test for this seam.
    # Fan over the issues the run's commits actually CITE (subject #NN — the
    # claimed ticket by convention, plus any mid-run filed child). The old
    # pickup-∪-scrape union fanned over the ENTIRE ready batch, so a run that
    # worked one ticket (or none) pushed its HEAD to every ready ticket's
    # branch — zero-commit shells and cross-wired PRs that starve the queue
    # (matou-app#145, 11 junk PRs across three sweeps). Only when NO commit
    # cites a ticket fall back to the ready list, where landing_push's
    # empty-shell guard still refuses a workless push.
    nums="$(git log --format=%s "$start_sha"..HEAD | grep -oE '#[0-9]+' | tr -d '#' | sort -un || true)"
    [ -n "$nums" ] || nums="$(jq -r '.[].number' <<<"$ready" | sort -un)"
    # shellcheck disable=SC2086 # the number list is deliberately word-split.
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
  # #193 last-line-of-defense: the host NEVER pushes a flagged protected-path
  # breach to main, even reached directly. (run-swarm's ordering already reds the
  # run before here; this makes the land seam safe on its own.)
  landing_pp_breach_guard "$repo_slug" || return 1
  # The guard (idss ADR 0267): a push run should never hold a landing-pr ticket's
  # commit (the lister hides such tickets from it), but "should never" is what a
  # guard is for. Fail-OPEN on an unreadable tracker — see landing_pr_tickets_cited.
  local cited cited_disp
  cited="$(landing_pr_tickets_cited "$start_sha" | tr '\n' ' ')"
  cited_disp="$(printf '%s' "$cited" | sed -E 's/ +$//; s/ /, #/g')"
  if [ -n "$cited_disp" ]; then
    git fetch origin main >/dev/null 2>&1 || true
    if git merge-base --is-ancestor HEAD origin/main 2>/dev/null; then
      _landing_notify ":rotating_light: **A landing-pr ticket's commit is ALREADY on main** in \`$repo_slug\` — this push run's commits cite #$cited_disp and a worker pushed them. Review on main; revert if it should not stand."
      return 0
    fi
    local rescue; rescue="sandcastle/rescue-$(date -u +%Y%m%d-%H%M%S)"
    git push origin "HEAD:refs/heads/$rescue" || true
    _landing_notify ":rotating_light: **Swarm did NOT push main** in \`$repo_slug\` — this run's commits cite #$cited_disp, which carries \`landing-pr\` and lands only by PR. HEAD is parked on \`$rescue\`: open the PR from there, and cherry-pick any other ticket's commits onto main."
    SWARM_EXIT_REASON="pr-ticket-in-push-run"
    return 1
  fi
  landing_push_main_with_rescue "$repo_slug"
}

fi
