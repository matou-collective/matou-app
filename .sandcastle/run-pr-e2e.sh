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

if ! n="$(derive_issue_from_branch "$branch")"; then
  echo "run-pr-e2e: branch '$branch' is not agent/issue-<N> — nothing to do"
  exit 0
fi

spec="$(feature_spec_path "$n")"
if [ -z "$spec" ]; then
  reason="$(skip_reason_from_body "$body")"
  bash "$here/notify-mattermost.sh" ":camera: **e2e PR #$PR_NUMBER** — no feature spec provided. ${reason:-No skip reason given in the PR body.} $pr_url" || true
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
make -C "$INFRA/any-sync" clean-test start-and-wait-test

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
( cd frontend && npx playwright test --project=features "tests/e2e/features/issue-$n.spec.ts" ) \
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

if [ "$rc" -eq 0 ]; then
  msg=":camera: **e2e PR #$PR_NUMBER** — ✅ passed (${tests_clause}${#shots[@]} screenshots) $pr_url"
else
  msg=":camera: **e2e PR #$PR_NUMBER** — ❌ FAILED (${tests_clause}${#shots[@]} screenshots) $pr_url"
  # include Playwright's failure screenshots alongside the curated snaps
  shopt -s nullglob globstar
  shots+=(frontend/tests/e2e/results/**/test-failed-*.png)
  shopt -u nullglob globstar
fi

root="$(bash "$here/notify-mattermost-files.sh" "$msg" "${shots[@]}")"
if [ "$rc" -ne 0 ] && [ -n "$root" ]; then
  excerpt="$(tail -30 /tmp/pr-e2e-playwright.log | head -c 3000)"
  bash "$here/notify-mattermost.sh" "\`\`\`
$excerpt
\`\`\`" "$root" || true
fi

# Spec verdict is evidence, not a gate.
exit 0
