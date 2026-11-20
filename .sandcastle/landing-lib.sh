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
# #382: the landing-pending MARKER (close-before-land window, #359) shares the
# `landing-` prefix but is NOT a landing-authority label — it must never answer
# "how does this ticket land". Exclude it here (routed through LANDING_PENDING_LABEL,
# its single source) so a reopened close that still carries it resolves its mode
# normally instead of rc-1/skipping for ever.
landing_ticket_label() {
  local n="${1:?landing_ticket_label: issue number required}" resp
  resp="$(forgejo_get "/issues/$n" 2>/dev/null)" \
    || { echo "landing: could not read #$n's labels — refusing to guess how it lands" >&2; return 1; }
  jq -r --arg p "${LANDING_PENDING_LABEL:-landing-pending}" \
    '[.labels[]?.name | select(startswith("landing-") and . != $p)][0] // ""' <<<"$resp" 2>/dev/null
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
# STATUS.md entry is judgement work a text merge can't do: its per-ticket rows
# collide when two writers edit them (#287/#374). Output is tee'd to <log> (default /dev/null)
# so the caller can classify a refusal. rc 0 only if the rebase actually completed.
#
# #364: the prompt is the LEADING positional (right after -p) and --allowedTools is
# LAST. --allowedTools is VARIADIC, so a prompt passed as a TRAILING positional
# after it was swallowed into the tool list — the CLI then saw no prompt and exited
# in <1s with "Input must be provided … when using --print", so the resolver never
# ran once on any consumer (its argv error was misclassified as a failed merge and
# paged). Keep the prompt ahead of every variadic option so nothing can consume it.
landing_resolve_rebase_with_claude() {
  local log="${1:-/dev/null}"
  command -v claude >/dev/null 2>&1 || return 1
  local prompt="This git checkout is mid-rebase with conflicts. Finish the rebase: resolve every conflicted file preserving BOTH sides' intent — STATUS.md is a compact status surface whose per-change history lives in the per-change journal (one append-only file per ticket; STATUS.md itself carries no dated header or history block to merge), so merge the conflicting per-ticket table and blocker rows to reflect both sides' facts, then compact prose so the file stays under its byte budget (the repo's offline docs-budget test enforces a hard ceiling AND a headroom floor). Then 'git add' the resolved files and 'GIT_EDITOR=true git rebase --continue'; repeat until the rebase completes. NEVER 'git rebase --abort', never force-push, never delete either side's content, and NEVER 'git push' — resolving is all you do; the harness re-tests the result and lands it."
  timeout 900 claude -p "$prompt" --model "$SWARM_MODEL" \
    --permission-mode acceptEdits --allowedTools "$LANDING_RESOLVE_ALLOWED_TOOLS" \
    2>&1 | tee "$log" >/dev/null
  ! landing_rebase_in_progress
}

# A POSITIVE signature that the resolver could NOT START — the argv was rejected
# (a usage error), the model name was bad, or it produced no output at all while the
# rebase is still mid-flight — as opposed to a resolver that RAN but could not finish
# the merge. #364: the pre-fix argv bug made claude exit in <1s with an "Input must
# be provided … when using --print" usage error; classified as a failed merge, it
# PAGED and parked a resolver that never ran. Positive-only (like
# landing_classify_push_failure, #346): no match => the caller keeps the ladder's
# `failed` default, so a genuine failed merge still parks + pages.
LANDING_RESOLVE_UNUSABLE_RE="${LANDING_RESOLVE_UNUSABLE_RE:-Input must be provided|prompt argument when using --print|error: unknown option|error: unknown command|Usage: claude|Invalid model|not a valid model|No such model|model .* not found}"
landing_resolve_unusable() {
  local log="${1:-}"
  [ -n "$log" ] && [ -r "$log" ] || return 1
  grep -qiE "$LANDING_RESOLVE_UNUSABLE_RE" "$log" 2>/dev/null && return 0
  # No output at all AND the rebase never advanced: the resolver died before doing
  # anything (claude absent, a silent crash) — it never started.
  [ ! -s "$log" ] && landing_rebase_in_progress
}

# landing_resolve_classified <log> -> resolved | refused | unusable | failed
#   resolved  the rebase completed
#   refused   the resolver hit a usage limit or an auth-dead refusal (the log says
#             so) — a quiet DEFER, never a page: it rides the same classify
#             contract every other claude caller does (execute-lib #510/#632)
#   unusable  the resolver could NOT START — claude absent, its argv rejected, or a
#             bad --model (#364). NOT a failed merge: a quiet DEFER too (the next run
#             retries), never a page. Detected POSITIVELY, so the ladder's default
#             stays `failed`.
#   failed    claude ran but the rebase is still unresolved — a genuine red
landing_resolve_classified() {
  local log="$1"
  # claude ABSENT is unusable, not a failed merge — catch it before invoking (the
  # call returns 1, which would otherwise read as "ran but did not resolve").
  command -v claude >/dev/null 2>&1 || { echo unusable; return 0; }
  if landing_resolve_rebase_with_claude "$log"; then echo resolved; return 0; fi
  if claude_auth_failed "$log" || claude_limit_hit "$log"; then echo refused; return 0; fi
  if landing_resolve_unusable "$log"; then echo unusable; return 0; fi
  echo failed
}

# Where a FAILED-resolve log is preserved (#383). A run-scoped evidence directory
# the consumer/host may override; defaults to the runner's tmp area. A seam so the
# offline test can point it at a scratch dir and assert the log lands there.
LANDING_RESOLVE_LOG_DIR="${LANDING_RESOLVE_LOG_DIR:-${TMPDIR:-/tmp}}"

# landing_keep_resolve_log <log> <repo-slug> — #383: on a FAILED resolve (the
# resolver RAN but could not finish the merge) preserve its log in the run's
# evidence directory instead of rm -f'ing it — every other path deletes it, which
# left all three policy-generators strands (2026-11-20) undiagnosable (nobody could
# say WHY landing_resolve_classified gave up, the same e9d7ba086503 signature each
# time). Echoes the kept path so the caller names it in the alarm. Best-effort: if
# the evidence dir cannot be written, echo the ORIGINAL log path — the caller has
# NOT removed it on the failed path, so the log is never lost, only less tidily
# located.
landing_keep_resolve_log() {
  local log="$1" repo_slug="${2:-}" dest slug_tag dir
  [ -n "$log" ] && [ -r "$log" ] || { printf '%s' "${log:-}"; return 0; }
  dir="${LANDING_RESOLVE_LOG_DIR:-${TMPDIR:-/tmp}}"
  slug_tag="$(printf '%s' "$repo_slug" | tr '/ ' '--')"
  if mkdir -p "$dir" 2>/dev/null; then
    dest="$dir/landing-resolve-${slug_tag:-run}-$(date -u +%Y%m%d-%H%M%S).log"
    if mv "$log" "$dest" 2>/dev/null || cp "$log" "$dest" 2>/dev/null; then
      printf '%s' "$dest"; return 0
    fi
  fi
  printf '%s' "$log"
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

# landing_classify_push_failure <captured-push-output> — WHY a `git push` failed,
# read from its combined stdout+stderr (#346). A LOCAL pre-push hook refuses the
# push BEFORE any network transport, so its output carries neither git's transport
# fatals (`unable to access`, `Could not resolve host`, …) nor the server's
# ref-rejection lines (`! [rejected]`, `fetch first`, …) — only the hook's own
# output plus git's generic `failed to push some refs`. A stale `main` is a server
# rejection; a down forge is a transport fatal; anything that still printed
# `failed to push some refs` with neither signature is a local refusal. Echoes
# exactly one of: transport | rejected | hook. An empty/unknown output defaults to
# `rejected` so the existing fetch+rebase ladder is preserved — the hook verdict is
# POSITIVE-only, so a classification miss never diverts a transport/stale failure.
landing_classify_push_failure() {
  case "$1" in
    *"unable to access"*|*"Could not resolve host"*|*"Could not read from remote repository"*|\
    *"Connection refused"*|*"Connection timed out"*|*"Failed to connect"*|\
    *"Operation timed out"*|*"The requested URL returned error"*|*"SSL connect error"*)
      echo transport ;;
    *"[rejected]"*|*"[remote rejected]"*|*"fetch first"*|*"non-fast-forward"*|\
    *"Updates were rejected"*|*"tip of your current branch is behind"*)
      echo rejected ;;
    *"failed to push some refs"*)
      echo hook ;;
    *)
      echo rejected ;;
  esac
}

