#!/usr/bin/env bash
# Offline test for run-swarm.sh's LANDING=pr reconcile + summary block (#13).
# The surrounding script needs pnpm/docker/a live tracker, so — like
# run-swarm-env-guard-test.sh and run-swarm-reconcile-summary-test.sh — the
# block under test is kept structurally identical here, with landing_reconcile
# and git shimmed. Proves: pr mode fans landing_reconcile over the touched-issue
# set (pickup ∪ commit-subject #NN) and the summary lists one line per PR; push
# mode takes neither branch. landing_reconcile itself is covered in
# landing-lib-test.sh. Run: bash .sandcastle/tests/run-swarm-landing-test.sh
set -euo pipefail
fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0

repo_web="https://fj.test/Matou/matou-app"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
CALLS="$tmp/landing-calls"

# Shim landing_reconcile: record (to a file — reconcile() runs in a $() subshell)
# which issue numbers it was fanned over, and echo "<N> <pr>" for each (the
# run-swarm contract) — PR number = 100 + N.
landing_reconcile() {
  printf '%s' "$*" > "$CALLS"
  local n
  for n in "$@"; do [ -n "$n" ] && printf '%s %s\n' "$n" "$((100 + n))"; done
}

# The reconcile block, verbatim from run-swarm.sh (git-log #NN scrape and the
# main-push branch replaced by injected inputs; the SWARM_POLICY_LANDING switch
# and the landing_reconcile fan-out kept identical).
reconcile() { # reconcile <landing> <ready-json> <commit-subjects-multiline>
  local SWARM_POLICY_LANDING="$1" ready="$2" subjects="$3" opened_prs="" reconcile_nums
  if [ "${SWARM_POLICY_LANDING:-push}" = pr ]; then
    reconcile_nums="$({ jq -r '.[].number' <<<"$ready";
        printf '%s\n' "$subjects" | grep -oE '#[0-9]+' | tr -d '#' || true; } | sort -un)"
    opened_prs="$(landing_reconcile $reconcile_nums || true)"
  else
    opened_prs=""   # push mode: main push happens here (not exercised offline)
  fi
  printf '%s' "$opened_prs"
}

# The summary section, verbatim from run-swarm.sh.
pr_summary() { # pr_summary <opened_prs>
  local opened_prs="$1" summary="" pr_lines
  if [ -n "$opened_prs" ]; then
    pr_lines="$(while read -r pnum pr; do
        [ -n "$pr" ] || continue
        printf -- '- [PR #%s](%s/pulls/%s) (closes #%s)\n' "$pr" "$repo_web" "$pr" "$pnum"
      done <<<"$opened_prs")"
    summary="$summary
**PRs opened this run:**
$pr_lines"
  fi
  printf '%s' "$summary"
}

# Shim landing_merge_reconcile (#15): self-gates on MERGE_AUTHORITY (like the
# real one on SWARM_POLICY_MERGE_AUTHORITY); records that it ran and echoes a
# "<N> <result>" line for the one open agent PR.
MERGE_CALLS="$tmp/merge-calls"
landing_merge_reconcile() {
  [ "${SWARM_POLICY_MERGE_AUTHORITY:-human}" = agent-after-green ] || return 0
  printf 'ran\n' > "$MERGE_CALLS"
  printf '7 merged 88\n'
}

# The merged-PRs summary section, verbatim from run-swarm.sh.
merge_summary() { # merge_summary <merged_prs>
  local merged_prs="$1" summary="" merge_lines
  if [ -n "$merged_prs" ]; then
    merge_lines="$(while read -r mnum mres; do
        [ -n "$mnum" ] || continue
        printf -- '- #%s → %s\n' "$mnum" "$mres"
      done <<<"$merged_prs")"
    summary="$summary
**Agent PRs reconciled (merge-if-green):**
$merge_lines"
  fi
  printf '%s' "$summary"
}

