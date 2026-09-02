package main

import "testing"

// The relay must refuse to start without a persistent token store: an
// in-memory store loses every device token on restart, and because the app only
// re-registers on permission grant or FCM token rotation (§7) affected users
// would silently stop receiving push.
func TestCheckStorePath(t *testing.T) {
	if err := checkStorePath("", false); err == nil {
		t.Fatal("an empty store path with FCM enabled must be fatal")
	}
	if err := checkStorePath("/var/lib/matou-push-relay/tokens.json", false); err != nil {
		t.Fatalf("a configured store path must be accepted: %v", err)
	}
	// Dry-runs dispatch nothing, so an in-memory store is harmless there.
	if err := checkStorePath("", true); err != nil {
		t.Fatalf("in-memory store must stay available when FCM is disabled: %v", err)
	}
}
