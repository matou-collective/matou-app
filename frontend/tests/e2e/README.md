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

## Linked-device sign-in on a real Android build

`e2e-linked-device-android.spec.ts` (project `linked-device-android`) installs
the debug APK on an emulator or USB device and runs the whole linked-device
story against it: the admin links the phone from desktop Settings, a profile
edit on the phone reaches the desktop, member1's chat message reaches both
devices, and the admin's desktop reply reaches the phone. The phone is driven
through Playwright's Android WebView bridge (`utils/android-device.ts`), so the
spec uses ordinary locators on both surfaces.

It is opt-in — never part of `npm test` — because it needs the Android
toolchain (`scripts/android/setup-toolchain.sh`) and a **test-mode** APK:

```bash
cd backend && make build-android-aar
VITE_ENV=test VITE_PROD_CONFIG_URL=http://localhost:4904 \
  VITE_TEST_CONFIG_URL=http://localhost:4904 scripts/android/build-apk.sh
cd frontend && npm run test:android-link
```

The harness refuses an APK that does not bake `http://localhost:4904` as its
config server (it would join production). With no emulator running it boots the
`matou` AVD headless and kills it afterwards; an already-running emulator is
adopted and left running. A physical phone is never picked up on its own — the
harness uninstalls the app (and its data) before installing, so name the device
with `MATOU_ANDROID_SERIAL` to opt in. See the header of
`utils/android-device.ts` for the other `MATOU_ANDROID_*` knobs.

Two things differ from a user's phone, both forced by the environment:

- **No camera.** The phone uses the scan screen's own "paste the code"
  fallback with the exact payload the desktop QR encodes.
- **Org config.** The embedded backend always runs as `Env=production`
  (`cmd/mobile`), so it never sends `X-Test-Config` and cannot see the e2e org
  in the config server's test slot. The harness mirrors the test org into the
  test config server's otherwise-unused default slot for the run and deletes
  it afterwards.
