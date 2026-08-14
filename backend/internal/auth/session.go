package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

// DefaultSessionTTL is the lifetime of a minted session token. It is kept short
// so that, combined with revoke-on-rotation, a compromised token has a bounded
// window of use.
const DefaultSessionTTL = 30 * time.Minute

type session struct {
	aid      string
	keysHash string
	expiry   time.Time
}

// SessionStore holds short-lived session tokens minted after a successful
// signed-challenge login. Tokens are opaque random strings mapped to a verified
// AID. Sessions carry the hash of the AID's signing keys at mint time so they
// can be invalidated when that AID's key state rotates (revoke-on-rotation).
type SessionStore struct {
	ttl     time.Duration
	mu      sync.Mutex
	byToken map[string]session
	byAID   map[string]map[string]struct{} // aid -> set of tokens
	now     func() time.Time
}

// NewSessionStore creates a SessionStore with the given TTL (0 uses
// DefaultSessionTTL).
func NewSessionStore(ttl time.Duration) *SessionStore {
	if ttl <= 0 {
		ttl = DefaultSessionTTL
	}
	return &SessionStore{
		ttl:     ttl,
		byToken: make(map[string]session),
		byAID:   make(map[string]map[string]struct{}),
		now:     time.Now,
	}
}

// KeysHash returns a stable hash of a set of qb64 signing keys, used to detect
// key-state rotation between a session's mint time and later observations.
func KeysHash(keys []string) string {
	sorted := append([]string(nil), keys...)
	sort.Strings(sorted)
	sum := sha256.Sum256([]byte(strings.Join(sorted, "|")))
	return hex.EncodeToString(sum[:])
}

// Mint creates a new session token bound to aid with the given keys hash and
// returns the token and its expiry.
func (s *SessionStore) Mint(aid, keysHash string) (token string, expiresAt time.Time, err error) {
	if aid == "" {
		return "", time.Time{}, fmt.Errorf("aid is required")
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", time.Time{}, fmt.Errorf("generate token: %w", err)
	}
	token = base64.RawURLEncoding.EncodeToString(buf)
	expiresAt = s.now().Add(s.ttl)

	s.mu.Lock()
	s.byToken[token] = session{aid: aid, keysHash: keysHash, expiry: expiresAt}
	if s.byAID[aid] == nil {
		s.byAID[aid] = make(map[string]struct{})
	}
	s.byAID[aid][token] = struct{}{}
	s.mu.Unlock()
	return token, expiresAt, nil
}

// Validate returns the AID bound to a token if the token exists and has not
// expired. Expired tokens are evicted on access.
func (s *SessionStore) Validate(token string) (aid string, ok bool) {
	if token == "" {
		return "", false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, found := s.byToken[token]
	if !found {
		return "", false
	}
	if s.now().After(sess.expiry) {
		s.deleteLocked(token, sess.aid)
		return "", false
	}
	return sess.aid, true
}

// RevokeAID invalidates every session for the given AID. Called when the AID's
// key state rotates so that tokens minted against the old key are rejected.
func (s *SessionStore) RevokeAID(aid string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	tokens := s.byAID[aid]
	n := len(tokens)
	for token := range tokens {
		delete(s.byToken, token)
	}
	delete(s.byAID, aid)
	return n
}

// RevokeAIDIfKeysChanged revokes all sessions for aid only if newKeysHash
// differs from the keys hash recorded on its active sessions. It returns the
// number of sessions revoked. This lets a rotation signal (a freshly synced
// KEL) invalidate stale sessions without forcing re-login on every KEL sync.
func (s *SessionStore) RevokeAIDIfKeysChanged(aid, newKeysHash string) int {
	s.mu.Lock()
	tokens := s.byAID[aid]
	changed := false
	for token := range tokens {
		if s.byToken[token].keysHash != newKeysHash {
			changed = true
			break
		}
	}
	s.mu.Unlock()
	if !changed {
		return 0
	}
	return s.RevokeAID(aid)
}

// deleteLocked removes a token from both indexes. Caller must hold s.mu.
func (s *SessionStore) deleteLocked(token, aid string) {
	delete(s.byToken, token)
	if set := s.byAID[aid]; set != nil {
		delete(set, token)
		if len(set) == 0 {
			delete(s.byAID, aid)
		}
	}
}
