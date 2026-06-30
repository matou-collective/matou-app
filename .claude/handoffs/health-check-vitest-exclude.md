# Handoff: exclude health-check.ts from vitest

**Date:** 2026-06-30

## Problem
`npm run test:script` (vitest) always reports one spurious failure:

```
FAIL tests/scripts/health-check.ts
Error: No test suite found in file /home/dev/matou-app/frontend/tests/scripts/health-check.ts
```

The worker also times out on teardown:
```
[vitest-pool]: Failed to terminate forks worker for test files health-check.ts.
Error: [vitest-pool-runner]: Timeout waiting for worker to respond
```

## Root cause
`frontend/tests/scripts/health-check.ts` is a plain CLI script — it calls `main()` directly
and uses `process.exit()`. It has no `describe`/`test` blocks. It is intentionally run via
`tsx`, not vitest:

```json
"health":      "tsx tests/scripts/health-check.ts",
"health:test": "TEST_MODE=true tsx tests/scripts/health-check.ts"
```

The vitest include glob (`tests/scripts/**/*.ts` in `vitest.config.ts`) sweeps it up anyway,
causing the "no test suite" error and a worker hang on teardown.

## Fix
Add `health-check.ts` to the `exclude` array in `frontend/vitest.config.ts`:

```ts
test: {
  include: ['tests/scripts/**/*.ts'],
  exclude: ['tests/scripts/health-check.ts'],  // plain CLI script, not a vitest test
  testTimeout: 120000,
  ...
}
```

That's the only change needed. No other files require modification.

## Verification
```
cd frontend && npm run test:script
```
Expect: 10 test files pass, 0 fail, no worker timeout at the end.
(Previously: 1 file failed with "No test suite found", worker timeout on teardown.)

## Note
Do NOT move or delete `health-check.ts` — it is a valid operational tool used by the team
via `npm run health` / `npm run health:test`. The fix is purely in vitest config.
