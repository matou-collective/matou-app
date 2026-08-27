package auth

import (
	"errors"
	"testing"
	"time"
)

func TestChallengeSingleUse(t *testing.T) {
	cs := NewChallengeStore(time.Minute)
	nonce, _, err := cs.Issue("Ealice")
	if err != nil {
		t.Fatal(err)
	}
	if !cs.Valid("Ealice", nonce) {
		t.Fatal("Valid should report an outstanding challenge")
	}
	if !cs.Consume("Ealice", nonce) {
		t.Fatal("first consume should succeed")
	}
	if cs.Consume("Ealice", nonce) {
		t.Fatal("second consume of same challenge must fail (replay)")
	}
	if cs.Valid("Ealice", nonce) {
		t.Fatal("consumed challenge must no longer be valid")
	}
}

// A wrong guess must NOT evict the legitimate outstanding challenge — otherwise
// anyone looping the public endpoints could lock a user out of logging in.
func TestChallengeMismatchDoesNotEvict(t *testing.T) {
	cs := NewChallengeStore(time.Minute)
	nonce, _, _ := cs.Issue("Ealice")
	if cs.Consume("Ealice", "wrong") {
		t.Fatal("wrong nonce must fail")
	}
	if cs.Consume("Ebob", nonce) {
		t.Fatal("nonce is bound to the issuing AID")
	}
	if !cs.Consume("Ealice", nonce) {
		t.Fatal("legitimate challenge must survive failed attempts by others")
	}
}

// Two clients on the same AID (or a retry) each hold their own challenge.
func TestChallengeMultipleOutstandingPerAID(t *testing.T) {
	cs := NewChallengeStore(time.Minute)
	n1, _, _ := cs.Issue("Ealice")
	n2, _, _ := cs.Issue("Ealice")
	if n1 == n2 {
		t.Fatal("nonces must be unique")
	}
	if !cs.Consume("Ealice", n2) {
		t.Fatal("second challenge should be consumable")
	}
	if !cs.Consume("Ealice", n1) {
		t.Fatal("first challenge must not have been replaced by the second")
	}
}

func TestChallengeExpiry(t *testing.T) {
	cs := NewChallengeStore(time.Minute)
	base := time.Unix(1_000_000, 0)
	cs.now = func() time.Time { return base }
	nonce, _, _ := cs.Issue("Ealice")
	cs.now = func() time.Time { return base.Add(2 * time.Minute) }
	if cs.Consume("Ealice", nonce) {
		t.Fatal("expired challenge must be rejected")
	}
	if cs.Len() != 0 {
		t.Fatal("expired challenge should be evicted on access")
	}
}

func TestChallengeCapSweepsExpiredThenRefuses(t *testing.T) {
	cs := NewChallengeStore(time.Minute)
	cs.SetMax(3)
	base := time.Unix(1_000_000, 0)
	cs.now = func() time.Time { return base }
	for i := 0; i < 3; i++ {
		if _, _, err := cs.Issue("Ealice"); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err := cs.Issue("Ealice"); !errors.Is(err, ErrChallengeStoreFull) {
		t.Fatalf("expected ErrChallengeStoreFull at cap, got %v", err)
	}
	// Once the old ones expire the cap frees up.
	cs.now = func() time.Time { return base.Add(2 * time.Minute) }
	if _, _, err := cs.Issue("Ealice"); err != nil {
		t.Fatalf("expected issue to succeed after sweep, got %v", err)
	}
	if cs.Len() != 1 {
		t.Fatalf("expected 1 outstanding after sweep, got %d", cs.Len())
	}
}

func TestSessionMintValidateExpiry(t *testing.T) {
	ss := NewSessionStore(time.Minute)
	base := time.Unix(2_000_000, 0)
	ss.now = func() time.Time { return base }
	token, _, err := ss.Mint("Ealice", KeysHash([]string{"Dk1"}))
	if err != nil {
		t.Fatal(err)
	}
	aid, ok := ss.Validate(token)
	if !ok || aid != "Ealice" {
		t.Fatalf("expected valid session for Ealice, got %q ok=%v", aid, ok)
	}
	ss.now = func() time.Time { return base.Add(2 * time.Minute) }
	if _, ok := ss.Validate(token); ok {
		t.Fatal("expired session must be rejected")
	}
}

func TestSessionRevokeAID(t *testing.T) {
	ss := NewSessionStore(time.Hour)
	t1, _, _ := ss.Mint("Ealice", "h1")
	t2, _, _ := ss.Mint("Ealice", "h1")
	tb, _, _ := ss.Mint("Ebob", "h9")
	if n := ss.RevokeAID("Ealice"); n != 2 {
		t.Fatalf("expected 2 revoked, got %d", n)
	}
	if _, ok := ss.Validate(t1); ok {
		t.Fatal("t1 should be revoked")
	}
	if _, ok := ss.Validate(t2); ok {
		t.Fatal("t2 should be revoked")
	}
	if _, ok := ss.Validate(tb); !ok {
		t.Fatal("bob's session must be untouched")
	}
}

func TestSessionRevokeOnKeyChange(t *testing.T) {
	ss := NewSessionStore(time.Hour)
	token, _, _ := ss.Mint("Ealice", KeysHash([]string{"DoldKey"}))

	// Same keys → no revocation.
	if n := ss.RevokeAIDIfKeysChanged("Ealice", KeysHash([]string{"DoldKey"})); n != 0 {
		t.Fatalf("unchanged keys should not revoke, got %d", n)
	}
	if _, ok := ss.Validate(token); !ok {
		t.Fatal("session should survive an unchanged-key signal")
	}

	// Rotated keys → revoke.
	if n := ss.RevokeAIDIfKeysChanged("Ealice", KeysHash([]string{"DnewKey"})); n != 1 {
		t.Fatalf("rotated keys should revoke 1, got %d", n)
	}
	if _, ok := ss.Validate(token); ok {
		t.Fatal("session must be revoked after rotation")
	}
}

func TestSessionPerAIDCapEvictsOldest(t *testing.T) {
	ss := NewSessionStore(time.Hour)
	ss.SetMax(100, 2)
	base := time.Unix(3_000_000, 0)
	tick := 0
	ss.now = func() time.Time { tick++; return base.Add(time.Duration(tick) * time.Second) }
	t1, _, _ := ss.Mint("Ealice", "h")
	t2, _, _ := ss.Mint("Ealice", "h")
	t3, _, _ := ss.Mint("Ealice", "h")
	if _, ok := ss.Validate(t1); ok {
		t.Fatal("oldest session should have been evicted by the per-AID cap")
	}
	for _, tok := range []string{t2, t3} {
		if _, ok := ss.Validate(tok); !ok {
			t.Fatal("newer sessions must survive")
		}
	}
}

func TestSessionTotalCapSweepsThenRefuses(t *testing.T) {
	ss := NewSessionStore(time.Minute)
	ss.SetMax(2, 10)
	base := time.Unix(3_000_000, 0)
	ss.now = func() time.Time { return base }
	if _, _, err := ss.Mint("Ea", "h"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := ss.Mint("Eb", "h"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := ss.Mint("Ec", "h"); !errors.Is(err, ErrSessionStoreFull) {
		t.Fatalf("expected ErrSessionStoreFull, got %v", err)
	}
	ss.now = func() time.Time { return base.Add(2 * time.Minute) }
	if _, _, err := ss.Mint("Ec", "h"); err != nil {
		t.Fatalf("expected mint after expired sweep, got %v", err)
	}
	if ss.Len() != 1 {
		t.Fatalf("expected 1 live session after sweep, got %d", ss.Len())
	}
}