# --- 1. pr mode: landing_reconcile is fanned over pickup ∪ commit #NN --------
out="$(reconcile pr '[{"number":7}]' 'sandcastle: do a thing (#7)
sandcastle: unblock child (#8)')"
[ "$(cat "$CALLS")" = "7 8" ] || fail "pr mode must fan landing over the touched set (pickup 7 + subject 8); got '$(cat "$CALLS")'"
grep -q '^7 107$' <<<"$out" || fail "pr mode must carry each issue's opened PR (7 -> 107)"
grep -q '^8 108$' <<<"$out" || fail "pr mode must carry the mid-run child's PR (8 -> 108)"
pass=$((pass+1))

# --- 2. the summary lists one 'closes #N' line per opened PR ----------------
sm="$(pr_summary "$out")"
grep -q 'PRs opened this run:' <<<"$sm" || fail "pr summary must have a 'PRs opened this run' header"
grep -qF "[PR #107]($repo_web/pulls/107) (closes #7)" <<<"$sm" || fail "pr summary must link PR #107 closing #7"
grep -qF "[PR #108]($repo_web/pulls/108) (closes #8)" <<<"$sm" || fail "pr summary must link PR #108 closing #8"
pass=$((pass+1))

# --- 3. push mode: neither branch runs — no landing fan-out, empty summary --
rm -f "$CALLS"
out="$(reconcile push '[{"number":7}]' 'sandcastle: do a thing (#7)')"
[ ! -f "$CALLS" ] || fail "push mode must NOT call landing_reconcile"
[ -z "$out" ] || fail "push mode must produce no opened_prs"
[ -z "$(pr_summary "$out")" ] || fail "push mode summary must omit the PRs section entirely"
pass=$((pass+1))

# --- 4. agent-after-green (#15): the reconcile pass merges & the summary lists it
rm -f "$MERGE_CALLS"
merged="$(SWARM_POLICY_MERGE_AUTHORITY=agent-after-green landing_merge_reconcile || true)"
[ -f "$MERGE_CALLS" ] || fail "agent-after-green must run the merge-if-green reconcile pass"
grep -q '^7 merged 88$' <<<"$merged" || fail "the merge pass must carry '<N> <result>' lines"
ms="$(merge_summary "$merged")"
grep -q 'Agent PRs reconciled (merge-if-green):' <<<"$ms" || fail "the summary must list the merge-if-green section"
grep -qF -- '- #7 → merged 88' <<<"$ms" || fail "the summary must show '#7 → merged 88'"
pass=$((pass+1))

# --- 5. MERGE_AUTHORITY=human: no merge pass, no merge section ---------------
rm -f "$MERGE_CALLS"
merged="$(SWARM_POLICY_MERGE_AUTHORITY=human landing_merge_reconcile || true)"
[ ! -f "$MERGE_CALLS" ] || fail "human authority must NOT run the merge-if-green pass"
[ -z "$(merge_summary "$merged")" ] || fail "human authority summary must omit the merge section"
pass=$((pass+1))

# --- 6. pr mode with an empty commit range: `grep -oE` matches nothing and
# exits 1. Under `set -euo pipefail` an unguarded scrape kills the whole
# reconcile stage (verdict "reconcile landing", exit=1, empty error lines) —
# run 5896's fault. This MUST run the scrape at top level in its own
# `set -euo pipefail` shell: wrapping it in a function consumed by `$()` (as
# the reconcile() shim above does) masks the death, which is how the bug
# shipped. The guarded scrape from run-swarm.sh must exit 0 on an empty range.
scrape='reconcile_nums="$({ jq -r ".[].number" <<<"[{\"number\":7}]";
    printf "%s\n" "" | grep -oE "#[0-9]+" | tr -d "#" || true; } | sort -un)"
printf "nums=[%s]\n" "$reconcile_nums"'
if out="$(bash -euo pipefail -c "$scrape" 2>&1)"; then
  [ "$out" = "nums=[7]" ] || fail "empty-range scrape must yield the pickup set alone; got '$out'"
else
  fail "empty-range scrape died under set -euo pipefail (exit $?) — the || true guard is missing"
fi
pass=$((pass+1))

echo "run-swarm-landing: $pass scenarios passed"
