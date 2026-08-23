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

fi
