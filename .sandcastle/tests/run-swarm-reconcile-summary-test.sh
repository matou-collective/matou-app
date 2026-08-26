#!/usr/bin/env bash
# Offline test for run-swarm.sh's reconcile-summary loop (#21). The loop scrapes
# every `#NN` from the commit subjects in $start_sha..HEAD to report each issue
# the run touched — but a subject can cite a FOREIGN #NN (a matou-app PR, an idss
# issue in a STATUS line) that 404s in THIS repo. `api` is `curl -sf`, so its 404
# exits 22 and, under `set -e`, kills the whole reconcile stage AFTER the work is
# pushed and issues closed (run 70: `#54` 404'd, verdict exit=22). The fix guards
# the per-number GET with `|| continue`. This test exercises the loop in isolation
# (the surrounding script needs pnpm, docker and a live tracker), kept structurally
# identical to the block in run-swarm.sh — only `api`/`jq` inputs are shimmed. Run:
#   bash .sandcastle/tests/run-swarm-reconcile-summary-test.sh
set -euo pipefail

fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0

# `api` shim: own-repo numbers (10, 11, 21) resolve 200; a foreign number (54)
# 404s exactly as `curl -sf` would — non-zero exit, no body.
api() { # api <url .../issues/NN>
  local num="${1##*/}"
  case "$num" in
    10) printf '{"state":"closed","title":"ten","html_url":"u/10","labels":[]}' ;;
    11) printf '{"state":"closed","title":"eleven","html_url":"u/11","labels":[]}' ;;
    21) printf '{"state":"open","title":"twentyone","html_url":"u/21","labels":[]}' ;;
    *)  return 22 ;;   # curl -sf on a 404
  esac
}

# The reconcile-summary loop, verbatim from run-swarm.sh (the FORGEJO_API prefix
# and the $ready / $commit_nums inputs injected as locals instead of derived from
# git and the live tracker).
reconcile_summary() { # reconcile_summary <ready-json> <commit_nums...>
  local FORGEJO_API="https://example/api" ready="$1"; shift
  local commit_nums="$*" summary="" num issue state title labels issue_url
  while read -r num; do
    [ -n "$num" ] || continue
    # A commit subject can cite a FOREIGN #NN — a matou-app PR (#54) or an idss
    # issue (#664) referenced in a STATUS line — that does not resolve in THIS
    # repo. `api` is `curl -sf`, so its 404 exits 22 and, under `set -e`, kills
    # the whole reconcile stage AFTER the work is pushed and issues closed (run
    # 70: `#54` 404'd, verdict `reconcile push to main` exit=22). Skip a number
    # this repo cannot resolve rather than red an already-successful run.
    issue="$(api "$FORGEJO_API/issues/$num")" || continue
    state="$(jq -r .state <<<"$issue")"
    title="$(jq -r .title <<<"$issue")"
    labels="$(jq -r '[.labels[].name] | join(", ")' <<<"$issue")"
    issue_url="$(jq -r .html_url <<<"$issue")"
    summary="$summary
- [#$num $title]($issue_url) → **$state**${labels:+ [$labels]}"
  done < <({ jq -r '.[].number' <<<"$ready"; printf '%s\n' $commit_nums; } | sort -un)
  printf '%s' "$summary"
}

# --- 1. A foreign #NN (54) scraped from a commit subject 404s, and the loop
#        STILL COMPLETES — under `set -e` the pre-fix `api` 404 would have
#        aborted the whole stage here. The foreign line is simply omitted. ---
out="$(reconcile_summary '[{"number":21}]' 10 11 54)" \
  || fail "the reconcile loop must complete even when a scraped #NN 404s (set -e must not abort the stage)"
grep -q '#54' <<<"$out" && fail "a foreign #54 that 404s must be omitted from the summary, not reported"
pass=$((pass+1))

# --- 2. Every own-repo number still lands its summary line (the pickup #21 and
#        the mid-run #10/#11 from commit subjects), in sorted order. ---
for want in '#10 ten' '#11 eleven' '#21 twentyone'; do
  grep -qF "$want" <<<"$out" || fail "own-repo issue line missing from summary: $want"
done
pass=$((pass+1))

# --- 3. A run whose ONLY foreign number 404s still yields a clean (empty)
#        summary and exit 0 — nothing to report is not a failure. ---
out="$(reconcile_summary '[]' 54)" \
  || fail "a run citing only a foreign #NN must not red — the loop must exit 0"
[ -z "$out" ] || fail "no resolvable issues should yield an empty summary, got: $out"
pass=$((pass+1))

echo "run-swarm-reconcile-summary: $pass scenarios passed"
