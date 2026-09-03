package contributions

import (
	"encoding/json"
	"log"
	"sync"
	"time"
)

// PolicyProvider supplies the community's current RolePolicy. Policy() may
// return nil, meaning "no synced policy" — callers fall back to
// DefaultRolePolicy() via CurrentPolicy().
type PolicyProvider interface {
	Policy() *RolePolicy
}

var (
	providerMu      sync.RWMutex
	currentProvider PolicyProvider
)

// SetPolicyProvider installs the process-wide policy provider (nil to reset
// to built-in defaults). Called once from main after the any-sync store is up.
func SetPolicyProvider(p PolicyProvider) {
	providerMu.Lock()
	defer providerMu.Unlock()
	currentProvider = p
}

// CurrentPolicy returns the synced policy if a provider is set and has one,
// otherwise the built-in default. Never returns nil.
func CurrentPolicy() *RolePolicy {
	providerMu.RLock()
	p := currentProvider
	providerMu.RUnlock()
	if p != nil {
		if policy := p.Policy(); policy != nil {
			return policy
		}
	}
	return DefaultRolePolicy()
}

// StorePolicyProvider reads the singleton RolePolicy object from the
// community-readonly space via ObjectStore, with a short TTL cache.
// Read-through matches how ProfileRoleLookup reads profiles; the TTL keeps
// per-request overhead low without tree-listener wiring.
type StorePolicyProvider struct {
	store   ObjectStore
	spaceID string
	// spaceIDFn, when set, overrides spaceID (see SetSpaceIDResolver).
	spaceIDFn func() string
	ttl       time.Duration

	mu        sync.Mutex
	cached    *RolePolicy
	fetchedAt time.Time
}

func NewStorePolicyProvider(store ObjectStore, spaceID string, ttl time.Duration) *StorePolicyProvider {
	return &StorePolicyProvider{store: store, spaceID: spaceID, ttl: ttl}
}

// SetSpaceIDResolver makes the provider look up the community-readonly space
// ID on every read instead of using the value captured at construction. The
// backend starts before an identity (and therefore the space) exists, so the
// wiring passes the identity's live getter here.
func (s *StorePolicyProvider) SetSpaceIDResolver(fn func() string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.spaceIDFn = fn
}

// currentSpaceID returns the resolver's value when set, else the static ID.
// Callers hold s.mu.
func (s *StorePolicyProvider) currentSpaceID() string {
	if s.spaceIDFn != nil {
		if id := s.spaceIDFn(); id != "" {
			return id
		}
	}
	return s.spaceID
}

// Policy returns the synced policy, or nil when none exists / space not
// configured / read fails (callers fall back to defaults via CurrentPolicy).
// It fails open: a store read error yields nil (or a stale cached value)
// rather than an error, so most callers can treat "no policy" uniformly.
// Callers that must not mistake a read failure for "policy absent" (e.g. the
// PUT handler's optimistic-concurrency check) should use PolicyOrErr instead.
func (s *StorePolicyProvider) Policy() *RolePolicy {
	p, err := s.fetchFromStore()
	if err != nil {
		log.Printf("[RolePolicy] list failed (falling back to %s): %v",
			map[bool]string{true: "cached", false: "default"}[p != nil], err)
	}
	return p
}

// PolicyOrErr is like Policy but fails closed: a store read error is
// returned instead of masked as "no policy". nil, nil means the policy is
// genuinely absent (never saved) — the only case callers should treat as
// "fall back to the default policy".
func (s *StorePolicyProvider) PolicyOrErr() (*RolePolicy, error) {
	return s.fetchFromStore()
}

// fetchFromStore re-reads and caches the policy from the store, honoring the
// TTL. It returns the store's error unmodified (alongside any still-cached
// value) so callers can decide whether to fail open or closed.
func (s *StorePolicyProvider) fetchFromStore() (*RolePolicy, error) {
	if s.store == nil {
		return nil, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	spaceID := s.currentSpaceID()
	if spaceID == "" {
		return nil, nil
	}
	if s.cached != nil && time.Since(s.fetchedAt) < s.ttl {
		return s.cached, nil
	}
	raws, err := s.store.List(spaceID, "RolePolicy")
	if err != nil {
		return s.cached, err // cached may be nil; err signals the read failed
	}
	var latest *RolePolicy
	for _, raw := range raws {
		var p RolePolicy
		if err := json.Unmarshal(raw, &p); err != nil {
			log.Printf("[RolePolicy] skipping corrupt policy object: %v", err)
			continue
		}
		if latest == nil || p.Version > latest.Version {
			latest = &p
		}
	}
	// Upgrade a policy saved under an older capability model in memory so
	// enforcement and the API see current capabilities (retired grants mapped
	// to successors, new-capability defaults merged). Version is unchanged; the
	// migration is persisted the next time the policy is saved (#313).
	NormalizeStoredPolicy(latest)
	s.cached = latest
	s.fetchedAt = time.Now()
	return s.cached, nil
}

// Invalidate drops the cache so the next Policy() call re-reads the store.
// Called by the PUT handler after a successful write.
func (s *StorePolicyProvider) Invalidate() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cached = nil
	s.fetchedAt = time.Time{}
}
