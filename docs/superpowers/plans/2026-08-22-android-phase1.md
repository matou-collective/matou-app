# Android Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a debug-installable Android APK of Mātou App in which the full Go backend (any-sync included) runs in-process and the existing Vue frontend talks to it over loopback HTTP, with the three layouts and all dialogs usable on a phone-sized screen.

**Architecture:** The backend's 800-line `main()` is extracted into a reusable `internal/app` package with `Start`/`Shutdown`, so both `cmd/server` (desktop) and `cmd/mobile` (gomobile) wire the same graph. A Capacitor shell hosts the Vue SPA; a small Java Capacitor plugin (`MatouBackend`) starts the Go server on a random loopback port with a random per-launch token and hands `{port, token}` to `platform.ts`, mirroring exactly what Electron's `electron-main.ts` does today. Responsive work is one global dialog override plus mobile modes for `DashboardLayout` (bottom tab bar) and `ChatLayout` (single pane).

**Tech Stack:** Go 1.25 + `golang.org/x/mobile` (gomobile bind, NDK r27c, `-androidapi 21`), Quasar 2 `capacitor` mode + Capacitor 6 (Android), Java 17 Capacitor plugin, Vitest for TS units, `go test` for Go units.

**Spec:** `docs/plans/2026-08-08-mobile-build-plan.md` (branch `mobile-dev`; merge it into this branch first — see Task 0). Spike evidence: `docs/spikes/2026-08-12-mobile-gomobile-android-spike.md` (on `main`).

## Global Constraints

