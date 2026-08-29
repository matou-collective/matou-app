# Frontend E2E tests

Playwright specs that drive the real app against the live KERI + any-sync test
network and a Go backend in test mode.

## One e2e run per machine

The e2e stack uses **fixed** ports and paths that are **not** namespaced per
checkout:

- **9080** — admin backend (started once, killed/rebound by
  `e2e-registration.spec.ts`'s `restartAdminBackend()`).
- **9003** — test dev server (`npm run test:serve`, reused across runs via
  Playwright's `reuseExistingServer: true`).
- **`/tmp/matou-test-backend.log`** — fixed backend log path.
- **`node_modules/.q-cache/dev-spa/vite-spa/deps`** — the Vite dep cache.

Because of this, **run only one e2e run on a machine at a time.** Two runs from
different checkouts (or git worktrees) will otherwise silently corrupt each
other: the second run's backend replaces the first's on 9080 (org config
vanishes mid-test), a run reuses a 9003 dev server built from the *other*
checkout's sources, or two dev servers fighting over a shared Vite dep cache
serve a blank page.

To make that failure **loud instead of silent** (issue #175), the preflight
(`requireAllTestServices`) and `restartAdminBackend()` check whether a fixed
port is held by a process from a *different* checkout (via `/proc/<pid>/cwd`)
and fail fast with an actionable error instead of stomping it. This does not
make concurrent runs coexist — it only turns corruption into a clear error.

### Using git worktrees

If you run e2e from a worktree, **`npm ci` inside the worktree** rather than
symlinking `node_modules` from the primary checkout — a symlinked
`node_modules` shares the Vite dep cache and produces blank-page failures with
no console output. Still: only one e2e run active at a time.
