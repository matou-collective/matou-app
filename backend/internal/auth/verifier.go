package auth

import (
	"context"
	"errors"
	"log"
	"time"
)

// Sentinel errors returned by Verifier so callers can map them to HTTP codes.
var (
	// ErrChallenge means the presented challenge was unknown, already used or
	// expired.
	ErrChallenge = errors.New("invalid or expired challenge")
	// ErrKeyState means the AID's current key state could not be resolved.
	ErrKeyState = errors.New("could not resolve key state")
	// ErrUnsupportedKeyState means the AID's key state was resolved but is not
	// a single-key, threshold-1 AID — multisig groups cannot log in directly
	// (a single member must not be able to mint a group session).
	ErrUnsupportedKeyState = errors.New("only single-key AIDs can sign in; multisig group AIDs are not supported")
	// ErrSignature means the challenge signature did not verify against any of
	// the AID's current keys.
	ErrSignature = errors.New("signature verification failed")
)

// SignedMessagePrefix domain-separates the login challenge: the client signs
// SignedMessage(aid, nonce), not the bare nonce, so a signature obtained for
// another purpose (or for another AID) can never be replayed as a login proof,
// and a login signature cannot be repurposed elsewhere. Both the signer
// (frontend KERIClient.signChallenge) and this verifier must agree on it.
const SignedMessagePrefix = "matou-auth:"

// SignedMessage returns the exact bytes the client must sign for a login
// challenge: "matou-auth:<aid>:<nonce>".
func SignedMessage(aid, nonce string) []byte {
	return []byte(SignedMessagePrefix + aid + ":" + nonce)
}

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

// Login consumes the AID's challenge, verifies signature (over
// SignedMessage(aid, challenge)) against the AID's current signing key —
// resolved authoritatively, never trusting a client-supplied key — and mints a
// short-lived session token on success.
func (v *Verifier) Login(ctx context.Context, aid, challenge, signature string) (token string, expiresAt time.Time, err error) {
	// Reject an unknown challenge before touching the resolver (no network
	// round-trip for garbage), but only consume it once key state is in hand so
	// a transient resolver failure (503) does not burn the client's nonce.
	if !v.Challenges.Valid(aid, challenge) {
		return "", time.Time{}, ErrChallenge
	}
	keys, err := v.Resolver.CurrentKeys(ctx, aid)
	if err != nil {
		if errors.Is(err, ErrUnsupportedKeyState) {
			return "", time.Time{}, err
		}
		return "", time.Time{}, ErrKeyState
	}
	if len(keys) == 0 {
		return "", time.Time{}, ErrKeyState
	}
	if len(keys) != 1 {
		return "", time.Time{}, ErrUnsupportedKeyState
	}
	if !v.Challenges.Consume(aid, challenge) {
		return "", time.Time{}, ErrChallenge
	}
	ok, verr := VerifySignature(keys[0], SignedMessage(aid, challenge), signature)
	if verr != nil || !ok {
		// The resolver may be serving a cached, pre-rotation key: a member that
		// rotated its personal AID (e.g. between multisig rounds 1 and 2) signs
		// with a key the cache has not seen yet, and nothing else invalidates
		// the cache until that AID syncs its own KEL over an authenticated
		// session — which it cannot get while login keeps failing. Drop the
		// cached state, re-resolve once from the authoritative source and
		// re-verify before rejecting. A genuinely bad signature still fails; it
		// just costs one extra key-state fetch, bounded by the login rate limit.
		keys, err = v.refreshedKeys(ctx, aid, keys)
		if err != nil {
			return "", time.Time{}, ErrSignature
		}
		ok, verr = VerifySignature(keys[0], SignedMessage(aid, challenge), signature)
		if verr != nil || !ok {
			return "", time.Time{}, ErrSignature
		}
	}
	return v.Sessions.Mint(aid, KeysHash(keys))
}

// refreshedKeys invalidates any cached key state for aid and re-resolves it.
// It returns the freshly resolved single key, or an error when the resolver
// cannot invalidate, cannot re-resolve, the state is not single-key, or the
// key is unchanged (so the caller does not verify the same key twice).
func (v *Verifier) refreshedKeys(ctx context.Context, aid string, stale []string) ([]string, error) {
	inv, ok := v.Resolver.(interface{ Invalidate(string) })
	if !ok {
		return nil, errors.New("resolver does not cache")
	}
	inv.Invalidate(aid)
	keys, err := v.Resolver.CurrentKeys(ctx, aid)
	if err != nil {
		return nil, err
	}
	if len(keys) != 1 {
		return nil, ErrUnsupportedKeyState
	}
	if len(stale) == 1 && stale[0] == keys[0] {
		return nil, errors.New("key state unchanged")
	}
	return keys, nil
}

// OnRotation is a rotation signal for aid: it drops any cached key state,
// re-resolves the AID's current keys from the authoritative resolver, and
// revokes the AID's sessions if those keys differ from the ones the sessions
// were minted against. Keys are never taken from the caller — a signal can at
// most trigger a re-fetch, so it cannot be used to log an AID out unless its
// key state really changed. Best-effort: resolver failures are logged and
// ignored so the sync path that calls this is never broken.
func (v *Verifier) OnRotation(ctx context.Context, aid string) {
	if aid == "" {
		return
	}
	if inv, ok := v.Resolver.(interface{ Invalidate(string) }); ok {
		inv.Invalidate(aid)
	}
	keys, err := v.Resolver.CurrentKeys(ctx, aid)
	if err != nil || len(keys) == 0 {
		log.Printf("[Auth] rotation check for %s: could not re-resolve key state: %v", aid, err)
		return
	}
	if n := v.Sessions.RevokeAIDIfKeysChanged(aid, KeysHash(keys)); n > 0 {
		log.Printf("[Auth] key rotation observed for %s: revoked %d session(s)", aid, n)
	}
}