- Android only. iOS (#24, #25, #26, #29) is out of scope; do not add iOS targets, `Pause`/`Resume` lifecycle hooks, or APNs work.
- Space keys never leave the device: any-sync runs in-process, no remote sync service (spec: "Any-sync runs on-device").
- Backend is served as loopback HTTP, not bridged functions (spec: "The whole backend ships, in-process"). `frontend/src/api` stays unchanged.
- `gomobile bind -target=android/arm64 -androidapi 21` is mandatory (NDK r27c rejects API < 21 — spike gotcha 1).
- Every new Go dependency must be cgo-free and raw-syscall-free (spec trade-off; spike cgo audit was clean — keep it so).
- Loopback port is random per launch; API token is random per launch and must travel via the native bridge, never a fixed constant (matches `frontend/src-electron/electron-main.ts:163-175` and `backend/internal/api/token.go:31`).
- Capacitor Android default origin is `https://localhost` (no port); `MATOU_CORS_MODE=bundled` must accept it.
- Backend env for mobile is exactly Electron-production's: `MATOU_ENV=production`, `MATOU_CORS_MODE=bundled`, `MATOU_CONFIG_SERVER_URL=<VITE_PROD_CONFIG_URL>`, `MATOU_DATA_DIR=<app files dir>`.
- Responsive breakpoint: Quasar `sm` = `< 1024px` is too wide for the existing `@media (max-width: 767px)` rule in `DashboardLayout.vue:471`; standardise on **767px** (`$breakpoint-xs`/`sm-max` semantics already used in `DashboardPage.vue:962`). Phone target viewport for manual checks: **390×844**.
- Keep `backend/cmd/mobile` blank-imports in sync with `backend/internal/` (existing comment in `mobile.go`).
- Commit messages follow repo style: `area: imperative summary (#issue)`. Reference Forgejo issue #23 for backend work; file new issues per Task 0.

## Out of scope (Phase 1, Android)

Recorded so nobody "helpfully" adds them: iOS, device pairing (`/pairing/*`, Phase 3), native push/local notifications (`src/lib/notifications.ts` stays on the web `Notification` API, which Android WebView silently ignores), signed release APK / Play Store, auto-update, `OnboardingLayout` redesign (it's a bare `<router-view>`; only the pages inside it get the dialog override).

---

## File structure

| Path | Responsibility |
|---|---|
| `backend/internal/app/options.go` | `Options` struct + `OptionsFromEnv()` — all env-var reading lives here, nowhere else. |
| `backend/internal/app/app.go` | `Start(ctx, Options) (*App, error)`, `App.Addr()`, `App.Port()`, `App.Shutdown(ctx)`. The wiring body moved out of `main()`. |
| `backend/internal/app/anysync_config.go` | `fetchAndSaveAnySyncConfig` (moved from `cmd/server/main.go:34`). |
| `backend/internal/app/options_test.go` | Unit tests for `OptionsFromEnv`. |
| `backend/cmd/server/main.go` | Thin: `OptionsFromEnv` → `Start` → wait for SIGINT → `Shutdown`. Keeps the endpoint banner printing. |
| `backend/cmd/mobile/mobile.go` | gomobile surface: `Start(dataDir, configServerURL, apiToken string) (int, error)`, `Stop() error`, `Version() string`. |
| `backend/internal/api/middleware.go` | `isBundledOrigin` accepts `https://localhost`. |
| `backend/internal/api/middleware_test.go` | Table test for `isBundledOrigin`. |
| `backend/Makefile` | `build-android-aar` target. |
| `scripts/android/setup-toolchain.sh` | Idempotent NDK/SDK/JDK/gomobile install (from spike §Reproduction). |
| `scripts/android/build-apk.sh` | `.aar` → `cap sync` → debug APK, one command. |
| `frontend/src-capacitor/` | Quasar-generated Capacitor project (`capacitor.config.json`, `android/`). |
| `frontend/src-capacitor/android/app/src/main/java/nz/matou/app/MatouBackendPlugin.java` | Capacitor plugin: starts Go backend, returns `{port, token}`. |
| `frontend/src-capacitor/android/app/src/main/java/nz/matou/app/SecureStoragePlugin.java` | Capacitor plugin: `EncryptedSharedPreferences` get/set/remove. |
| `frontend/src-capacitor/android/app/src/main/java/nz/matou/app/MainActivity.java` | Registers both plugins. |
| `frontend/src-capacitor/android/app/src/main/res/xml/network_security_config.xml` | Cleartext allowed for `127.0.0.1` only. |
| `frontend/src/lib/capacitor.ts` | Typed accessors for `window.Capacitor.Plugins.MatouBackend` / `.SecureStorage`; `isCapacitor()`. |
| `frontend/src/lib/platform.ts` | Add Capacitor branches to `getBackendUrl` / `getApiToken`. |
| `frontend/src/lib/secureStorage.ts` | Add Capacitor branch. |
| `frontend/tests/scripts/platform.test.ts` | Vitest for platform detection + URL/token resolution. |
| `frontend/tests/scripts/secure-storage.test.ts` | Vitest for Capacitor branch. |
| `frontend/src/css/app.scss` | Global mobile dialog override. |
| `frontend/src/layouts/DashboardLayout.vue` | Bottom tab bar ≤767px. |
| `frontend/src/components/chat/ChatLayout.vue` | Single-pane mode ≤767px. |
| `frontend/src/composables/useIsMobile.ts` | `isMobile` ref from a `matchMedia('(max-width: 767px)')` listener. |
| `.forgejo/workflows/android.yml` | Builds `.aar` + debug APK on the swarm pool, uploads artifact. |
| `docs/mobile/ANDROID.md` | Developer guide: toolchain, build, install on device, debug. |

---

### Task 0: Branch, merge the spec, file tracking issues

**Files:**
- Create: branch `mobile/android-phase1` from `main`
- Merge: `origin/mobile-dev` (brings `docs/plans/2026-08-08-mobile-build-plan.md`)

- [ ] **Step 1: Create branch and merge the plan doc**

```bash
git checkout main && git pull origin main
git checkout -b mobile/android-phase1
git merge origin/mobile-dev -m "merge mobile-dev: bring mobile build plan onto the Android phase-1 branch"
test -f docs/plans/2026-08-08-mobile-build-plan.md && echo OK
```

Expected: `OK`. If the merge conflicts (mobile-dev is ~2 weeks behind main), resolve by taking `main`'s side for everything except the new `docs/plans/` file.

- [ ] **Step 2: Tickets (already filed 2026-08-22)**

| Task | Issue | Task | Issue |
|---|---|---|---|
| 1 CORS origin | #64 | 8 SecureStorage | #71 |
| 2 Options | #65 | 9 useIsMobile + dialog override | #72 |
| 3 app.Start | #66 | 10 non-dialog widths | #73 |
| 4 gomobile surface | #67 | 11 bottom tab bar | #74 |
| 5 toolchain/aar | #68 | 12 chat single-pane | #75 |
| 6 Capacitor shell | #69 | 13 android.yml | #76 |
| 7 platform.ts | #70 | 14 device verify + PR | #77 |

Dependent tickets are labelled `no-triage` with a "Blocked by" line; flip to `ready-for-agent` (or `ready-for-session` for #68/#69/#71/#76/#77, which need the host toolchain / a device / a repo secret) as their blockers close.

- [ ] **Step 3: Commit**

```bash
git add docs/plans/2026-08-08-mobile-build-plan.md
git commit -m "docs: land mobile build plan on android phase-1 branch"
```

---

### Task 1: `https://localhost` is a bundled origin

The Capacitor Android WebView serves the SPA from `https://localhost` (Capacitor's default `androidScheme: "https"`). `backend/internal/api/middleware.go:14-26` accepts `capacitor://`, `file://`, `app://`, `http://localhost:<port>` — not `https://localhost`. Without this every mutating request gets a 401 with no CORS header → "Failed to fetch".

**Files:**
- Modify: `backend/internal/api/middleware.go:14-26`
- Create: `backend/internal/api/middleware_test.go`

**Interfaces:**
- Produces: unchanged signature `isBundledOrigin(origin string) bool`, now true for `https://localhost` and `https://localhost:<port>`.

- [ ] **Step 1: Write the failing test**

```go
package api

import "testing"

func TestIsBundledOrigin(t *testing.T) {
	cases := []struct {
		origin string
		want   bool
	}{
		{"", false},
		{"file://", true},
		{"capacitor://localhost", true},
		{"app://matou", true},
		{"http://localhost:9300", true},
		{"http://127.0.0.1:41234", true},
		{"https://localhost", true},        // Capacitor Android default origin
		{"https://localhost:8443", true},   // Capacitor with explicit port
		{"https://localhost.evil.com", false},
		{"https://evil.com", false},
		{"http://evil.com", false},
	}
	for _, c := range cases {
		if got := isBundledOrigin(c.origin); got != c.want {
			t.Errorf("isBundledOrigin(%q) = %v, want %v", c.origin, got, c.want)
		}
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && go test ./internal/api/ -run TestIsBundledOrigin -v`
Expected: FAIL on `https://localhost` and `https://localhost:8443`.

- [ ] **Step 3: Implement**

Replace the body of `isBundledOrigin` with:

```go
func isBundledOrigin(origin string) bool {
	if origin == "" {
		return false
	}
	if strings.HasPrefix(origin, "file://") ||
		strings.HasPrefix(origin, "capacitor://") ||
		strings.HasPrefix(origin, "app://") ||
		strings.HasPrefix(origin, "http://localhost:") ||
		strings.HasPrefix(origin, "http://127.0.0.1:") {
		return true
	}
	// Capacitor on Android serves the bundled SPA from https://localhost
	// (default androidScheme "https"), with no port. Exact host match only:
	// "https://localhost.evil.com" must not pass.
	return origin == "https://localhost" || strings.HasPrefix(origin, "https://localhost:")
}
```

- [ ] **Step 4: Run tests**

Run: `cd backend && go test ./internal/api/ -run TestIsBundledOrigin -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/api/middleware.go backend/internal/api/middleware_test.go
git commit -m "api: accept https://localhost as a bundled CORS origin for Capacitor Android (#64)"
```

---

### Task 2: `internal/app.Options` + `OptionsFromEnv`

All env reading in `cmd/server/main.go:182-268` and `:317-330` becomes one pure function so `cmd/mobile` can build an `Options` without env vars.

**Files:**
- Create: `backend/internal/app/options.go`
- Create: `backend/internal/app/options_test.go`

**Interfaces:**
- Produces:

```go
package app

type Options struct {
	Env               string // "", "test", "production"
	DataDir           string
	Port              int    // 0 = pick a free port
	Host              string // default "localhost"; mobile passes "127.0.0.1"
	APIToken          string // "" = api.ResolveAPIToken() semantics
	ConfigServerURL   string
	ConfigServerToken string
	AnysyncConfigPath string // "" = derived from Env/DataDir as today
	PrintBanner       bool   // cmd/server prints the endpoint list; mobile doesn't
}

func (o Options) IsTest() bool       { return o.Env == "test" }
func (o Options) IsProd() bool       { return o.Env == "production" }
func OptionsFromEnv() (Options, error)
```

- [ ] **Step 1: Write the failing tests**

```go
package app

import "testing"

func TestOptionsFromEnvDefaults(t *testing.T) {
	t.Setenv("MATOU_ENV", "")
	t.Setenv("MATOU_DATA_DIR", "")
	t.Setenv("MATOU_SERVER_PORT", "")
	t.Setenv("MATOU_CONFIG_SERVER_URL", "")
	t.Setenv("MATOU_CONFIG_SERVER_TOKEN", "")
	t.Setenv("MATOU_ANYSYNC_CONFIG", "")

	o, err := OptionsFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if o.DataDir != "./data" || o.Port != 8080 || o.ConfigServerURL != "http://localhost:3904" ||
		o.ConfigServerToken != "dev-insecure-local-only" || o.AnysyncConfigPath != "config/client-dev.yml" || o.Host != "localhost" {
		t.Errorf("unexpected defaults: %+v", o)
	}
}

func TestOptionsFromEnvTest(t *testing.T) {
	t.Setenv("MATOU_ENV", "test")
	t.Setenv("MATOU_DATA_DIR", "")
	t.Setenv("MATOU_SERVER_PORT", "")
	t.Setenv("MATOU_CONFIG_SERVER_URL", "")
	t.Setenv("MATOU_ANYSYNC_CONFIG", "")

	o, err := OptionsFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if o.DataDir != "./data-test" || o.Port != 9080 || o.ConfigServerURL != "http://localhost:4904" || o.AnysyncConfigPath != "config/client-test.yml" {
		t.Errorf("unexpected test-mode options: %+v", o)
	}
}

func TestOptionsFromEnvProductionRequiresConfigServer(t *testing.T) {
	t.Setenv("MATOU_ENV", "production")
	t.Setenv("MATOU_CONFIG_SERVER_URL", "")
	if _, err := OptionsFromEnv(); err == nil {
		t.Fatal("expected error when MATOU_CONFIG_SERVER_URL is unset in production")
	}
}

func TestOptionsFromEnvOverrides(t *testing.T) {
	t.Setenv("MATOU_ENV", "production")
	t.Setenv("MATOU_DATA_DIR", "/tmp/x")
	t.Setenv("MATOU_SERVER_PORT", "41234")
	t.Setenv("MATOU_CONFIG_SERVER_URL", "https://awa.matou.nz:3904")
	t.Setenv("MATOU_CONFIG_SERVER_TOKEN", "")
	t.Setenv("MATOU_ANYSYNC_CONFIG", "")

	o, err := OptionsFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if o.DataDir != "/tmp/x" || o.Port != 41234 || o.AnysyncConfigPath != "/tmp/x/client-production.yml" || o.ConfigServerToken != "" {
		t.Errorf("unexpected: %+v", o)
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && go test ./internal/app/ -v`
Expected: build failure, package does not exist.

- [ ] **Step 3: Implement `options.go`**

```go
// Package app wires the Matou backend object graph and serves the HTTP API.
// It is shared by cmd/server (desktop/Electron child process) and cmd/mobile
// (gomobile, in-process on Android). All environment-variable reading lives
// in OptionsFromEnv; Start itself never touches os.Getenv.
package app

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
)

type Options struct {
	Env               string
	DataDir           string
	Port              int
	Host              string
	APIToken          string
	ConfigServerURL   string
	ConfigServerToken string
	AnysyncConfigPath string
	PrintBanner       bool
}

func (o Options) IsTest() bool { return o.Env == "test" }
func (o Options) IsProd() bool { return o.Env == "production" }

// OptionsFromEnv reproduces the env handling previously inlined in
// cmd/server/main.go. Production without MATOU_CONFIG_SERVER_URL is an error
// (main.go used log.Fatalf).
func OptionsFromEnv() (Options, error) {
	o := Options{Env: os.Getenv("MATOU_ENV"), Host: "localhost", Port: 8080, PrintBanner: true}

	o.ConfigServerURL = os.Getenv("MATOU_CONFIG_SERVER_URL")
	if o.ConfigServerURL == "" {
		switch {
		case o.IsTest():
			o.ConfigServerURL = "http://localhost:4904"
		case o.IsProd():
			return o, fmt.Errorf("MATOU_CONFIG_SERVER_URL is not set for production")
		default:
			o.ConfigServerURL = "http://localhost:3904"
		}
	}
	o.ConfigServerToken = os.Getenv("MATOU_CONFIG_SERVER_TOKEN")
	if o.ConfigServerToken == "" && !o.IsProd() {
		o.ConfigServerToken = "dev-insecure-local-only"
	}

	o.DataDir = os.Getenv("MATOU_DATA_DIR")
	if o.DataDir == "" {
		if o.IsTest() {
			o.DataDir = "./data-test"
		} else {
			o.DataDir = "./data"
		}
	}

	if o.IsTest() {
		o.Port = 9080
	}
	if p := os.Getenv("MATOU_SERVER_PORT"); p != "" {
		if n, err := strconv.Atoi(p); err == nil {
			o.Port = n
		}
	}

	o.AnysyncConfigPath = os.Getenv("MATOU_ANYSYNC_CONFIG")
	if o.AnysyncConfigPath == "" {
		o.AnysyncConfigPath = DefaultAnysyncConfigPath(o)
	}
	o.APIToken = os.Getenv("MATOU_API_TOKEN") // "" → Start resolves via api.ResolveAPIToken
	return o, nil
}

// DefaultAnysyncConfigPath mirrors the per-env selection from main.go.
func DefaultAnysyncConfigPath(o Options) string {
	switch {
	case o.IsTest():
		return "config/client-test.yml"
	case o.IsProd():
		return filepath.Join(o.DataDir, "client-production.yml")
	default:
		return "config/client-dev.yml"
	}
}
```

- [ ] **Step 4: Run tests**

Run: `cd backend && go test ./internal/app/ -v`
Expected: 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/app/options.go backend/internal/app/options_test.go
git commit -m "app: add Options and OptionsFromEnv, the single place env vars are read (#65)"
```

---

### Task 3: Move the wiring into `app.Start` / `App.Shutdown`; make `cmd/server` thin

This is a mechanical move of `cmd/server/main.go:179-822` into `app.go`. Behaviour must be identical for desktop (Electron relies on `MATOU_SERVER_PORT` + the stderr/stdout logs).

**Files:**
- Create: `backend/internal/app/app.go`
- Create: `backend/internal/app/anysync_config.go` (move `fetchAndSaveAnySyncConfig` and the three adapter types `eventBrokerAdapter`, `chatPersisterAdapter`, `contribNotifierAdapter` from `main.go:34-178` — keep their code verbatim, just change `package main` → `package app`)
- Modify: `backend/cmd/server/main.go` → ~40 lines

**Interfaces:**
- Consumes: `Options` (Task 2).
- Produces:

```go
type App struct { /* unexported */ }
func Start(ctx context.Context, o Options) (*App, error)  // returns once the listener is bound
func (a *App) Port() int                                    // actual bound port (useful when o.Port == 0)
func (a *App) Addr() string                                 // "127.0.0.1:41234"
func (a *App) Shutdown(ctx context.Context) error           // graceful http shutdown + deferred closers in reverse order
func (a *App) Wait() error                                  // blocks until the server exits
```

- [ ] **Step 1: Write the failing smoke test (listener only, no network)**

`Start` needs KERIA/any-sync infra to fully wire, so the unit test covers only the listener contract via a small seam: `listenAndServe(ctx, host, port, handler)`. Put it in `app.go` and test it directly.

```go
// backend/internal/app/app_test.go
package app

import (
	"context"
	"net/http"
	"testing"
	"time"
)

func TestListenPicksFreePortWhenZero(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(204) })
	a, err := listenAndServe(ctx, "127.0.0.1", 0, h)
	if err != nil {
		t.Fatal(err)
	}
	if a.Port() == 0 {
		t.Fatal("expected a real port")
	}
	resp, err := http.Get("http://" + a.Addr() + "/")
	if err != nil || resp.StatusCode != 204 {
		t.Fatalf("server not reachable: %v %v", err, resp)
	}
	sctx, scancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer scancel()
	if err := a.Shutdown(sctx); err != nil {
		t.Fatal(err)
	}
	if _, err := http.Get("http://" + a.Addr() + "/"); err == nil {
		t.Fatal("expected connection refused after Shutdown")
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && go test ./internal/app/ -run TestListen -v`
Expected: FAIL, `listenAndServe` undefined.

- [ ] **Step 3: Write `app.go` skeleton with `listenAndServe`**

```go
package app

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"sync"
)

type App struct {
	srv      *http.Server
	ln       net.Listener
	port     int
	closers  []func()        // run in reverse on Shutdown (replaces main()'s defers)
	done     chan struct{}
	serveErr error
	once     sync.Once
}

func (a *App) Port() int     { return a.port }
func (a *App) Addr() string  { return a.ln.Addr().String() }
func (a *App) Wait() error   { <-a.done; return a.serveErr }

func (a *App) Shutdown(ctx context.Context) error {
	var err error
	a.once.Do(func() {
		err = a.srv.Shutdown(ctx)
		for i := len(a.closers) - 1; i >= 0; i-- {
			a.closers[i]()
		}
	})
	return err
}

func listenAndServe(ctx context.Context, host string, port int, h http.Handler) (*App, error) {
	ln, err := net.Listen("tcp", fmt.Sprintf("%s:%d", host, port))
	if err != nil {
		return nil, fmt.Errorf("listen: %w", err)
	}
	a := &App{srv: &http.Server{Handler: h}, ln: ln, port: ln.Addr().(*net.TCPAddr).Port, done: make(chan struct{})}
	go func() {
		a.serveErr = a.srv.Serve(ln)
		if a.serveErr == http.ErrServerClosed {
			a.serveErr = nil
		}
		close(a.done)
	}()
	go func() { <-ctx.Done(); _ = a.Shutdown(context.Background()) }()
	return a, nil
}
```

- [ ] **Step 4: Run the test**

Run: `cd backend && go test ./internal/app/ -run TestListen -v`
Expected: PASS.

- [ ] **Step 5: Move `main()`'s body into `Start`**

Add to `app.go`:

```go
func Start(ctx context.Context, o Options) (*App, error) {
	// --- body of cmd/server/main.go lines 270..818 goes here, with the
	// mechanical substitutions listed below ---
}
```

Copy `cmd/server/main.go` lines **270–818** (from `orgConfigHandler := api.NewOrgConfigHandler(` through `defer syncWorker.Stop()` and the `handler := ...` line) into `Start`, then apply exactly these substitutions:

1. Lines 182–268 are replaced by the `Options` fields: `isTest` → `o.IsTest()`, `isProd` → `o.IsProd()`, `dataDir` → `o.DataDir`, `configServerURL` → `o.ConfigServerURL`, `configServerToken` → `o.ConfigServerToken`, `anysyncConfigPath` → `o.AnysyncConfigPath`, and `cfg.Server.Port = ...` → after `config.Load` set `cfg.Server.Port = o.Port; cfg.Server.Host = o.Host`.
2. Keep `os.MkdirAll(o.DataDir, 0755)` and the API-token block at the top of `Start`; `apiToken := o.APIToken; if apiToken == "" { apiToken = api.ResolveAPIToken() }`.
3. Every `log.Fatalf(msg, args...)` → `return nil, fmt.Errorf(msg, args...)` (drop trailing `\n`). Every `defer X.Close()` / `defer X.Stop()` → `app.closers = append(app.closers, func() { X.Close() })` — declare `app := &App{}` as the first line of `Start` so closers can be collected before the listener exists; when `listenAndServe` succeeds, copy its fields: `app.srv, app.ln, app.port, app.done = l.srv, l.ln, l.port, l.done` (or restructure `listenAndServe` to accept the pre-made `*App` — either is fine, keep the test green).
4. The big `fmt.Println("Endpoints:")...` banner (lines 667–781) moves to a `func printBanner(addr string)` in `cmd/server/main.go`, called only when `o.PrintBanner`.
5. Replace the final `http.ListenAndServe(addr, handler)` with `return listenAndServe(ctx, o.Host, o.Port, handler)` (plus the closer merge from 3).
6. Fix the `isProd`-cached-config branch that called `log.Fatalf` on missing config: return the error.

Then rewrite `cmd/server/main.go` to:

```go
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/matou-dao/backend/internal/app"
)

func main() {
	o, err := app.OptionsFromEnv()
	if err != nil {
		log.Fatalf("%v", err)
	}
	switch {
	case o.IsTest():
		fmt.Println("MATOU DAO Backend Server (TEST)")
	case o.IsProd():
		fmt.Println("MATOU DAO Backend Server (PRODUCTION)")
	default:
		fmt.Println("MATOU DAO Backend Server")
	}
	fmt.Println("============================")

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	a, err := app.Start(ctx, o)
	if err != nil {
		log.Fatalf("Server failed: %v", err)
	}
	fmt.Printf("Starting HTTP server on %s\n", a.Addr())
	printBanner()

	if err := a.Wait(); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
	sctx, scancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer scancel()
	_ = a.Shutdown(sctx)
}

// printBanner is the endpoint list formerly inlined in main(); unchanged text.
func printBanner() {
	fmt.Println()
	fmt.Println("Endpoints:")
	// … paste lines 668–781 of the old main.go verbatim …
}
```

- [ ] **Step 6: Build, vet, run the unit suite**

Run: `cd backend && go build ./... && go vet ./cmd/... ./internal/app/ && make test`
Expected: all green. (`make test-integration` is known-broken by netcheck — see memory `project_netcheck_blocks_integration_tests`; do not use it as the gate.)

- [ ] **Step 7: Desktop regression check**

Run: `cd backend && MATOU_SERVER_PORT=0 make run` in one shell; in another `curl -s http://localhost:$(grep -o 'Starting HTTP server on [^:]*:[0-9]*' <(sleep 3; true) ...)` — simpler: run `make run` (port 8080) and `curl -s localhost:8080/health`.
Expected: `{"status":"ok"...}`, identical banner text as before, Ctrl-C exits cleanly within 10s.

Then run the Electron dev flow once: `cd frontend && npm run dev -- -m electron` → app boots, Home loads (proves `MATOU_SERVER_PORT` path still works).

- [ ] **Step 8: Commit**

```bash
git add backend/internal/app backend/cmd/server/main.go
git commit -m "app: move server wiring into internal/app.Start so cmd/mobile can embed it (#66)"
```

---

### Task 4: gomobile surface in `cmd/mobile`

**Files:**
- Modify: `backend/cmd/mobile/mobile.go`
- Create: `backend/cmd/mobile/mobile_test.go`

**Interfaces:**
- Consumes: `app.Start`, `app.Options`, `app.DefaultAnysyncConfigPath`.
- Produces (gobind-compatible — only `string`, `int`, `error` cross the bridge):

```go
func Start(dataDir, configServerURL, apiToken string) (int, error) // returns bound loopback port
func Stop() error
func Version() string
```

- [ ] **Step 1: Write the failing test**

```go
package mobile

import "testing"

func TestStopWithoutStartIsNoop(t *testing.T) {
	if err := Stop(); err != nil {
		t.Fatalf("Stop before Start should be a no-op, got %v", err)
	}
}

func TestStartRejectsEmptyArgs(t *testing.T) {
	if _, err := Start("", "https://x", "tok"); err == nil {
		t.Fatal("expected error for empty dataDir")
	}
	if _, err := Start(t.TempDir(), "", "tok"); err == nil {
		t.Fatal("expected error for empty configServerURL")
	}
	if _, err := Start(t.TempDir(), "https://x", ""); err == nil {
		t.Fatal("expected error for empty apiToken")
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && go test ./cmd/mobile/ -v`
Expected: FAIL, `Start`/`Stop` undefined.

- [ ] **Step 3: Implement**

Replace the `Version` function and the blank-import block's doc in `mobile.go` with (keep the package doc comment, update the "Build" line to `make build-android-aar`):

```go
package mobile

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/matou-dao/backend/internal/app"
)

var (
	mu      sync.Mutex
	running *app.App
	cancel  context.CancelFunc
)

// Start boots the full backend in-process and serves the HTTP API on a random
// loopback port. The caller (Android MatouBackendPlugin) generates apiToken
// and keeps it in memory; it is never written to disk by the Java side.
// Production semantics (MATOU_ENV=production, MATOU_CORS_MODE=bundled) are
// fixed here rather than read from env — there is no env on a phone.
func Start(dataDir, configServerURL, apiToken string) (int, error) {
	if dataDir == "" || configServerURL == "" || apiToken == "" {
		return 0, errors.New("mobile.Start: dataDir, configServerURL and apiToken are all required")
	}
	mu.Lock()
	defer mu.Unlock()
	if running != nil {
		return running.Port(), nil
	}
	o := app.Options{
		Env:             "production",
		DataDir:         dataDir,
		Host:            "127.0.0.1",
		Port:            0,
		APIToken:        apiToken,
		ConfigServerURL: configServerURL,
		PrintBanner:     false,
	}
	o.AnysyncConfigPath = app.DefaultAnysyncConfigPath(o)
	ctx, c := context.WithCancel(context.Background())
	a, err := app.Start(ctx, o)
	if err != nil {
		c()
		return 0, fmt.Errorf("mobile.Start: %w", err)
	}
	running, cancel = a, c
	return a.Port(), nil
}

// Stop shuts the server down. Safe to call when not running.
func Stop() error {
	mu.Lock()
	defer mu.Unlock()
	if running == nil {
		return nil
	}
	ctx, c := context.WithTimeout(context.Background(), 10*time.Second)
	defer c()
	err := running.Shutdown(ctx)
	cancel()
	running, cancel = nil, nil
	return err
}

// Version reports the embedded-backend binding version.
func Version() string { return "matou-mobile-android-phase1" }
```

`app.Start` must set `MATOU_CORS_MODE=bundled` semantics without env: in Task 3's `Start`, middleware reads `os.Getenv("MATOU_CORS_MODE")` (`middleware.go:31`). Add to `app.Start`, right before building `handler`: `if o.IsProd() { _ = os.Setenv("MATOU_CORS_MODE", "bundled") }` with a comment that `CORSMiddleware`/`ResolveAPIToken` still read env and that this is the one sanctioned write (Electron already sets it for production). Add `"os"` to imports.

- [ ] **Step 4: Run tests**

Run: `cd backend && go test ./cmd/mobile/ -v && go vet ./cmd/mobile/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/cmd/mobile backend/internal/app/app.go
git commit -m "mobile: real gomobile surface — Start(dataDir, configServerURL, token) (port), Stop (#67)"
```

---

### Task 5: Android toolchain script + `make build-android-aar`

**Files:**
- Create: `scripts/android/setup-toolchain.sh`
- Modify: `backend/Makefile` (new target after `build-all`)
- Modify: `backend/go.mod`, `backend/go.sum` (add `golang.org/x/mobile`)
- Create: `docs/mobile/ANDROID.md`

**Interfaces:**
- Produces: `frontend/src-capacitor/android/app/libs/matou.aar` (consumed by Task 6's Gradle config).

- [ ] **Step 1: Write `scripts/android/setup-toolchain.sh`** (from the spike's reproduction section; idempotent; installs under `$ANDROID_TOOLCHAIN_DIR`, default `$HOME/.matou-android`)

```bash
#!/usr/bin/env bash
# Installs the Android toolchain the gomobile bind + Capacitor build need.
# Versions are pinned to those proven in docs/spikes/2026-08-12-mobile-gomobile-android-spike.md.
set -euo pipefail
ROOT="${ANDROID_TOOLCHAIN_DIR:-$HOME/.matou-android}"
NDK_VER=27.2.12479018          # r27c
PLATFORM=android-34
BUILD_TOOLS=34.0.0
CMDLINE_ZIP=https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
JDK_URL=https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jdk/hotspot/normal/eclipse
mkdir -p "$ROOT"
export ANDROID_HOME="$ROOT/sdk" JAVA_HOME="$ROOT/jdk"
if [ ! -x "$JAVA_HOME/bin/java" ]; then
  echo ">> JDK 17"; mkdir -p "$JAVA_HOME"; curl -sSL "$JDK_URL" | tar -xz -C "$JAVA_HOME" --strip-components=1
fi
if [ ! -x "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" ]; then
  echo ">> cmdline-tools"; mkdir -p "$ANDROID_HOME/cmdline-tools"; tmp=$(mktemp -d)
  curl -sSL "$CMDLINE_ZIP" -o "$tmp/c.zip"; unzip -q "$tmp/c.zip" -d "$tmp"
  mv "$tmp/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"; rm -rf "$tmp"
fi
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
yes | sdkmanager --licenses >/dev/null
sdkmanager "platforms;$PLATFORM" "build-tools;$BUILD_TOOLS" "ndk;$NDK_VER" "platform-tools" >/dev/null
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/$NDK_VER"
echo ">> gomobile"
GOBIN="$(go env GOPATH)/bin" go install golang.org/x/mobile/cmd/gomobile@v0.0.0-20260812174124-2f419b2fb945
GOBIN="$(go env GOPATH)/bin" go install golang.org/x/mobile/cmd/gobind@v0.0.0-20260812174124-2f419b2fb945
"$(go env GOPATH)/bin/gomobile" init
cat > "$ROOT/env.sh" <<ENV
export ANDROID_HOME="$ANDROID_HOME"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export ANDROID_NDK_HOME="$ANDROID_NDK_HOME"
export JAVA_HOME="$JAVA_HOME"
export PATH="\$JAVA_HOME/bin:\$ANDROID_HOME/platform-tools:\$ANDROID_HOME/cmdline-tools/latest/bin:$(go env GOPATH)/bin:\$PATH"
ENV
echo "Toolchain ready. Run:  source $ROOT/env.sh"
```

`chmod +x scripts/android/setup-toolchain.sh`.

- [ ] **Step 2: Pin `golang.org/x/mobile` in `go.mod`** (so the bind no longer needs `-mod=mod` — spike gotcha 3)

Run: `cd backend && go get golang.org/x/mobile/bind@v0.0.0-20260812174124-2f419b2fb945 && go mod tidy && go build ./... && make test`
Expected: green; `go.mod` gains `golang.org/x/mobile`. Confirm cgo audit is still clean: `GOOS=android GOARCH=arm64 CGO_ENABLED=0 go build ./...` → exit 0.

- [ ] **Step 3: Add the Makefile target**

Insert after the `build-all` target in `backend/Makefile`:

```make
# Android: gomobile bind of the full backend → Capacitor's app/libs.
# Requires: source scripts/android/setup-toolchain.sh's env.sh first.
# -androidapi 21 is mandatory with NDK r27c (spike gotcha 1).
# arm64 for devices, amd64 for the x86_64 emulator.
AAR_OUT ?= ../frontend/src-capacitor/android/app/libs/matou.aar
build-android-aar:
	@test -n "$$ANDROID_NDK_HOME" || { echo "ANDROID_NDK_HOME unset — run scripts/android/setup-toolchain.sh"; exit 1; }
	mkdir -p $(dir $(AAR_OUT))
	gomobile bind -target=android/arm64,android/amd64 -androidapi 21 -javapkg nz.matou.backend \
		-o $(AAR_OUT) ./cmd/mobile
	@ls -la $(AAR_OUT)
```

Add `build-android-aar` to the `help` target's list.

- [ ] **Step 4: Run it**

Run: `bash scripts/android/setup-toolchain.sh && source ~/.matou-android/env.sh && cd backend && make build-android-aar`
Expected: `matou.aar` ≈ 10–20 MB; `unzip -l ../frontend/src-capacitor/android/app/libs/matou.aar | grep -E 'jni/(arm64-v8a|x86_64)/libgojni.so|classes.jar'` lists both `.so` files. (Note `src-capacitor/` does not exist until Task 6 — `mkdir -p` in the target handles it.)

- [ ] **Step 5: Write `docs/mobile/ANDROID.md`**

```markdown
# Android build (Phase 1)

## One-time toolchain
    bash scripts/android/setup-toolchain.sh
    source ~/.matou-android/env.sh          # every new shell

## Build
    cd backend && make build-android-aar    # Go backend → frontend/src-capacitor/android/app/libs/matou.aar
    bash scripts/android/build-apk.sh       # SPA → cap sync → app-debug.apk

Output: frontend/dist/capacitor/android/apk/debug/app-debug.apk

## Install & run
    adb install -r frontend/dist/capacitor/android/apk/debug/app-debug.apk
    adb logcat -s MatouBackend:* GoLog:*    # backend log lines come through GoLog

## How it works
MainActivity registers MatouBackendPlugin. On first `getInfo()` the plugin
generates a 32-byte random token, calls `nz.matou.backend.Mobile.start(filesDir, configServerUrl, token)`
which boots the Go backend on a random 127.0.0.1 port, and returns `{port, token}`
to `frontend/src/lib/platform.ts`. Same contract as Electron's IPC (`get-backend-port`, `get-api-token`).

Config server URL is baked in from `VITE_PROD_CONFIG_URL` (`.env.production`) at `quasar build` time
via `capacitor.config.json` → `plugins.MatouBackend.configServerUrl`.

## Gotchas
- `-androidapi 21` is mandatory (NDK r27c).
- Cleartext http to 127.0.0.1 is allowed only by `res/xml/network_security_config.xml`.
- The WebView origin is `https://localhost`; backend CORS bundled mode accepts it (api/middleware.go).
- Emulator needs the `android/amd64` slice (included in `make build-android-aar`).
```

- [ ] **Step 6: Commit** (do NOT commit the `.aar`; add `frontend/src-capacitor/android/app/libs/` to `.gitignore` in Task 6)

```bash
git add scripts/android/setup-toolchain.sh backend/Makefile backend/go.mod backend/go.sum docs/mobile/ANDROID.md
git commit -m "android: toolchain script, pinned x/mobile, make build-android-aar (#68)"
```

---

### Task 6: Capacitor shell + `MatouBackend` plugin

**Files:**
- Create: `frontend/src-capacitor/**` via `quasar mode add capacitor`
- Create: `frontend/src-capacitor/android/app/src/main/java/nz/matou/app/MatouBackendPlugin.java`
- Modify: `frontend/src-capacitor/android/app/src/main/java/nz/matou/app/MainActivity.java`
- Create: `frontend/src-capacitor/android/app/src/main/res/xml/network_security_config.xml`
- Modify: `frontend/src-capacitor/android/app/src/main/AndroidManifest.xml`, `frontend/src-capacitor/android/app/build.gradle`
- Modify: `frontend/quasar.config.ts:102-104`
- Modify: `frontend/.gitignore`
- Create: `scripts/android/build-apk.sh`

**Interfaces:**
- Consumes: `nz.matou.backend.Mobile.start(String,String,String) → long` and `Mobile.stop()` (gobind-generated from Task 4; `int` return becomes `long` in Java).
- Produces (JS side, consumed by Task 7): `window.Capacitor.Plugins.MatouBackend.getInfo(): Promise<{ port: number; token: string }>`.

- [ ] **Step 1: Add Capacitor mode**

Run: `cd frontend && npx quasar mode add capacitor` — answer app id `nz.matou.app`, name `Matou`. Then `cd src-capacitor && npm install && npx cap add android && cd ..`
Expected: `frontend/src-capacitor/android/` exists; `src-capacitor/capacitor.config.json` has `"appId": "nz.matou.app"`.

- [ ] **Step 2: Configure `capacitor.config.json`** (overwrite)

```json
{
  "appId": "nz.matou.app",
  "appName": "Matou",
  "webDir": "www",
  "android": { "allowMixedContent": false },
  "plugins": {
    "MatouBackend": { "configServerUrl": "__CONFIG_SERVER_URL__" }
  }
}
```

and in `frontend/quasar.config.ts` replace the `capacitor:` block with:

```ts
    capacitor: {
      hideSplashscreen: true,
      // Bake the production config-server URL into the native plugin config so
      // the Java side can pass it to the embedded Go backend (mirrors
      // extendElectronMainConf's PROD_CONFIG_SERVER_URL define).
      capacitorCliPreparationParams: ['sync', ctx.targetName],
    },
```

and add `scripts/android/build-apk.sh` which substitutes the placeholder before `quasar build`:

```bash
#!/usr/bin/env bash
# SPA → Capacitor sync → debug APK. Run after `make build-android-aar`.
set -euo pipefail
cd "$(dirname "$0")/../../frontend"
: "${ANDROID_HOME:?run: source ~/.matou-android/env.sh}"
URL=$(grep -E '^VITE_PROD_CONFIG_URL=' .env.production | cut -d= -f2-)
[ -n "$URL" ] || { echo "VITE_PROD_CONFIG_URL missing from frontend/.env.production"; exit 1; }
test -f src-capacitor/android/app/libs/matou.aar || { echo "matou.aar missing — cd backend && make build-android-aar"; exit 1; }
sed -i "s#__CONFIG_SERVER_URL__#$URL#" src-capacitor/capacitor.config.json
trap 'sed -i "s#$URL#__CONFIG_SERVER_URL__#" src-capacitor/capacitor.config.json' EXIT
npx quasar build -m capacitor -T android --debug
ls -la dist/capacitor/android/apk/debug/app-debug.apk
```

`chmod +x scripts/android/build-apk.sh`.

- [ ] **Step 3: Gradle + manifest**

In `src-capacitor/android/app/build.gradle` add inside `dependencies {`:

```groovy
    implementation files('libs/matou.aar')
```

Create `src-capacitor/android/app/src/main/res/xml/network_security_config.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="false" />
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="false">127.0.0.1</domain>
    </domain-config>
</network-security-config>
```

In `AndroidManifest.xml` add to `<application ...>`: `android:networkSecurityConfig="@xml/network_security_config"`. Confirm `<uses-permission android:name="android.permission.INTERNET" />` is present (Capacitor adds it).

- [ ] **Step 4: Write the plugin**

`src-capacitor/android/app/src/main/java/nz/matou/app/MatouBackendPlugin.java`:

```java
package nz.matou.app;

import android.util.Log;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.security.SecureRandom;
import nz.matou.backend.Mobile;

/** Starts the embedded Go backend once per process and hands {port, token} to the webview. */
@CapacitorPlugin(name = "MatouBackend")
public class MatouBackendPlugin extends Plugin {
    private static final String TAG = "MatouBackend";
    private static long port = 0;
    private static String token = null;

    @PluginMethod
    public void getInfo(PluginCall call) {
        try {
            synchronized (MatouBackendPlugin.class) {
                if (port == 0) {
                    String url = getConfig().getString("configServerUrl", "");
                    if (url.isEmpty() || url.startsWith("__")) {
                        call.reject("configServerUrl not configured (build via scripts/android/build-apk.sh)");
                        return;
                    }
                    byte[] buf = new byte[32];
                    new SecureRandom().nextBytes(buf);
                    StringBuilder sb = new StringBuilder();
                    for (byte b : buf) sb.append(String.format("%02x", b));
                    String t = sb.toString();
                    String dataDir = getContext().getFilesDir().getAbsolutePath() + "/matou";
                    Log.i(TAG, "starting backend, dataDir=" + dataDir);
                    port = Mobile.start(dataDir, url, t);   // blocks until the listener is bound
                    token = t;
                    Log.i(TAG, "backend up on 127.0.0.1:" + port);
                }
            }
            JSObject ret = new JSObject();
            ret.put("port", port);
            ret.put("token", token);
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "backend start failed", e);
            call.reject("backend start failed: " + e.getMessage());
        }
    }
}
```

`MainActivity.java`:

```java
package nz.matou.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MatouBackendPlugin.class);
        registerPlugin(SecureStoragePlugin.class); // Task 8
        super.onCreate(savedInstanceState);
    }
}
```

(Until Task 8 exists, leave the `SecureStoragePlugin` line out; Task 8 adds it.)

- [ ] **Step 5: Ignore build outputs**

Append to `frontend/.gitignore`:

```
# Capacitor Android build outputs
/src-capacitor/android/app/libs/matou.aar
/src-capacitor/android/app/build
/src-capacitor/android/.gradle
/src-capacitor/android/local.properties
```

- [ ] **Step 6: Build the APK**

Run: `source ~/.matou-android/env.sh && bash scripts/android/build-apk.sh`
Expected: `frontend/dist/capacitor/android/apk/debug/app-debug.apk` exists. If Gradle complains about JDK, `export JAVA_HOME` is missing — re-source env.sh.

- [ ] **Step 7: Smoke on emulator/device** (platform.ts is not wired yet — this verifies only that the backend boots)

Run: `adb install -r frontend/dist/capacitor/android/apk/debug/app-debug.apk && adb shell am start -n nz.matou.app/.MainActivity && adb logcat -d -s MatouBackend:* GoLog:* | tail -20`
Expected: the app opens (UI will fail to reach the backend until Task 7 — that is expected). `getInfo` isn't called yet either, so trigger it from Chrome devtools: `chrome://inspect` → the Matou WebView → console: `await Capacitor.Plugins.MatouBackend.getInfo()` → `{port: <n>, token: "<64 hex>"}`, and logcat shows `backend up on 127.0.0.1:<n>` followed by Go log lines.

- [ ] **Step 8: Commit**

```bash
git add frontend/src-capacitor frontend/quasar.config.ts frontend/.gitignore scripts/android/build-apk.sh
git commit -m "android: Capacitor shell with MatouBackend plugin starting the embedded Go backend (#69)"
```

---

### Task 7: Capacitor detection in `platform.ts`

**Files:**
- Create: `frontend/src/lib/capacitor.ts`
- Modify: `frontend/src/lib/platform.ts`
- Create: `frontend/tests/scripts/platform.test.ts`

**Interfaces:**
- Consumes: `window.Capacitor.Plugins.MatouBackend.getInfo()` (Task 6).
- Produces:

```ts
// src/lib/capacitor.ts
export interface BackendInfo { port: number; token: string }
export function isCapacitor(): boolean            // !!window.Capacitor?.isNativePlatform?.()
export function getBackendInfo(): Promise<BackendInfo>  // memoised
export function getSecureStoragePlugin(): SecureStoragePlugin | null   // Task 8
```

- [ ] **Step 1: Write the failing tests**

`frontend/tests/scripts/platform.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

// platform.ts caches resolved values at module scope; re-import per test.
async function freshPlatform() {
  vi.resetModules();
  return await import('src/lib/platform');
}

describe('platform detection', () => {
  beforeEach(() => {
    // @ts-expect-error test shim
    globalThis.window = globalThis.window ?? {};
    delete (window as any).Capacitor;
    delete (window as any).electronAPI;
    delete (window as any).cordova;
  });

  it('isCapacitor is false in a plain browser', async () => {
    const p = await freshPlatform();
    expect(p.isCapacitor()).toBe(false);
    expect(p.isBrowser()).toBe(true);
  });

  it('isCapacitor is true when Capacitor reports a native platform', async () => {
    (window as any).Capacitor = { isNativePlatform: () => true, Plugins: {} };
    const p = await freshPlatform();
    expect(p.isCapacitor()).toBe(true);
    expect(p.isBrowser()).toBe(false);
  });

  it('resolves backend URL and token from MatouBackend.getInfo on Capacitor', async () => {
    const getInfo = vi.fn().mockResolvedValue({ port: 41234, token: 'abc123' });
    (window as any).Capacitor = { isNativePlatform: () => true, Plugins: { MatouBackend: { getInfo } } };
    const p = await freshPlatform();
    expect(await p.getBackendUrl()).toBe('http://127.0.0.1:41234');
    expect(await p.getApiToken()).toBe('abc123');
    expect(p.getBackendUrlSync()).toBe('http://127.0.0.1:41234');
    expect(p.getApiTokenSync()).toBe('abc123');
    expect(getInfo).toHaveBeenCalledTimes(1); // memoised across URL + token
  });

  it('does not fall back to the dev token on Capacitor when the plugin is missing', async () => {
    (window as any).Capacitor = { isNativePlatform: () => true, Plugins: {} };
    const p = await freshPlatform();
    await expect(p.getApiToken()).rejects.toThrow(/MatouBackend/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run tests/scripts/platform.test.ts`
Expected: FAIL — `isCapacitor` is not exported.

- [ ] **Step 3: Implement `src/lib/capacitor.ts`**

```ts
/**
 * Thin, import-free access to the native Capacitor plugins registered in
 * src-capacitor/android/.../MainActivity.java. We read window.Capacitor
 * instead of importing @capacitor/core so the same bundle works in browser,
 * Electron and Capacitor modes (the package only exists in src-capacitor/).
 */
export interface BackendInfo {
  port: number;
  token: string;
}

export interface SecureStoragePlugin {
  get(o: { key: string }): Promise<{ value: string | null }>;
  set(o: { key: string; value: string }): Promise<void>;
  remove(o: { key: string }): Promise<void>;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  Plugins?: {
    MatouBackend?: { getInfo(): Promise<BackendInfo> };
    SecureStorage?: SecureStoragePlugin;
  };
}

function cap(): CapacitorGlobal | undefined {
  return (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
}

export function isCapacitor(): boolean {
  return !!cap()?.isNativePlatform?.();
}

let infoPromise: Promise<BackendInfo> | null = null;

/** Starts (once) and describes the embedded backend. Rejects if the plugin is absent. */
export function getBackendInfo(): Promise<BackendInfo> {
  if (!infoPromise) {
    const plugin = cap()?.Plugins?.MatouBackend;
    if (!plugin) {
      return Promise.reject(new Error('MatouBackend Capacitor plugin is not registered'));
    }
    infoPromise = plugin.getInfo().catch((e) => {
      infoPromise = null; // allow retry after a failed start
      throw e;
    });
  }
  return infoPromise;
}

export function getSecureStoragePlugin(): SecureStoragePlugin | null {
  return cap()?.Plugins?.SecureStorage ?? null;
}
```

- [ ] **Step 4: Wire `platform.ts`**

In `frontend/src/lib/platform.ts`:

```ts
import { getBackendInfo, isCapacitor } from './capacitor';
export { isCapacitor } from './capacitor';
```

Change `isBrowser` to `return !isElectron() && !isCordova() && !isCapacitor();`.

In `getBackendUrl()`, after the Electron block and before the browser fallback:

```ts
  if (isCapacitor()) {
    const { port, token } = await getBackendInfo();
    cachedBackendUrl = `http://127.0.0.1:${port}`;
    cachedApiToken = token;
    return cachedBackendUrl;
  }
