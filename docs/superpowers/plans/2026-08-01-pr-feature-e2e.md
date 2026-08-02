# PR Feature E2E with Screenshots — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agent PRs carry an issue-scoped Playwright spec; a `pr-e2e` workflow runs it against a scripted-bootstrap test env and posts pass/fail + curated screenshots to Mattermost.

**Architecture:** A new `features` Playwright project (depending on the existing self-sufficient `org-setup` + `registration` projects for bootstrap) runs specs named `issue-<N>.spec.ts` written by swarm agents against fixtures (`adminPage`, `memberPage`, `snap`). A host-mode Forgejo workflow brings up KERI + any-sync test infra per run, executes only the PR's spec, and publishes screenshots via a new Mattermost file-upload script. Spec: `docs/superpowers/specs/2026-08-01-pr-feature-e2e-design.md`.

**Tech Stack:** Playwright, Vitest, bash (`.sandcastle/` conventions), Forgejo Actions (host-mode runner on matou-workstation), Mattermost REST v4.

## Global Constraints

- Base branch: `main` from the `forgejo` remote (`https://git.matou.nz/Matou/matou-app`). Work on branch `feat/pr-e2e` in an isolated worktree (superpowers:using-git-worktrees) — the main checkout has unrelated uncommitted work.
- Shell scripts: `#!/usr/bin/env bash`, `set -euo pipefail`, mirror `.sandcastle/notify-mattermost.sh` conventions (no-creds fallback → message to stderr, exit 0). Offline tests live in `.sandcastle/tests/*-test.sh`, runnable with no network/creds, print `<name>: N checks passed`.
- Never echo tokens. Secrets come from workflow env (`secrets.*`) or `/run/secrets/*` fallback.
- Commit style: conventional, e.g. `feat(swarm): ...`, `ci: ...`; end commit messages with the Claude co-author line used in this repo.
- Deviation from spec §2, agreed rationale: bootstrap reuses the existing `test-accounts.json` + `loginWithMnemonic` pattern (mnemonic re-login per test) instead of Playwright `storageState`; roles are `adminPage` (kaitiaki) + `memberPage` (no `memberBPage` — YAGNI, registration creates one member).
- The e2e suite itself only runs on matou-workstation (live infra). Local/sandbox validation of specs is `npx playwright test --list` only.

---

### Task 1: Green unit-CI baseline (exclude live-infra Vitest files in CI)

The `checks` job has never passed: `npm run test:script` includes
`tests/scripts/test-oobi-messaging.ts` and
`tests/scripts/witness-assignment.test.ts`, which dial KERIA
(`ECONNREFUSED 127.0.0.1:4904`) and can never pass in the sandbox.

**Files:**
- Modify: `frontend/vitest.config.ts`
- Modify: `frontend/package.json` (scripts)
- Modify: `.forgejo/workflows/ci.yml` (checks step)
- Modify: `.sandcastle/prompt.md` (rule 3 frontend command)

**Interfaces:**
- Produces: npm script `test:unit` — Vitest run with infra-dependent files excluded via env `VITEST_SKIP_INFRA=1`. CI and the agent sandbox call `npm run test:unit`; humans with live infra keep `npm run test:script` (full).

- [ ] **Step 1: Env-gated exclude in vitest.config.ts**

Replace the `test:` block's `exclude` line:

```ts
  test: {
    // Test scripts live outside src/
    include: ['tests/scripts/**/*.ts'],
    // VITEST_SKIP_INFRA=1 (CI / agent sandbox) drops tests that need live
    // KERI infrastructure (KERIA on 4904 + config server).
    exclude: [
      'tests/scripts/health-check.ts',
      ...(process.env.VITEST_SKIP_INFRA
        ? [
            'tests/scripts/test-oobi-messaging.ts',
            'tests/scripts/witness-assignment.test.ts',
          ]
        : []),
    ],
    testTimeout: 120000,
```

- [ ] **Step 2: Add `test:unit` script to frontend/package.json**

Next to `"test:script"`:

```json
    "test:unit": "VITEST_SKIP_INFRA=1 vitest run --config vitest.config.ts",
```

- [ ] **Step 3: Verify locally — excluded run passes, full run still includes them**

Run: `cd frontend && npm run test:unit`
Expected: PASS, and neither `test-oobi-messaging` nor `witness-assignment` appears in the file list.

