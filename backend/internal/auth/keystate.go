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
// witness). Each url template must contain "{aid}"; it defaults to the KERIA
// CESR endpoint OOBI route. The e2e suite (real KERIA infrastructure) is the
// verification of this path per the ticket's acceptance criteria.
//
// Multiple sources and bounded retry (#513): KERIA's bare OOBI is not a reliable
// key-state source. It 404s a fully-receipted multisig group AID whose OOBI is
// answered by a co-signer's agent that never collected the group's receipts, and
// it 404s an AID's own OOBI in the window between a rotation and its witness
// receipts landing. To ride out both, the resolver accepts an ordered list of
// url templates (a witness — the receipt-holder of record — can be listed as a
// fallback for the KERIA OOBI) and retries a transient 404/503 with bounded
// backoff before giving up. A witness holds the receipted KEL by protocol
// design, so consulting it is a correctness fix toward the authoritative source,
// not a loosening of the trust boundary — every source is still held to the
// loopback/TLS rule below.
type KERIAResolver struct {
	urlTemplates  []string
	client        *http.Client
	cache         *keyStateCache
	retryAttempts int
	retryBackoff  time.Duration
}

// Retry defaults for the witness-receipting window (#513). backoff doubles each
// pass, capped at maxNotFoundBackoff, so the worst-case added latency across the
// default budget is ~200+400+800+1000 ≈ 2.4s — bounded, and short-circuited the
// moment any source serves the KEL.
const (
	defaultNotFoundRetries = 4
	defaultNotFoundBackoff = 200 * time.Millisecond
	maxNotFoundBackoff     = 1 * time.Second
)

// ResolverOption tunes NewKERIAResolver.
type ResolverOption func(*resolverOptions)

type resolverOptions struct {
	allowInsecure bool
	retrySet      bool
	retryAttempts int
	retryBackoff  time.Duration
}

// AllowInsecureHTTP permits a plain-http key-state URL to a non-loopback host.
// Only for remote-dev setups where the KERIA endpoint is on a trusted network;
// it re-opens the trust-boundary hole documented on KERIAResolver.
func AllowInsecureHTTP() ResolverOption {
	return func(o *resolverOptions) { o.allowInsecure = true }
}

// WithNotFoundRetry tunes how the resolver rides out the witness-receipting
// window (#513): when every configured source answers 404/503 (the AID's KEL is
// not yet fully witnessed anywhere reachable), it retries up to attempts times,
// sleeping backoff*2^n (capped at maxNotFoundBackoff) between passes, before
// giving up. attempts<=0 disables retry. Primarily a test seam; production uses
// the defaults.
func WithNotFoundRetry(attempts int, backoff time.Duration) ResolverOption {
	return func(o *resolverOptions) {
		o.retrySet = true
		o.retryAttempts = attempts
		o.retryBackoff = backoff
	}
}

// NewKERIAResolver builds a KERIAResolver. urlTemplate is one or more comma-
// separated templates, each of which must contain the literal "{aid}"
// placeholder (e.g. "http://localhost:3902/oobi/{aid}") and be https or plain
// http to a loopback host. When more than one is given they are consulted in
// order until one serves the KEL — list a witness after the KERIA OOBI to cover
// a group AID whose OOBI a co-signer's agent 404s. cacheTTL of 0 disables
// caching.
func NewKERIAResolver(urlTemplate string, cacheTTL time.Duration, opts ...ResolverOption) (*KERIAResolver, error) {
	var o resolverOptions
	for _, opt := range opts {
		opt(&o)
	}
	var templates []string
	for _, t := range strings.Split(urlTemplate, ",") {
		t = strings.TrimSpace(t)
		if t == "" {
			continue
		}
		if !strings.Contains(t, "{aid}") {
			return nil, fmt.Errorf("url template %q must contain {aid} placeholder", t)
		}
		probe, err := url.Parse(strings.ReplaceAll(t, "{aid}", "probe"))
		if err != nil {
			return nil, fmt.Errorf("invalid url template %q: %w", t, err)
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
		templates = append(templates, t)
	}
	if len(templates) == 0 {
		return nil, fmt.Errorf("no key-state url template given")
	}
	attempts, backoff := defaultNotFoundRetries, defaultNotFoundBackoff
	if o.retrySet {
		attempts, backoff = o.retryAttempts, o.retryBackoff
	}
	return &KERIAResolver{
		urlTemplates:  templates,
		client:        &http.Client{Timeout: 10 * time.Second},
		cache:         newKeyStateCache(cacheTTL),
		retryAttempts: attempts,
		retryBackoff:  backoff,
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

// fetchKEL retrieves aid's KEL as a CESR stream, trying each configured source
// in order and riding out a transient 404/503 (the witness-receipting window,
// #513) with bounded backoff. It returns the first 200 body; if every source is
// exhausted it returns the last error. A 404/503 anywhere marks the pass as
// retryable, so a persistent hard failure (bad AID, 500, network error) fails
// fast without burning the whole retry budget.
func (r *KERIAResolver) fetchKEL(ctx context.Context, aid string) ([]byte, error) {
	var lastErr error
	for attempt := 0; ; attempt++ {
		retryable := false
		for _, tmpl := range r.urlTemplates {
			body, status, err := r.getOnce(ctx, tmpl, aid)
			switch {
			case err != nil:
				lastErr = err
			case status == http.StatusOK:
				return body, nil
			default:
				lastErr = fmt.Errorf("key-state endpoint returned %d for %s", status, aid)
				if status == http.StatusNotFound || status == http.StatusServiceUnavailable {
					retryable = true
				}
			}
		}
		if !retryable || attempt >= r.retryAttempts {
			return nil, lastErr
		}
		if err := sleepBackoff(ctx, r.backoffFor(attempt)); err != nil {
			return nil, err
		}
	}
}

// getOnce performs a single GET against one url template. It returns the body
// only for a 200 response (draining and discarding otherwise), the HTTP status,
// and a non-nil error for transport/build failures.
func (r *KERIAResolver) getOnce(ctx context.Context, tmpl, aid string) ([]byte, int, error) {
	u := strings.ReplaceAll(tmpl, "{aid}", url.PathEscape(aid))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, 0, fmt.Errorf("build key-state request: %w", err)
	}
	resp, err := r.client.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("fetch key state for %s: %w", aid, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, resp.StatusCode, nil
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, resp.StatusCode, fmt.Errorf("read key state for %s: %w", aid, err)
	}
	return body, resp.StatusCode, nil
}

// backoffFor returns the sleep before the pass following attempt: backoff
// doubled per attempt, capped at maxNotFoundBackoff.
func (r *KERIAResolver) backoffFor(attempt int) time.Duration {
	d := r.retryBackoff
	for i := 0; i < attempt && d < maxNotFoundBackoff; i++ {
		d *= 2
	}
	if d > maxNotFoundBackoff {
		d = maxNotFoundBackoff
	}
	return d
}

// sleepBackoff waits for d or until ctx is cancelled, whichever comes first.
func sleepBackoff(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
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
