#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$here/../pr-e2e-lib.sh"
fail() { echo "FAIL: $1" >&2; exit 1; }

[ "$(derive_issue_from_branch agent/issue-42)" = "42" ] || fail "derive 42"
[ "$(derive_issue_from_branch agent/issue-6)" = "6" ] || fail "derive 6"
derive_issue_from_branch main >/dev/null 2>&1 && fail "main must not derive"
derive_issue_from_branch agent/issue-x >/dev/null 2>&1 && fail "non-numeric must not derive"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/frontend/tests/e2e/features"
: > "$tmp/frontend/tests/e2e/features/issue-7.spec.ts"
( cd "$tmp"
  [ "$(feature_spec_path 7)" = "frontend/tests/e2e/features/issue-7.spec.ts" ] || fail "spec path found"
  [ -z "$(feature_spec_path 8)" ] || fail "missing spec must echo nothing"
)

body=$'closes #9\n\n**Feature e2e:** skipped — backend-only change\n**Verified in sandbox:** go test'
[ "$(skip_reason_from_body "$body")" = "**Feature e2e:** skipped — backend-only change" ] || fail "skip reason"
[ -z "$(skip_reason_from_body "no marker here")" ] || fail "absent marker must echo nothing"

# spec_from_body: the agent PR-body marker names the spec (with or without the
# frontend/ prefix, with trailing prose); skipped/absent markers yield nothing.
[ "$(spec_from_body $'**Feature e2e:** tests/e2e/features/issue-119.spec.ts — verifies the tab bar')" = "frontend/tests/e2e/features/issue-119.spec.ts" ] || fail "spec_from_body plain"
[ "$(spec_from_body $'x\n**Feature e2e:** `frontend/tests/e2e/features/issue-7.spec.ts` (snaps)')" = "frontend/tests/e2e/features/issue-7.spec.ts" ] || fail "spec_from_body prefixed+backticks"
[ -z "$(spec_from_body "$body")" ] || fail "skipped marker must yield no spec"
[ -z "$(spec_from_body "no marker")" ] || fail "no marker must yield no spec"

[ "$(issue_from_spec frontend/tests/e2e/features/issue-119.spec.ts)" = "119" ] || fail "issue_from_spec"
issue_from_spec frontend/tests/e2e/foo.spec.ts >/dev/null 2>&1 && fail "issue_from_spec non-feature must fail"

# classify_e2e_outcome: rc 0 → passed; rc≠0 with a [features] result line →
# failed; rc≠0 without one (bootstrap red, spec "did not run") → did-not-run.
log="$tmp/pw.log"
printf '  ✓  1 [org-setup] › a\n  ✘  2 [features] › tests/e2e/features/issue-7.spec.ts:3:1 › t\n  1 failed\n' >"$log"
[ "$(classify_e2e_outcome 0 "$log")" = passed ] || fail "classify passed"
[ "$(classify_e2e_outcome 1 "$log")" = failed ] || fail "classify failed"
printf '  ✘  1 [registration-member] › tests/e2e/e2e-registration.spec.ts:216:7 › x\n  2 did not run\n' >"$log"
[ "$(classify_e2e_outcome 1 "$log")" = did-not-run ] || fail "classify did-not-run"
[ "$(classify_e2e_outcome 1 "$tmp/absent.log")" = did-not-run ] || fail "classify missing log"

# screenshot_label + build_pr_comment
[ "$(screenshot_label /r/snaps/issue-7/01-filter_open.png)" = "filter open" ] || fail "curated label"
[ "$(screenshot_label /r/results/issue-7-Feature-x-features/test-failed-1.png)" = "issue-7-Feature-x-features/test-failed-1" ] || fail "failure label"
c="$(build_pr_comment "✅ passed" $'filter open\thttp://x/a.png' $'sorted\thttp://x/b.png')"
[[ "$c" == "<!-- pr-e2e -->"* ]] || fail "comment must start with marker"
grep -q '^✅ passed$' <<<"$c" || fail "comment status line"
grep -q '2 screenshot(s)' <<<"$c" || fail "comment count"
grep -q '!\[filter open\](http://x/a.png)' <<<"$c" || fail "comment image a"
grep -q '!\[sorted\](http://x/b.png)' <<<"$c" || fail "comment image b"
c0="$(build_pr_comment "skipped")"
grep -q 'screenshot(s)' <<<"$c0" && fail "no-shot comment must have no details block"

echo "pr-e2e-lib: 24 checks passed"