Run: `npx vitest list --config vitest.config.ts 2>/dev/null | grep -c oobi || true`
Expected: non-zero (full config still includes the file).

- [ ] **Step 4: Point ci.yml at test:unit**

In `.forgejo/workflows/ci.yml`, in the docker run script, change:

```
cd frontend && CI=true npm ci && npm run test:script && npm run lint && cd ..
```
to
```
cd frontend && CI=true npm ci && npm run test:unit && npm run lint && cd ..
```

- [ ] **Step 5: Same swap in the agent's checklist**

In `.sandcastle/prompt.md` rule 3, change
`frontend: cd frontend && npm run test:script && npm run lint`
to
`frontend: cd frontend && npm run test:unit && npm run lint`.

- [ ] **Step 6: Commit**

```bash
git add frontend/vitest.config.ts frontend/package.json .forgejo/workflows/ci.yml .sandcastle/prompt.md
git commit -m "ci: green unit baseline — exclude live-infra vitest files via VITEST_SKIP_INFRA"
```

---

### Task 2: `features` Playwright project + fixtures (`adminPage`, `memberPage`, `snap`)

**Files:**
- Modify: `frontend/playwright.config.ts` (add project; extend `chromium` testIgnore)
- Create: `frontend/tests/e2e/features/fixtures.ts`
- Create: `frontend/tests/e2e/features/issue-0.spec.ts` (fixture smoke spec, kept — proves the harness itself on every future full run)

**Interfaces:**
- Consumes: `loginWithMnemonic(page, mnemonic: string[])` from `frontend/tests/e2e/utils/test-helpers.ts` (existing — see usage in `e2e-projects-contributions.spec.ts:314`); `tests/e2e/test-accounts.json` written by the `org-setup`/`registration` projects (`{ admin: { mnemonic: string[] }, member: { mnemonic: string[] } }`).
- Produces: fixtures module exporting `test` (with `adminPage`, `memberPage`, `snap`) and `expect`. `snap(page, label)` writes `frontend/tests/e2e/results/snaps/issue-<N>/<nn>-<label>.png` (N parsed from the spec filename). Task 5's workflow collects that directory.

- [ ] **Step 1: Add the `features` project to playwright.config.ts**

Insert before the `chromium` catch-all project:

```ts
    // Feature specs authored by swarm agents (one per issue). Bootstrap via
    // the self-sufficient org-setup + registration projects, which create the
    // org and a member and persist tests/e2e/test-accounts.json.
    {
      name: 'features',
      testMatch: /features\/issue-\d+\.spec\.ts/,
      use: browserConfig,
      dependencies: ['org-setup', 'registration'],
    },
```

And add to the `chromium` project's `testIgnore` array:

```ts
        /features\/issue-\d+\.spec\.ts/,
```

- [ ] **Step 2: Write fixtures.ts**

```ts
import { test as base, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { loginWithMnemonic } from '../utils/test-helpers';

// Accounts persisted by the org-setup / registration projects (declared as
// project dependencies of `features`). Feature specs never register/login
// manually — they consume these fixtures only.
interface TestAccounts {
  admin?: { mnemonic: string[]; aid: string; name: string };
  member?: { mnemonic: string[]; aid?: string; name?: string };
}

function loadAccounts(): TestAccounts {
  const p = path.join(__dirname, '..', 'test-accounts.json');
  if (!fs.existsSync(p)) {
    throw new Error(
      'test-accounts.json missing — run via `--project=features` so the ' +
        'org-setup/registration dependencies bootstrap the test env first.'
    );
  }
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as TestAccounts;
}

type Fixtures = {
  adminPage: Page;
  memberPage: Page;
  snap: (page: Page, label: string) => Promise<void>;
};

export const test = base.extend<Fixtures>({
  adminPage: async ({ browser }, use) => {
    const accounts = loadAccounts();
    if (!accounts.admin?.mnemonic) throw new Error('no admin in test-accounts.json');
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await loginWithMnemonic(page, accounts.admin.mnemonic);
    await use(page);
    await ctx.close();
  },
  memberPage: async ({ browser }, use) => {
    const accounts = loadAccounts();
    if (!accounts.member?.mnemonic) throw new Error('no member in test-accounts.json');
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await loginWithMnemonic(page, accounts.member.mnemonic);
    await use(page);
    await ctx.close();
  },
  snap: async ({}, use, testInfo) => {
    const m = path.basename(testInfo.file).match(/issue-(\d+)/);
    const dir = path.join(__dirname, '..', 'results', 'snaps', `issue-${m ? m[1] : 'unknown'}`);
    fs.mkdirSync(dir, { recursive: true });
    let n = 0;
    await use(async (page: Page, label: string) => {
      n++;
      const name = `${String(n).padStart(2, '0')}-${label.replace(/[^a-z0-9-]/gi, '_')}.png`;
      await page.screenshot({ path: path.join(dir, name), fullPage: true });
    });
  },
});

export { expect };
```

