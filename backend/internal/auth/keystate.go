package auth

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// KeyStateResolver resolves an AID to its current signing keys (qb64 verfers).
// This is the authoritative source the login path uses to decide which key must
// have signed the challenge; the client's claimed key is never trusted.
type KeyStateResolver interface {
	CurrentKeys(ctx context.Context, aid string) ([]string, error)
}

// StaticKeyStateResolver serves key state from an in-memory map. Used in tests
// and as a fallback where key state is provisioned out of band.
type StaticKeyStateResolver struct {
	mu   sync.RWMutex
	keys map[string][]string
}

// NewStaticKeyStateResolver creates an empty StaticKeyStateResolver.
func NewStaticKeyStateResolver() *StaticKeyStateResolver {
	return &StaticKeyStateResolver{keys: make(map[string][]string)}
}

// Set records the current keys for an AID.
func (r *StaticKeyStateResolver) Set(aid string, keys []string) {
	r.mu.Lock()
	r.keys[aid] = append([]string(nil), keys...)
	r.mu.Unlock()
}

// CurrentKeys returns the keys previously recorded for aid.
func (r *StaticKeyStateResolver) CurrentKeys(_ context.Context, aid string) ([]string, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	keys, ok := r.keys[aid]
	if !ok {
		return nil, fmt.Errorf("no key state for AID %s", aid)
	}
	return keys, nil
}

// KERIAResolver resolves key state read-only over HTTP by fetching an AID's KEL
// as a CESR stream and extracting the current establishment keys.
//
// NEEDS LIVE VERIFICATION: the exact URL that serves an unauthenticated CESR
// KEL for an AID depends on the KERI deployment (KERIA OOBI endpoint vs a
// witness). urlTemplate must contain "{aid}"; it defaults to the KERIA CESR
// endpoint OOBI route. The e2e suite (real KERIA infrastructure) is the
// verification of this path per the ticket's acceptance criteria.
type KERIAResolver struct {
	urlTemplate string
	client      *http.Client
	cache       *keyStateCache
}

// NewKERIAResolver builds a KERIAResolver. urlTemplate must contain the literal
// "{aid}" placeholder (e.g. "http://localhost:3902/oobi/{aid}"). cacheTTL of 0
// disables caching.
func NewKERIAResolver(urlTemplate string, cacheTTL time.Duration) (*KERIAResolver, error) {
	if !strings.Contains(urlTemplate, "{aid}") {
		return nil, fmt.Errorf("url template must contain {aid} placeholder")
	}
	return &KERIAResolver{
		urlTemplate: urlTemplate,
		client:      &http.Client{Timeout: 10 * time.Second},
		cache:       newKeyStateCache(cacheTTL),
	}, nil
}

// CurrentKeys fetches and parses the AID's KEL, returning its current signing
// keys. Results are cached for the resolver's TTL; Invalidate drops the cache
// on rotation.
func (r *KERIAResolver) CurrentKeys(ctx context.Context, aid string) ([]string, error) {
	if keys, ok := r.cache.get(aid); ok {
		return keys, nil
	}
	url := strings.ReplaceAll(r.urlTemplate, "{aid}", aid)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("build key-state request: %w", err)
	}
	resp, err := r.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch key state for %s: %w", aid, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("key-state endpoint returned %d for %s", resp.StatusCode, aid)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("read key state for %s: %w", aid, err)
	}
	keys, err := ExtractCurrentKeys(body)
	if err != nil {
		return nil, fmt.Errorf("parse KEL for %s: %w", aid, err)
	}
	r.cache.set(aid, keys)
	return keys, nil
}

// Invalidate drops any cached key state for aid, forcing the next resolution to
// hit the network. Call on a rotation signal.
func (r *KERIAResolver) Invalidate(aid string) {
	r.cache.invalidate(aid)
}

type keyStateCache struct {
	ttl time.Duration
	mu  sync.Mutex
	m   map[string]keyStateEntry
	now func() time.Time
}

type keyStateEntry struct {
	keys   []string
	expiry time.Time
}

func newKeyStateCache(ttl time.Duration) *keyStateCache {
	return &keyStateCache{ttl: ttl, m: make(map[string]keyStateEntry), now: time.Now}
}

func (c *keyStateCache) get(aid string) ([]string, bool) {
	if c.ttl <= 0 {
		return nil, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.m[aid]
	if !ok || c.now().After(entry.expiry) {
		return nil, false
	}
	return entry.keys, true
}

func (c *keyStateCache) set(aid string, keys []string) {
	if c.ttl <= 0 {
		return
	}
	c.mu.Lock()
	c.m[aid] = keyStateEntry{keys: append([]string(nil), keys...), expiry: c.now().Add(c.ttl)}
	c.mu.Unlock()
}

func (c *keyStateCache) invalidate(aid string) {
	c.mu.Lock()
	delete(c.m, aid)
	c.mu.Unlock()
}