```

In `getApiToken()`, same position:

```ts
  if (isCapacitor()) {
    const { port, token } = await getBackendInfo();
    cachedBackendUrl = `http://127.0.0.1:${port}`;
    cachedApiToken = token;
    return cachedApiToken;
  }
```

Update the header comment to say "Electron, Capacitor, Cordova, and browser". Do **not** change `getBackendUrlSync`/`getApiTokenSync` — they return the cache, which the Capacitor branch populates.

- [ ] **Step 5: Make sure the async path is awaited before first request**

Find where the app first resolves the backend URL: `grep -rn "getBackendUrl()" frontend/src | grep -v platform.ts`. In `frontend/src/boot/keri.ts` (or whichever boot file runs first) ensure `await getBackendUrl()` happens before any store fires a request; if it already does for Electron (it must, since Electron's port is also async), nothing to change — confirm and note the line in the commit message.

- [ ] **Step 6: Run tests + lint**

Run: `cd frontend && npx vitest run tests/scripts/platform.test.ts && npm run lint`
Expected: 4 PASS, lint clean.

- [ ] **Step 7: Rebuild APK, real smoke**

Run: `bash scripts/android/build-apk.sh && adb install -r frontend/dist/capacitor/android/apk/debug/app-debug.apk && adb shell am start -n nz.matou.app/.MainActivity`
Expected: Welcome/onboarding screen renders; `chrome://inspect` network tab shows `GET http://127.0.0.1:<port>/health` → 200 and `/api/v1/org/config` → 200 with CORS header `Access-Control-Allow-Origin: https://localhost`.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/capacitor.ts frontend/src/lib/platform.ts frontend/tests/scripts/platform.test.ts
git commit -m "platform: detect Capacitor and resolve backend port/token from the MatouBackend plugin (#70)"
```

---

### Task 8: Encrypted secure storage on Android

`src/lib/secureStorage.ts:11-38` falls back to plaintext `localStorage` whenever it isn't Electron; on a phone that would put the mnemonic in WebView storage. Add a plugin backed by `EncryptedSharedPreferences`.

**Files:**
- Create: `frontend/src-capacitor/android/app/src/main/java/nz/matou/app/SecureStoragePlugin.java`
- Modify: `frontend/src-capacitor/android/app/src/main/java/nz/matou/app/MainActivity.java` (register)
- Modify: `frontend/src-capacitor/android/app/build.gradle` (`implementation "androidx.security:security-crypto:1.1.0-alpha06"`)
- Modify: `frontend/src/lib/secureStorage.ts`
- Create: `frontend/tests/scripts/secure-storage.test.ts`

**Interfaces:**
- Consumes: `getSecureStoragePlugin()` (Task 7).
- Produces: unchanged `secureStorage` API (`getItem/setItem/removeItem`) — check the exact exported names at `secureStorage.ts:15-40` and keep them.

- [ ] **Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

async function fresh() {
  vi.resetModules();
  return await import('src/lib/secureStorage');
}

describe('secureStorage on Capacitor', () => {
  const store = new Map<string, string>();
  const plugin = {
    get: vi.fn(async ({ key }: { key: string }) => ({ value: store.get(key) ?? null })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => { store.set(key, value); }),
    remove: vi.fn(async ({ key }: { key: string }) => { store.delete(key); }),
  };

  beforeEach(() => {
    store.clear();
    // @ts-expect-error test shim
    globalThis.window = globalThis.window ?? {};
    (window as any).localStorage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() };
    (window as any).Capacitor = { isNativePlatform: () => true, Plugins: { SecureStorage: plugin } };
    delete (window as any).electronAPI;
  });

  it('round-trips through the native plugin and never touches localStorage', async () => {
    const s = await fresh();
    await s.secureStorage.setItem('mnemonic', 'word1 word2');
    expect(await s.secureStorage.getItem('mnemonic')).toBe('word1 word2');
    await s.secureStorage.removeItem('mnemonic');
    expect(await s.secureStorage.getItem('mnemonic')).toBeNull();
    expect((window as any).localStorage.setItem).not.toHaveBeenCalled();
  });
});
```

