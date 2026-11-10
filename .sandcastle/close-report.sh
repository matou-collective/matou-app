#!/usr/bin/env bash
# close-report.sh — the ONLY sanctioned path for a swarm worker to close a
# ticket (#444, learning L1). "Agent proposes, code disposes."
#
# The worker writes a close-report envelope (JSON) describing what it did; this
# script runs the deterministic claim gates (close-report-lib.sh) over it and
# closes the issue ONLY if every gate passes. The envelope — valid or not — is
# ALWAYS posted to the issue as a comment, so the thread carries the evidence in
# every outcome. On gate failure it prints the verbatim violation list (for the
# worker to fix and retry, prompt step 7) and exits non-zero WITHOUT closing.
#
# Usage:  close-report.sh <issue-number> <envelope.json>
#   env:  FORGEJO_API (required), FORGEJO_TOKEN or /run/secrets/forgejo_token,
#         CR_MAIN_HEAD (default origin/main).
# Exit:   0 = gates passed, comment posted, issue VERIFIED closed.
#         2 = usage / envelope-read error (nothing posted).
#         1 = gates refused the close (envelope+violations posted, NOT closed),
#             OR gates passed but the close PATCH failed / did not stick — the
#             envelope is posted saying so, the issue stays OPEN (#20).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=close-report-lib.sh
. "$here/close-report-lib.sh"
# Per-repo LANDING policy (#13, ADR 0002). SWARM_POLICY_FILE is a test-only seam;
# unset in production → the consumer's real swarm-policy.sh → LANDING=push, and
# the pr-mode branches below are inert (push mode is byte-identical to before).
# shellcheck source=policy-lib.sh
. "$here/policy-lib.sh"
# shellcheck source=landing-lib.sh
. "$here/landing-lib.sh"
# model-lib.sh (#197): SWARM_REVIEW_MODEL — the tier the reviewer gate runs on,
# defaulting to the heal tier. swarm-db-lib.sh: swarmdb_spend_from_result records
# the review call's token spend. Both are sourceable with no side effects beyond
# defining vars/functions; best-effort, so a host without them never fails a close.
# shellcheck source=model-lib.sh
. "$here/model-lib.sh" 2>/dev/null || true
# shellcheck source=swarm-db-lib.sh
. "$here/swarm-db-lib.sh" 2>/dev/null || true
policy_load "${SWARM_POLICY_FILE:-}"

issue="${1:-}"
envelope_file="${2:-}"
if [ -z "$issue" ] || [ -z "$envelope_file" ]; then
  echo "usage: close-report.sh <issue-number> <envelope.json>" >&2
  exit 2
fi
if [ ! -r "$envelope_file" ]; then
  echo "close-report: cannot read envelope file '$envelope_file'" >&2
  exit 2
fi

json="$(cat "$envelope_file")"
if ! jq -e . >/dev/null 2>&1 <<<"$json"; then
  echo "close-report: envelope '$envelope_file' is not valid JSON — refusing to touch the issue" >&2
  exit 2
fi

token="${FORGEJO_TOKEN:-$(cat /run/secrets/forgejo_token 2>/dev/null || true)}"
: "${FORGEJO_API:?close-report: FORGEJO_API is not set}"
root="$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
export FORGEJO_TOKEN="$token"

# Landing head (#13): gate 1 checks each commit is reachable from where the
# ticket LANDS. Resolved per ticket: push mode: main (origin/main / CR_MAIN_HEAD). pr mode: the
# issue's OWN open PR head — resolve it now (the pr flow lands on agent/issue-<N>
# and a human, or agent-after-green, merges). No open PR in pr mode is NOT yet
# a refusal (#108): another run's reconcile sweep (landing_merge_reconcile lands
# EVERY open agent PR, #15) can merge the worker's PR — and close the issue via
# `closes #N` — in the seconds between its push and this close-report. Then the
# work HAS landed, on main: gate against main exactly as push mode does, and
# finish like a merge (sweep the claim labels). Only no-open-AND-no-merged PR
# means the work never landed as a PR: force a refusal with a clear violation.
# Per TICKET (idss ADR 0267): the repo knob is the default; a ticket carrying
# `landing-pr` lands by PR whatever it says. An unreadable or mislabelled ticket
# is a loud stop — guessing `push` here is how a PR ticket would close on main.
if ! landing="$(landing_mode_for "$issue")"; then
  echo "close-report: could not resolve how #$issue lands (tracker unreadable, or a landing-* label off the allowlist) — NOT closing" >&2
  exit 1