If `loginWithMnemonic` is exported from a different path than
`../utils/test-helpers`, match the import used at the top of
`e2e-projects-contributions.spec.ts` — same file, same symbol.

- [ ] **Step 3: Fixture smoke spec (issue-0)**

`frontend/tests/e2e/features/issue-0.spec.ts` — proves fixtures + snap wiring
without depending on any feature:

```ts
import { test, expect } from './fixtures';

test.describe('features harness smoke', () => {
  test('admin and member fixtures produce logged-in sessions', async ({
    adminPage,
    memberPage,
    snap,
  }) => {
    await adminPage.goto('/');
    await expect(adminPage.locator('body')).toBeVisible();
    await snap(adminPage, 'admin-home');

    await memberPage.goto('/');
    await expect(memberPage.locator('body')).toBeVisible();
    await snap(memberPage, 'member-home');
  });
});
```

- [ ] **Step 4: Validate without infra**

Run: `cd frontend && npx playwright test --list --project=features`
Expected: lists `issue-0.spec.ts` test(s), exit 0 — parse/type errors would fail here.

Run: `npx playwright test --list --project=chromium 2>/dev/null | grep -c 'features/' || true`
Expected: `0` (catch-all ignores feature specs).

- [ ] **Step 5: Ensure snaps output is gitignored**

Check `frontend/.gitignore` (or root) covers `tests/e2e/results/`. If not, add
`frontend/tests/e2e/results/`.

- [ ] **Step 6: Commit**

```bash
git add frontend/playwright.config.ts frontend/tests/e2e/features/
git commit -m "feat(e2e): features project with adminPage/memberPage/snap fixtures"
```

---

### Task 3: `notify-mattermost-files.sh` + offline test

**Files:**
- Create: `.sandcastle/notify-mattermost-files.sh`
- Test: `.sandcastle/tests/notify-files-test.sh`

**Interfaces:**
- Consumes: env `MATTERMOST_URL`, `MATTERMOST_BOT_TOKEN` (or `/run/secrets/mattermost_bot_token`), `MATTERMOST_CHANNEL_ID` — identical contract to `notify-mattermost.sh`.
- Produces: `notify-mattermost-files.sh "<message>" [png ...]` — uploads files, posts message with first 10 attached, overflow in thread replies, prints root post id to stdout. Task 5 calls it.

- [ ] **Step 1: Write the failing test**

`.sandcastle/tests/notify-files-test.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
n="$here/../notify-mattermost-files.sh"
fail() { echo "FAIL: $1" >&2; exit 1; }

# creds unset → message+files to stderr, NOTHING on stdout, exit 0
out="$(env -u MATTERMOST_URL -u MATTERMOST_BOT_TOKEN -u MATTERMOST_CHANNEL_ID \
  bash "$n" "hello" /nonexistent.png 2>/dev/null)"
[ -z "$out" ] || fail "stdout must stay empty when chat is unset"

# no message → usage error
if bash "$n" >/dev/null 2>&1; then fail "no-arg call must fail"; fi

# 12 files → 12 uploads, 2 posts (root with 10, one threaded overflow reply)
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/bin"
cat >"$tmp/bin/curl" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "${CURL_LOG:?}"
if [[ "$*" == */api/v4/files* ]]; then
  echo "{\"file_infos\":[{\"id\":\"fid-$RANDOM$RANDOM\"}]}"
else
  # capture the posted JSON body from stdin (curl -d @-)
  cat >> "${CURL_LOG}.bodies"
  echo '{"id":"post-1"}'
fi
EOF
chmod +x "$tmp/bin/curl"
for i in $(seq 1 12); do : > "$tmp/s$i.png"; done
out="$(PATH="$tmp/bin:$PATH" CURL_LOG="$tmp/calls.log" \
  MATTERMOST_URL=http://mm MATTERMOST_BOT_TOKEN=t MATTERMOST_CHANNEL_ID=chan \
  bash "$n" "msg here" "$tmp"/s*.png)"
[ "$out" = "post-1" ] || fail "must print root post id, got: $out"
[ "$(grep -c '/api/v4/files' "$tmp/calls.log")" -eq 12 ] || fail "expected 12 uploads"
[ "$(grep -c '/api/v4/posts' "$tmp/calls.log")" -eq 2 ] || fail "expected root + overflow posts"
grep -q '"root_id":"post-1"' "$tmp/calls.log.bodies" || fail "overflow must thread under root"

echo "notify-files: 5 checks passed"
```