Adjust `s.secureStorage.setItem` to the actual exported shape in `secureStorage.ts` (read lines 1-40 first; if it exports functions rather than an object, call those).

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run tests/scripts/secure-storage.test.ts`
Expected: FAIL — `localStorage.setItem` was called (plaintext fallback).

- [ ] **Step 3: Implement the TS branch**

In `secureStorage.ts`, import `{ getSecureStoragePlugin, isCapacitor } from './capacitor'` and, in each of the three operations, before the Electron check add:

```ts
    if (isCapacitor()) {
      const p = getSecureStoragePlugin();
      if (!p) throw new Error('SecureStorage Capacitor plugin is not registered');
      // get:    return (await p.get({ key })).value;
      // set:    await p.set({ key, value }); return;
      // remove: await p.remove({ key }); return;
    }
```

(Use the matching line for each operation.) Note the module-scope `const isElectron = ...` at line 11 stays as is.

- [ ] **Step 4: Run test**

Run: `cd frontend && npx vitest run tests/scripts/secure-storage.test.ts`
Expected: PASS.

- [ ] **Step 5: Java plugin**

```java
package nz.matou.app;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;
import android.content.SharedPreferences;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Keystore-backed key/value store for the mnemonic and other secrets. */
@CapacitorPlugin(name = "SecureStorage")
public class SecureStoragePlugin extends Plugin {
    private SharedPreferences prefs;

