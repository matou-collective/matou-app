package auth

import (
	"context"
	"crypto/ed25519"
	"errors"
	"testing"
	"time"
)

// newTestVerifier wires a verifier with a static resolver holding aid's key.
func newTestVerifier(aid string, pub ed25519.PublicKey) (*Verifier, *StaticKeyStateResolver) {
	res := NewStaticKeyStateResolver()
	res.Set(aid, []string{encodeVerferD(pub)})
	return NewVerifier(res, NewChallengeStore(time.Minute), NewSessionStore(time.Hour)), res
}

// signLogin produces the signature a well-behaved client sends: over the
// domain-separated message, not the bare nonce.
func signLogin(priv ed25519.PrivateKey, aid, nonce string) string {
	return encodeSig0B(ed25519.Sign(priv, SignedMessage(aid, nonce)))
}

func TestSignedMessageDomainSeparation(t *testing.T) {
	got := string(SignedMessage("Ealice", "nonce123"))
	if got != "matou-auth:Ealice:nonce123" {
		t.Fatalf("unexpected signed message %q", got)
	}
}

func TestLoginHappyPath(t *testing.T) {
	aid := "Ealice"
	pub, priv, _ := ed25519.GenerateKey(nil)
	v, _ := newTestVerifier(aid, pub)

	nonce, _, err := v.Challenge(aid)
	if err != nil {
		t.Fatal(err)
	}
	token, _, err := v.Login(context.Background(), aid, nonce, signLogin(priv, aid, nonce))
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	gotAID, ok := v.Sessions.Validate(token)
	if !ok || gotAID != aid {
		t.Fatalf("expected session for %s, got %q ok=%v", aid, gotAID, ok)
	}
}

// A signature over the bare nonce (no domain prefix) or over another AID's
// message must be refused.
func TestLoginRejectsUndomainedOrForeignSignature(t *testing.T) {
	aid := "Ealice"
	pub, priv, _ := ed25519.GenerateKey(nil)
	v, _ := newTestVerifier(aid, pub)

	nonce, _, _ := v.Challenge(aid)
	bare := encodeSig0B(ed25519.Sign(priv, []byte(nonce)))
	if _, _, err := v.Login(context.Background(), aid, nonce, bare); !errors.Is(err, ErrSignature) {
		t.Fatalf("bare-nonce signature must fail with ErrSignature, got %v", err)
	}
	// Challenge is still there after a failed signature? No — it was consumed
	// once key state was in hand. Re-issue for the next check.
	nonce, _, _ = v.Challenge(aid)
	foreign := signLogin(priv, "Emallory", nonce)
	if _, _, err := v.Login(context.Background(), aid, nonce, foreign); !errors.Is(err, ErrSignature) {
		t.Fatalf("signature over another AID's message must fail, got %v", err)
	}
}

func TestLoginRejectsBadSignature(t *testing.T) {
	aid := "Ealice"
	pub, _, _ := ed25519.GenerateKey(nil)
	_, wrongPriv, _ := ed25519.GenerateKey(nil) // attacker key, not aid's key
	v, _ := newTestVerifier(aid, pub)

	nonce, _, _ := v.Challenge(aid)
	_, _, err := v.Login(context.Background(), aid, nonce, signLogin(wrongPriv, aid, nonce))
	if !errors.Is(err, ErrSignature) {
		t.Fatalf("expected ErrSignature, got %v", err)
	}
}

func TestLoginRejectsReplay(t *testing.T) {
	aid := "Ealice"
	pub, priv, _ := ed25519.GenerateKey(nil)
	v, _ := newTestVerifier(aid, pub)

	nonce, _, _ := v.Challenge(aid)
	sig := signLogin(priv, aid, nonce)

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
	if _, _, err := v.Login(context.Background(), aid, nonce, signLogin(priv, aid, nonce)); !errors.Is(err, ErrKeyState) {
		t.Fatalf("expected ErrKeyState, got %v", err)
	}
	// A resolver failure must not burn the challenge: the client can retry
	// once the resolver is back.
	if !v.Challenges.Valid(aid, nonce) {
		t.Fatal("challenge must survive a key-state resolution failure")
	}
}

// A multisig group AID resolves to several keys; one member's signature must
// not mint a session for the group.
func TestLoginRejectsMultiKeyAID(t *testing.T) {
	aid := "Egroup"
	pub1, priv1, _ := ed25519.GenerateKey(nil)
	pub2, _, _ := ed25519.GenerateKey(nil)
	res := NewStaticKeyStateResolver()
	res.Set(aid, []string{encodeVerferD(pub1), encodeVerferD(pub2)})
	v := NewVerifier(res, NewChallengeStore(time.Minute), NewSessionStore(time.Hour))

	nonce, _, _ := v.Challenge(aid)
	if _, _, err := v.Login(context.Background(), aid, nonce, signLogin(priv1, aid, nonce)); !errors.Is(err, ErrUnsupportedKeyState) {
		t.Fatalf("expected ErrUnsupportedKeyState, got %v", err)
	}
}