fi
gate_head="${CR_MAIN_HEAD:-origin/main}"
# What the final verified-close comment says gate 1 checked against (#283). The
# default is `main` (CR_MAIN_HEAD, or the pr-merged fall-through where the merge
# landed on main); the push-mode PRE-land case below rewrites it to name the
# worker branch, so the comment never falsely claims "verified against main" when
# it only verified the pushed worker branch the host has not yet promoted.
gate_head_desc="main"
pr_number="" pr_no_pr="" pr_merged="" pr_superseded=""
if [ "$landing" = pr ]; then
  if pr_number="$(landing_merged_pr_for "$issue")"; then
    pr_merged=1
    git -C "$root" fetch --quiet origin main 2>/dev/null || true   # so main carries the merge
  elif pr_superseded="$(landing_superseded_by_pr_for "$issue")" && [ -n "$pr_superseded" ]; then
    # #151: a multi-host race let ANOTHER host win this ticket — its PR merged and
    # `closes #$issue` closed the issue on a branch other than agent/issue-$issue,
    # so this run's work is redundant. Detect it BEFORE the open-PR gate and the
    # no-PR refusal so a loser with a still-open agent PR, or with no PR at all,
    # self-closes as SUPERSEDED (below) rather than gating un-merged commits or
    # dead-ending in `agent-blocked`. (My OWN agent PR being merged is the #108
    # path above, which keeps its distinct verified-close handling.)
    :
  elif pr_number="$(landing_open_pr_for "$issue")"; then
    pr_head_sha="$(forgejo_pr_head_sha "$pr_number" || true)"
    if [ -n "$pr_head_sha" ]; then
      # Make the PR head resolvable locally for merge-base (it may be a branch
      # this checkout never fetched); best-effort, gate 1 fails loud if absent.
      git -C "$root" rev-parse -q --verify "$pr_head_sha^{commit}" >/dev/null 2>&1 ||
        git -C "$root" fetch --quiet origin "$(landing_branch_for "$issue")" 2>/dev/null || true
      gate_head="$pr_head_sha"
    fi
  else
    pr_no_pr=1
  fi