    private SharedPreferences prefs() throws Exception {
        if (prefs == null) {
            MasterKey key = new MasterKey.Builder(getContext())
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build();
            prefs = EncryptedSharedPreferences.create(getContext(), "matou_secure", key,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
        }
        return prefs;
    }

    @PluginMethod public void get(PluginCall call) {
        try {
            String v = prefs().getString(call.getString("key"), null);
            JSObject ret = new JSObject();
            ret.put("value", v == null ? JSObject.NULL : v);
            call.resolve(ret);
        } catch (Exception e) { call.reject(e.getMessage()); }
    }

    @PluginMethod public void set(PluginCall call) {
        try {
            prefs().edit().putString(call.getString("key"), call.getString("value")).apply();
            call.resolve();
        } catch (Exception e) { call.reject(e.getMessage()); }
    }

    @PluginMethod public void remove(PluginCall call) {
        try {
            prefs().edit().remove(call.getString("key")).apply();
            call.resolve();
        } catch (Exception e) { call.reject(e.getMessage()); }
    }
}
```

Add `registerPlugin(SecureStoragePlugin.class);` to `MainActivity.onCreate` and the gradle dependency.

- [ ] **Step 6: Build + device check**

Run: `bash scripts/android/build-apk.sh && adb install -r frontend/dist/capacitor/android/apk/debug/app-debug.apk`
Then in `chrome://inspect` console: `await Capacitor.Plugins.SecureStorage.set({key:'t',value:'1'}); await Capacitor.Plugins.SecureStorage.get({key:'t'})` → `{value:"1"}`. Then `adb shell run-as nz.matou.app cat shared_prefs/matou_secure.xml` → values are ciphertext, not `1`.

- [ ] **Step 7: Commit**

```bash
git add frontend/src-capacitor/android frontend/src/lib/secureStorage.ts frontend/tests/scripts/secure-storage.test.ts
git commit -m "android: EncryptedSharedPreferences-backed SecureStorage plugin; no plaintext mnemonic on device (#71)"
```

---

### Task 9: `useIsMobile` + global dialog override

One global rule beats editing 24 `q-card style="min-width: NNNpx"` sites: stylesheet `!important` wins over inline non-important styles.

**Files:**
- Create: `frontend/src/composables/useIsMobile.ts`
- Create: `frontend/tests/scripts/use-is-mobile.test.ts`
- Modify: `frontend/src/css/app.scss`

**Interfaces:**
- Produces: `useIsMobile(): Readonly<Ref<boolean>>` — true when `(max-width: 767px)` matches; updates live.

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it, vi } from 'vitest';

