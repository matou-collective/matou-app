// Package pushrelay implements the standalone push-relay service (design doc
// docs/architecture/08-push-notifications.md, topology C). The relay is the
// only holder of the FCM server credential and of the AID→device-token map. It
// never sees message content: senders' backends call it with content-free
// wake signals which it dispatches as data-only FCM messages.
package pushrelay

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// TokenRecord is one device token registered for an AID. LastSeen bounds the
// map: tokens untouched past the store TTL are expired.
type TokenRecord struct {
	Token    string    `json:"token"`
	AID      string    `json:"aid"`
	Platform string    `json:"platform"`
	LastSeen time.Time `json:"lastSeen"`
}

// Store holds the AID→token map and per-AID opt-out flags. It is the only
// server-side state the design permits (§2): push plumbing, not an identity
// registry. Safe for concurrent use. When path is non-empty the map is
// persisted to a JSON file on every mutation (atomic write) and loaded on
// startup; with an empty path the store is in-memory only (used by tests).
type Store struct {
	mu       sync.Mutex
	path     string
	ttl      time.Duration
	tokens   map[string]*TokenRecord    // token -> record
	byAID    map[string]map[string]bool // aid -> set of tokens
	optedOut map[string]bool            // aid -> opted out of pushes
	now      func() time.Time
}

// NewStore creates a Store persisting to path (empty = in-memory only) with the
// given untouched-token TTL. If a snapshot exists at path it is loaded.
func NewStore(path string, ttl time.Duration) (*Store, error) {
	s := &Store{
		path:     path,
		ttl:      ttl,
		tokens:   make(map[string]*TokenRecord),
		byAID:    make(map[string]map[string]bool),
		optedOut: make(map[string]bool),
		now:      time.Now,
	}
	if path != "" {
		if err := s.load(); err != nil {
			return nil, err
		}
	}
	return s, nil
}

type snapshot struct {
	Tokens   []*TokenRecord `json:"tokens"`
	OptedOut []string       `json:"optedOut"`
}

func (s *Store) load() error {
	data, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var snap snapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		return err
	}
	for _, rec := range snap.Tokens {
		if rec == nil || rec.Token == "" || rec.AID == "" {
			continue
		}
		s.tokens[rec.Token] = rec
		s.addIndexLocked(rec.AID, rec.Token)
	}
	for _, aid := range snap.OptedOut {
		s.optedOut[aid] = true
	}
	return nil
}

// persistLocked writes the current map to disk atomically. Caller holds s.mu.
func (s *Store) persistLocked() error {
	if s.path == "" {
		return nil
	}
	snap := snapshot{Tokens: make([]*TokenRecord, 0, len(s.tokens))}
	for _, rec := range s.tokens {
		snap.Tokens = append(snap.Tokens, rec)
	}
	sort.Slice(snap.Tokens, func(i, j int) bool { return snap.Tokens[i].Token < snap.Tokens[j].Token })
	for aid, out := range s.optedOut {
		if out {
			snap.OptedOut = append(snap.OptedOut, aid)
		}
	}
	sort.Strings(snap.OptedOut)
	data, err := json.MarshalIndent(snap, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func (s *Store) addIndexLocked(aid, token string) {
	if s.byAID[aid] == nil {
		s.byAID[aid] = make(map[string]bool)
	}
	s.byAID[aid][token] = true
}

func (s *Store) removeIndexLocked(aid, token string) {
	if set := s.byAID[aid]; set != nil {
		delete(set, token)
		if len(set) == 0 {
			delete(s.byAID, aid)
		}
	}
}

// Register records (or refreshes) a device token for an AID and clears any
// opt-out flag on that AID — registering is an explicit opt-in. If the token
// was previously bound to a different AID (device handed to another identity)
// the old binding is removed.
func (s *Store) Register(aid, token, platform string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if existing, ok := s.tokens[token]; ok && existing.AID != aid {
		s.removeIndexLocked(existing.AID, token)
	}
	s.tokens[token] = &TokenRecord{
		Token:    token,
		AID:      aid,
		Platform: platform,
		LastSeen: s.now(),
	}
	s.addIndexLocked(aid, token)
	delete(s.optedOut, aid)
	return s.persistLocked()
}

// Deregister removes a single device token. The AID that owns the token must
// match — a caller can only drop its own tokens. Removing an unknown token is a
// no-op (idempotent logout).
func (s *Store) Deregister(aid, token string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, ok := s.tokens[token]
	if !ok || rec.AID != aid {
		return nil
	}
	delete(s.tokens, token)
	s.removeIndexLocked(aid, token)
	return s.persistLocked()
}

// SetOptOut sets or clears the opt-out flag for an AID. Opt-out holds even when
// senders are unaware of it (§7): the relay drops pushes for opted-out AIDs.
func (s *Store) SetOptOut(aid string, out bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if out {
		s.optedOut[aid] = true
	} else {
		delete(s.optedOut, aid)
	}
	return s.persistLocked()
}

// IsOptedOut reports whether an AID has opted out of pushes.
func (s *Store) IsOptedOut(aid string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.optedOut[aid]
}

// TokensForAID returns the live (non-expired) tokens for an AID. Expired tokens
// are pruned as a side effect.
func (s *Store) TokensForAID(aid string) []TokenRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expireLocked()
	set := s.byAID[aid]
	if len(set) == 0 {
		return nil
	}
	out := make([]TokenRecord, 0, len(set))
	for token := range set {
		if rec, ok := s.tokens[token]; ok {
			out = append(out, *rec)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Token < out[j].Token })
	return out
}

// Touch refreshes a token's last-seen timestamp (e.g. after a successful FCM
// dispatch) so active devices are not expired.
func (s *Store) Touch(token string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if rec, ok := s.tokens[token]; ok {
		rec.LastSeen = s.now()
		_ = s.persistLocked()
	}
}

// PruneToken removes a token FCM reported as NotRegistered/Unregistered.
func (s *Store) PruneToken(token string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if rec, ok := s.tokens[token]; ok {
		delete(s.tokens, token)
		s.removeIndexLocked(rec.AID, token)
		_ = s.persistLocked()
	}
}

// ExpireStale prunes tokens untouched past the TTL, returning the count removed.
func (s *Store) ExpireStale() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := s.expireLocked()
	if n > 0 {
		_ = s.persistLocked()
	}
	return n
}

// expireLocked drops tokens older than the TTL. Caller holds s.mu. Does not
// persist (callers decide). Returns the count removed.
func (s *Store) expireLocked() int {
	if s.ttl <= 0 {
		return 0
	}
	cutoff := s.now().Add(-s.ttl)
	removed := 0
	for token, rec := range s.tokens {
		if rec.LastSeen.Before(cutoff) {
			delete(s.tokens, token)
			s.removeIndexLocked(rec.AID, token)
			removed++
		}
	}
	return removed
}

// Len reports the number of tokens held.
func (s *Store) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.tokens)
}