else
  # push mode (#193): the worker pushed HEAD to its per-run worker branch, NOT
  # `main` — the HOST promotes it to `main` only after the post-run verify gates.
  # So PRE-land (this close-report runs in the sandbox, before the host lands)
  # the claimed commits are reachable from the worker-branch head, not from
  # origin/main; gate 1 must check THAT head. The worker branch always contains
  # the worker's commits — a superset of `main` even after the host lands — so a
  # later re-run still verifies against it (the "then from main after the host
  # lands" phase is the host's own post-land check, not this one). Only when the
  # caller has NOT pinned CR_MAIN_HEAD (a test, or a deliberate main re-check) and
  # HEAD is actually a `sandcastle/worker/*` branch; otherwise gate_head stays
  # origin/main (today's behaviour for any other checkout).
  if [ -z "${CR_MAIN_HEAD:-}" ]; then
    wb="$(git -C "$root" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    case "$wb" in
      sandcastle/worker/*)
        # Prefer the PUSHED remote ref (it proves the land to the worker branch);
        # fetch it if this checkout lacks the tracking ref. If it still cannot be
        # resolved, leave gate_head at origin/main — a safe refusal (gate 1 fails
        # loud) rather than a false close, and by a late re-run the host will have
        # landed `main` anyway.
        git -C "$root" rev-parse -q --verify "origin/$wb^{commit}" >/dev/null 2>&1 ||
          git -C "$root" fetch --quiet origin "$wb" 2>/dev/null || true
        if git -C "$root" rev-parse -q --verify "origin/$wb^{commit}" >/dev/null 2>&1; then
          gate_head="origin/$wb"
          # PRE-land: gate 1 verified the pushed worker branch, NOT main — the
          # host promotes it to main only after its post-run verify (#193), and
          # that land can still roll back (#283). Say so, so the close comment is
          # honest about what it proved.
          gate_head_desc="the pushed worker branch \`$wb\` (pre-land — the host promotes it to \`main\` only after its post-run verify, #193/#283)"
        fi ;;
      *)
        # #244: a NON-worker-branch push-mode checkout gates against origin/main,
        # but that tracking ref was captured at run start and is NEVER refreshed
        # after the worker's push. A commit that landed on `main` DURING the run
        # is a descendant of a head this checkout never saw, so gate 1 refuses it
        # as "not landed" — the #237 stall (53793ce on main, every close refused;
        # #238/#239/#241 blocked ~22h). Refresh the LIVE remote main head here, in
        # the same checkout gate 1 evaluates, before the reachability check, and
        # gate against the fetched sha. FETCH_HEAD resolves the just-fetched head
        # deterministically (no dependence on an opportunistic tracking-ref
        # update). On a fetch failure (no origin / offline) gate_head stays
        # origin/main — today's safe refusal, never a false close. The fetch time
        # is carried into the gate-1 refusal message (CR_HEAD_FETCHED_AT) so a
        # future stall is diagnosable from the message alone.
        if git -C "$root" fetch --quiet origin main 2>/dev/null; then
          live="$(git -C "$root" rev-parse -q --verify FETCH_HEAD 2>/dev/null || true)"
          if [ -n "$live" ]; then
            gate_head="$live"
            CR_HEAD_FETCHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)"
          fi
        fi ;;
    esac
  fi
fi
export CR_HEAD_FETCHED_AT="${CR_HEAD_FETCHED_AT:-}"

# #206 gate seams — all additive (the lib no-ops when a seam resolves empty).
#  - CR_START_SHA: gate 1's start..head membership + the #<issue> subject check.
#    run-swarm drops the run's start sha in the host-signals dir, mounted
#    read-only in the sandbox at /run/host-signals/start-sha.
#  - CR_ISSUE_BODY: gate 5b's acceptance-clause ↔ `criteria` presence check.
#  - CR_TEST_HOST_EC: gate 4b — re-run the repo's pinned TEST_CMD host-side and
#    let the lib compare its exit code to the self-report. Only on a claimed
#    success, and only when a consumer opted in by declaring TEST_CMD (the empty
#    default leaves it inert — no command is honest across repos, CLAUDE.md).
cr_start_sha_file="${CR_START_SHA_FILE:-/run/host-signals/start-sha}"
if [ -z "${CR_START_SHA:-}" ] && [ -r "$cr_start_sha_file" ]; then
  CR_START_SHA="$(tr -d '[:space:]' < "$cr_start_sha_file" 2>/dev/null || true)"
fi
export CR_START_SHA="${CR_START_SHA:-}"
if [ -z "${CR_ISSUE_BODY:-}" ]; then
  CR_ISSUE_BODY="$(forgejo_get "/issues/$issue" 2>/dev/null | jq -r '.body // ""' 2>/dev/null || true)"
fi
export CR_ISSUE_BODY="${CR_ISSUE_BODY:-}"
env_status="$(jq -r '.status // ""' <<<"$json")"
if [ "$env_status" = success ] && [ -z "${pr_superseded:-}" ] && [ -n "${SWARM_POLICY_TEST_CMD:-}" ] && [ -z "${CR_TEST_HOST_EC:-}" ]; then
  echo "close-report: re-running the pinned test command host-side (gate 4b, #206): $SWARM_POLICY_TEST_CMD" >&2
  cr_test_ec=0
  ( cd "$root" && eval "$SWARM_POLICY_TEST_CMD" ) >/dev/null 2>&1 || cr_test_ec=$?
  CR_TEST_HOST_EC="$cr_test_ec"
fi
export CR_TEST_HOST_EC="${CR_TEST_HOST_EC:-}"

# Deterministic verdict. cr_violations echoes one line per failed gate. The
# superseded path (#151) skips it: the winner's PR carries the work, and this
# run's un-merged commits are NOT on main, so gating them would only manufacture
# a spurious refusal for work that already landed.
violations="" gate_rc=0
if [ -z "$pr_superseded" ]; then
  violations="$(cr_violations "$json" "$root" "$gate_head")" && gate_rc=0 || gate_rc=$?
fi
if [ -n "$pr_no_pr" ]; then
  violations="${violations:+$violations$'\n'}no open agent PR (agent/issue-$issue) for this issue — pr-mode commits land on a PR before they can close it (#13)"
  gate_rc=1
fi
# idss ADR 0267: a `landing-pr` ticket's PR must carry its evidence BEFORE anyone
# is asked to review it — a screenshot attached to the PR, or the waiver line. A
# refusal (not a park) so the worker can attach and retry; its blocked path
# labels agent-blocked if it cannot. Only for an OPEN, un-merged PR: a merged one
# was already reviewed.
ticket_landing_label=""
if [ "$landing" = pr ] && [ -n "$pr_number" ] && [ -z "$pr_merged" ] && [ -z "$pr_superseded" ]; then
  ticket_landing_label="$(landing_ticket_label "$issue" 2>/dev/null || true)"
  if [ "$ticket_landing_label" = "$POLICY_LANDING_PR_LABEL" ]; then
    ev_rc=0; ev_msg="$(landing_evidence_gate "$issue" "$pr_number")" || ev_rc=$?
    case "$ev_rc" in
      0) ;;
      1) violations="${violations:+$violations$'\n'}$ev_msg — attach after-fix screenshots (bash .sandcastle/land-pr.sh $issue … <screenshot.png>) or state the waiver (idss ADR 0267)"
         gate_rc=1 ;;
      *) violations="${violations:+$violations$'\n'}could not read PR #$pr_number to verify its screenshots — retry (idss ADR 0267)"
         gate_rc=1 ;;
    esac
  fi
fi

# ── the reviewer gate's seams (#197) ──────────────────────────────────────────
# cr_review_enabled — the gate is ON when a reviewer can actually RUN: the test
# seam CR_REVIEW_CMD is set, OR a review model is configured AND `claude` is on
# PATH. CR_REVIEW_DISABLE is the explicit escape hatch. The fail-CLOSED posture
# (#197) is about a reviewer that RAN and returned garbage — cr_review_parse
# refuses on empty/unparseable output. The ABSENCE of a reviewer binary is an
# environment fact, not a bad review: skipping the gate there is no worse than
# the pre-#197 world (no review at all), where failing the close closed would
# brick every close on a host whose worker sandbox has no `claude`.
cr_review_enabled() {
  [ -z "${CR_REVIEW_DISABLE:-}" ] || return 1
  [ -n "${CR_REVIEW_CMD:-}" ] && return 0
  [ -n "${SWARM_REVIEW_MODEL:-}" ] && command -v claude >/dev/null 2>&1
}

# cr_review_build_prompt — the reviewer prompt: the fixed skeleton (rendered into
# .sandcastle/review-prompt.md beside this script) followed by the issue body, the
# worker's criteria/tests, and the diff of the claimed commits. Best-effort — any
# piece that cannot be read is simply omitted; the reviewer still has read-only
# tools to explore the checkout.
# _cr_review_prompt_default — the reviewer-prompt skeleton's location, resolved
# across the two layouts close-report runs from (#228): beside this script in the
# vendored .sandcastle/ copy (where render-prompts drops review-prompt.md), or
# under prompts/ when running from the repo root (the skeleton's home — the root
# has no review-prompt.md beside the script). Echoes the first that exists; else
# $here/review-prompt.md so a missing skeleton still degrades to a best-effort
# prompt (cr_review_build_prompt simply skips a non-existent skel).
_cr_review_prompt_default() {
  if [ -f "$here/review-prompt.md" ]; then
    printf '%s\n' "$here/review-prompt.md"
  elif [ -f "$here/prompts/review-prompt.md" ]; then
    printf '%s\n' "$here/prompts/review-prompt.md"
  else
    printf '%s\n' "$here/review-prompt.md"
  fi
}

cr_review_build_prompt() {
  local skel="${CR_REVIEW_PROMPT_FILE:-$(_cr_review_prompt_default)}" shas diff body
  if [ -f "$skel" ]; then cat "$skel"; fi
  printf '\n\n## The issue\n\n'
  body="$(forgejo_get "/issues/$issue" 2>/dev/null | jq -r '.body // ""' 2>/dev/null || true)"
  printf '%s\n' "${body:-(issue body unavailable)}"
  printf '\n## The worker'\''s envelope (criteria + tests)\n\n'
  jq '{criteria: (.criteria // {}), tests: (.tests // [])}' <<<"$json" 2>/dev/null || true
  printf '\n## The diff\n\n'
  shas="$(jq -r '(.commits // []) | join(" ")' <<<"$json" 2>/dev/null || true)"
  if [ -n "$shas" ]; then
    # shellcheck disable=SC2086  # intentional word-split of the sha list
    diff="$(git -C "$root" show --format=medium $shas 2>/dev/null | head -c 200000 || true)"
  fi
  printf '```diff\n%s\n```\n' "${diff:-(diff unavailable)}"
}

# cr_review_invoke <prompt-file> <result-file> <log-file> — run the read-only
# reviewer. CR_REVIEW_CMD is the test seam (the stub receives the prompt file as
# $1 and writes the claude-shaped result to stdout). Production runs headless
# `claude --output-format json` on SWARM_REVIEW_MODEL with a READ-ONLY tool
# allowlist — no Edit/Write/push, so the reviewer can never mutate the checkout
# (the review-prompt.md "read-only" contract, enforced not just asked). A missing
# `claude` leaves the result empty → cr_review_parse fails CLOSED.
cr_review_invoke() {
  local prompt_file="$1" result="$2" log="$3"
  : > "$result"
  if [ -n "${CR_REVIEW_CMD:-}" ]; then
    ${CR_REVIEW_CMD} "$prompt_file" > "$result" 2>"$log" || true
    return 0
  fi
  command -v claude >/dev/null 2>&1 || return 0
  local tools="${CR_REVIEW_ALLOWED_TOOLS:-Read,Grep,Glob,Bash(git diff:*),Bash(git show:*),Bash(git log:*),Bash(git status:*)}"
  ( cd "$root" && timeout "${CR_REVIEW_TIMEOUT:-600}" claude -p --model "$SWARM_REVIEW_MODEL" \
      --allowedTools "$tools" --output-format json "$(cat "$prompt_file")" ) \
    > "$result" 2>"$log" || true
}

# cr_post_review <normalised-json> <verdict> — post the review verdict + findings
# on the thread, like the envelope (#197 AC). Best-effort: never fails the close.
cr_post_review() {
  local rjson="$1" verdict="$2" lines body emoji
  lines="$(cr_review_finding_lines "$rjson")"
  case "$verdict" in
    approve)         emoji=":white_check_mark:" ;;
    reject)          emoji=":no_entry:" ;;
    unsure)          emoji=":grey_question:" ;;
    unauthenticated) emoji=":fast_forward:" ;;
    *)               emoji=":warning:" ;;
  esac
  body="$emoji **independent reviewer** for #$issue — verdict \`$verdict\`
${lines:+
$(printf '%s\n' "$lines" | sed 's/^/- /')
}
<details><summary>review JSON</summary>

\`\`\`json
$(jq . <<<"$rjson" 2>/dev/null || printf '%s' "$rjson")
\`\`\`
</details>"
  jq -n --arg b "$body" '{body:$b}' |
    curl -sf -X POST -H "Authorization: token $token" -H "Content-Type: application/json" \
      -d @- "$FORGEJO_API/issues/$issue/comments" >/dev/null 2>&1 || true
}

status="$(jq -r '.status // "?"' <<<"$json")"
pretty="$(jq . <<<"$json")"

# ── gate: the independent reviewer (#197) ─────────────────────────────────────
# A SECOND, read-only agent reads the run's diff before the close can proceed —
# the deterministic gates above only check envelope self-consistency, never code
# quality or spec conformance. Runs ONLY when the close would otherwise succeed:
# the deterministic gates passed (gate_rc==0), the worker claims success, and this
# is none of: a superseded race, a no-PR dead-end, or an already-merged PR whose
# work has already landed (nothing of it is still gated here). In
# pr mode this sits BEFORE the mode branch below, so it gates the close ahead of
# landing_merge_if_green. The reviewer emits JSON {verdict, findings}; reject →
# fold the findings into the violation list (refuse), unsure → park the ticket
# ready-for-human with the findings attached, approve → proceed, unauthenticated
# → SKIP the gate (a claude -p child that is not logged in is treated as an
# absent reviewer, #228). Unparseable / empty output from a reviewer that
# genuinely RAN still fails CLOSED (refuse). The review JSON is posted on the thread like
# the envelope, and the review call's token spend is recorded (swarm.db, #94).
park_for_human=""
if cr_review_enabled && [ "$gate_rc" -eq 0 ] && [ "$status" = success ] \
   && [ -z "$pr_superseded" ] && [ -z "$pr_no_pr" ] && [ -z "$pr_merged" ]; then
  cr_review_result="$(mktemp 2>/dev/null || echo /tmp/cr-review-$issue.json)"
  cr_review_log="$(mktemp 2>/dev/null || echo /tmp/cr-review-$issue.log)"
  cr_review_build_prompt > "$cr_review_result.prompt" 2>/dev/null || true
  cr_review_invoke "$cr_review_result.prompt" "$cr_review_result" "$cr_review_log"
  # Spend for the review call (#197/#94): best-effort, a no-op without swarm.db.
  if declare -F swarmdb_spend_from_result >/dev/null 2>&1; then
    cr_spent="$(swarmdb_spend_from_result "${SWARM_RUN_ID:-close-report-$issue}" "$issue" \
      "${CLAUDE_ACTIVE_ACCOUNT:-}" "$cr_review_result" 2>/dev/null || echo 0)"
    if [ "$cr_spent" = 1 ]; then
      echo "close-report: recorded the review call's token spend (#197/#94)"
    fi
  fi
  review_json="$(cr_review_parse "$cr_review_result")"
  review_verdict="$(jq -r '.verdict // "malformed"' <<<"$review_json" 2>/dev/null || echo malformed)"
  review_lines="$(cr_review_finding_lines "$review_json")"
  cr_post_review "$review_json" "$review_verdict"   # on the thread, like the envelope
  case "$review_verdict" in
    approve) ;;  # proceed to the mode branch / direct close
    unauthenticated)
      # #228: the reviewer subprocess could not AUTHENTICATE — a `claude -p`
      # child in an interactive standing session is not logged in. Treat it like
      # an ABSENT reviewer binary and SKIP the gate (no violation, no gate_rc=1);
      # the close proceeds on the deterministic gates alone, no worse than the
      # pre-#197 world. Visible on stdout + the thread (cr_post_review above),
      # never a silent pass. Fail-CLOSED is retained for a reviewer that genuinely
      # ran and returned garbage (the malformed case below).
      echo "close-report: the independent reviewer could not authenticate (claude -p is not logged in) — SKIPPING the reviewer gate, treated as an absent reviewer (#228)" ;;
    reject)
      # The findings become the close's violation list, verbatim (#197).
      if [ -n "$review_lines" ]; then
        violations="${violations:+$violations$'\n'}$review_lines"
      else
        violations="${violations:+$violations$'\n'}reviewer rejected the diff (no findings enumerated)"
      fi
      gate_rc=1 ;;
    unsure)
      park_for_human=1 ;;
    *)  # malformed / empty — fail CLOSED
      violations="${violations:+$violations$'\n'}reviewer output was empty or unparseable — failing the close CLOSED (#197)"
      gate_rc=1 ;;
  esac
fi

# #574: close_outcome — the value swarm-db.py's attempts.close_outcome column
# exists for (success|blocked|refused|...) — is the GATE's verdict, not merely
# the envelope's self-declared status: an agent claiming "success" whose gates
# refuse the close must read "refused", never "success". Printed as a single
# structured stdout line (never worker chain-of-thought prose — the exact
# anti-pattern verdict-lib.sh's header warns about) in EVERY outcome, so
# main.mts (host-side, holding the full RunResult after the sandbox exits) can
# parse it out of the combined run stdout and wire attempts/spend into
# swarm.db — closing the "zero production writers" gap main.mts's own missing
# capture left (#574 item 1).
outcome="$status"
[ "$gate_rc" -ne 0 ] && outcome="refused"
[ -n "$park_for_human" ] && outcome="parked"      # #197: reviewer said `unsure`
[ -n "$pr_superseded" ] && outcome="superseded"   # #151: another host won the race
commits_csv="$(jq -r '(.commits // []) | join(",")' <<<"$json")"
echo "SANDCASTLE_ATTEMPT issue=$issue outcome=$outcome commits=$commits_csv"

# The envelope lands on the issue in EVERY outcome (evidence trail, #444 AC).
# post_comment wraps the given verdict markdown with the header + envelope.
post_comment() { # post_comment <verdict-markdown>
  # #1940: a mirror gate is waivable only by an explicit `mirror_waiver`, which
  # must sit in the posted comment for a human to read — surface it in the
  # verdict prose, not just inside the collapsed envelope.
  local waiver_note="" mw xw
  mw="$(jq -r '.mirror_waiver // "" | tostring' <<<"$json")"
  [ -n "$mw" ] && waiver_note="

> :warning: **mirror_waiver:** $mw"
  # #1963: gate 9's cross-repo waiver is the same bargain — the close asserts no
  # other repo is left guessing, and a human must be able to check that claim.
  xw="$(jq -r '.cross_repo_waiver // "" | tostring' <<<"$json")"
  [ -n "$xw" ] && waiver_note="$waiver_note

> :warning: **cross_repo_waiver:** $xw"
  local body="**close-report** for #$issue — status \`$status\`

$1$waiver_note

<details><summary>envelope</summary>

\`\`\`json
$pretty
\`\`\`
</details>"
  jq -n --arg b "$body" '{body:$b}' |
    curl -sf -X POST -H "Authorization: token $token" -H "Content-Type: application/json" \
      -d @- "$FORGEJO_API/issues/$issue/comments" >/dev/null
}

# #22: on a VERIFIED close, release the claim labels the swarm added while the
# ticket was in flight — `agent-working` (from claim_mark_working on claim) and
# the queue's `ready-for-agent`. The blocked path in prompt.md strips them by
# hand; the success path never did, so a closed ticket kept advertising itself
# as claimed. Resolve ids by NAME (they differ per repo) and DELETE via the
# label endpoint — GOTCHAS 2: a `labels` field in an issue-PATCH is ignored.
# A removal that fails is a WARNING line, never a refused close: the close has
# already stuck, and a lingering label is a cosmetic follow-up, not a reason to
# reopen a verified-closed ticket.
cr_release_claim_labels() { # cr_release_claim_labels <issue>
  local labels_json name lid code
  labels_json="$(forgejo_get "/labels?limit=50" 2>/dev/null || true)"
  for name in agent-working ready-for-agent; do
    lid="$(forgejo_label_id "$labels_json" "$name")"
    if [ -z "$lid" ]; then
      echo "close-report: warning: label '$name' not on the tracker — cannot release it from #$1" >&2
      continue
    fi
    code="$(forgejo_remove_label "$1" "$lid")"
    case "$code" in
      2*|"") ;;  # removed (empty = a curl/shim answering without an HTTP code)
      *) echo "close-report: warning: could not release label '$name' (HTTP $code) from #$1" >&2 ;;
    esac
  done
}

# #151: superseded — a multi-host race let another host WIN this ticket. Its PR
# merged and `closes #$issue` closed the issue on main via a branch other than
# agent/issue-$issue, so this run's work is redundant. Recognise the landed work
# instead of dead-ending in `agent-blocked`: release the claim labels the merge
# path would (so the ticket is left CLOSED with neither agent-working nor
# ready-for-agent, never the confusing dual state), post a superseded verdict,
# and exit 0. Reached only when the issue reads `closed` AND the winning merged
# PR was found (landing_superseded_by_pr_for), so this never self-closes work
# that never landed.
if [ -n "$pr_superseded" ]; then
  super_url="$(forgejo_get "/pulls/$pr_superseded" 2>/dev/null | jq -r '.html_url // empty' 2>/dev/null || true)"
  super_link="PR #$pr_superseded${super_url:+ ($super_url)}"
  post_comment ":white_check_mark: **close-report: superseded** — this issue was already closed by the merge of $super_link (a multi-host race, #151); its \`closes #$issue\` landed the work on main from a branch other than \`agent/issue-$issue\`. This run's work is redundant, so its un-merged commits are NOT gated; releasing the claim labels and closing out (never \`agent-blocked\`)."
  echo "close-report: #$issue superseded by merged $super_link — releasing claim labels, exit 0 (multi-host race, #151)."
  cr_release_claim_labels "$issue"   # #151/#22: the winner's merge closed it — release the claim labels
  exit 0
fi

# #197: the reviewer said `unsure` — a judgement call it will not make and the
# deterministic gates cannot. Do NOT close and do NOT refuse-for-retry: PARK the
# ticket for a human, findings attached, so a person rules on it. Hand the claim
# over like the blocked path does (remove ready-for-agent + agent-working, add
# ready-for-human) and exit 0 — the worker's part is done, the human takes it.
if [ -n "$park_for_human" ]; then
  park_bullets=""
  [ -n "$review_lines" ] && park_bullets="

$(printf '%s\n' "$review_lines" | sed 's/^/- /')"
  post_comment ":grey_question: **close-report: reviewer UNSURE — parked \`ready-for-human\`** — every deterministic gate passed, but the independent reviewer (#197) could not rule on the diff and flagged it for a human. The review JSON is on the thread above; its findings:$park_bullets"
  park_labels_json="$(forgejo_get "/labels?limit=50" 2>/dev/null || true)"
  rfh_id="$(forgejo_label_id "$park_labels_json" ready-for-human)"
  if [ -n "$rfh_id" ]; then
    forgejo_add_labels "$issue" "$rfh_id" >/dev/null 2>&1 || true
  else
    echo "close-report: warning: label 'ready-for-human' not on the tracker — cannot park #$issue" >&2
  fi
  for lname in ready-for-agent agent-working; do
    lid="$(forgejo_label_id "$park_labels_json" "$lname")"
    [ -n "$lid" ] && forgejo_remove_label "$issue" "$lid" >/dev/null 2>&1 || true
  done
  echo "close-report: #$issue parked ready-for-human — the reviewer was unsure (#197). Issue left OPEN for a human."
  exit 0
fi

if [ "$gate_rc" -ne 0 ]; then
  bullets="$(printf '%s\n' "$violations" | sed 's/^/- /')"
  post_comment ":no_entry: **close-report gates REFUSED this close** — the following claims did not verify:

$bullets"
  echo "close-report: REFUSED — issue #$issue NOT closed. Violations:" >&2
  printf '%s\n' "$violations" >&2
  exit 1
fi

# Gates green in pr mode (#13): the issue does NOT close by a direct state PATCH
# — it closes when the PR merges (the PR body's `closes #<issue>`). If the repo's
# MERGE_AUTHORITY is agent-after-green, merge it now and the merge closes the
# issue; otherwise leave it OPEN for a human to merge, with the envelope + PR
# linked on the thread. Either way the worker's part is done: exit 0.
if [ "$landing" = pr ]; then
  merge_authority="$(landing_merge_authority_for "$issue")"   # per ticket: landing-pr is ALWAYS human (idss ADR 0267)
  pr_url="$(forgejo_get "/pulls/$pr_number" 2>/dev/null | jq -r '.html_url // empty' 2>/dev/null || true)"
  pr_link="PR #$pr_number${pr_url:+ ($pr_url)}"
  # #206: stamp the PR with the gates-passed marker BEFORE any agent merge path
  # reads it (landing_merge_if_green requires it, so a green PR whose worker never
  # ran a verified close-report is no longer merged on green alone). Best-effort:
  # a human merge never needs it, and a failed post must not fail a passed close.
  if [ -n "$pr_number" ]; then
    forgejo_comment "$pr_number" "$LANDING_GATES_MARKER close-report gates passed for #$issue — every claim verified; this PR is cleared for merge." >/dev/null 2>&1 || true
  fi
  if [ -n "$pr_merged" ]; then
    # #108: the PR was already merged (a reconcile sweep got there first). If its
    # `closes #N` closed the issue, record the verified close and release the
    # claim labels — the merge path's own tail. If the issue is somehow still
    # open, the verified work IS on main, so fall through to the push-mode close
    # (PATCH + verify) rather than refuse.
    state="$(forgejo_get "/issues/$issue" 2>/dev/null | jq -r '.state // "?"' 2>/dev/null || true)"
    if [ "$state" = closed ]; then
      post_comment ":white_check_mark: **close-report gates passed** — every claim verified against main; $pr_link was already merged (a reconcile pass landed it before this close-report ran) and the merge closed this issue via \`closes #$issue\`."
      echo "close-report: issue #$issue already closed via the earlier merge of $pr_link (all claim gates passed)."
      cr_release_claim_labels "$issue"   # #22: closed by the merge — release the claim labels
      exit 0
    fi
    echo "close-report: $pr_link is merged but #$issue is still open — closing it directly (the work is verified on main)."
  elif [ "$merge_authority" = agent-after-green ]; then
    # #15: don't merge on the gate's word alone — merge only if the PR's required
    # checks are green. landing_merge_if_green merges a green PR (its `closes #N`
    # closes the issue), leaves a pending one for a later reconcile pass, and
    # parks a red one `agent-blocked` with the failing check named.
    merge_result="$(landing_merge_if_green "$issue")"
    case "$merge_result" in
      merged*)
        state="$(forgejo_get "/issues/$issue" 2>/dev/null | jq -r '.state // "?"' 2>/dev/null || true)"
        if [ "$state" = closed ]; then
          post_comment ":white_check_mark: **close-report gates passed** — every claim verified against the PR head; $pr_link is green and was merged (agent-after-green); the issue closed via \`closes #$issue\`."
          echo "close-report: issue #$issue closed via merge of $pr_link (all claim gates passed, checks green)."
          cr_release_claim_labels "$issue"   # #22: the merge closed it — release the claim labels
        else
          post_comment ":warning: **close-report gates passed and $pr_link merged, but the merge did not close the issue** — issue #$issue still OPEN. A human completes the merge (\`closes #$issue\`)."
          echo "close-report: gates passed and $pr_link merged but did not close #$issue — still OPEN." >&2
          exit 1
        fi
        ;;
      blocked*)
        post_comment ":no_entry: **close-report gates passed, but $pr_link's required checks are RED** — ${merge_result#blocked } failed; the PR was NOT merged and #$issue is parked \`agent-blocked\` (MERGE_AUTHORITY=agent-after-green). A human resolves the failing check(s) and re-arms it."
        echo "close-report: gates passed but $pr_link checks RED (${merge_result#blocked }) — parked agent-blocked; #$issue OPEN." >&2
        ;;
      merge-failed*)
        post_comment ":warning: **close-report gates passed and the checks are green, but the merge POST failed** ($merge_result) — $pr_link still open; a later reconcile pass or a human retries the merge."
        echo "close-report: gates passed, checks green, but the merge POST failed ($merge_result) — $pr_link open; #$issue OPEN." >&2
        ;;
      *)   # pending / no-pr — checks not all green yet
        post_comment ":hourglass_flowing_sand: **close-report gates passed** — every claim verified against the PR head; $pr_link's required checks are not all green yet, so it was NOT merged (MERGE_AUTHORITY=agent-after-green). A later reconcile pass merges it once green."
        echo "close-report: gates passed — $pr_link checks pending, left for a later merge-if-green pass; #$issue OPEN."
        ;;
    esac
  else
    post_comment ":white_check_mark: **close-report gates passed** — every claim verified against the PR head. $pr_link is open and green; a human merges it and the merge closes this issue via \`closes #$issue\` (MERGE_AUTHORITY=human)."
    echo "close-report: gates passed — $pr_link open and green, awaiting human merge; issue #$issue intentionally left OPEN."
    # idss ADR 0267: the evidence gate passed, so this is the first moment the PR
    # is worth a person's time — say so once. Best-effort, never fails the close.
    if [ "$ticket_landing_label" = "$POLICY_LANDING_PR_LABEL" ]; then
      bash "${CLOSE_REPORT_NOTIFY:-$here/notify-mattermost.sh}" \
        ":package: **PR ready for your review** — $pr_link lands #$issue, a \`landing-pr\` ticket: evidence is attached, every close-report claim verified against the PR head. Your merge closes the issue." \
        >/dev/null 2>&1 || true
    fi
  fi
  [ -n "$pr_merged" ] || exit 0   # merged-but-open (#108) falls through to the direct close
fi

# Gates green: close FIRST, VERIFY the state with a GET, and only THEN post the
# envelope with wording that matches what actually happened (#20). #19's worker
# posted ":white_check_mark: ... closing." BEFORE the PATCH; the PATCH 403'd
# because swarm-bot had repo.code write but not repo.issues write, and nothing
# said so — four runs each announced a close that never landed. So: close,
# confirm the issue really is `closed`, then speak.
close_code="$(curl -s -o /dev/null -w '%{http_code}' -X PATCH \
  -H "Authorization: token $token" -H "Content-Type: application/json" \
  -d '{"state":"closed"}' "$FORGEJO_API/issues/$issue" || true)"
state="$(curl -sf -H "Authorization: token $token" "$FORGEJO_API/issues/$issue" 2>/dev/null |
  jq -r '.state // "?"' 2>/dev/null || true)"

if [ "$state" = "closed" ]; then
  post_comment ":white_check_mark: **close-report gates passed** — every claim verified against $gate_head_desc; issue closed."
  echo "close-report: issue #$issue closed (all claim gates passed)."
  cr_release_claim_labels "$issue"   # #22: the close stuck — release the claim labels
else
  post_comment ":warning: **close-report gates passed but the close FAILED: HTTP $close_code** — issue #$issue is still OPEN. The bot likely lacks issue-write permission on this repo (the \`machines\` team needs \`repo.issues\` write, not just \`repo.code\`)."
  echo "close-report: gates passed but the close PATCH FAILED (HTTP $close_code) — issue #$issue still OPEN; check the bot's issues permission on this repo." >&2
  exit 1
fi
