package pushrelay

import (
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func TestStoreRegisterDeregister(t *testing.T) {
	s, err := NewStore("", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Register("Ealice", "tok1", "android"); err != nil {
		t.Fatal(err)
	}
	if got := s.TokensForAID("Ealice"); len(got) != 1 || got[0].Token != "tok1" {
		t.Fatalf("expected tok1 for Ealice, got %+v", got)
	}
	if err := s.Deregister("Ealice", "tok1"); err != nil {
		t.Fatal(err)
	}
	if got := s.TokensForAID("Ealice"); len(got) != 0 {
		t.Fatalf("expected no tokens after deregister, got %+v", got)
	}
}

// A token can only be dropped by the AID that owns it.
func TestStoreDeregisterWrongAID(t *testing.T) {
	s, _ := NewStore("", time.Hour)
	_ = s.Register("Ealice", "tok1", "android")
	_ = s.Deregister("Emallory", "tok1")
	if got := s.TokensForAID("Ealice"); len(got) != 1 {
		t.Fatalf("another AID must not deregister Ealice's token, got %+v", got)
	}
}

// A token bound to one AID cannot be claimed by another: rebinding would let a
// caller that learns a device token cut its owner off from push and steer its
// own channel ids onto that device.
func TestStoreRegisterRefusesTokenOwnedByAnotherAID(t *testing.T) {
	s, _ := NewStore("", time.Hour)
	_ = s.Register("Ealice", "tok1", "android")
	if err := s.Register("Ebob", "tok1", "android"); !errors.Is(err, ErrTokenOwnedByOtherAID) {
		t.Fatalf("expected ErrTokenOwnedByOtherAID, got %v", err)
	}
	if got := s.TokensForAID("Ealice"); len(got) != 1 || got[0].Token != "tok1" {
		t.Fatalf("owner must keep the token, got %+v", got)
	}
	if got := s.TokensForAID("Ebob"); len(got) != 0 {
		t.Fatalf("claimant must not hold the token, got %+v", got)
	}
}

// Re-registering one's own token is a refresh, not a conflict (§7 re-registers
// on every FCM token rotation).
func TestStoreRegisterOwnTokenRefreshes(t *testing.T) {
	s, _ := NewStore("", time.Hour)
	now := time.Unix(1_000_000, 0)
	s.now = func() time.Time { return now }
	_ = s.Register("Ealice", "tok1", "android")
	now = now.Add(10 * time.Minute)
	if err := s.Register("Ealice", "tok1", "android"); err != nil {
		t.Fatalf("re-registering own token: %v", err)
	}
	got := s.TokensForAID("Ealice")
	if len(got) != 1 || !got[0].LastSeen.Equal(now) {
		t.Fatalf("expected refreshed last-seen, got %+v", got)
	}
}

// The handover path §7 mandates: the owner deregisters on logout, then the
// token is free for the next identity on that device.
func TestStoreRegisterAfterDeregisterAllowsHandover(t *testing.T) {
	s, _ := NewStore("", time.Hour)
	_ = s.Register("Ealice", "tok1", "android")
	_ = s.Deregister("Ealice", "tok1")
	if err := s.Register("Ebob", "tok1", "android"); err != nil {
		t.Fatalf("handover after deregister must succeed: %v", err)
	}
	if got := s.TokensForAID("Ebob"); len(got) != 1 {
		t.Fatalf("new owner should hold the token, got %+v", got)
	}
}

func TestStoreOptOut(t *testing.T) {
	s, _ := NewStore("", time.Hour)
	if s.IsOptedOut("Ealice") {
		t.Fatal("default must not be opted out")
	}
	_ = s.SetOptOut("Ealice", true)
	if !s.IsOptedOut("Ealice") {
		t.Fatal("expected opted out")
	}
	// Only an explicit opt-in clears the flag.
	_ = s.SetOptOut("Ealice", false)
	if s.IsOptedOut("Ealice") {
		t.Fatal("SetOptOut(false) must clear opt-out")
	}
}

// Registration must not resurrect push for a user who opted out: §7 re-registers
// on every FCM token rotation, which happens with no user action at all.
func TestStoreRegisterPreservesOptOut(t *testing.T) {
	s, _ := NewStore("", time.Hour)
	_ = s.SetOptOut("Ealice", true)
	if err := s.Register("Ealice", "tok1", "android"); err != nil {
		t.Fatal(err)
	}
	if !s.IsOptedOut("Ealice") {
		t.Fatal("register (e.g. FCM token rotation) must not clear opt-out")
	}
	// The token is still stored — the relay drops the push at send time.
	if got := s.TokensForAID("Ealice"); len(got) != 1 {
		t.Fatalf("token should still be registered, got %+v", got)
	}
}

func TestStorePruneToken(t *testing.T) {
	s, _ := NewStore("", time.Hour)
	_ = s.Register("Ealice", "tok1", "android")
	s.PruneToken("tok1")
	if s.Len() != 0 {
		t.Fatalf("expected token pruned, len=%d", s.Len())
	}
}

func TestStoreTTLExpiry(t *testing.T) {
	s, _ := NewStore("", time.Hour)
	now := time.Unix(1_000_000, 0)
	s.now = func() time.Time { return now }
	_ = s.Register("Ealice", "tok1", "android")

	// Not yet expired.
	now = now.Add(30 * time.Minute)
	if n := s.ExpireStale(); n != 0 {
		t.Fatalf("token within TTL must not expire, removed=%d", n)
	}
	// Past TTL.
	now = now.Add(2 * time.Hour)
	if n := s.ExpireStale(); n != 1 {
		t.Fatalf("expected 1 expired token, got %d", n)
	}
	if s.Len() != 0 {
		t.Fatalf("expired token should be gone, len=%d", s.Len())
	}
}

// Touch refreshes last-seen so an active device survives expiry.
func TestStoreTouchDefersExpiry(t *testing.T) {
	s, _ := NewStore("", time.Hour)
	now := time.Unix(1_000_000, 0)
	s.now = func() time.Time { return now }
	_ = s.Register("Ealice", "tok1", "android")

	now = now.Add(50 * time.Minute)
	s.Touch("tok1")
	now = now.Add(50 * time.Minute) // 100m since register, but only 50m since touch
	if n := s.ExpireStale(); n != 0 {
		t.Fatalf("touched token must not expire, removed=%d", n)
	}
}

func TestStorePersistence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tokens.json")
	s, err := NewStore(path, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	_ = s.Register("Ealice", "tok1", "android")
	_ = s.SetOptOut("Ebob", true)

	// Reload from disk.
	s2, err := NewStore(path, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if got := s2.TokensForAID("Ealice"); len(got) != 1 || got[0].Token != "tok1" {
		t.Fatalf("token not persisted, got %+v", got)
	}
	if !s2.IsOptedOut("Ebob") {
		t.Fatal("opt-out not persisted")
	}
}

func TestCoalescer(t *testing.T) {
	c := newCoalescer(time.Minute)
	now := time.Unix(1_000_000, 0)
	c.now = func() time.Time { return now }

	if !c.allow("Ealice", "chan1") {
		t.Fatal("first push must be allowed")
	}
	if c.allow("Ealice", "chan1") {
		t.Fatal("duplicate within window must be suppressed")
	}
	// A different channel is independent.
	if !c.allow("Ealice", "chan2") {
		t.Fatal("different channel must be allowed")
	}
	// After the window elapses it is allowed again.
	now = now.Add(2 * time.Minute)
	if !c.allow("Ealice", "chan1") {
		t.Fatal("push after window must be allowed")
	}
}

func TestCoalescerDisabled(t *testing.T) {
	c := newCoalescer(0)
	first := c.allow("Ealice", "chan1")
	second := c.allow("Ealice", "chan1")
	if !first || !second {
		t.Fatal("zero window disables coalescing")
	}
}