# landing_park_hook_refusal <repo-slug> <captured-push-output> — the #346 honest
# park. A LOCAL pre-push hook refused the push to `main`; the forge was reachable
# and `main` was not stale, so this is NOT push-rescue-unreachable (the old ladder's
# "forge unreachable / rescue branch exists" was doubly false). Park the commits on
# a rescue branch with the hook BYPASSED (`--no-verify`): a rescue branch exists to
# preserve work that could not land and NEVER auto-lands — a human re-reviews before
# it reaches `main` — so gating the park only strands the commits for the next run's
# reset --hard to destroy (ruled a two-way door under ADR 0174: revertible, and the
# offline test proves the park survives). The alarm names the hook refusal and
# surfaces its output, and claims the branch EXISTS only when its push returned
# success (#141 class). SWARM_EXIT_REASON names which outcome.
landing_park_hook_refusal() {
  local repo_slug="$1" hook_out rescue
  hook_out="$(printf '%s\n' "$2" | tail -n 40)"
  rescue="sandcastle/rescue-$(date -u +%Y%m%d-%H%M%S)"
  if git push --no-verify origin "HEAD:refs/heads/$rescue"; then
    _landing_notify ":rotating_light: **Swarm push to \`main\` was refused by a LOCAL pre-push hook** in \`$repo_slug\` — NOT a transport fault (the forge was reachable) and NOT a stale \`main\`. The commits are parked on \`$rescue\` with the hook bypassed (\`--no-verify\`; a rescue branch never auto-lands — a human re-reviews before it reaches \`main\`). Fix the hook, then cherry-pick from \`$rescue\` onto main (the issues will NOT retry). The pre-push hook said:
\`\`\`
$hook_out
\`\`\`"
    SWARM_EXIT_REASON="push-refused-by-local-hook"
  else
    _landing_notify ":rotating_light: **Swarm push to \`main\` was refused by a LOCAL pre-push hook AND the rescue park (hook bypassed) could not be pushed** in \`$repo_slug\` — the commits live ONLY in the runner workdir \`$(pwd)\` at \`$(git rev-parse --short HEAD 2>/dev/null)\`; do NOT let it reset. The pre-push hook said:
\`\`\`
$hook_out
\`\`\`"
    SWARM_EXIT_REASON="push-refused-by-local-hook-rescue-unreachable"
  fi
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
  local repo_slug="$1" pushed="" rescue body log push_out push_rc
  # #2119: this function OWNS the SHA-preserving-promote signal run-swarm.sh's
  # land-SUCCESS #283 reconcile reads — clear any prior value on entry. A
  # first-try push to main is a clean fast-forward or a no-op "Everything
  # up-to-date": either the worker SHAs are preserved on main or main never
  # moved, so a by-SHA reachability re-check on the success path is SAFE. The
  # rebase ladder below rewrites the SHAs, so it leaves the flag cleared and the
  # success-path reconcile skips it (never false-reopening rebased-landed work).
  LANDING_PROMOTE_CLEAN=""
  push_out="$(git push origin HEAD:main 2>&1)"; push_rc=$?
  if [ "$push_rc" = 0 ]; then LANDING_PROMOTE_CLEAN=1; return 0; fi
  # #346: a LOCAL pre-push hook refusal is neither a transport fault nor a stale
  # main — the SAME hook refuses the rebase-retry and the rescue push, so the old
  # ladder bottomed out at push-rescue-unreachable and alarmed "forge unreachable /
  # rescue branch exists", both false. Catch it at the top — before the futile
  # rebase+resolver — and park with the hook bypassed, naming the hook + its output.
  if [ "$(landing_classify_push_failure "$push_out")" = hook ]; then
    landing_park_hook_refusal "$repo_slug" "$push_out"
    return 1
  fi
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
      unusable)
        # #364: the resolver could not START — claude absent, its argv rejected, or
        # a bad --model. That is an environment/invocation fault, NOT a failed merge:
        # defer quietly (like `refused`) rather than paging a park, because the
        # commits are safe (the worker branch carries them) and the next run retries.
        rm -f "$log"
        git rebase --abort 2>/dev/null || true
        _landing_notify ":hourglass_flowing_sand: **Swarm rebase-rescue deferred — the conflict resolver could not START** in \`$repo_slug\` — the headless \`claude\` was absent or its invocation was rejected (not a usage limit), so the rebase conflict was NOT resolved and NOTHING was pushed. The commits stay in the runner workdir; the next run retries. If this recurs, the resolver's invocation is broken (see #364)."
        SWARM_EXIT_REASON="rebase-rescue-resolver-unusable"
        return 1 ;;
      *)
        # claude ran but could not finish the rebase — a genuine red. KEEP its log
        # (#383): every path above rm -f's it, so the three policy-generators strands
        # (2026-11-20) could never be read to learn WHY the resolver gave up. Preserve
        # it in the run's evidence dir and NAME where, then fall through to the
        # honest-alarm park ladder below (it parks HEAD + pages).
        local kept; kept="$(landing_keep_resolve_log "$log" "$repo_slug")"
        _landing_notify ":mag: **Swarm rebase-conflict resolver RAN but could not finish the merge** in \`$repo_slug\` (#383) — its log is kept at \`$kept\` for diagnosis (every prior path deleted it). The resolved tree is parked below; read the log to see why the resolver gave up."
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

# landing_drop_run_claims <issue> [<run>] — #366. Delete THIS run's own swarm
# claim comments from <issue> (run defaults to $SWARM_RUN_ID). The #283 reconcile
# calls it as it reopens a stranded close: the run that posted the claim is the
# run doing the reconcile, at its end, so the claim is known dead — yet nothing
# else ever removes it (janitor_sweep and the stale-claim sweep only visit
# agent-working), and the session-runner treats any claim younger than its TTL
# as a live peer (claim_fresh_runs, #1412). Left in place it made every host
# stand down from the reopened ticket for SESSION_RUNNER_TIMEOUT + slack (this
# tracker's #359: 2h05m). Two safeties: only a claim whose run= is exactly <run>
# is touched, never a peer's; and a SESSION claim (` session-ttl=` after run=) is
# never touched, because its run= is a pid that can equal a swarm run number by
# chance. No run id (unset, 0, non-numeric) is a no-op. Best-effort, rc 0 always.
landing_drop_run_claims() {
  local dr_issue="${1:-}" dr_run="${2:-${SWARM_RUN_ID:-}}" dr_raw dr_cid
  [ -n "$dr_issue" ] || return 0
  case "$dr_run" in ''|0|*[!0-9]*) return 0 ;; esac
  dr_raw="$(forgejo_get "/issues/$dr_issue/comments" 2>/dev/null)" || return 0
  for dr_cid in $(jq -r --arg r "$dr_run" '
      .[]? | select((.body // "") | split("\n")[0]
               | test("^swarm-claim host=\\S+ run=" + $r + "[ \\t\\r]*$"))
           | .id' <<<"$dr_raw" 2>/dev/null); do
    forgejo_delete_code "/issues/comments/$dr_cid" >/dev/null 2>&1 || true
  done
  return 0
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
# line whose claimed commits are a GENUINELY STRANDED close — a commit that is NOT
# reachable from <main-ref> (default origin/main), EXISTS as an object, and DIFFERS
# from main — AND whose issue currently reads `closed`, REOPEN it: PATCH state:open,
# relabel LANDING_REOPEN_LABEL, and comment exactly why. The reachability guard is
# the safety: a close whose commits DID land (a clean push earlier in the ladder, or
# an already-on-main prior run) is left closed. #372: the existence + non-empty-diff
# guards are the SECOND safety — a re-worked already-landed ticket records a close
# whose commit no longer exists or has an empty diff vs main (its "land" was a
# correct no-op), which is NOT a stranded close and must not reopen, so the fix
# never reopens honest OR already-satisfied work.
# Echoes one "<N> reopened" line per issue reopened; rc 0 always (a reconcile over
# many must never abort on one). A no-op (echoes nothing) when the file is absent
# or empty — a run whose worker closed nothing.
landing_reopen_stranded_closes() {
  local attempts="${1:-}" repo_slug="${2:-}" main_ref="${3:-origin/main}"
  [ -n "$attempts" ] && [ -r "$attempts" ] || return 0
  local line issue commits_csv c stranded state labels_json lid pid old_ifs
  while IFS= read -r line; do
    case "$line" in "SANDCASTLE_ATTEMPT "*) ;; *) continue ;; esac
    case "$line" in *" outcome=success "*) ;; *) continue ;; esac
    issue="$(printf '%s\n' "$line" | sed -n 's/.*issue=\([0-9][0-9]*\).*/\1/p')"
    [ -n "$issue" ] || continue
    commits_csv="$(printf '%s\n' "$line" | sed -n 's/.*commits=\([^ ]*\).*/\1/p')"
    [ -n "$commits_csv" ] || continue   # an empty-commit close cannot be judged here
    # Stranded iff ANY claimed commit carries real work that never reached main.
    # A commit is genuinely stranded only when it (a) is NOT an ancestor of
    # main_ref, (b) EXISTS as a commit object, and (c) differs from main_ref.
    # All-reachable means the close genuinely landed — leave it closed. #372: a
    # worker that re-works an ALREADY-landed ticket records a success close whose
    # claimed commit either no longer exists (its "land" was a correct no-op push,
    # so the SHA was never a real object on any surviving branch) or has an empty
    # diff vs main (its tree is byte-identical to main — nothing new to strand).
    # Both present to the ancestry test as "not on main", yet neither lost any
    # work; reopening them drives the #52 reopen -> ready-for-session -> re-do ->
    # no-op-land -> reopen loop. The existence + non-empty-diff guards skip those
    # while a real stranded close (commits off-main, carrying a diff) still reopens.
    stranded=""; old_ifs="$IFS"; IFS=','
    for c in $commits_csv; do
      [ -n "$c" ] || continue
      git merge-base --is-ancestor "$c" "$main_ref" 2>/dev/null && continue  # landed
      git cat-file -e "${c}^{commit}" 2>/dev/null || continue   # #372: non-existent cannot be stranded
      git diff --quiet "$main_ref" "$c" 2>/dev/null && continue  # #372: empty diff vs main — nothing to strand
      stranded=1; break
    done
    IFS="$old_ifs"
    [ -n "$stranded" ] || continue
    # Only reopen a currently-CLOSED issue — never disturb one a human already
    # reopened, and never re-PATCH one still open.
    state="$(forgejo_get "/issues/$issue" 2>/dev/null | jq -r '.state // ""' 2>/dev/null || true)"
    [ "$state" = closed ] || continue
    forgejo_reopen_issue "$issue" >/dev/null 2>&1 || true
    landing_drop_run_claims "$issue"   # #366: this run is over; its claim must not outrank the re-land
    labels_json="$(forgejo_get '/labels?limit=100' 2>/dev/null || true)"
    # #382: strip the landing-pending marker BEFORE re-labelling for the pipeline.
    # A stranded close keeps it (close-report added it pre-land); left on the
    # reopened ticket it (a) makes list-ready-tasks count it as a still-unmet
    # dependency for its dependants and (b) — because it shares the `landing-`
    # prefix — made every session's landing-mode resolver rc-1 and skip the ticket
    # (#373 skipped 17× before a human deleted the label by hand). Clearing it here
    # re-arms the reopened ticket immediately.
    pid="$(forgejo_label_id "$labels_json" "$LANDING_PENDING_LABEL")"
    [ -n "$pid" ] && forgejo_remove_label "$issue" "$pid" >/dev/null 2>&1 || true
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

# The label a push-mode close wears between its (pre-land) close and the host's
# verified promote to `main` (#359). close-report.sh adds it the moment it closes
# an issue against the pushed worker branch (the host has not yet landed `main`);
# landing_promote_landed clears it here once the commits ARE on `main`. While it
# sits on a CLOSED issue, list-ready-tasks.sh counts that issue as a STILL-unmet
# dependency, so a dependent is never handed out in the window between a close and
# its land (gap A of #359: "closed is treated as landed"). A repo that has not
# minted the label is a clean no-op everywhere — close-report skips the add, the
# lister finds the label on nothing, and this clear removes nothing.
LANDING_PENDING_LABEL="${LANDING_PENDING_LABEL:-landing-pending}"

# _landing_blocker_unmet_count <dependencies-json> — how many of an issue's
# blockers are STILL unmet, by the SAME rule list-ready-tasks.sh applies: a
# blocker counts as unmet when it is open, OR closed but still carrying
# landing-pending (closed pre-land, not yet on `main`). 0 means every blocker is
# met. Fails SAFE to 1 (treat as blocked) on an unparseable response.
_landing_blocker_unmet_count() {
  local n
  n="$(jq -r --arg p "$LANDING_PENDING_LABEL" \
    '[.[]? | select(.state == "open"
                    or (((.labels // []) | map(.name) | index($p)) != null))] | length' \
    <<<"${1:-}" 2>/dev/null || echo 1)"
  case "$n" in ''|*[!0-9]*) echo 1 ;; *) echo "$n" ;; esac
}

# landing_rearm_dependants <landed-issue> <repo-slug> <labels-json> — gap B of
# #359. For every OPEN issue the just-landed ticket BLOCKS (its native Forgejo
# dependants, the same DAG list-ready-tasks.sh filters on) that is labelled
# `agent-blocked` AND now has no still-unmet blocker, relabel it
# `agent-blocked` -> `ready-for-agent` so the machinery re-queues it. A dependent
# that blocked itself in the close-before-land gap (it found the dependency closed
# but not on `main`, refused to rebuild it, and parked `agent-blocked`) is picked
# back up by the swarm instead of waiting for a human — the condition that parked
# it clears on its own, so a check, not a person, lifts it. A dependant blocked
# for ANY OTHER reason is untouched: a ticket that is not this one's native
# dependant never appears in `/blocks`, and one with another unmet blocker fails
# the count gate. Best-effort (rc 0): a reconcile pass must never red a landed run.
landing_rearm_dependants() {
  local issue="$1" repo_slug="$2" labels_json="$3" blocks dep deps unmet rfa_id ab_id
  blocks="$(forgejo_get "/issues/$issue/blocks?limit=50" 2>/dev/null || true)"
  [ -n "$blocks" ] || return 0
  rfa_id="$(forgejo_label_id "$labels_json" ready-for-agent)"
  ab_id="$(forgejo_label_id "$labels_json" agent-blocked)"
  if [ -z "$rfa_id" ] || [ -z "$ab_id" ]; then
    echo "landing: warning: ready-for-agent/agent-blocked not minted — cannot re-arm dependants of landed #$issue (#359)" >&2
    return 0
  fi
  for dep in $(jq -r '.[]?
      | select(.state == "open")
      | select(((.labels // []) | map(.name) | index("agent-blocked")) != null)
      | .number' <<<"$blocks" 2>/dev/null); do
    [ -n "$dep" ] || continue
    deps="$(forgejo_get "/issues/$dep/dependencies?limit=50" 2>/dev/null || true)"
    unmet="$(_landing_blocker_unmet_count "$deps")"
    [ "$unmet" -eq 0 ] || continue   # another blocker is still unmet — leave it blocked
    forgejo_remove_label "$dep" "$ab_id" >/dev/null 2>&1 || true
    forgejo_add_labels "$dep" "$rfa_id" >/dev/null 2>&1 || true
    forgejo_comment "$dep" ":repeat: **Re-armed \`ready-for-agent\` — the dependency #$issue has landed on \`main\` (#359).** This ticket was parked \`agent-blocked\` because a dependency it needs was closed before its work reached \`main\`; that work is now landed and no other blocker is open, so the machinery is re-queuing it rather than asking a human (ADR 0174 — veto anytime)." 2>/dev/null || true
    echo "landing: re-armed #$dep (dependant of landed #$issue) ready-for-agent (#359)"
  done
  return 0
}

# landing_promote_landed <attempts-file> <repo-slug> [main-ref] — the SUCCESS-path
# counterpart of landing_reopen_stranded_closes (#359). run-swarm.sh calls it the
# moment landing_stage advances `main`. For each `outcome=success` attempt it:
#   A. (#382) clears the landing-pending label from a close that is STILL `closed` —
#      the reliable "it landed" signal, since landing_stage has advanced main and the
#      #283 reopen reconcile already pulled out (and un-marked) every stranded/no-op
#      close before this point. Keying on issue STATE, not commit SHAs, is the #382
#      fix: a rebase land rewrites the worker's SHAs onto main, so the old by-SHA
#      ancestry test read a genuinely-landed close as "not on main" and left the
#      mark on for ever, stalling the queue; and
#   B. re-arms the agent-blocked dependants it was blocking (landing_rearm_dependants,
#      gap B) — kept on the strict by-SHA landed guard (re-arming on a non-landed
#      dependency would be wrong); #382 leaves gap B's own rebase gap out of scope.
# Best-effort (rc 0): a reconcile over many successes must never abort on one, and
# nothing here may red a run whose work already landed. A no-op when the file is
# absent or empty. Offline-tested by tests/landing-lib-test.sh (git/curl shimmed).
landing_promote_landed() {
  local attempts="${1:-}" repo_slug="${2:-}" main_ref="${3:-origin/main}"
  [ -n "$attempts" ] && [ -r "$attempts" ] || return 0
  local line issue commits_csv c landed state old_ifs labels_json lid
  while IFS= read -r line; do
    case "$line" in "SANDCASTLE_ATTEMPT "*) ;; *) continue ;; esac
    case "$line" in *" outcome=success "*) ;; *) continue ;; esac
    issue="$(printf '%s\n' "$line" | sed -n 's/.*issue=\([0-9][0-9]*\).*/\1/p')"
    [ -n "$issue" ] || continue
    labels_json="$(forgejo_get '/labels?limit=100' 2>/dev/null || true)"
    # gap A (#359; #382): clear the landing-pending mark from a close that genuinely
    # landed. The reliable signal is the ISSUE STATE, not the claimed commit SHAs.
    # run-swarm.sh reaches landing_promote_landed only AFTER landing_stage advanced
    # main, and the #283 reopen reconcile has already REOPENED (and, #382, stripped
    # the mark from) every stranded / no-op close BEFORE this point — so a success
    # close STILL reading `closed` here landed, whatever its SHAs. The old by-SHA
    # ancestry gate could not tell a REBASE land (the host rewrites the worker's
    # commit SHAs onto main, so they read as "not an ancestor") from a genuine
    # strand, and so left landing-pending on every rebase-landed close for ever —
    # #382: list-ready-tasks then counted the closed-but-marked ticket as a
    # still-unmet dependency and starved its dependants, with no TTL.
    state="$(forgejo_get "/issues/$issue" 2>/dev/null | jq -r '.state // ""' 2>/dev/null || true)"
    if [ "$state" = closed ]; then
      lid="$(forgejo_label_id "$labels_json" "$LANDING_PENDING_LABEL")"
      [ -n "$lid" ] && forgejo_remove_label "$issue" "$lid" >/dev/null 2>&1 || true
    fi
    # gap B (#359) — re-arming the agent-blocked dependants this ticket blocked — is
    # tracked separately (#382 out of scope) and stays on the strict by-SHA landed
    # guard: re-arming a dependant whose dependency did not truly land would be wrong,
    # so this under-fires (a rebase land does not re-arm) rather than over-fires.
    commits_csv="$(printf '%s\n' "$line" | sed -n 's/.*commits=\([^ ]*\).*/\1/p')"
    [ -n "$commits_csv" ] || continue   # an empty-commit close cannot be judged for gap B
    # Landed iff EVERY claimed commit is an ancestor of main_ref (the inverse of
    # landing_reopen_stranded_closes's stranded test).
    landed=1; old_ifs="$IFS"; IFS=','
    for c in $commits_csv; do
      [ -n "$c" ] || continue
      git merge-base --is-ancestor "$c" "$main_ref" 2>/dev/null || { landed=""; break; }
    done
    IFS="$old_ifs"
    [ -n "$landed" ] || continue
    landing_rearm_dependants "$issue" "$repo_slug" "$labels_json"                    # gap B: lift the dependency blocks
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
  LANDING_OPENED_PRS=""; LANDING_MERGED_PRS=""; LANDING_PROMOTE_CLEAN=""   # #2119
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
  # #347: a push run with NO commits of its own must never push main. In push mode
  # HEAD carries exactly the commits execute_adopt_worker_branch moved onto this
  # run's base (start_sha) from the per-run worker branch; an empty start_sha..HEAD
  # means the worker committed nothing, so there is nothing of OURS to land. Pushing
  # regardless would promote whatever HEAD happens to point at — notably a SIBLING
  # run's adopted commit reached through the shared workdir (two-runs-one-checkout,
  # #347), landing another run's work under this run's name. The swarm.yml workdir
  # lock now spans the whole run so that race can no longer arise; this is the land
  # seam's own independent refusal. Fail-OPEN when rev-list cannot answer (an odd
  # checkout with no base): only a PROVABLE empty range refuses, mirroring the
  # pr-mode empty-shell guard (matou-app#145). A clean no-op, not a red.
  local own; own="$(git rev-list --count "$start_sha"..HEAD 2>/dev/null)" || own=""
  if [ "$own" = 0 ]; then
    echo "landing: push run has no commits of its own beyond its base ($start_sha) — nothing to land; not pushing main (#347)" >&2
    return 0
  fi
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
  landing_push_main_with_rescue "$repo_slug" || return 1
  # #2119: a first-try promote can be a NO-OP "Everything up-to-date" — the
  # worker's commit never reached the runner HEAD, so main never advanced yet the
  # push returned 0 and we are here on the success path. The two #283 reconciles
  # in run-swarm.sh only fire when landing_stage FAILS, so this silent no-op left
  # #2100/#2102 `closed success` against worker branches that were never promoted
  # (2026-10-31; #2097/#2099 before). Re-run the reconcile here, but ONLY when the
  # promote was SHA-preserving (a first-try fast-forward/no-op sets
  # LANDING_PROMOTE_CLEAN): a rebase landing rewrites the worker SHAs onto main,
  # so a by-SHA reachability check would false-reopen genuinely-landed work. The
  # attempt lines ride the exported EXECUTE_ATTEMPTS_FILE run-swarm.sh wired for
  # the failure-path reconciles; refetch origin/main so a sibling-promoted commit
  # reads as reachable (fewer false reopens). Never red the run on this — a clean
  # land already succeeded; `|| true` keeps the summary path intact.
  if [ -n "${LANDING_PROMOTE_CLEAN:-}" ]; then
    git fetch origin main >/dev/null 2>&1 || true
    SWARM_EXIT_REASON="the promote did not advance main (a no-op push to main)" \
      landing_reopen_stranded_closes "${EXECUTE_ATTEMPTS_FILE:-}" "$repo_slug" origin/main || true
  fi
  return 0
}

fi
