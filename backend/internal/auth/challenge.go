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

type challengeEntry struct {
	nonce  string
	expiry time.Time
}

// ChallengeStore issues single-use, time-bounded login challenges keyed by AID.
// A challenge is the random nonce the client must sign to prove control of the
// AID's current signing key. Consuming a challenge deletes it, so a captured
// challenge/signature pair cannot be replayed to mint a second session.
type ChallengeStore struct {
	ttl time.Duration
	mu  sync.Mutex
	m   map[string]challengeEntry
	now func() time.Time
}

// NewChallengeStore creates a ChallengeStore with the given TTL (0 uses
// DefaultChallengeTTL).
func NewChallengeStore(ttl time.Duration) *ChallengeStore {
	if ttl <= 0 {
		ttl = DefaultChallengeTTL
	}
	return &ChallengeStore{
		ttl: ttl,
		m:   make(map[string]challengeEntry),
		now: time.Now,
	}
}

// Issue generates a fresh challenge for the AID, replacing any prior one, and
// returns the nonce and its expiry time.
func (s *ChallengeStore) Issue(aid string) (nonce string, expiresAt time.Time, err error) {
	if aid == "" {
		return "", time.Time{}, fmt.Errorf("aid is required")
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", time.Time{}, fmt.Errorf("generate challenge: %w", err)
	}
	nonce = base64.RawURLEncoding.EncodeToString(buf)
	expiresAt = s.now().Add(s.ttl)

	s.mu.Lock()
	s.m[aid] = challengeEntry{nonce: nonce, expiry: expiresAt}
	s.mu.Unlock()
	return nonce, expiresAt, nil
}

// Consume validates that nonce is the outstanding, unexpired challenge for aid
// and removes it (single use). It returns true only on a successful match.
func (s *ChallengeStore) Consume(aid, nonce string) bool {
	if aid == "" || nonce == "" {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.m[aid]
	if !ok {
		return false
	}
	// Always consume the stored challenge, even on mismatch/expiry, so a wrong
	// guess forces the client to request a fresh one.
	delete(s.m, aid)
	if entry.nonce != nonce {
		return false
	}
	if s.now().After(entry.expiry) {
		return false
	}
	return true
}
