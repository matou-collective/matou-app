# PR Feature E2E with Screenshots — Design

**Date:** 2026-08-01
**Status:** Approved (design), not yet implemented
**Depends on:** sandcastle swarm (2026-07-31), runner capacity fix (precondition, see Rollout)

## Problem

Swarm agents open PRs that pass unit tests, but nobody sees the feature working.
E2E coverage exists only as a heavyweight full suite (~145 tests, 45–90 min,
live KERI + any-sync infra) that cannot run per-PR. Reviewers merge on faith
plus a "Needs live verification" note in the PR body.

Goal: every agent PR for a user-facing change carries a feature-specific
Playwright spec, the pipeline runs exactly that spec against real test infra,
and pass/fail plus curated screenshots land in Mattermost for the reviewer.

## Decisions (made during brainstorming)

| Question | Decision |
|---|---|
| When does feature e2e run? | Separate workflow on PR open/update — evidence, **not** a required merge check |
| Spec fate after merge | Kept permanently under `tests/e2e/features/` as a growing regression suite |
| Where do results go? | New Mattermost thread per run (keeps Verify #N thread clean for the approve/reject poller) |
| Test environment | Scripted bootstrap per run — **no persistent env**. Stale-state failures (KERIA notifications, leftover accounts) are a documented failure class in this repo; a persistent env also becomes a hand-rebuilt pet. Bootstrap makes the env cattle; the healer can re-run it. |

## 1. Agent-side convention (`.sandcastle/prompt.md`)

For user-facing changes the agent's TDD loop gains a first step: author
`frontend/tests/e2e/features/issue-<N>.spec.ts` **before** implementing.

- Specs use provided fixtures only: `test('...', async ({ memberPage, kaitiakiPage, snap }) => ...)`.
  Fixtures deliver logged-in pages per role. Specs never perform their own
  registration/login/org setup.
- `snap(page, 'label')` captures a curated screenshot at a meaningful state
  (e.g. `filter-open`, `sorted-by-date`). Screenshots are the reviewer's view
  of the feature — the agent chooses states that demonstrate it.
- The sandbox cannot execute Playwright against live infra, but the spec must
  pass `npx playwright test --list tests/e2e/features/issue-<N>.spec.ts`
  (parse/type validation, no browsers needed). Added to the agent's
  pre-commit checklist next to vitest/lint.
- Non-UI issues (backend-only, docs, CI) may skip the spec. The PR body must
  contain a `**Feature e2e:** skipped — <reason>` line. The pipeline reports
  the skip to Mattermost; silence is not an option.
- PR body gains `**Feature e2e:** tests/e2e/features/issue-<N>.spec.ts` when
  a spec is provided.

## 2. Test-env bootstrap

New Playwright project `setup`, repackaging the existing `org-setup` and
`registration` flows:

- Creates the community/org and registers a fixed cast:
  `kaitiaki-test` (admin role), `member-a`, `member-b`.
- Writes per-role `storageState` files and `test-env.json` (passcodes, AIDs,
  display names) to a gitignored `.test-env/` directory.
- The `features` project declares `dependencies: ['setup']` in
  `playwright.config.ts`, so ordering is automatic and `setup` is skipped when
  targeting other projects.
- `frontend/tests/e2e/features/fixtures.ts` reads `.test-env/` and exposes
  `kaitiakiPage`, `memberPage`, `memberBPage`, and `snap`. `snap` writes PNGs
  to `.test-env/screens/issue-<N>/<order>-<label>.png`.
- Where a flow doesn't need the UI, setup may call backend APIs or existing
  scripts (`create-test-aid.ts`) directly for speed. Target: ≤ 6 min total
  bootstrap. If it drags, the escape hatch (later, not now) is snapshotting
  data dirs post-setup and restoring instead of re-running.

## 3. Workflow: `.forgejo/workflows/pr-e2e.yml`

Trigger: `pull_request` (opened, synchronize) + `workflow_dispatch`.
Job proceeds only for `agent/issue-*` head branches (or dispatch input).

Host-mode job on `matou-workstation`, `timeout-minutes: 40`, holding the
global swarm flock (`/tmp/matou-swarm.lock`) for the whole run — one set of
test ports, and e2e must not overlap sandcastle agent jobs on the 4-core/8 GB
box.

Steps (teardown runs in a trap so failure still cleans up):

1. Checkout PR head.
2. Derive `N` from branch name; locate `tests/e2e/features/issue-<N>.spec.ts`.
   - Missing spec → post the skip/absence note to Mattermost (including the
     PR-body reason if present) and exit success.
3. Clean state: KERI `make clean-test` + frontend test-data clean.
4. Infra up with health gates: KERI test network, any-sync test network
   (from `/home/dev/matou/matou-infrastructure`).
5. Backend: build test binary (BackendManager spawns it on 9080).
6. Frontend: `npm ci`, `npx playwright install --with-deps chromium`.
7. `npx playwright test --project=features tests/e2e/features/issue-<N>.spec.ts`
   (pulls in `setup` via dependency).
8. Publish results + screenshots to Mattermost (section 4).
9. Teardown: infra down, clean-test.

Failure semantics:

- **Spec failed** → reported to Mattermost (with failure screenshot + error
  excerpt); job exits success from the runner's perspective. Not a merge
  gate.
- **Pipeline broke** (infra refused to start, bootstrap failed) → job fails,
  healer investigates like every other workflow, `:rotating_light:` on
  healer error.

## 4. Mattermost publishing

New `.sandcastle/notify-mattermost-files.sh` (sibling of
`notify-mattermost.sh`, same env contract and no-creds fallback):

- Uploads PNGs via `POST /api/v4/files` (multipart, `channel_id`), then
  creates the post with `file_ids`.
- Mattermost caps 10 attachments per post: first 10 screenshots attach to the
  root post; overflow goes in thread replies.
- Root post format:
  `:camera: **e2e PR #<n>** — ✅ passed | ❌ failed (<m> tests, <k> screenshots) <PR link>`
- On failure: thread reply with the last error excerpt and Playwright's
  failure screenshot.
- One new thread per run (PR update → new run → new thread). Low PR volume
  makes threading-by-PR not worth the state.

## 5. Testing the pipeline itself

- Offline (alongside existing `.sandcastle/tests/*`):
  - `notify-files-test.sh` — upload/post payloads with mocked curl, including
    the >10 attachments chunking and the creds-unset fallback.
  - Branch → spec-path derivation, and the missing-spec path.
- Live smoke:
  1. Dispatch `pr-e2e.yml` against PR #7 as-is → exercises the
     missing-spec/skip path end to end.
  2. Hand-write `issue-6.spec.ts` (sort/search on contributions view), push
     to `agent/issue-6` → full path: bootstrap, spec run, screenshots in
     Mattermost.

## Rollout preconditions (ordered)

1. **Fix unit-CI baseline red** — exclude live-infra tests
   (`test-oobi-messaging.ts`, `witness-assignment.test.ts`) from the sandbox
   `test:script` run. Without this, "checks" noise drowns the new signal.
2. **Runner capacity ≥ 2** (or a second registered runner) — a 20–40 min
   flock-holding job on today's capacity-1 runner starves triage/swarm; we
   ate a 6-hour queue jam from exactly this on 2026-08-01.
3. Then enable `pr-e2e.yml`.

## Out of scope (deliberately)

- Nightly full-suite e2e workflow (natural follow-up; features suite slots in).
- Snapshot/restore optimization of the bootstrap.
- Making pr-e2e a required merge check.
- Docker-in-docker self-verification inside the agent sandbox.
