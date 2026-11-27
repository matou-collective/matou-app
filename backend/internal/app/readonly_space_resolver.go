package app

import (
	"context"
	"log"
	"sync"
	"time"
)

const (
	// readOnlyProbeTTL bounds how long a reachability verdict is trusted. The
	// resolver runs on every role / profile / policy request, so the coordinator
	// must not be asked each time; it is short enough that a coordinator that
	// was down at boot, or an org-config ID that propagates later, is picked up.
	readOnlyProbeTTL = 30 * time.Second

	// readOnlyProbeTimeout bounds a single coordinator probe.
	readOnlyProbeTimeout = 5 * time.Second
)

// readOnlySpaceSources are the inputs readOnlySpaceResolver reads, injected so
// the resolution rule can be tested without a network or a persisted identity.
type readOnlySpaceSources struct {
	identityID func() string
	orgID      func() string
	exists     func(ctx context.Context, spaceID string) bool
	persist    func(spaceID string) error
	now        func() time.Time
}

// readOnlySpaceResolver resolves the community read-only space ID live.
//
// The persisted identity ID wins while it is reachable. When it is empty, or
// unreachable while org config holds a reachable different ID, org config wins
// and the identity is healed to match. #540 only handled the empty case, so an
// install holding a stale non-empty ID, minted by the original #539 bug, kept
// pulling a space that never propagated, with every role and profile lookup
// empty (#719).
type readOnlySpaceResolver struct {
	src readOnlySpaceSources

	mu        sync.Mutex
	cachedFor [2]string
	cached    string
	expires   time.Time
}

func newReadOnlySpaceResolver(src readOnlySpaceSources) *readOnlySpaceResolver {
	if src.now == nil {
		src.now = time.Now
	}
	return &readOnlySpaceResolver{src: src}
}

// Resolve returns the read-only space ID to use now, or "" when none is known.
func (r *readOnlySpaceResolver) Resolve() string {
	id, org := r.src.identityID(), r.src.orgID()
	if id == "" {
		return org
	}
	if org == "" || org == id {
		return id
	}

	key := [2]string{id, org}
	now := r.src.now()
	r.mu.Lock()
	if r.cachedFor == key && now.Before(r.expires) {
		cached := r.cached
		r.mu.Unlock()
		return cached
	}
	r.mu.Unlock()

	resolved := r.choose(id, org)

	r.mu.Lock()
	r.cachedFor, r.cached, r.expires = key, resolved, now.Add(readOnlyProbeTTL)
	r.mu.Unlock()
	return resolved
}

// choose is called only when the identity and org-config IDs differ.
func (r *readOnlySpaceResolver) choose(id, org string) string {
	ctx, cancel := context.WithTimeout(context.Background(), readOnlyProbeTimeout)
	defer cancel()

	if r.src.exists(ctx, id) {
		return id
	}
	if !r.src.exists(ctx, org) {
		return id
	}
	log.Printf("[ReadOnlySpace] identity read-only space %s is unreachable; org config's %s is — healing identity (#719)", id, org)
	if err := r.src.persist(org); err != nil {
		log.Printf("[ReadOnlySpace] could not persist healed read-only space ID: %v", err)
	}
	return org
}
