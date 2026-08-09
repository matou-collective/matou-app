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
	ttl     time.Duration

	mu        sync.Mutex
	cached    *RolePolicy
	fetchedAt time.Time
}

func NewStorePolicyProvider(store ObjectStore, spaceID string, ttl time.Duration) *StorePolicyProvider {
	return &StorePolicyProvider{store: store, spaceID: spaceID, ttl: ttl}
}

// Policy returns the synced policy, or nil when none exists / space not
// configured / read fails (callers fall back to defaults via CurrentPolicy).
func (s *StorePolicyProvider) Policy() *RolePolicy {
	if s.store == nil || s.spaceID == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cached != nil && time.Since(s.fetchedAt) < s.ttl {
		return s.cached
	}
	raws, err := s.store.List(s.spaceID, "RolePolicy")
	if err != nil {
		log.Printf("[RolePolicy] list failed (falling back to %s): %v",
			map[bool]string{true: "cached", false: "default"}[s.cached != nil], err)
		return s.cached // possibly nil → default
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
	s.cached = latest
	s.fetchedAt = time.Now()
	return s.cached
}

// Invalidate drops the cache so the next Policy() call re-reads the store.
// Called by the PUT handler after a successful write.
func (s *StorePolicyProvider) Invalidate() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cached = nil
	s.fetchedAt = time.Time{}
}