- [ ] **Step 2: Run it — must fail (script missing)**

Run: `bash .sandcastle/tests/notify-files-test.sh`
Expected: FAIL (no such file `notify-mattermost-files.sh`).

- [ ] **Step 3: Write the script**

`.sandcastle/notify-mattermost-files.sh`:

```bash
#!/usr/bin/env bash
# Post a markdown message WITH file attachments to Mattermost as the swarm bot.
# Usage: notify-mattermost-files.sh "<message>" [file ...]
# Env: same contract as notify-mattermost.sh. When creds are unset, print the
# message and file list to stderr and exit 0.
# Mattermost caps 10 attachments per post: the first 10 files attach to the
# root post; each further batch of 10 goes in a threaded reply.
# Prints the root post id on stdout.
set -euo pipefail
msg="${1:?usage: notify-mattermost-files.sh <message> [file ...]}"
shift || true
if [ -z "${MATTERMOST_BOT_TOKEN:-}" ] && [ -f /run/secrets/mattermost_bot_token ]; then
  MATTERMOST_BOT_TOKEN="$(cat /run/secrets/mattermost_bot_token)"
fi
if [ -z "${MATTERMOST_URL:-}" ] || [ -z "${MATTERMOST_BOT_TOKEN:-}" ] || [ -z "${MATTERMOST_CHANNEL_ID:-}" ]; then
  echo "notify-mattermost-files: MATTERMOST_URL/MATTERMOST_BOT_TOKEN/MATTERMOST_CHANNEL_ID unset — would have sent:" >&2
  echo "$msg" >&2
  [ "$#" -gt 0 ] && printf ' - %s\n' "$@" >&2
  exit 0
fi

ids=()
for f in "$@"; do
  [ -f "$f" ] || continue
  id="$(curl -sf --max-time 60 -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" \
    -F "files=@$f" -F "channel_id=$MATTERMOST_CHANNEL_ID" \
    "$MATTERMOST_URL/api/v4/files" | jq -r '.file_infos[0].id // empty')"
  [ -n "$id" ] && ids+=("$id")
done

post() { # $1=message $2=json-array-of-file-ids $3=root_id ("" for root)
  jq -n --arg channel_id "$MATTERMOST_CHANNEL_ID" --arg message "$1" \
    --argjson file_ids "$2" --arg root_id "$3" \
    '{channel_id: $channel_id, message: $message, file_ids: $file_ids}
     + (if $root_id != "" then {root_id: $root_id} else {} end)' |
  curl -sf --max-time 30 -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" \
    -H 'Content-Type: application/json' -d @- "$MATTERMOST_URL/api/v4/posts" |
  jq -r '.id // empty'
}

slice_json() { # $1=start index — 10 ids from $ids as a JSON array
  local s=$1 out=()
  out=("${ids[@]:$s:10}")
  if [ "${#out[@]}" -eq 0 ]; then echo '[]'; else
    printf '%s\n' "${out[@]}" | jq -R . | jq -cs .
  fi
}

root="$(post "$msg" "$(slice_json 0)" "")"
i=10
while [ "$i" -lt "${#ids[@]}" ]; do
  post "(more screenshots)" "$(slice_json "$i")" "$root" >/dev/null
  i=$((i + 10))
done
printf '%s' "$root"
```

- [ ] **Step 4: Run the test — must pass**

Run: `bash .sandcastle/tests/notify-files-test.sh`
Expected: `notify-files: 5 checks passed`

