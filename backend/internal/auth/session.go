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

// DefaultMaxSessions caps the total number of live sessions held in memory;
// DefaultMaxSessionsPerAID caps how many one AID may hold (the oldest is
// evicted when a new one is minted past the cap).
const (
	DefaultMaxSessions       = 10_000
	DefaultMaxSessionsPerAID = 32
)

// ErrSessionStoreFull is returned by Mint when the store is at capacity with
// no expired sessions left to evict.
var ErrSessionStoreFull = fmt.Errorf("too many live sessions")

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
	ttl       time.Duration
	max       int
	maxPerAID int
	mu        sync.Mutex
	byToken   map[string]session
	byAID     map[string]map[string]struct{} // aid -> set of tokens
	now       func() time.Time
}

// NewSessionStore creates a SessionStore with the given TTL (0 uses
// DefaultSessionTTL) and default capacity caps.
func NewSessionStore(ttl time.Duration) *SessionStore {
	if ttl <= 0 {
		ttl = DefaultSessionTTL
	}
	return &SessionStore{
		ttl:       ttl,
		max:       DefaultMaxSessions,
		maxPerAID: DefaultMaxSessionsPerAID,
		byToken:   make(map[string]session),
		byAID:     make(map[string]map[string]struct{}),
		now:       time.Now,
	}
}

// SetMax overrides the total and per-AID session caps (tests).
func (s *SessionStore) SetMax(total, perAID int) {
	s.mu.Lock()
	s.max, s.maxPerAID = total, perAID
	s.mu.Unlock()
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
	now := s.now()
	expiresAt = now.Add(s.ttl)

	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.byToken) >= s.max {
		s.sweepLocked(now)
		if len(s.byToken) >= s.max {
			return "", time.Time{}, ErrSessionStoreFull
		}
	}
	// Per-AID cap: evict this AID's earliest-expiring session to make room.
	for len(s.byAID[aid]) >= s.maxPerAID {
		var oldest string
		var oldestExp time.Time
		for t := range s.byAID[aid] {
			if exp := s.byToken[t].expiry; oldest == "" || exp.Before(oldestExp) {
				oldest, oldestExp = t, exp
			}
		}
		s.deleteLocked(oldest, aid)
	}
	s.byToken[token] = session{aid: aid, keysHash: keysHash, expiry: expiresAt}
	if s.byAID[aid] == nil {
		s.byAID[aid] = make(map[string]struct{})
	}
	s.byAID[aid][token] = struct{}{}
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

// Len reports the number of sessions held (including not-yet-swept expired ones).
func (s *SessionStore) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.byToken)
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

// sweepLocked drops expired sessions. Caller must hold s.mu.
func (s *SessionStore) sweepLocked(now time.Time) {
	for token, sess := range s.byToken {
		if now.After(sess.expiry) {
			s.deleteLocked(token, sess.aid)
		}
	}
}
