#!/usr/bin/env bash
# Pure helpers for the pr-e2e workflow. Source this file; no side effects.

# agent/issue-<N> → N. Anything else: exit 1, no output.
derive_issue_from_branch() {
  [[ "${1:-}" =~ ^agent/issue-([0-9]+)$ ]] || return 1
  echo "${BASH_REMATCH[1]}"
}

# N → repo-relative spec path if it exists under CWD, else nothing (exit 0).
feature_spec_path() {
  local p="frontend/tests/e2e/features/issue-${1:?}.spec.ts"
  [ -f "$p" ] && echo "$p" || true
}

# PR body text → the '**Feature e2e:** skipped — ...' line, else nothing.
skip_reason_from_body() {
  printf '%s\n' "${1:-}" | sed -n 's/^\(\*\*Feature e2e:\*\* skipped[^\r]*\).*$/\1/p' | head -1
}
