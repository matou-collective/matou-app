# Smoke-tier e2e driver

A standing **rehearsal-drive** for matou-app at the low-effort `smoke` tier of
the six-clause e2e-driver contract. It chains a few of the real Playwright e2e
specs as **legs** over one honest journey and emits machine-readable per-leg
artifacts that the vendored reporter/healer
(`.sandcastle/rehearsal-report.sh`) can read from the run dir without re-running
anything.

Filed and ruled in [matou-app#41](https://git.matou.nz/Matou/matou-app/issues/41)
(Ben, 2026-08-20). Unlike `.sandcastle/run-pr-e2e.sh` (PR-scoped: one feature
spec per PR, Mattermost notify), this is a standing journey driver.

## The journey is adaptive

Every drive composes a **base sub-journey** plus an optional
**feature-showcase leg**:

- **Base `a`** — `org-setup` alone. "The platform stands up." The minimal base,
  used when the feature under test doesn't involve the membership loop.
- **Base `b`** — `org-setup → registration → invitation`. The identity
  protocol's founding growth loop: an org is bootstrapped, a person registers (a
  KERI identity is minted), and an invitation flows to a second person.
- **Feature leg** — runs the per-issue feature spec
  `frontend/tests/e2e/features/issue-<N>.spec.ts` (the same specs
  `run-pr-e2e.sh` resolves). Its screenshots are the review currency: the drive
  *shows the feature that was built*.

A base-`a` drive that carries a feature leg inserts the `registration-member`
bootstrap the `features` Playwright project depends on (its fixtures need a
member in `test-accounts.json`); a base-`b` drive's full `registration` leg
already persists one.

Each leg runs as an independent `--no-deps` Playwright invocation; disk state
(`test-accounts.json`, the test org on the backend) persists across
invocations, so the legs compose exactly like the real journey.

### Base auto-selection

Bare (a standing health lap) → base `a`. With `--feature N`, the base is read
from the spec's marker comment, unless `--base` overrides it. A feature spec
declares the base it needs with a marker line:

```ts
// smoke-base: b   // this feature exercises the membership growth loop
```

`b` selects the growth loop; anything else (or no marker) → `a`.

## Usage

```bash
scripts/smoke-drive/run-smoke-drive.sh [--base a|b] [--feature <issue-N>] \
                                       [--run-dir DIR] [--skip-infra]
```

- `--base a|b` — override the base sub-journey (default: auto).
- `--feature N` — add the feature-showcase leg for issue N.
- `--run-dir DIR` — override the run dir (default `test-results/smoke/<stamp>`).
- `--skip-infra` — assume KERI/any-sync/backend are already up (hand-runs
  against a live test env). Otherwise the driver bootstraps them the same way
  `run-pr-e2e.sh` does (`scripts/clean-test.sh`, `matou-infrastructure` keri +
  any-sync, `MATOU_ENV=test` backend on :9080).

Examples:

```bash
# Standing health lap — base a, org-setup only:
scripts/smoke-drive/run-smoke-drive.sh

# Founding growth loop:
scripts/smoke-drive/run-smoke-drive.sh --base b

# Showcase a PR's feature on top of its auto-selected base:
scripts/smoke-drive/run-smoke-drive.sh --feature 12
```

Runnable by hand and by workflow dispatch (`.forgejo/workflows/smoke-drive.yml`).
Standing-drive scheduling (a periodic bare lap on a cron) waits on
`Matou/dev-factory#3`'s host-state move — out of scope here.

## The six clauses → the run dir

```
test-results/smoke/<stamp>/            # 3. run dir (UTC basic stamp = basename)
  artifacts/
    legs.json                          # 1. rewritten after EVERY leg
    verdict.json                       # 2. authoritative green/red for the drive
    legs.d/                            #    per-leg record fragments (internal)
  logs/
    NN-<leg>.txt                       # 5. per-leg Playwright output
  screenshots/
    <leg>/*.png                        # 4. per-leg screenshots
```

1. **`legs.json`** — a JSON array of `{leg, status, ms[, error]}`, rewritten
   after every leg so partial progress survives a red.
2. **`verdict.json`** — `{verdict:"green"|"red", tier:"smoke", base, feature,
   stamp, legs_total, legs_red}`. The reporter trusts `.verdict` over any
   out-of-band exit code (contract clause 5).
3. **run dir** — `test-results/smoke/<stamp>/`, stamp = `YYYYMMDDThhmmssZ`.
4. **screenshots** — per leg, curated snaps + Playwright's own captures.
5. **text logs** — per-leg Playwright output.
6. **rc ≠ 0 on first red** — the drive stops at the first red leg and exits
   non-zero.

## Files

| File | What |
|------|------|
| `run-smoke-drive.sh` | orchestrator (bootstraps infra, drives legs, emits artifacts) |
| `smoke-drive-lib.sh` | pure helpers: base resolution, leg planning, artifact shaping |
| `smoke-drive-lib-test.sh` | unit tests for the pure helpers (offline) |
| `run-smoke-drive-test.sh` | integration test of the orchestrator via a stub Playwright (offline) |

Both test scripts run in the swarm sandbox (no KERI/any-sync/Playwright); they
are what let the driver's logic be verified where real infra can't be stood up.
