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

# PR body text → the spec path named by a '**Feature e2e:** tests/e2e/features/
# issue-<N>.spec.ts' line (repo-relative, frontend/ prefixed), else nothing.
# Lets non-agent branches (session/*, feature/*) opt into the pipeline by
# naming their spec in the PR body instead of via the branch name.
spec_from_body() {
  printf '%s\n' "${1:-}" \
    | sed -n 's/^\*\*Feature e2e:\*\*[^a-z]*\(\(frontend\/\)\{0,1\}tests\/e2e\/features\/issue-[0-9]\{1,\}\.spec\.ts\).*$/\1/p' \
    | head -1 | sed 's#^tests/#frontend/tests/#'
}

# frontend/tests/e2e/features/issue-<N>.spec.ts → N. Anything else: exit 1.
issue_from_spec() {
  [[ "${1:-}" =~ issue-([0-9]+)\.spec\.ts$ ]] || return 1
  echo "${BASH_REMATCH[1]}"
}

# Playwright exit code + log → passed | failed | did-not-run.
#
# The features project depends on org-setup + registration-member; when one
# of those bootstrap projects goes red the feature spec is reported as "did
# not run" and produces zero snaps. That is pipeline breakage (the healer's
# business), not a verdict on the PR — so it must not be reported as a plain
# spec failure. A spec "ran" iff Playwright printed at least one
# "[features] ›" result line for it.
classify_e2e_outcome() { # classify_e2e_outcome <rc> <playwright-log>
  local rc="${1:?}" log="${2:?}"
  if [ "$rc" -eq 0 ]; then echo passed; return; fi
  if [ -f "$log" ] && grep -q '\[features\] ›' "$log"; then echo failed; else echo did-not-run; fi
}

# Marker that identifies the pipeline's comment on a PR so reruns edit it in
# place instead of stacking a new comment per push.
PR_E2E_COMMENT_MARKER='<!-- pr-e2e -->'

# Human label for a screenshot path: curated snaps are NN-label.png (label with
# underscores → spaces); anything else (Playwright's test-failed-N.png) is
# prefixed with its result directory so the reviewer can tell which test.
screenshot_label() {
  local f="${1:?}" base
  base="$(basename "$f" .png)"
  if [[ "$base" =~ ^[0-9]+-(.+)$ ]]; then
    printf '%s\n' "${BASH_REMATCH[1]//_/ }"
  else
    printf '%s/%s\n' "$(basename "$(dirname "$f")")" "$base"
  fi
}

# build_pr_comment <status-markdown> [label<TAB>url ...] → comment body on stdout.
build_pr_comment() {
  local status="${1:?}"; shift || true
  printf '%s\n%s\n' "$PR_E2E_COMMENT_MARKER" "$status"
  if [ "$#" -gt 0 ]; then
    printf '\n<details open><summary>%d screenshot(s)</summary>\n\n' "$#"
    local pair label url
    for pair in "$@"; do
      label="${pair%%$'\t'*}"; url="${pair#*$'\t'}"
      printf '**%s**\n\n![%s](%s)\n\n' "$label" "$label" "$url"
    done
    printf '</details>\n'
  fi
}
