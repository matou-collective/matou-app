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
# ticket LANDS. push mode: main (origin/main / CR_MAIN_HEAD). pr mode: the
# issue's OWN open PR head — resolve it now (the pr flow lands on agent/issue-<N>
# and a human, or agent-after-green, merges). No open PR in pr mode is NOT yet
# a refusal (#108): another run's reconcile sweep (landing_merge_reconcile lands
# EVERY open agent PR, #15) can merge the worker's PR — and close the issue via
# `closes #N` — in the seconds between its push and this close-report. Then the
# work HAS landed, on main: gate against main exactly as push mode does, and
# finish like a merge (sweep the claim labels). Only no-open-AND-no-merged PR
# means the work never landed as a PR: force a refusal with a clear violation.
landing="${SWARM_POLICY_LANDING:-push}"
gate_head="${CR_MAIN_HEAD:-origin/main}"
pr_number="" pr_no_pr="" pr_merged=""
if [ "$landing" = pr ]; then
  if pr_number="$(landing_merged_pr_for "$issue")"; then
    pr_merged=1
    git -C "$root" fetch --quiet origin main 2>/dev/null || true   # so main carries the merge
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
fi

# Deterministic verdict. cr_violations echoes one line per failed gate.
violations="$(cr_violations "$json" "$root" "$gate_head")" && gate_rc=0 || gate_rc=$?
if [ -n "$pr_no_pr" ]; then
  violations="${violations:+$violations$'\n'}no open agent PR (agent/issue-$issue) for this issue — pr-mode commits land on a PR before they can close it (#13)"
  gate_rc=1
fi

status="$(jq -r '.status // "?"' <<<"$json")"
pretty="$(jq . <<<"$json")"

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
commits_csv="$(jq -r '(.commits // []) | join(",")' <<<"$json")"
echo "SANDCASTLE_ATTEMPT issue=$issue outcome=$outcome commits=$commits_csv"

# The envelope lands on the issue in EVERY outcome (evidence trail, #444 AC).
# post_comment wraps the given verdict markdown with the header + envelope.
post_comment() { # post_comment <verdict-markdown>
  local body="**close-report** for #$issue — status \`$status\`

$1

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
  merge_authority="${SWARM_POLICY_MERGE_AUTHORITY:-human}"
  pr_url="$(forgejo_get "/pulls/$pr_number" 2>/dev/null | jq -r '.html_url // empty' 2>/dev/null || true)"
  pr_link="PR #$pr_number${pr_url:+ ($pr_url)}"
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
  post_comment ":white_check_mark: **close-report gates passed** — every claim verified against main; issue closed."
  echo "close-report: issue #$issue closed (all claim gates passed)."
  cr_release_claim_labels "$issue"   # #22: the close stuck — release the claim labels
else
  post_comment ":warning: **close-report gates passed but the close FAILED: HTTP $close_code** — issue #$issue is still OPEN. The bot likely lacks issue-write permission on this repo (the \`machines\` team needs \`repo.issues\` write, not just \`repo.code\`)."
  echo "close-report: gates passed but the close PATCH FAILED (HTTP $close_code) — issue #$issue still OPEN; check the bot's issues permission on this repo." >&2
  exit 1
fi
