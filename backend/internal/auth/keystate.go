package auth

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
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

// KeyHistoryResolver optionally resolves an AID's full establishment key-state
// history (one entry per KEL sequence number, ascending). A KeyStateResolver
// that also implements it lets callers verify a signature against the key state
// as of a past sequence number — e.g. an action proof that carries its
// signing-time KEL sn stays verifiable after a later legitimate rotation
// (GH#19 part 3 / #112).
type KeyHistoryResolver interface {
	KeyHistory(ctx context.Context, aid string) ([]EstablishmentKeyState, error)
}

// ValidAID reports whether s looks like a CESR-qualified KERI identifier
// prefix: base64url characters only, 44 chars (one-character derivation code
// over 32 bytes — the "E"/"D"/"B" prefixes signify creates) or 48 chars
// (two-character code over 33 bytes). It is a syntactic check used before an
// AID is interpolated into a URL or used as a store key.
func ValidAID(s string) bool {
	if len(s) != 44 && len(s) != 48 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '-', c == '_':
		default:
			return false
		}
	}
	return true
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
// Trust boundary: the resolver trusts the KEL the configured endpoint serves
// wholesale — it does not verify event signatures, digests or witness receipts
// itself. Whoever controls that endpoint (or the network path to it) therefore
// controls which key the backend accepts for login. That is acceptable only
// because the endpoint is the deployment's own KERIA/witness reached over
// loopback (dev/test/Electron) or TLS (remote); NewKERIAResolver refuses plain
// http to a non-loopback host for this reason. Full KEL verification is a
// follow-up.
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

// ResolverOption tunes NewKERIAResolver.
type ResolverOption func(*resolverOptions)

type resolverOptions struct {
	allowInsecure bool
}

// AllowInsecureHTTP permits a plain-http key-state URL to a non-loopback host.
// Only for remote-dev setups where the KERIA endpoint is on a trusted network;
// it re-opens the trust-boundary hole documented on KERIAResolver.
func AllowInsecureHTTP() ResolverOption {
	return func(o *resolverOptions) { o.allowInsecure = true }
}

// NewKERIAResolver builds a KERIAResolver. urlTemplate must contain the literal
// "{aid}" placeholder (e.g. "http://localhost:3902/oobi/{aid}") and must be
// https or plain http to a loopback host. cacheTTL of 0 disables caching.
func NewKERIAResolver(urlTemplate string, cacheTTL time.Duration, opts ...ResolverOption) (*KERIAResolver, error) {
	var o resolverOptions
	for _, opt := range opts {
		opt(&o)
	}
	if !strings.Contains(urlTemplate, "{aid}") {
		return nil, fmt.Errorf("url template must contain {aid} placeholder")
	}
	probe, err := url.Parse(strings.ReplaceAll(urlTemplate, "{aid}", "probe"))
	if err != nil {
		return nil, fmt.Errorf("invalid url template: %w", err)
	}
	switch probe.Scheme {
	case "https":
	case "http":
		if !o.allowInsecure && !isLoopbackHost(probe.Hostname()) {
			return nil, fmt.Errorf("refusing plain-http key-state URL to non-loopback host %q: the KEL it serves is trusted wholesale, use https", probe.Hostname())
		}
	default:
		return nil, fmt.Errorf("unsupported key-state URL scheme %q", probe.Scheme)
	}
	return &KERIAResolver{
		urlTemplate: urlTemplate,
		client:      &http.Client{Timeout: 10 * time.Second},
		cache:       newKeyStateCache(cacheTTL),
	}, nil
}

// isLoopbackHost reports whether host is localhost or a loopback IP.
func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// CurrentKeys fetches and parses the AID's KEL, returning its current signing
// keys. Results are cached for the resolver's TTL; Invalidate drops the cache
// on rotation. An AID whose key state is not a single key with threshold 1
// yields ErrUnsupportedKeyState.
func (r *KERIAResolver) CurrentKeys(ctx context.Context, aid string) ([]string, error) {
	if !ValidAID(aid) {
		return nil, fmt.Errorf("invalid AID %q", aid)
	}
	if keys, ok := r.cache.get(aid); ok {
		return keys, nil
	}
	body, err := r.fetchKEL(ctx, aid)
	if err != nil {
		return nil, err
	}
	ks, err := ExtractKeyState(body, aid)
	if err != nil {
		return nil, fmt.Errorf("parse KEL for %s: %w", aid, err)
	}
	if !ks.SingleKey() {
		return nil, fmt.Errorf("%w (%d keys, kt=%s)", ErrUnsupportedKeyState, len(ks.Keys), ks.Threshold)
	}
	r.cache.set(aid, ks.Keys)
	return ks.Keys, nil
}

// KeyHistory implements KeyHistoryResolver: it fetches aid's KEL and returns its
// full establishment key-state history (one entry per KEL sequence number,
// ascending), so a proof-backed transition can be verified against the signing
// keys as of the proof's sn even after a later rotation. Not cached — it is used
// off the state-reconstruction hot path by the write-rule refresher, which
// resolves each known member AID periodically. Unlike CurrentKeys it does not
// reject multi-key states; the caller decides how to use them.
func (r *KERIAResolver) KeyHistory(ctx context.Context, aid string) ([]EstablishmentKeyState, error) {
	if !ValidAID(aid) {
		return nil, fmt.Errorf("invalid AID %q", aid)
	}
	body, err := r.fetchKEL(ctx, aid)
	if err != nil {
		return nil, err
	}
	states, err := ExtractKeyStates(body, aid)
	if err != nil {
		return nil, fmt.Errorf("parse KEL for %s: %w", aid, err)
	}
	return states, nil
}

// fetchKEL retrieves aid's KEL as a CESR stream from the configured endpoint.
func (r *KERIAResolver) fetchKEL(ctx context.Context, aid string) ([]byte, error) {
	u := strings.ReplaceAll(r.urlTemplate, "{aid}", url.PathEscape(aid))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, fmt.Errorf("build key-state request: %w", err)
	}
	resp, err := r.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch key state for %s: %w", aid, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("key-state endpoint returned %d for %s", resp.StatusCode, aid)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("read key state for %s: %w", aid, err)
	}
	return body, nil
}

// Invalidate drops any cached key state for aid, forcing the next resolution to
// hit the network. Call on a rotation signal.
func (r *KERIAResolver) Invalidate(aid string) {
	r.cache.invalidate(aid)
}

// maxKeyStateCacheEntries bounds the resolver cache; when full, expired
// entries are swept and, if still full, the new entry is simply not cached.
const maxKeyStateCacheEntries = 10_000

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
	defer c.mu.Unlock()
	now := c.now()
	if len(c.m) >= maxKeyStateCacheEntries {
		for k, e := range c.m {
			if now.After(e.expiry) {
				delete(c.m, k)
			}
		}
		if len(c.m) >= maxKeyStateCacheEntries {
			return
		}
	}
	c.m[aid] = keyStateEntry{keys: append([]string(nil), keys...), expiry: now.Add(c.ttl)}
}

func (c *keyStateCache) invalidate(aid string) {
	c.mu.Lock()
	delete(c.m, aid)
	c.mu.Unlock()
}
