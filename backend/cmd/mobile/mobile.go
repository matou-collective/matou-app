// Package mobile is the gomobile-bind entry point that embeds the full Matou
// backend in-process on a mobile device (Android/iOS).
//
// It exists for the Phase 0 mobile build spike (issue #23): its sole job is to
// force `gomobile bind` to compile and link the *entire* backend dependency
// graph — including on-device any-sync and quic-go v0.59.0 — for a mobile
// target, so the embedded-backend architecture can be validated before any
// real Phase 1 binding work begins.
//
// To that end it blank-imports every internal backend package. The Go compiler
// still compiles a blank-imported package and its full transitive dependency
// graph, so binding this one package is equivalent to binding the whole
// backend. The exported surface (see Version) is intentionally a placeholder;
// the real mobile API is Phase 1 work.
//
// Build (Android arm64, NDK required):
//
//	gomobile bind -target=android/arm64 -o matou.aar \
//	    github.com/matou-dao/backend/cmd/mobile
//
// See docs/spikes/2026-08-12-mobile-gomobile-android-spike.md for spike results.
package mobile

import (
	// Blank-import every internal package so `gomobile bind` compiles the full
	// backend (and its transitive deps: any-sync, quic-go, modernc sqlite, …)
	// for the mobile target. Keep this list in sync with internal/.
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

// Version reports the embedded-backend binding version.
//
// It is a placeholder exported symbol that gives `gomobile bind` a bindable
// surface to generate against; the real binding API (identity, sync, org
// operations) is Phase 1 work and out of scope for the spike.
func Version() string {
	return "matou-mobile-spike-0"
}