func TestOnRotationRevokesSessions(t *testing.T) {
	aid := "Ealice"
	pub, priv, _ := ed25519.GenerateKey(nil)
	v, res := newTestVerifier(aid, pub)

	nonce, _, _ := v.Challenge(aid)
	token, _, _ := v.Login(context.Background(), aid, nonce, signLogin(priv, aid, nonce))

	// Key state unchanged at the resolver → session survives.
	v.OnRotation(context.Background(), aid)
	if _, ok := v.Sessions.Validate(token); !ok {
		t.Fatal("session should survive a non-rotation signal")
	}

	// Resolver now reports a new key → session revoked.
	newPub, _, _ := ed25519.GenerateKey(nil)
	res.Set(aid, []string{encodeVerferD(newPub)})
	v.OnRotation(context.Background(), aid)
	if _, ok := v.Sessions.Validate(token); ok {
		t.Fatal("session must be revoked after key rotation")
	}

	// An unknown AID (resolver error) is a no-op, never a panic.
	v.OnRotation(context.Background(), "Enobody")
}

// cachingResolver mimics KERIAResolver's cache: it keeps serving the keys it
// first returned until Invalidate is called, then serves the current keys.
type cachingResolver struct {
	live    *StaticKeyStateResolver
	cached  map[string][]string
	fetches int
}

func newCachingResolver() *cachingResolver {
	return &cachingResolver{live: NewStaticKeyStateResolver(), cached: map[string][]string{}}
}

func (r *cachingResolver) CurrentKeys(ctx context.Context, aid string) ([]string, error) {
	if keys, ok := r.cached[aid]; ok {
		return keys, nil
	}
	r.fetches++
	keys, err := r.live.CurrentKeys(ctx, aid)
	if err != nil {
		return nil, err
	}
	r.cached[aid] = keys
	return keys, nil
}

func (r *cachingResolver) Invalidate(aid string) { delete(r.cached, aid) }

// After the AID rotates, a login signed with the NEW key must succeed even
// though the resolver's cache still holds the pre-rotation key: the verifier
// has to drop the cached state and re-resolve before rejecting the signature.
// This is the multisig steward-join path — the member rotates its personal AID
// between round 1 and round 2, reloads, and would otherwise be locked out for
// the whole cache TTL (issue seen in e2e "register and approve a second member").
func TestLoginAfterRotationRefreshesStaleKeyState(t *testing.T) {
	aid := "Ealice"
	res := newCachingResolver()
	oldPub, oldPriv, _ := ed25519.GenerateKey(nil)
	res.live.Set(aid, []string{encodeVerferD(oldPub)})
	v := NewVerifier(res, NewChallengeStore(time.Minute), NewSessionStore(time.Hour))

	// First login warms the cache with the old key.
	nonce, _, _ := v.Challenge(aid)
	if _, _, err := v.Login(context.Background(), aid, nonce, signLogin(oldPriv, aid, nonce)); err != nil {
		t.Fatalf("pre-rotation login: %v", err)
	}

	// Rotate: the authoritative key state changes, the cache does not.
	newPub, newPriv, _ := ed25519.GenerateKey(nil)
	res.live.Set(aid, []string{encodeVerferD(newPub)})

	nonce, _, _ = v.Challenge(aid)
	token, _, err := v.Login(context.Background(), aid, nonce, signLogin(newPriv, aid, nonce))
	if err != nil {
		t.Fatalf("post-rotation login must refresh stale key state, got %v", err)
	}
	if _, ok := v.Sessions.Validate(token); !ok {
		t.Fatal("expected a valid session after post-rotation login")
	}
	if res.fetches != 2 {
		t.Fatalf("expected exactly one re-fetch after the stale miss, fetches=%d", res.fetches)
	}

	// A genuinely bad signature still fails — and only costs one re-fetch.
	_, wrongPriv, _ := ed25519.GenerateKey(nil)
	nonce, _, _ = v.Challenge(aid)
	if _, _, err := v.Login(context.Background(), aid, nonce, signLogin(wrongPriv, aid, nonce)); !errors.Is(err, ErrSignature) {
		t.Fatalf("bad signature must still fail with ErrSignature, got %v", err)
	}
	if res.fetches != 3 {
		t.Fatalf("bad signature should trigger exactly one re-fetch, fetches=%d", res.fetches)
	}
}
