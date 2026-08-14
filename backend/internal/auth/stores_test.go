package auth

import (
	"testing"
	"time"
)

func TestChallengeSingleUse(t *testing.T) {
	cs := NewChallengeStore(time.Minute)
	nonce, _, err := cs.Issue("Ealice")
	if err != nil {
		t.Fatal(err)
	}
	if !cs.Consume("Ealice", nonce) {
		t.Fatal("first consume should succeed")
	}
	if cs.Consume("Ealice", nonce) {
		t.Fatal("second consume of same challenge must fail (replay)")
	}
}

func TestChallengeWrongNonceAndAID(t *testing.T) {
	cs := NewChallengeStore(time.Minute)
	nonce, _, _ := cs.Issue("Ealice")
	if cs.Consume("Ealice", "wrong") {
		t.Fatal("wrong nonce must fail")
	}
	// A wrong guess consumes the challenge, so the real nonce is now gone too.
	if cs.Consume("Ealice", nonce) {
		t.Fatal("challenge should have been consumed by the failed attempt")
	}
	nonce2, _, _ := cs.Issue("Ealice")
	if cs.Consume("Ebob", nonce2) {
		t.Fatal("nonce is bound to the issuing AID")
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
