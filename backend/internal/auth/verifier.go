package auth

import (
	"context"
	"errors"
	"time"
)

// Sentinel errors returned by Verifier so callers can map them to HTTP codes.
var (
	// ErrChallenge means the presented challenge was unknown, already used or
	// expired.
	ErrChallenge = errors.New("invalid or expired challenge")
	// ErrKeyState means the AID's current key state could not be resolved.
	ErrKeyState = errors.New("could not resolve key state")
	// ErrSignature means the challenge signature did not verify against any of
	// the AID's current keys.
	ErrSignature = errors.New("signature verification failed")
)

// Verifier ties together challenge issuance, key-state resolution, signature
// verification and session minting for the signed-challenge login flow.
type Verifier struct {
	Challenges *ChallengeStore
	Sessions   *SessionStore
	Resolver   KeyStateResolver
}

// NewVerifier constructs a Verifier. If challenges or sessions are nil, stores
// with default TTLs are created.
func NewVerifier(resolver KeyStateResolver, challenges *ChallengeStore, sessions *SessionStore) *Verifier {
	if challenges == nil {
		challenges = NewChallengeStore(0)
	}
	if sessions == nil {
		sessions = NewSessionStore(0)
	}
	return &Verifier{Challenges: challenges, Sessions: sessions, Resolver: resolver}
}

// Challenge issues a fresh login challenge for the AID.
func (v *Verifier) Challenge(aid string) (nonce string, expiresAt time.Time, err error) {
	return v.Challenges.Issue(aid)
}

// Login consumes the AID's outstanding challenge, verifies signature against the
// AID's current signing keys (resolved authoritatively, never trusting a
// client-supplied key), and mints a short-lived session token on success.
func (v *Verifier) Login(ctx context.Context, aid, challenge, signature string) (token string, expiresAt time.Time, err error) {
	if !v.Challenges.Consume(aid, challenge) {
		return "", time.Time{}, ErrChallenge
	}
	keys, err := v.Resolver.CurrentKeys(ctx, aid)
	if err != nil || len(keys) == 0 {
		return "", time.Time{}, ErrKeyState
	}
	msg := []byte(challenge)
	for _, key := range keys {
		ok, verr := VerifySignature(key, msg, signature)
		if verr == nil && ok {
			return v.Sessions.Mint(aid, KeysHash(keys))
		}
	}
	return "", time.Time{}, ErrSignature
}

// OnRotation is a rotation signal: given an AID and its freshly observed current
// signing keys, it invalidates any resolver cache and revokes the AID's sessions
// if those keys changed since the sessions were minted. Best-effort — a nil/empty
// key set is a no-op — so it must never break the sync path that calls it.
func (v *Verifier) OnRotation(aid string, currentKeys []string) {
	if aid == "" || len(currentKeys) == 0 {
		return
	}
	if inv, ok := v.Resolver.(interface{ Invalidate(string) }); ok {
		inv.Invalidate(aid)
	}
	v.Sessions.RevokeAIDIfKeysChanged(aid, KeysHash(currentKeys))
}
