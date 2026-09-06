// Package pushrelayclient is a thin HTTP client for the push-relay service
// (docs/architecture/08-push-notifications.md §3, topology C). The embedded
// backend is the only caller: it registers a device's FCM token and, on the
// chat write-path, asks the relay to wake recipient devices with a
// content-free signal. The relay itself is a separate service (slice 2); this
// package never sees Firebase.
//
// Every call is authenticated with a KERI-signed session (§3), but the backend
// cannot sign: the member's signing keys live at the edge in signify-ts inside
// the WebView (see docs/signed-auth.md). So the topology is "the frontend signs,
// the backend spends" (#277): the frontend signs a relay-issued challenge, hands
// the signature back over the loopback API, and the backend exchanges it for a
// bearer session (RelayChallenge/RelaySession). The client caches that token in
// memory only — never on disk, it is a short-lived credential — and spends it on
// register/deregister/notify. Because the relay derives the caller's AID from the
// signed session, never from a request body, the register/notify surface cannot
// spoof another member's AID.
//
// The client is deliberately dumb about content: it forwards only opaque
// routing data (token, platform, recipient AIDs, opaque channel id, coarse
// kind). No message body, sender name, or channel name ever passes through it.
package pushrelayclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// ErrNoSession means there is no valid relay session to spend: none has been
// minted yet, or the relay rejected the cached one (expired / relay restarted).
// The backend cannot re-mint — only the WebView holds the signing key — so this
// is surfaced to the caller, which drops the call. The API layer maps it to a
// 401 so the frontend knows to re-mint; PushSender drops the notify.
var ErrNoSession = errors.New("push-relay: no active session")

// Client talks to the push-relay HTTP API. Construct with New; a nil *Client is
// never valid — callers that have no relay configured hold a nil interface
// value and skip the call entirely (see notifications.PushSender / api.PushHandler).
type Client struct {
	baseURL string
	http    *http.Client

	mu           sync.Mutex
	sessionAID   string
	sessionToken string
	sessionExp   time.Time
}

// Option configures a Client.
type Option func(*options)

type options struct {
	allowInsecure bool
}

// AllowInsecureHTTP permits a plain-http relay URL to a non-loopback host. Only
// for dev setups where the relay sits on a trusted network; it puts device FCM
// tokens and full recipient-AID lists on the wire in cleartext, which is exactly
// the routing metadata the content-free design is meant to keep private.
func AllowInsecureHTTP() Option {
	return func(o *options) { o.allowInsecure = true }
}

// New builds a relay client for baseURL. A per-request timeout bounds every
// call so a slow or dead relay never blocks the chat write-path. The client
// starts with no session: register/deregister/notify fail fast with ErrNoSession
// until the frontend mints one via RelayChallenge/RelaySession (the caller logs
// and moves on — relay failures are never fatal).
//
// baseURL must be https, or plain http to a loopback host unless
// AllowInsecureHTTP is passed; anything else is rejected with an error so the
// caller can leave push dark rather than ship tokens in cleartext.
func New(baseURL string, opts ...Option) (*Client, error) {
	var o options
	for _, opt := range opts {
		opt(&o)
	}
	trimmed := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	u, err := url.Parse(trimmed)
	if err != nil {
		return nil, fmt.Errorf("invalid relay URL: %w", err)
	}
	if u.Host == "" {
		return nil, fmt.Errorf("relay URL %q has no host", baseURL)
	}
	switch u.Scheme {
	case "https":
	case "http":
		if !o.allowInsecure && !isLoopbackHost(u.Hostname()) {
			return nil, fmt.Errorf("refusing plain-http relay URL to non-loopback host %q: device tokens and recipient AIDs would travel in cleartext, use https", u.Hostname())
		}
	default:
		return nil, fmt.Errorf("unsupported relay URL scheme %q", u.Scheme)
	}
	return &Client{
		baseURL: trimmed,
		http:    &http.Client{Timeout: 10 * time.Second},
	}, nil
}

// RelayChallenge asks the relay for a single-use login challenge bound to aid.
// The backend forwards the nonce to the WebView, which signs the domain-separated
// message matou-auth:<aid>:<nonce> with the AID key — the backend cannot sign.
func (c *Client) RelayChallenge(ctx context.Context, aid string) (challenge string, expiresAt time.Time, err error) {
	var chal struct {
		Challenge string `json:"challenge"`
		ExpiresAt string `json:"expiresAt"`
	}
	if err := c.postJSON(ctx, "/auth/challenge", "", map[string]string{"aid": aid}, &chal); err != nil {
		return "", time.Time{}, fmt.Errorf("push-relay challenge: %w", err)
	}
	if chal.Challenge == "" {
		return "", time.Time{}, fmt.Errorf("push-relay challenge: empty nonce")
	}
	exp, _ := time.Parse(time.RFC3339, chal.ExpiresAt)
	return chal.Challenge, exp, nil
}