Also run the existing suite to confirm nothing regressed:
`for t in .sandcastle/tests/*-test.sh; do bash "$t"; done`

- [ ] **Step 5: Commit**

```bash
git add .sandcastle/notify-mattermost-files.sh .sandcastle/tests/notify-files-test.sh
chmod +x .sandcastle/notify-mattermost-files.sh
git commit -m "feat(swarm): mattermost file-upload notifier with 10-attachment chunking"
```

---

### Task 4: `pr-e2e-lib.sh` (pure helpers) + offline test

**Files:**
- Create: `.sandcastle/pr-e2e-lib.sh`
- Test: `.sandcastle/tests/pr-e2e-lib-test.sh`

**Interfaces:**
- Produces (sourced by Task 5's runner):
  - `derive_issue_from_branch <branch>` → echoes N for `agent/issue-<N>`, exit 1 otherwise
  - `feature_spec_path <N>` → echoes `frontend/tests/e2e/features/issue-<N>.spec.ts` if the file exists (relative to CWD), else echoes nothing, exit 0
  - `skip_reason_from_body <pr-body-text>` → echoes the `**Feature e2e:** skipped — ...` line if present, else nothing, exit 0

- [ ] **Step 1: Write the failing test**

`.sandcastle/tests/pr-e2e-lib-test.sh`:

```bash
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
```

- [ ] **Step 2: Run it — must fail (lib missing)**

Run: `bash .sandcastle/tests/pr-e2e-lib-test.sh`
Expected: FAIL sourcing `pr-e2e-lib.sh`.

- [ ] **Step 3: Write the lib**

`.sandcastle/pr-e2e-lib.sh`:

```bash
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
```

- [ ] **Step 4: Run the test — must pass**

Run: `bash .sandcastle/tests/pr-e2e-lib-test.sh`
Expected: `pr-e2e-lib: 8 checks passed`

- [ ] **Step 5: Commit**

```bash
git add .sandcastle/pr-e2e-lib.sh .sandcastle/tests/pr-e2e-lib-test.sh
git commit -m "feat(swarm): pr-e2e pure helpers — branch parsing, spec lookup, skip marker"
```

---

### Task 5: `run-pr-e2e.sh` + `.forgejo/workflows/pr-e2e.yml`

**Files:**
- Create: `.sandcastle/run-pr-e2e.sh`
- Create: `.forgejo/workflows/pr-e2e.yml`

**Interfaces:**
- Consumes: Task 3 (`notify-mattermost-files.sh`), Task 4 (`pr-e2e-lib.sh`), Task 2 (`features` project, snaps dir), existing `notify-mattermost.sh`, `scripts/clean-test.sh`, infra Makefiles (`clean-test`, `start-and-wait-test`, `down-test` in both `keri/` and `any-sync/`).
- Env contract of `run-pr-e2e.sh` (set by workflow): `FORGEJO_TOKEN`, `FORGEJO_API` (repo-scoped), `PR_NUMBER`, `MATTERMOST_URL`, `MATTERMOST_BOT_TOKEN`, `MATTERMOST_CHANNEL_ID`, optional `MATOU_INFRA_DIR` (default `$HOME/matou/matou-infrastructure`). Run from the repo checkout root, already at the PR head commit.

- [ ] **Step 1: Write run-pr-e2e.sh**

```bash
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
  bash "$here/notify-mattermost.sh" ":camera: **e2e PR #$PR_NUMBER** — no feature spec provided. ${reason:-No skip reason given in the PR body.} $pr_url"
  exit 0
fi

backend_pid=""
teardown() {
  [ -n "$backend_pid" ] && kill "$backend_pid" 2>/dev/null || true
  make -C "$INFRA/any-sync" down-test >/dev/null 2>&1 || true
  make -C "$INFRA/keri" down-test >/dev/null 2>&1 || true
}
trap teardown EXIT

echo "run-pr-e2e: PR #$PR_NUMBER issue #$n spec $spec"
bash scripts/clean-test.sh
make -C "$INFRA/keri" clean-test start-and-wait-test
make -C "$INFRA/any-sync" clean-test start-and-wait-test

( cd backend && make build )
( cd backend && MATOU_ENV=test ./bin/server ) >/tmp/pr-e2e-backend.log 2>&1 &
backend_pid=$!
for _ in $(seq 1 60); do
  curl -sf http://localhost:9080/health >/dev/null && break
  sleep 2
done
curl -sf http://localhost:9080/health >/dev/null || { echo "backend never became healthy" >&2; exit 1; }

( cd frontend && npm ci && npx playwright install --with-deps chromium )

set +e
( cd frontend && npx playwright test --project=features "tests/e2e/features/issue-$n.spec.ts" ) \
  >/tmp/pr-e2e-playwright.log 2>&1
rc=$?
set -e
tail -40 /tmp/pr-e2e-playwright.log

shopt -s nullglob
shots=(frontend/tests/e2e/results/snaps/issue-"$n"/*.png)
shopt -u nullglob

if [ "$rc" -eq 0 ]; then
  msg=":camera: **e2e PR #$PR_NUMBER** — ✅ passed (${#shots[@]} screenshots) $pr_url"
else
  msg=":camera: **e2e PR #$PR_NUMBER** — ❌ FAILED (${#shots[@]} screenshots) $pr_url"
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
```

- [ ] **Step 2: Validate with the offline paths only**

Run (from repo root, creds unset — exercises arg guards + not-an-agent-branch path via a fake API):

```bash
tmp="$(mktemp -d)"; mkdir "$tmp/bin"
cat >"$tmp/bin/curl" <<'EOF'
#!/usr/bin/env bash
echo '{"head":{"ref":"main"},"html_url":"http://x","body":""}'
EOF
chmod +x "$tmp/bin/curl"
PATH="$tmp/bin:$PATH" FORGEJO_TOKEN=t FORGEJO_API=http://x PR_NUMBER=1 bash .sandcastle/run-pr-e2e.sh
```
Expected: `run-pr-e2e: branch 'main' is not agent/issue-<N> — nothing to do`, exit 0. (The live path is Task 8.)

- [ ] **Step 3: Write pr-e2e.yml**

`.forgejo/workflows/pr-e2e.yml` — mirrors `triage.yml`'s clone-with-token and
healer patterns; holds the same global lock so it never overlaps agent jobs
(one set of test ports on the box):

```yaml
name: pr-e2e
on:
  pull_request:
    types: [opened, synchronize]
  workflow_dispatch:
    inputs:
      pr_number:
        description: "PR number to run feature e2e for"
        required: true

jobs:
  feature-e2e:
    runs-on: matou-workstation
    timeout-minutes: 40
    if: github.event_name == 'workflow_dispatch' || startsWith(github.event.pull_request.head.ref, 'agent/issue-')
    steps:
      - name: Feature e2e under global lock
        env:
          FORGEJO_TOKEN: ${{ secrets.SWARM_FORGEJO_TOKEN }}
          FORGEJO_API: ${{ github.server_url }}/api/v1/repos/${{ github.repository }}
          REPO_SLUG: ${{ github.repository }}
          PR_NUMBER: ${{ github.event.pull_request.number || inputs.pr_number }}
          HEAD_REF: ${{ github.event.pull_request.head.ref || '' }}
          MATTERMOST_URL: ${{ secrets.MATTERMOST_URL }}
          MATTERMOST_BOT_TOKEN: ${{ secrets.MATTERMOST_BOT_TOKEN }}
          MATTERMOST_CHANNEL_ID: ${{ secrets.MATTERMOST_CHANNEL_ID }}
        run: |
          set -euo pipefail
          exec 9>/tmp/matou-swarm.lock
          flock -w 3600 9
          workdir="$HOME/swarm-e2e/$REPO_SLUG"
          mkdir -p "$workdir"
          cd "$workdir"
          url="https://swarm:${FORGEJO_TOKEN}@git.matou.nz/${REPO_SLUG}.git"
          if [ -d .git ]; then
            git remote set-url origin "$url"
          else
            git clone "$url" .
          fi
          git fetch origin "refs/pull/${PR_NUMBER}/head"
          git checkout -f FETCH_HEAD
          bash .sandcastle/run-pr-e2e.sh
      - name: Investigate failure (healer)
        if: failure()
        env:
          FORGEJO_TOKEN: ${{ secrets.SWARM_FORGEJO_TOKEN }}
          FORGEJO_API: ${{ github.server_url }}/api/v1/repos/${{ github.repository }}
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          MATTERMOST_URL: ${{ secrets.MATTERMOST_URL }}
          MATTERMOST_BOT_TOKEN: ${{ secrets.MATTERMOST_BOT_TOKEN }}
          MATTERMOST_CHANNEL_ID: ${{ secrets.MATTERMOST_CHANNEL_ID }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_number }}
          WORKFLOW: pr-e2e
          HEAL_DRY_RUN: "1"
        run: |
          bash "$HOME/swarm-e2e/${{ github.repository }}/.sandcastle/heal.sh" || {
            [ -z "$MATTERMOST_BOT_TOKEN" ] && exit 0
            jq -n --arg channel_id "$MATTERMOST_CHANNEL_ID" --arg message ":rotating_light: pr-e2e failed AND the healer errored in \`${{ github.repository }}\` — $RUN_URL" '{channel_id: $channel_id, message: $message}' |
              curl -sf -X POST -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" -H 'Content-Type: application/json' -d @- "$MATTERMOST_URL/api/v4/posts" || true
          }
```

- [ ] **Step 4: Lint the YAML**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.forgejo/workflows/pr-e2e.yml'))" && echo OK`
Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add .sandcastle/run-pr-e2e.sh .forgejo/workflows/pr-e2e.yml
chmod +x .sandcastle/run-pr-e2e.sh
git commit -m "feat(swarm): pr-e2e workflow — feature spec run + screenshots to Mattermost"
```

---

### Task 6: Agent convention in `.sandcastle/prompt.md`

**Files:**
- Modify: `.sandcastle/prompt.md` (insert new rule after rule 2; renumber the following rules; extend the PR-body template in the PR-opening rule)

**Interfaces:**
- Consumes: Task 2's fixtures (names must match: `adminPage`, `memberPage`, `snap`).
- Produces: the convention Task 5's missing-spec path reads (`**Feature e2e:** skipped — <reason>` marker, matching Task 4's `skip_reason_from_body`).

- [ ] **Step 1: Insert the new rule after rule 2 ("Reproduce before fixing")**

```markdown
3. **Feature e2e spec — user-facing changes only.** Before implementing,
   create `frontend/tests/e2e/features/issue-<NUMBER>.spec.ts`. Import ONLY
   from `./fixtures` (`test`, `expect` — fixtures provide `adminPage` and
   `memberPage` as logged-in sessions, plus `snap`). Never register, log in,
   or create the org manually. Call `await snap(page, '<label>')` at each
   state that demonstrates the feature — these screenshots are what the
   human reviewer sees in Mattermost. You cannot RUN e2e here; validate
   syntax with:
   `cd frontend && npx playwright test --list tests/e2e/features/issue-<NUMBER>.spec.ts`
   For backend-only / docs / CI issues, skip the spec and put
   `**Feature e2e:** skipped — <reason>` in the PR body (exact marker — the
   pipeline reports it to Mattermost).
```

Renumber existing rules 3–7 to 4–8 (their cross-references too, if any).

- [ ] **Step 2: Extend the PR body template**

In the PR-opening `curl` example inside the (now) rule 6, extend the body
string with a line before `**Verified in sandbox:**`:

```
**Feature e2e:** tests/e2e/features/issue-<NUMBER>.spec.ts
```
(or the `skipped — <reason>` form).

- [ ] **Step 3: Sanity-check the offline swarm tests still pass**

Run: `for t in .sandcastle/tests/*-test.sh; do bash "$t"; done`
Expected: all pass (prompt.md is data for run-swarm.sh; no test parses the rule numbers, but confirm).

- [ ] **Step 4: Commit**

```bash
git add .sandcastle/prompt.md
git commit -m "feat(swarm): agents author feature e2e specs with snap screenshots"
```

---

### Task 7: Runner capacity 2 (ops — matou-workstation)

Without this, a 20–40 min flock-holding e2e job on the capacity-1 runner
starves triage/swarm (the 2026-08-01 six-hour jam). Requires shell access:
`ssh matou-workstation` (user `dev`); systemd steps may need sudo — if `dev`
lacks it, hand these commands to Benz/Ian.

**Files (remote host, not this repo):**
- Create: `/home/dev/forgejo-runner/config.yml`
- Modify: `/etc/systemd/system/forgejo-runner.service` (ExecStart)

- [ ] **Step 1: Generate default config and set capacity**

```bash
ssh matou-workstation
cd /home/dev/forgejo-runner
/usr/local/bin/forgejo-runner generate-config > config.yml
sed -i 's/^\(\s*capacity:\).*/\1 2/' config.yml
grep -n 'capacity' config.yml   # expect: capacity: 2
```

- [ ] **Step 2: Point the service at the config**

Edit `/etc/systemd/system/forgejo-runner.service` ExecStart to:

```
ExecStart=/usr/local/bin/forgejo-runner daemon --config /home/dev/forgejo-runner/config.yml
```

- [ ] **Step 3: Restart when idle**

A restart kills running jobs. Wait until no agent container is live and the
journal shows no recent pickup:

```bash
docker ps --filter name=sandcastle- --format '{{.Names}}'   # must be empty
journalctl -u forgejo-runner -q --since "-5 min" | grep -c "task .* repo is" # ideally 0
sudo systemctl daemon-reload && sudo systemctl restart forgejo-runner
```

- [ ] **Step 4: Verify**

```bash
systemctl is-active forgejo-runner        # active
journalctl -u forgejo-runner -q --since "-2 min" | head -5   # daemon started, no config errors
```
Then from the laptop confirm the runner still shows `active` via
`GET /api/v1/orgs/Matou/actions/runners` and, over the next hour, that two
tasks can run concurrently (journal shows a second pickup while a swarm job runs).

---

### Task 8: Live smoke (after merging `feat/pr-e2e` → main)

Order matters: Task 1 must be on main for the repo's first-ever green
`checks` run; the pr-e2e workflow only triggers once its file is on main.

- [ ] **Step 1: Open PR for `feat/pr-e2e`, confirm first green checks run**

Push the branch, open a PR (human reviews + merges). On the PR, the `checks`
job should pass — the first green in the repo's history. If it fails, read
the failure before merging; only pre-existing infra-test exclusions were made.

- [ ] **Step 2: Missing-spec path**

After merge, dispatch against PR #7 (its branch has no feature spec):

```bash
source /home/benz/Documents/1.projects/ourcloud/.sandcastle/.env
curl -sf -X POST -H "Authorization: token $FORGEJO_TOKEN" -H 'Content-Type: application/json' \
  -d '{"ref":"main","inputs":{"pr_number":"7"}}' \
  'https://git.matou.nz/api/v1/repos/Matou/matou-app/actions/workflows/pr-e2e.yml/dispatches'
```
Expected in Mattermost: `:camera: **e2e PR #7** — no feature spec provided. No skip reason given in the PR body. <link>`

- [ ] **Step 3: Full path — hand-write `issue-6.spec.ts` on `agent/issue-6`**

Read PR #7's diff first (`frontend/src/lib/contributionsView.ts`,
`ContributionsPage.vue`) and adjust the locators below to the actual
controls it added (search input, sort control). Template:

