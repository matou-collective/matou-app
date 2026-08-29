#!/usr/bin/env bash
# Run the PR's feature e2e spec against freshly-bootstrapped test infra and
# publish result + screenshots to Mattermost. Spec failure is REPORTED, not a
# job failure (exit 0); only pipeline breakage (infra/bootstrap) exits non-zero
# so the healer investigates.
# Run from the repo checkout root, checked out at the PR head.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$here/pr-e2e-lib.sh"
: "${FORGEJO_TOKEN:?}" "${FORGEJO_API:?}" "${PR_NUMBER:?}"
INFRA="${MATOU_INFRA_DIR:-$HOME/matou/matou-infrastructure}"

api() { curl -sf -H "Authorization: token $FORGEJO_TOKEN" "$@"; }

pr="$(api "$FORGEJO_API/pulls/$PR_NUMBER")"
branch="$(jq -r .head.ref <<<"$pr")"
pr_url="$(jq -r .html_url <<<"$pr")"
body="$(jq -r '.body // ""' <<<"$pr")"

# Which spec? agent/issue-<N> branches imply issue-<N>.spec.ts; any other
# branch (session/*, feature/*) opts in by naming its spec in the PR body
# ('**Feature e2e:** tests/e2e/features/issue-<N>.spec.ts'). Every PR gets a
# verdict comment either way, so a UI PR without screenshots is visible as
# such on the PR itself.
spec=""
if n="$(derive_issue_from_branch "$branch")"; then
  spec="$(feature_spec_path "$n")"
fi
if [ -z "$spec" ]; then
  spec="$(spec_from_body "$body")"
  if [ -n "$spec" ] && [ ! -f "$spec" ]; then
    echo "run-pr-e2e: PR body names $spec but it is not in the checkout" >&2
    spec=""
  fi
  [ -n "$spec" ] && n="$(issue_from_spec "$spec")"
fi
if [ -z "$spec" ]; then
  reason="$(skip_reason_from_body "$body")"
  note="no feature spec provided. ${reason:-No skip reason given in the PR body.}"
  bash "$here/notify-mattermost.sh" ":camera: **e2e PR #$PR_NUMBER** — $note $pr_url" || true
  bash "$here/post-pr-screenshots.sh" "$PR_NUMBER" ":camera: **Feature e2e:** $note" >/dev/null || true
  exit 0
fi

backend_pid=""
teardown() {
  [ -n "$backend_pid" ] && kill "$backend_pid" 2>/dev/null || true
  fuser -k 9003/tcp 2>/dev/null || true
  make -C "$INFRA/any-sync" down-test >/dev/null 2>&1 || true
  make -C "$INFRA/keri" down-test >/dev/null 2>&1 || true
}
trap teardown EXIT

echo "run-pr-e2e: PR #$PR_NUMBER issue #$n spec $spec"
bash scripts/clean-test.sh
make -C "$INFRA/keri" clean-test start-and-wait-test
# any-sync clean-test wipes the generated network config (etc-test/), which
# bare start can't recreate — setup-test regenerates it before starting.
make -C "$INFRA/any-sync" clean-test setup-test

# Runner shells are non-login: pick up a user-local Go toolchain if go isn't
# already on PATH (the workstation installs one at ~/go-sdk/go).
command -v go >/dev/null 2>&1 || export PATH="$HOME/go-sdk/go/bin:$PATH"

# Auth-enabled config servers gate writes behind a bearer token. Surface the
# test env's token (if the infra checkout provisions one) to the backend
# (MATOU_CONFIG_SERVER_TOKEN, used for the server-side config mirror and email
# relay) and to the e2e helpers (CONFIG_ADMIN_TOKEN, used for the test-reset
# DELETE in mock-config.ts). The browser never holds the token — see
# matou-collective/matou-app#1. If unset, both sides fall back to the
# well-known dev/test placeholder, which matches infra's generated default.
if [ -z "${CONFIG_ADMIN_TOKEN:-}" ] && [ -f "$INFRA/keri/.env.test" ]; then
  CONFIG_ADMIN_TOKEN="$(sed -n 's/^CONFIG_ADMIN_TOKEN=//p' "$INFRA/keri/.env.test" | head -1)"
