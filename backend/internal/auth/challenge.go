package auth

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"sync"
	"time"
)

// DefaultChallengeTTL is how long an issued challenge remains valid.
const DefaultChallengeTTL = 2 * time.Minute

// DefaultMaxChallenges caps the number of outstanding challenges held in
// memory. Challenge issuance is unauthenticated, so without a cap a client
// looping the endpoint could grow the store without bound.
const DefaultMaxChallenges = 10_000

// ErrChallengeStoreFull is returned by Issue when the store is at capacity
// with no expired entries left to evict.
var ErrChallengeStoreFull = fmt.Errorf("too many outstanding challenges")

type challengeEntry struct {
	aid    string
	expiry time.Time
}

// ChallengeStore issues single-use, time-bounded login challenges. A challenge
// is the random nonce the client must sign to prove control of the AID's
// current signing key.
//
// Challenges are keyed by nonce, not by AID: several may be outstanding for one
// AID at a time (two clients on the same identity, or a retry), and issuing a
// new one never disturbs the others. A challenge is removed only when it is
// successfully consumed or has expired — a mismatched guess does not evict it,
// so an attacker looping the public endpoints cannot lock a legitimate client
// out of its own pending challenge. Replay is still impossible: consuming a
// nonce deletes it.
type ChallengeStore struct {
	ttl time.Duration
	max int
	mu  sync.Mutex
	m   map[string]challengeEntry
	now func() time.Time
}

// NewChallengeStore creates a ChallengeStore with the given TTL (0 uses
// DefaultChallengeTTL) and DefaultMaxChallenges capacity.
func NewChallengeStore(ttl time.Duration) *ChallengeStore {
	if ttl <= 0 {
		ttl = DefaultChallengeTTL
	}
	return &ChallengeStore{
		ttl: ttl,
		max: DefaultMaxChallenges,
		m:   make(map[string]challengeEntry),
		now: time.Now,
	}
}

// SetMax overrides the outstanding-challenge cap (tests).
func (s *ChallengeStore) SetMax(n int) {
	s.mu.Lock()
	s.max = n
	s.mu.Unlock()
}

// Issue generates a fresh challenge bound to the AID and returns the nonce and
// its expiry time.
func (s *ChallengeStore) Issue(aid string) (nonce string, expiresAt time.Time, err error) {
	if aid == "" {
		return "", time.Time{}, fmt.Errorf("aid is required")
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", time.Time{}, fmt.Errorf("generate challenge: %w", err)
	}
	nonce = base64.RawURLEncoding.EncodeToString(buf)
	now := s.now()
	expiresAt = now.Add(s.ttl)

	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.m) >= s.max {
		s.sweepLocked(now)
		if len(s.m) >= s.max {
			return "", time.Time{}, ErrChallengeStoreFull
		}
	}
	s.m[nonce] = challengeEntry{aid: aid, expiry: expiresAt}
	return nonce, expiresAt, nil
}

// Consume validates that nonce is an outstanding, unexpired challenge issued to
// aid and removes it (single use). It returns true only on a successful match.
// A nonce that was issued to a different AID is left untouched (that AID's
// client can still use it); an expired one is evicted.
func (s *ChallengeStore) Consume(aid, nonce string) bool {
	if aid == "" || nonce == "" {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.m[nonce]
	if !ok {
		return false
	}
	if s.now().After(entry.expiry) {
		delete(s.m, nonce)
		return false
	}
	if entry.aid != aid {
		return false
	}
	delete(s.m, nonce)
	return true
}

// Valid reports whether nonce is an outstanding, unexpired challenge issued to
// aid, without consuming it. Login uses it to reject a bogus challenge before
// spending a key-state lookup on it.
func (s *ChallengeStore) Valid(aid, nonce string) bool {
	if aid == "" || nonce == "" {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.m[nonce]
	return ok && entry.aid == aid && !s.now().After(entry.expiry)
}

// Len reports the number of outstanding (not yet swept) challenges.
func (s *ChallengeStore) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.m)
}

// sweepLocked drops expired challenges. Caller must hold s.mu.
func (s *ChallengeStore) sweepLocked(now time.Time) {
	for nonce, entry := range s.m {
		if now.After(entry.expiry) {
			delete(s.m, nonce)
		}
	}
}