```ts
import { test, expect } from './fixtures';

test.describe('contributions sort & search (#6)', () => {
  test('member can search and sort the contributions list', async ({ memberPage, snap }) => {
    await memberPage.goto('/#/contributions');
    await expect(memberPage.getByText(/contributions/i).first()).toBeVisible();
    await snap(memberPage, 'list-initial');

    // locator: match the search input PR #7 added (read the component)
    const search = memberPage.getByPlaceholder(/search/i);
    await search.fill('zzz-no-such-contribution');
    await snap(memberPage, 'search-no-results');
    await search.clear();

    // locator: match the sort control PR #7 added
    await memberPage.getByRole('button', { name: /sort/i }).click();
    await snap(memberPage, 'sort-open');
  });
});
```

Commit to `agent/issue-6`, push to Forgejo. The `synchronize` event fires
pr-e2e for real: bootstrap → spec → screenshots.

- [ ] **Step 4: Confirm the evidence**

Expected in Mattermost: `:camera: **e2e PR #7** — ✅ passed (3 screenshots) <link>`
with the three snaps attached. If ❌: the thread reply carries the Playwright
error excerpt — debug from there (backend log at `/tmp/pr-e2e-backend.log`,
Playwright log at `/tmp/pr-e2e-playwright.log` on matou-workstation).

- [ ] **Step 5: Record outcome**

Update `docs/superpowers/specs/2026-08-01-pr-feature-e2e-design.md` Status
line to `Implemented + live-verified <date>`; commit.
