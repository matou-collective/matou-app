#!/usr/bin/env bash
# Offline test for run-swarm.sh's reconcile-summary loop (#21). The loop scrapes
# every `#NN` from the commit subjects in $start_sha..HEAD to report each issue
# the run touched — but a subject can cite a FOREIGN #NN (a matou-app PR, an idss
# issue in a STATUS line) that 404s in THIS repo. The API call is `curl -sf`, so
# its 404 exits 22 and, under `set -e`, killed the whole reconcile stage AFTER the
# work was pushed and issues closed (run 70: `#54` 404'd, verdict exit=22). The
# fix guards the per-number GET with `|| continue`.
#
# Until #2 this file kept a structurally-identical COPY of the loop, because the
# surrounding script needs pnpm, docker and a live tracker to reach it. The loop
# now lives in report-lib.sh (the REPORT seam) as report_issue_section, so this
# test drives the REAL function with only the API call shimmed.
#
# Run: bash .sandcastle/tests/run-swarm-reconcile-summary-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sc="$here/.."
. "$sc/sweep-lib.sh"
. "$sc/report-lib.sh"

fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0

export FORGEJO_API="https://example/api"

# `_report_api` shim: own-repo numbers (10, 11, 21) resolve 200; a foreign number
# (54) 404s exactly as `curl -sf` would — non-zero exit, no body.
_report_api() { # _report_api <url .../issues/NN>
  local num="${1##*/}"
  case "$num" in
    10) printf '{"state":"closed","title":"ten","html_url":"u/10","labels":[]}' ;;
    11) printf '{"state":"closed","title":"eleven","html_url":"u/11","labels":[]}' ;;
    21) printf '{"state":"open","title":"twentyone","html_url":"u/21","labels":[]}' ;;
    *)  return 22 ;;   # curl -sf on a 404
  esac
}

# --- 1. A foreign #NN (54) scraped from a commit subject 404s, and the loop
#        STILL COMPLETES — under `set -e` the pre-fix GET's 404 would have
#        aborted the whole stage here. The foreign line is simply omitted. ---
out="$(report_issue_section '[{"number":21}]' 10 11 54)" \
  || fail "the reconcile loop must complete even when a scraped #NN 404s (set -e must not abort the stage)"
grep -q '#54' <<<"$out" && fail "a foreign #54 that 404s must be omitted from the summary, not reported"
pass=$((pass+1))

# --- 2. Every own-repo number still lands its summary line (the pickup #21 and
#        the mid-run #10/#11 from commit subjects), in sorted order. ---
for want in '#10 ten' '#11 eleven' '#21 twentyone'; do
  grep -qF "$want" <<<"$out" || fail "own-repo issue line missing from summary: $want"
done
[ "$(grep -c '^- \[#' <<<"$out")" = 3 ] || fail "exactly the three resolvable issues should be listed:
$out"
pass=$((pass+1))

# --- 3. A run whose ONLY foreign number 404s still yields a clean (empty)
#        summary and exit 0 — nothing to report is not a failure. ---
out="$(report_issue_section '[]' 54)" \
  || fail "a run citing only a foreign #NN must not red — the loop must exit 0"
[ -z "$out" ] || fail "no resolvable issues should yield an empty summary, got: $out"
pass=$((pass+1))

echo "run-swarm-reconcile-summary: $pass scenarios passed"