fi
export CONFIG_ADMIN_TOKEN="${CONFIG_ADMIN_TOKEN:-}" MATOU_CONFIG_SERVER_TOKEN="${CONFIG_ADMIN_TOKEN:-}"

( cd backend && make build )
( cd backend && MATOU_ENV=test exec ./bin/server ) >/tmp/pr-e2e-backend.log 2>&1 &
backend_pid=$!
for _ in $(seq 1 60); do
  curl -sf http://localhost:9080/health >/dev/null && break
  sleep 2
done
curl -sf http://localhost:9080/health >/dev/null || { echo "backend never became healthy" >&2; exit 1; }

( cd frontend && npm ci && npx playwright install chromium )

set +e
# The e2e utils locate infra as a sibling of the repo root, which doesn't hold
# for this checkout (~/swarm-e2e/<slug>) — point them at $INFRA explicitly.
( cd frontend && MATOU_KERI_INFRA_DIR="$INFRA/keri" \
    npx playwright test --project=features "tests/e2e/features/issue-$n.spec.ts" ) \
  >/tmp/pr-e2e-playwright.log 2>&1
rc=$?
set -e
tail -40 /tmp/pr-e2e-playwright.log

shopt -s nullglob
shots=(frontend/tests/e2e/results/snaps/issue-"$n"/*.png)
shopt -u nullglob

# Best-effort test count from Playwright's summary line (e.g. "3 passed (12s)").
# Falls back to omitting the tests clause if the log format doesn't match.
tests_clause=""
if passed="$(grep -oE '[0-9]+ passed' /tmp/pr-e2e-playwright.log | head -1)"; then
  tests_clause="${passed%% passed} tests, "
fi

outcome="$(classify_e2e_outcome "$rc" /tmp/pr-e2e-playwright.log)"
case "$outcome" in
  passed)
    msg=":camera: **e2e PR #$PR_NUMBER** — ✅ passed (${tests_clause}${#shots[@]} screenshots) $pr_url"
    status="✅ **Feature e2e passed** (\`$spec\`, ${tests_clause}${#shots[@]} screenshots)"
    ;;
  failed)
    msg=":camera: **e2e PR #$PR_NUMBER** — ❌ FAILED (${tests_clause}${#shots[@]} screenshots) $pr_url"
    status="❌ **Feature e2e failed** (\`$spec\`, ${#shots[@]} curated screenshots + Playwright failure captures below). Evidence only — not a merge gate."
    ;;
  did-not-run)
    # Bootstrap (org-setup / registration-member) went red before the feature
    # spec could run: nothing here says anything about the PR. Report it as
    # pipeline breakage so the healer investigates, not as a spec failure.
    msg=":rotating_light: **e2e PR #$PR_NUMBER** — feature spec DID NOT RUN (bootstrap projects failed; 0 screenshots) $pr_url"
    status="🚨 **Feature e2e did not run** — the org-setup/registration-member bootstrap failed before \`$spec\` started, so there is no evidence for this PR yet. The pipeline (not this PR) is broken; the healer has been notified."
    ;;
esac
if [ "$outcome" != passed ]; then
  # include Playwright's failure screenshots alongside the curated snaps
  shopt -s nullglob globstar
  shots+=(frontend/tests/e2e/results/**/test-failed-*.png)
  shopt -u nullglob globstar
fi

root="$(bash "$here/notify-mattermost-files.sh" "$msg" "${shots[@]}")"
if [ "$outcome" != passed ] && [ -n "$root" ]; then
  excerpt="$(tail -30 /tmp/pr-e2e-playwright.log | head -c 3000)"
  bash "$here/notify-mattermost.sh" "\`\`\`
$excerpt
\`\`\`" "$root" || true
fi

# The reviewer's copy: verdict + screenshots on the PR itself.
bash "$here/post-pr-screenshots.sh" "$PR_NUMBER" "$status" "${shots[@]}" >/dev/null || true

# Spec verdict is evidence, not a gate; a spec that never ran is pipeline
# breakage and fails the job so the healer step runs.
[ "$outcome" = did-not-run ] && exit 1
exit 0