// RelaySession exchanges a WebView-signed challenge for a bearer session token
// and caches it in memory (never persisted — it is a short-lived credential).
// From then on register/deregister/notify spend it until it expires or the relay
// rejects it, at which point the frontend re-mints. The AID is supplied by the
// backend (the authenticated loopback session), never a request body.
func (c *Client) RelaySession(ctx context.Context, aid, challenge, signature string) (expiresAt time.Time, err error) {
	var login struct {
		Token     string `json:"token"`
		ExpiresAt string `json:"expiresAt"`
	}
	if err := c.postJSON(ctx, "/auth/login", "", map[string]string{
		"aid":       aid,
		"challenge": challenge,
		"signature": signature,
	}, &login); err != nil {
		return time.Time{}, fmt.Errorf("push-relay login: %w", err)
	}
	if login.Token == "" {
		return time.Time{}, fmt.Errorf("push-relay login: empty token")
	}
	// Default to a conservative lifetime; prefer the relay's own expiry with a
	// small safety margin so we treat the token as expired just before the relay
	// does (the frontend refreshes near expiry — §3).
	exp := time.Now().Add(25 * time.Minute)
	if parsed, perr := time.Parse(time.RFC3339, login.ExpiresAt); perr == nil {
		if margin := parsed.Add(-30 * time.Second); margin.After(time.Now()) {
			exp = margin
		} else {
			exp = parsed
		}
	}
	c.SetSession(aid, login.Token, exp)
	return exp, nil
}

// SetSession stores the bearer token, the AID it was minted for, and its expiry.
// Held in memory only. Exposed so a session minted out of band (e.g. a test, or
// a future non-login mint path) can be injected.
func (c *Client) SetSession(aid, token string, expiresAt time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.sessionAID = aid
	c.sessionToken = token
	c.sessionExp = expiresAt
}

// SessionAID returns the AID the live session was minted for, or "" when there
// is no valid session. Callers use it to detect a session left over from a
// previous identity (an identity switch mid-TTL): spending that session on a
// register would bind the device token to the OLD AID at the relay, so the API
// layer refuses the mismatch with a 401 and the frontend mints a fresh session.
func (c *Client) SessionAID() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.sessionToken == "" || !time.Now().Before(c.sessionExp) {
		return ""
	}
	return c.sessionAID
}

// ClearSession drops the in-memory session (logout / identity switch). After it
// the authed routes fail with ErrNoSession until the frontend mints a new one.
func (c *Client) ClearSession() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.sessionAID = ""
	c.sessionToken = ""
	c.sessionExp = time.Time{}
}

// token returns the current session token if it is present and unexpired. The
// mutex is held only long enough to copy the fields — never across an HTTP
// round-trip (the earlier session() held it across two, a known bug).
func (c *Client) token() (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.sessionToken == "" || !time.Now().Before(c.sessionExp) {
		return "", false
	}
	return c.sessionToken, true
}

// isLoopbackHost reports whether host is localhost or a loopback IP. Mirrors the
// same check in internal/auth for the KERIA key-state URL.
func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// Register maps this device's FCM token to the local AID on the relay. The AID
// is taken from the signed session, never a parameter — the device token and
// platform are the only caller-supplied values.
func (c *Client) Register(ctx context.Context, token, platform string) error {
	if platform == "" {
		platform = "android"
	}
	return c.authedPost(ctx, "/register", map[string]string{
		"token":    token,
		"platform": platform,
	})
}

// Deregister removes this device's FCM token from the relay (logout / identity
// switch / token rotation). The AID comes from the signed session.
func (c *Client) Deregister(ctx context.Context, token string) error {
	return c.authedPost(ctx, "/deregister", map[string]string{"token": token})
}

// Notify asks the relay to wake the given recipient AIDs for a new message in an
// opaque channel. kind is the coarse priority tier ("dm" | "ch"); the payload is
// content-free by construction — recipients, an opaque channel id, and the kind
// are all it carries.
func (c *Client) Notify(ctx context.Context, recipients []string, channel, kind string) error {
	return c.authedPost(ctx, "/notify", map[string]any{
		"recipients": recipients,
		"channel":    channel,
		"kind":       kind,
	})
}

// authedPost spends the cached session on path. With no valid session it fails
// fast with ErrNoSession (never blocks). If the relay rejects the session (401)
// the client clears it and returns ErrNoSession: the backend cannot re-mint, so
// the frontend re-signs on its next foreground / 401 (§3).
func (c *Client) authedPost(ctx context.Context, path string, body any) error {
	token, ok := c.token()
	if !ok {
		return ErrNoSession
	}
	status, err := c.post(ctx, path, token, body)
	if err != nil {
		return err
	}
	if status == http.StatusUnauthorized {
		c.ClearSession()
		return ErrNoSession
	}
	if status < 200 || status >= 300 {
		return fmt.Errorf("push-relay %s returned status %d", path, status)
	}
	return nil
}

// post sends an authenticated JSON POST and returns the HTTP status. A 401 is
// returned (not treated as an error) so the caller can re-auth and retry.
func (c *Client) post(ctx context.Context, path, token string, body any) (int, error) {
	buf, err := json.Marshal(body)
	if err != nil {
		return 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(buf))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, err
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.StatusCode, nil
}

// postJSON sends a JSON POST and decodes a 2xx JSON response into out. Non-2xx
// responses are surfaced as an error (used for the auth flow, where any failure
// aborts the login).
func (c *Client) postJSON(ctx context.Context, path, token string, body, out any) error {
	buf, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(buf))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("status %d: %s", resp.StatusCode, strings.TrimSpace(string(data)))
	}
	if out != nil {
		if err := json.Unmarshal(data, out); err != nil {
			return fmt.Errorf("decoding response: %w", err)
		}
	}
	return nil
}
