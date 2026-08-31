package pushrelay

import (
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

// Re-registering a token under a new AID moves it (device handed over).
func TestStoreTokenRebind(t *testing.T) {
	s, _ := NewStore("", time.Hour)
	_ = s.Register("Ealice", "tok1", "android")
	_ = s.Register("Ebob", "tok1", "android")
	if got := s.TokensForAID("Ealice"); len(got) != 0 {
		t.Fatalf("old AID should no longer hold the rebound token, got %+v", got)
	}
	if got := s.TokensForAID("Ebob"); len(got) != 1 {
		t.Fatalf("new AID should hold the token, got %+v", got)
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
	// Registering is an explicit opt-in and clears the flag.
	_ = s.Register("Ealice", "tok1", "android")
	if s.IsOptedOut("Ealice") {
		t.Fatal("register must clear opt-out")
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