describe('useIsMobile', () => {
  it('tracks the 767px media query', async () => {
    let listener: ((e: { matches: boolean }) => void) | null = null;
    const mql = {
      matches: true,
      addEventListener: vi.fn((_: string, cb: typeof listener) => { listener = cb; }),
      removeEventListener: vi.fn(),
    };
    // @ts-expect-error test shim
    globalThis.window = { matchMedia: vi.fn(() => mql) };
    vi.resetModules();
    const { useIsMobile } = await import('src/composables/useIsMobile');
    const isMobile = useIsMobile();
    expect(window.matchMedia).toHaveBeenCalledWith('(max-width: 767px)');
    expect(isMobile.value).toBe(true);
    listener!({ matches: false });
    expect(isMobile.value).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run tests/scripts/use-is-mobile.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
import { onScopeDispose, readonly, ref, getCurrentScope } from 'vue';

export const MOBILE_QUERY = '(max-width: 767px)';

/**
 * Reactive phone-width flag. 767px matches the existing breakpoint in
 * DashboardLayout.vue and DashboardPage.vue; keep them in lockstep.
 */
export function useIsMobile() {
  const isMobile = ref(false);
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return readonly(isMobile);
  }
  const mql = window.matchMedia(MOBILE_QUERY);
  isMobile.value = mql.matches;
  const onChange = (e: { matches: boolean }) => { isMobile.value = e.matches; };
  mql.addEventListener('change', onChange);
  if (getCurrentScope()) onScopeDispose(() => mql.removeEventListener('change', onChange));
  return readonly(isMobile);
}
```

- [ ] **Step 4: Test passes**

Run: `cd frontend && npx vitest run tests/scripts/use-is-mobile.test.ts` → PASS.

- [ ] **Step 5: Global dialog override** — append to `frontend/src/css/app.scss`:

```scss
// ---------------------------------------------------------------------------
// Mobile: dialogs. 24 dialog cards carry inline `min-width: 400–620px`
// (grep 'min-width:' in components/**/ *Dialog.vue, *Modal.vue, *Form.vue).
// A stylesheet !important beats inline non-important styles, so one rule
// makes every dialog fit a 390px phone without touching each component.
// ---------------------------------------------------------------------------
@media (max-width: 767px) {
  .q-dialog .q-card {
    min-width: 0 !important;
    width: calc(100vw - 24px) !important;
    max-width: calc(100vw - 24px) !important;
    max-height: calc(100vh - 24px);
    overflow-y: auto;
  }
  // Scoped-style dialog cards (ConfirmDestroyDialog, MilestoneFormDialog,
  // CreateContributionDialog, ReportIssueDialog, AssignRoleDialog,
  // AddGovernanceActionDialog, ConfirmArchiveDialog, AssignmentCard) use
  // class-level min-width inside .q-dialog; the selector above covers them
  // because scoped attrs don't raise specificity past !important.
}
```

- [ ] **Step 6: Verify in the browser**

Run: `cd frontend && npm run dev` then Chrome devtools → device toolbar → 390×844. Open: Projects → "New project" (ProjectForm, 560px inline), Proposals → "Create proposal" (600px), a contribution → "Submit evidence" (ContributionDetailPage 500px), sidebar → "Report an issue" (ReportIssueDialog scoped 525px).
Expected: each dialog fits with 12px side gutters and scrolls internally; no horizontal page scroll.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/composables/useIsMobile.ts frontend/tests/scripts/use-is-mobile.test.ts frontend/src/css/app.scss
git commit -m "ui: useIsMobile composable and global ≤767px dialog override (#72)"
```

---

### Task 10: Non-dialog fixed widths

The remaining `min-width` ≥100px hits that aren't dialogs; each gets a ≤767px relaxation in its own scoped style block.

**Files:**
- Modify: `frontend/src/pages/Contributions/ContributionsPage.vue:435,448` (filter controls 140px/220px)
- Modify: `frontend/src/pages/Projects/ProjectDetailPage.vue:1891,1925` (180px / 460px)
- Modify: `frontend/src/pages/DashboardPage.vue:1025` (200px)
- Modify: `frontend/src/components/projects/ContributionCardCompact.vue:290` (120px)
- Modify: `frontend/src/components/contributions/AssignmentCard.vue:302` (360px — if this card is not inside a `.q-dialog`, it needs its own rule)
- Modify: `frontend/src/pages/AccountSettingsPage.vue:1331` (100px)

- [ ] **Step 1: For each file, read the selector at the listed line and append to that file's `<style>`**

```scss
@media (max-width: 767px) {
  .<that-selector> {
    min-width: 0;
    width: 100%;
  }
}
```

Example for `ContributionsPage.vue` — the two selectors at 435/448 are the filter `q-select` wrappers; both get `min-width: 0; width: 100%;` and their parent row gets `flex-wrap: wrap; gap: 8px;`.

- [ ] **Step 2: Verify**

`npm run dev` at 390×844: Contributions list (filters wrap, no overflow), a Project detail page (milestone table/columns at 1891/1925 don't force horizontal scroll), Home dashboard, Account settings.
Expected: `document.documentElement.scrollWidth === window.innerWidth` in the console on each page.

- [ ] **Step 3: Lint + commit**

```bash
cd frontend && npm run lint
git add frontend/src/pages frontend/src/components/projects/ContributionCardCompact.vue frontend/src/components/contributions/AssignmentCard.vue
git commit -m "ui: relax fixed min-widths on pages and cards at ≤767px (#73)"
```

---

### Task 11: `DashboardLayout` bottom tab bar

At ≤767px the sidebar is `display: none` (`DashboardLayout.vue:471-478`) and there is **no navigation at all**. Replace with a bottom tab bar showing the same 7 destinations + profile.

**Files:**
- Modify: `frontend/src/layouts/DashboardLayout.vue`

**Interfaces:**
- Consumes: `useIsMobile` (Task 9).

- [ ] **Step 1: Refactor the nav items into data** — in `<script setup>` add:

```ts
import { useIsMobile } from 'src/composables/useIsMobile';
const isMobile = useIsMobile();

const navItems = [
  { name: 'dashboard',     label: 'Home',          icon: Home,          badge: () => 0 },
  { name: 'chat',          label: 'Chat',          icon: MessageSquare, badge: () => chatStore.totalUnreadCount },
  { name: 'wallet',        label: 'Wallet',        icon: Wallet,        badge: () => 0 },
  { name: 'activity',      label: 'Notices',       icon: Bell,          badge: () => noticesUnreadTotal.value },
  { name: 'proposals',     label: 'Proposals',     icon: Vote,          badge: () => 0 },
  { name: 'projects',      label: 'Projects',      icon: Target,        badge: () => projectsUnreadTotal.value },
  { name: 'contributions', label: 'Contributions', icon: Hammer,        badge: () => contributionsUnreadTotal.value,
    active: () => route.name === 'contributions' || route.name === 'contribution-detail' },
] as const;

function isActive(item: (typeof navItems)[number]) {
  return 'active' in item ? item.active() : route.name === item.name;
}
function badgeText(n: number) { return n > 99 ? '99+' : String(n); }
```

Rewrite the `<nav class="sidebar-nav">` block to a `v-for` over `navItems` (keep the `report-issue-btn` after the loop) so the sidebar and bottom bar share one source of truth. Keep the markup/classes otherwise identical so the desktop look is unchanged.

- [ ] **Step 2: Add the bottom bar** — after `</main>` in the template:

```vue
    <!-- Mobile bottom navigation (≤767px). Sidebar is display:none there. -->
    <nav v-if="isMobile" class="bottom-nav" aria-label="Primary">
      <button
        v-for="item in navItems"
        :key="item.name"
        class="bottom-nav-item"
        :class="{ active: isActive(item) }"
        @click="router.push({ name: item.name })"
      >
        <component :is="item.icon" class="bottom-nav-icon" />
        <span class="bottom-nav-label">{{ item.label }}</span>
        <span v-if="item.badge() > 0" class="nav-badge bottom-nav-badge">{{ badgeText(item.badge()) }}</span>
      </button>
      <button class="bottom-nav-item" :class="{ active: route.name === 'account-settings' }" @click="router.push({ name: 'account-settings' })">
        <div class="user-avatar bottom-nav-avatar">
          <img v-if="userAvatarUrl" :src="userAvatarUrl" class="w-full h-full rounded-full object-cover" alt="Avatar" />
          <span v-else>{{ userInitials }}</span>
        </div>
        <span class="bottom-nav-label">Me</span>
      </button>
    </nav>
```

"Report an issue" moves to Account Settings on mobile: add a `Report an issue` list entry on `AccountSettingsPage.vue` that opens the same `ReportIssueDialog` (copy the `showReportDialog` ref + `<ReportIssueDialog v-model=...>` usage from DashboardLayout). Desktop sidebar keeps its button.

- [ ] **Step 3: Styles** — replace the `@media (max-width: 767px)` block at the end of `<style>` with:

```scss
.bottom-nav { display: none; }

@media (max-width: 767px) {
  .sidebar { display: none; }
  .main-content {
    margin-left: 0;
    width: 100%;
    padding-bottom: calc(64px + env(safe-area-inset-bottom));
  }
  .bottom-nav {
    position: fixed;
    left: 0; right: 0; bottom: 0;
    height: calc(64px + env(safe-area-inset-bottom));
    padding-bottom: env(safe-area-inset-bottom);
    display: flex;
    justify-content: space-around;
    align-items: stretch;
    overflow-x: auto;
    background-color: var(--matou-sidebar);
    border-top: 1px solid var(--matou-sidebar-border);
    z-index: 40;
  }
  .bottom-nav-item {
    flex: 1 0 56px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    position: relative;
    background: none;
    border: 0;
    color: var(--matou-sidebar-foreground);
    font-size: 10px;
    &.active { color: var(--matou-sidebar-primary); }
  }
  .bottom-nav-icon { width: 22px; height: 22px; }
  .bottom-nav-badge { position: absolute; top: 6px; right: 10px; }
  .bottom-nav-avatar { width: 24px; height: 24px; font-size: 10px; }
}
```

- [ ] **Step 4: Verify**

`npm run dev` at 390×844 and at 1280×800.
Expected: phone — bottom bar with 8 tabs, active tab highlighted, unread badges show, page content not hidden behind the bar; desktop — unchanged sidebar, no bottom bar. Then at 390px open Account settings → "Report an issue" works.

- [ ] **Step 5: Lint + commit**

```bash
cd frontend && npm run lint && npx vue-tsc --noEmit
git add frontend/src/layouts/DashboardLayout.vue frontend/src/pages/AccountSettingsPage.vue
git commit -m "ui: bottom tab bar for DashboardLayout at ≤767px; nav items driven from one list (#74)"
```

---

### Task 12: `ChatLayout` single-pane mode

`ChatLayout.vue` is a three-pane flex row: `ChannelSidebar` (240px fixed, `ChannelSidebar.vue:67`), `.chat-main`, `ThreadPanel` (320px, `ThreadPanel.vue:87`). On a phone: show the channel list when no channel is selected, the messages when one is, a back button in the header, and the thread as a full-width overlay.

**Files:**
- Modify: `frontend/src/components/chat/ChatLayout.vue`
- Modify: `frontend/src/components/chat/ChannelHeader.vue` (add optional `showBack` prop + `back` emit)
- Modify: `frontend/src/components/chat/ThreadPanel.vue` (mobile overlay style)

**Interfaces:**
- Consumes: `useIsMobile`, `chatStore.selectChannel(id)`, `chatStore.currentChannelId`.
- Produces: `ChannelHeader` props `showBack?: boolean`; emits `back`.

- [ ] **Step 1: ChatLayout script**

```ts
import { useIsMobile } from 'src/composables/useIsMobile';
const isMobile = useIsMobile();
const showChannelList = computed(() => !isMobile.value || !chatStore.currentChannelId);
const showMain = computed(() => !isMobile.value || !!chatStore.currentChannelId);
function handleBack() {
  threadMessageId.value = null;
  chatStore.selectChannel(null); // verify selectChannel accepts null; if it takes only string, add a clearChannel() action to stores/chat.ts that sets currentChannelId = null
}
```

- [ ] **Step 2: ChatLayout template** — wrap the sidebar in `v-if="showChannelList"`, `.chat-main` in `v-if="showMain"`, and pass to `ChannelHeader`: `:show-back="isMobile" @back="handleBack"`. Give `ThreadPanel` `:class="{ 'thread-panel--overlay': isMobile }"`.

- [ ] **Step 3: ChannelHeader** — add:

```ts
defineProps<{ channel: Channel; showBack?: boolean }>(); // extend the existing props
const emit = defineEmits<{ settings: []; back: [] }>();   // extend the existing emits
```

and at the start of the header's left group:

```vue
<button v-if="showBack" class="back-btn" aria-label="Back to channels" @click="emit('back')">
  <ChevronLeft class="w-5 h-5" />
</button>
```

(`ChevronLeft` from `lucide-vue-next`.)

- [ ] **Step 4: Styles**

`ChatLayout.vue` `<style>` add:

```scss
@media (max-width: 767px) {
  .chat-layout :deep(.channel-sidebar) { width: 100%; }   // check the root class name in ChannelSidebar.vue:67
  .chat-layout :deep(.thread-panel--overlay) {
    position: fixed; inset: 0; width: 100%; z-index: 45;
    padding-bottom: calc(64px + env(safe-area-inset-bottom)); // above the bottom nav
  }
}
```

- [ ] **Step 5: Verify**

`npm run dev` at 390×844: Chat tab → channel list full width → tap a channel → messages + composer full width, back chevron in header → back returns to the list. Open a thread → overlay fills the screen, close returns to messages. At 1280px: unchanged three-pane.

- [ ] **Step 6: Lint + commit**

```bash
cd frontend && npm run lint && npx vue-tsc --noEmit
git add frontend/src/components/chat frontend/src/stores/chat.ts
git commit -m "chat: single-pane mobile mode with back navigation and thread overlay (#75)"
```

---

### Task 13: Android CI workflow

**Files:**
- Create: `.forgejo/workflows/android.yml`

The sandbox image (`.sandcastle/Dockerfile`) has Node + Go but no NDK. Rather than bloating it, the job installs the toolchain into a cached dir on the runner via Task 5's script (idempotent, ~1.5 GB first run).

- [ ] **Step 1: Write the workflow**

```yaml
name: android
# Builds the gomobile .aar and a debug APK. Manual + on changes to the paths
# that feed the Android build. Artifact: app-debug.apk.
on:
  workflow_dispatch: {}
  pull_request:
    paths:
      - 'backend/**'
      - 'frontend/src-capacitor/**'
      - 'frontend/src/lib/platform.ts'
      - 'frontend/src/lib/capacitor.ts'
      - 'scripts/android/**'
      - '.forgejo/workflows/android.yml'

jobs:
  apk:
    runs-on: swarm
    timeout-minutes: 60
    steps:
      - name: Checkout (raw clone — see ci.yml for why not actions/checkout)
        env:
          FORGEJO_TOKEN: ${{ secrets.SWARM_FORGEJO_TOKEN }}
          SERVER_URL: ${{ github.server_url }}
          REPO_SLUG: ${{ github.repository }}
          SHA: ${{ github.event.pull_request.head.sha || github.sha }}
        run: |
          set -euo pipefail
          host="${SERVER_URL#https://}"
          url="https://swarm:${FORGEJO_TOKEN}@${host}/${REPO_SLUG}.git"
          git init -q . && git remote add origin "$url"
          git fetch -q --depth=1 origin "$SHA" && git checkout -q -f FETCH_HEAD
      - name: Toolchain (cached in $HOME/.matou-android)
        run: bash scripts/android/setup-toolchain.sh
      - name: Bind backend
        run: |
          set -euo pipefail
          source "$HOME/.matou-android/env.sh"
          cd backend && make build-android-aar
      - name: Build debug APK
        env:
          VITE_PROD_CONFIG_URL: ${{ secrets.PROD_CONFIG_URL }}
        run: |
          set -euo pipefail
          source "$HOME/.matou-android/env.sh"
          cd frontend && CI=true npm ci
          printf 'VITE_ENV=prod\nVITE_PROD_CONFIG_URL=%s\n' "$VITE_PROD_CONFIG_URL" > .env.production
          cd src-capacitor && npm ci && cd ..
          cd .. && bash scripts/android/build-apk.sh
      - name: Upload APK
        uses: actions/upload-artifact@v3
        with:
          name: app-debug.apk
          path: frontend/dist/capacitor/android/apk/debug/app-debug.apk
```

- [ ] **Step 2: Add the `PROD_CONFIG_URL` secret** in Forgejo repo settings (value = the `VITE_PROD_CONFIG_URL` from your local `frontend/.env.production`). Note in the PR body that this secret is required.

- [ ] **Step 3: Trigger and check**

Push the branch, open the PR (Task 14), then `workflow_dispatch` the `android` workflow from the Actions tab.
Expected: green, artifact `app-debug.apk` downloadable. First run takes ~15 min (toolchain download); subsequent ~5 min. If `actions/upload-artifact@v3` fails to fetch (same data.forgejo.org flakiness as checkout), replace with `curl` upload of the APK to the Mattermost channel using the `MATTERMOST_*` secrets already used by `ci.yml`.

- [ ] **Step 4: Commit**

```bash
git add .forgejo/workflows/android.yml
git commit -m "ci: android workflow — gomobile bind + debug APK artifact (#76)"
```

---

### Task 14: End-to-end device verification and PR

- [ ] **Step 1: Fresh install, full onboarding on a phone** (or emulator with `android/amd64` slice)

```bash
adb uninstall nz.matou.app || true
adb install frontend/dist/capacitor/android/apk/debug/app-debug.apk
adb logcat -c && adb shell am start -n nz.matou.app/.MainActivity
```

Walk through: welcome → create identity (mnemonic is generated; confirm `adb shell run-as nz.matou.app ls files/matou` shows the data dir and `shared_prefs/matou_secure.xml` holds ciphertext) → register with the dev/test org using an invite → Home loads → Chat send a message → open a Project → open a contribution dialog. Background the app for 2 minutes, foreground it: chat still live (Android doesn't suspend like iOS; confirm no reconnect errors in `adb logcat -s GoLog:*`).

- [ ] **Step 2: Regression on desktop**

```bash
cd backend && make test && go vet ./...
cd ../frontend && npm run test:script && npm run lint && npx vue-tsc --noEmit
```

Expected: all green. Optionally one Playwright project: `npx playwright test --project=org-setup` with infra up (see `clean-start` skill).

- [ ] **Step 3: Update docs**

Append to `README.md` under the build section: "Android: see `docs/mobile/ANDROID.md`." Append to `CLAUDE.md` Common Commands → Backend: `make build-android-aar  # gomobile bind → Capacitor libs`.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin mobile/android-phase1
T=$(cat ~/.config/forgejo-token)
curl -s -H "Authorization: token $T" -H 'Content-Type: application/json' \
  https://git.matou.nz/api/v1/repos/matou/matou-app/pulls \
  -d "$(jq -n '{head:"mobile/android-phase1", base:"main",
    title:"Mobile Phase 1 (Android): embedded Go backend, Capacitor shell, responsive layouts",
    body:"Implements docs/superpowers/plans/2026-08-22-android-phase1.md.\n\nCloses #64–#68, #69–#71, #72–#75, #76. Builds on spike #23 / PR #30.\n\nRequires repo secret PROD_CONFIG_URL for the android workflow.\n\nDevice-verified: fresh install → onboarding → chat → project dialogs at 390×844.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)"}')" | jq -r .html_url
```

---

## Self-review

**Spec coverage:** on-device any-sync ✔ (Task 4 embeds `app.Start` with the full graph); loopback HTTP, `src/api` unchanged ✔ (Tasks 3–7); gomobile entry point in `cmd/mobile` with `Initialize/Shutdown` ✔ (named `Start/Stop`; `Pause/Resume` explicitly deferred to iOS — Global Constraints); Capacitor build + real Capacitor detection in `platform.ts` ✔ (Tasks 6–7); layout overhaul for `DashboardLayout`, `ChatLayout`, 38 dialogs ✔ (Tasks 9–12; `OnboardingLayout` covered by the global override and declared out of scope for redesign); spec "Corrections" — `window.Capacitor` not `window.cordova` ✔ (Task 7), `ChatLayout` is a component ✔ (Task 12 path). Dependency-audit constraint ✔ (Task 5 step 2 re-runs `CGO_ENABLED=0` build). CI bind job from the spike's follow-ups ✔ (Task 13).

**Placeholders:** Task 3 step 5 references a verbatim move of `main.go` lines with substitution rules instead of reproducing 550 lines — intentional; the rules are exhaustive. Task 8 step 1 and Task 12 step 1 tell the implementer to confirm an existing export shape (`secureStorage` API, `selectChannel(null)`) and give the fallback.

**Type consistency:** `Options.PrintBanner`, `DefaultAnysyncConfigPath(o)`, `App.Port()/Addr()/Shutdown()/Wait()` used identically in Tasks 2–4; Java `Mobile.start` returns `long` (gobind maps Go `int` → Java `long`) and is stored in a `long` ✔; `BackendInfo {port, token}` keys match the Java `JSObject` keys ✔; `useIsMobile` return used as `.value` in Tasks 11–12 ✔; `SecureStoragePlugin` method names `get/set/remove` match Java `@PluginMethod`s ✔.
