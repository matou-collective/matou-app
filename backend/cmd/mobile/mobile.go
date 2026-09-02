// Package mobile is the gomobile-bind entry point that embeds the full Matou
// backend in-process on a mobile device (Android/iOS).
//
// gomobile bind generates a native library (Android .aar / iOS framework) that
// exposes this package's exported functions to Kotlin/Swift. The host app calls
// Start to boot the backend on a loopback listener, then points its WebView at
// http://127.0.0.1:<port>; Stop tears it down. This is the Phase 1 replacement
// for the #23 spike placeholder, which only forced the dependency graph to link.
//
// The blank imports below stay: they guarantee `gomobile bind` compiles every
// internal backend package (and its transitive deps: any-sync, quic-go, modernc
// sqlite, …) for the mobile target. internal/app is imported for real (it drives
// the wiring), so the whole backend is linked; keep the blank list in sync with
// internal/ so a package that app stops importing is still bound.
//
// Build (Android arm64, NDK required):
//
//	gomobile bind -target=android/arm64 -o matou.aar \
//	    github.com/matou-dao/backend/cmd/mobile
//
// See docs/spikes/2026-08-12-mobile-gomobile-android-spike.md for spike results.
package mobile

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/matou-dao/backend/internal/app"

	// Blank-import every other internal package so `gomobile bind` compiles the
	// full backend for the mobile target even if internal/app ever stops pulling
	// one in. internal/app itself is imported normally above.
	_ "github.com/matou-dao/backend/internal/anystore"
	_ "github.com/matou-dao/backend/internal/anysync"
	_ "github.com/matou-dao/backend/internal/api"
	_ "github.com/matou-dao/backend/internal/config"
	_ "github.com/matou-dao/backend/internal/contributions"
	_ "github.com/matou-dao/backend/internal/email"
	_ "github.com/matou-dao/backend/internal/identity"
	_ "github.com/matou-dao/backend/internal/keri"
	_ "github.com/matou-dao/backend/internal/logging"
	_ "github.com/matou-dao/backend/internal/notifications"
	_ "github.com/matou-dao/backend/internal/sync"
	_ "github.com/matou-dao/backend/internal/trust"
	_ "github.com/matou-dao/backend/internal/types"
)

// shutdownGrace bounds how long Stop waits for a graceful teardown before the
// call returns. Mirrors cmd/server's window.
const shutdownGrace = 10 * time.Second

// mu guards running so concurrent Start/Stop calls from the host stay coherent.
var (
	mu      sync.Mutex
	running *app.App
)

// Start boots the embedded backend on a loopback listener and returns the bound
// TCP port. It uses production semantics (bundled CORS, config fetched from
// configServerURL, per-launch apiToken enforced by TokenGuard) but binds to
// 127.0.0.1 on a random free port so the on-device WebView can reach it without
// exposing the API off-device.
//
// Start is idempotent: a second call while the backend is already running is a
// no-op that returns the existing port. dataDir, configServerURL and apiToken
// are all required; an empty argument is rejected without starting anything.
//
// The signature (string args, (int, error) return) is gobind-compatible so
// gomobile bind exposes it directly to Kotlin/Swift.
func Start(dataDir, configServerURL, apiToken string) (int, error) {
	return StartWithEncryptionKey(dataDir, configServerURL, apiToken, "")
}

// StartWithEncryptionKey is Start plus an at-rest encryption key for the on-disk
// identity (issue #117). identityEncryptionKey is opaque key material the host
// reads from the OS trust root (Android Keystore / iOS Keychain) — the same
// trust root SecureStorage uses — so {dataDir}/identity.json is never written
// with the mnemonic in plaintext. An empty key preserves the legacy plaintext
// format, so a host that has not yet been wired keeps working unchanged.
//
// The gobind-compatible signature lets gomobile bind expose it to Kotlin/Swift.
func StartWithEncryptionKey(dataDir, configServerURL, apiToken, identityEncryptionKey string) (int, error) {
	mu.Lock()
	defer mu.Unlock()

	// Idempotent: already running → report the existing port, start nothing new.
	if running != nil {
		return running.Port(), nil
	}

	switch {
	case dataDir == "":
		return 0, errors.New("mobile.Start: dataDir is required")
	case configServerURL == "":
		return 0, errors.New("mobile.Start: configServerURL is required")
	case apiToken == "":
		return 0, errors.New("mobile.Start: apiToken is required")
	}

	var encKey []byte
	if identityEncryptionKey != "" {
		encKey = []byte(identityEncryptionKey)
	}

	// Production Options built in-process — no environment, no log.Fatalf. app.Start
	// sets MATOU_CORS_MODE=bundled for prod, so bundled CORS applies without env.
	opts := app.Options{
		Env:                   "production",
		DataDir:               dataDir,
		Host:                  "127.0.0.1",
		Port:                  0, // random free port; the bound port is returned below
		APIToken:              apiToken,
		IdentityEncryptionKey: encKey,
		ConfigServerURL:       configServerURL,
		PrintBanner:           false, // an embedded backend stays silent
	}
	opts.AnysyncConfigPath = opts.DefaultAnysyncConfigPath()

	application, err := app.Start(context.Background(), opts)
	if err != nil {
		return 0, err
	}
	running = application
	return application.Port(), nil
}

// Stop gracefully shuts the embedded backend down and releases every resource
// Start opened. It is a no-op (returns nil) when the backend is not running, so
// the host can call it unconditionally. After Stop returns, Start may be called
// again to boot a fresh instance.
func Stop() error {
	mu.Lock()
	defer mu.Unlock()

	if running == nil {
		return nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
	defer cancel()
	err := running.Shutdown(ctx)
	running = nil // clear even on error so a later Start is not blocked
	return err
}
