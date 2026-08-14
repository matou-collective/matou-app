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

echo "pr-e2e-lib: 8 checks passed"
