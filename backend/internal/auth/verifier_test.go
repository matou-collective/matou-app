package auth

import (
	"context"
	"crypto/ed25519"
	"errors"
	"testing"
	"time"
)

// newTestVerifier wires a verifier with a static resolver holding aid's key.
func newTestVerifier(aid string, pub ed25519.PublicKey) *Verifier {
	res := NewStaticKeyStateResolver()
	res.Set(aid, []string{encodeVerferD(pub)})
	return NewVerifier(res, NewChallengeStore(time.Minute), NewSessionStore(time.Hour))
}

func TestLoginHappyPath(t *testing.T) {
	aid := "Ealice"
	pub, priv, _ := ed25519.GenerateKey(nil)
	v := newTestVerifier(aid, pub)

	nonce, _, err := v.Challenge(aid)
	if err != nil {
		t.Fatal(err)
	}
	sig := encodeSig0B(ed25519.Sign(priv, []byte(nonce)))

	token, _, err := v.Login(context.Background(), aid, nonce, sig)
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	gotAID, ok := v.Sessions.Validate(token)
	if !ok || gotAID != aid {
		t.Fatalf("expected session for %s, got %q ok=%v", aid, gotAID, ok)
	}
}

func TestLoginRejectsBadSignature(t *testing.T) {
	aid := "Ealice"
	pub, _, _ := ed25519.GenerateKey(nil)
	_, wrongPriv, _ := ed25519.GenerateKey(nil) // attacker key, not aid's key
	v := newTestVerifier(aid, pub)

	nonce, _, _ := v.Challenge(aid)
	sig := encodeSig0B(ed25519.Sign(wrongPriv, []byte(nonce)))

	_, _, err := v.Login(context.Background(), aid, nonce, sig)
	if !errors.Is(err, ErrSignature) {
		t.Fatalf("expected ErrSignature, got %v", err)
	}
}

func TestLoginRejectsReplay(t *testing.T) {
	aid := "Ealice"
	pub, priv, _ := ed25519.GenerateKey(nil)
	v := newTestVerifier(aid, pub)

	nonce, _, _ := v.Challenge(aid)
	sig := encodeSig0B(ed25519.Sign(priv, []byte(nonce)))

	if _, _, err := v.Login(context.Background(), aid, nonce, sig); err != nil {
		t.Fatalf("first login should succeed: %v", err)
	}
	// Replaying the same challenge+signature must fail — the challenge is spent.
	if _, _, err := v.Login(context.Background(), aid, nonce, sig); !errors.Is(err, ErrChallenge) {
		t.Fatalf("expected ErrChallenge on replay, got %v", err)
	}
}

func TestLoginRejectsUnknownKeyState(t *testing.T) {
	aid := "Eghost"
	_, priv, _ := ed25519.GenerateKey(nil)
	// Resolver has no key state for this AID.
	v := NewVerifier(NewStaticKeyStateResolver(), NewChallengeStore(time.Minute), NewSessionStore(time.Hour))

	nonce, _, _ := v.Challenge(aid)
	sig := encodeSig0B(ed25519.Sign(priv, []byte(nonce)))

	if _, _, err := v.Login(context.Background(), aid, nonce, sig); !errors.Is(err, ErrKeyState) {
		t.Fatalf("expected ErrKeyState, got %v", err)
	}
}

func TestOnRotationRevokesSessions(t *testing.T) {
	aid := "Ealice"
	pub, priv, _ := ed25519.GenerateKey(nil)
	v := newTestVerifier(aid, pub)

	nonce, _, _ := v.Challenge(aid)
	sig := encodeSig0B(ed25519.Sign(priv, []byte(nonce)))
	token, _, _ := v.Login(context.Background(), aid, nonce, sig)

	// Same key set → session survives.
	v.OnRotation(aid, []string{encodeVerferD(pub)})
	if _, ok := v.Sessions.Validate(token); !ok {
		t.Fatal("session should survive a non-rotation KEL sync")
	}

	// New key set → session revoked.
	newPub, _, _ := ed25519.GenerateKey(nil)
	v.OnRotation(aid, []string{encodeVerferD(newPub)})
	if _, ok := v.Sessions.Validate(token); ok {
		t.Fatal("session must be revoked after key rotation")
	}
}
