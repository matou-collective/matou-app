// Package pushrelayclient is a thin HTTP client for the push-relay service
// (docs/architecture/08-push-notifications.md §3, topology C). The embedded
// backend is the only caller: it registers a device's FCM token and, on the
// chat write-path, asks the relay to wake recipient devices with a
// content-free signal. The relay itself is a separate service (slice 2); this
// package never sees Firebase.
//
// Every call is authenticated with a KERI-signed session (§3): the client logs
// in by signing a relay-issued challenge with the local identity's AID key
// (via the injected Signer), caches the short-lived session token, and re-auths
// transparently on expiry. Because the relay derives the caller's AID from the
// signed session — never from a request body — the register/notify surface
// cannot spoof another member's AID.
//
// The client is deliberately dumb about content: it forwards only opaque
// routing data (token, platform, recipient AIDs, opaque channel id, coarse
// kind). No message body, sender name, or channel name ever passes through it.
package pushrelayclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Signer proves control of a KERI AID to the relay. It is the seam where the
// identity's signing capability plugs in; the client itself holds no keys.
type Signer interface {
	// AID returns the KERI AID the relay session will be bound to.
	AID() string
	// Sign returns the signature over the relay-issued challenge nonce, encoded
	// exactly as the relay's signed-auth verifier expects (see backend/internal/auth).
	Sign(ctx context.Context, challenge string) (string, error)
}

// Client talks to the push-relay HTTP API. Construct with New; a nil *Client is
// never valid — callers that have no relay configured hold a nil interface
// value and skip the call entirely (see notifications.PushSender / api.PushHandler).
type Client struct {
	baseURL string
	signer  Signer
	http    *http.Client

	mu           sync.Mutex
	sessionToken string
	sessionExp   time.Time
}

// New builds a relay client for baseURL, authenticating as signer. A per-request
// timeout bounds every call so a slow or dead relay never blocks the chat
// write-path. signer may be nil, in which case any call fails fast with an error
// (the caller logs and moves on — relay failures are never fatal).
func New(baseURL string, signer Signer) *Client {
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		signer:  signer,
		http:    &http.Client{Timeout: 10 * time.Second},
	}
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

// authedPost sends body to path with a valid session, re-authenticating once if
// the relay reports the session invalid/expired (401).
func (c *Client) authedPost(ctx context.Context, path string, body any) error {
	token, err := c.session(ctx, false)
	if err != nil {
		return err
	}
	status, err := c.post(ctx, path, token, body)
	if err != nil {
		return err
	}
	if status == http.StatusUnauthorized {
		// Session rejected (expired between checks, or relay restarted): mint a
		// fresh one and retry exactly once.
		if token, err = c.session(ctx, true); err != nil {
			return err
		}
		if status, err = c.post(ctx, path, token, body); err != nil {
			return err
		}
	}
	if status < 200 || status >= 300 {
		return fmt.Errorf("push-relay %s returned status %d", path, status)
	}
	return nil
}

// session returns a cached session token, minting a new one via the signed-auth
// login flow when there is none, it has (nearly) expired, or force is set.
func (c *Client) session(ctx context.Context, force bool) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if !force && c.sessionToken != "" && time.Now().Before(c.sessionExp) {
		return c.sessionToken, nil
	}
	if c.signer == nil {
		return "", fmt.Errorf("push-relay: no signer configured")
	}
	aid := c.signer.AID()
	if aid == "" {
		return "", fmt.Errorf("push-relay: signer has no AID")
	}

	// 1. Ask for a challenge nonce bound to our AID.
	var chal struct {
		Challenge string `json:"challenge"`
		ExpiresAt string `json:"expiresAt"`
	}
	if err := c.postJSON(ctx, "/auth/challenge", "", map[string]string{"aid": aid}, &chal); err != nil {
		return "", fmt.Errorf("push-relay challenge: %w", err)
	}
	if chal.Challenge == "" {
		return "", fmt.Errorf("push-relay challenge: empty nonce")
	}

	// 2. Sign it with the AID key and exchange for a session token.
	sig, err := c.signer.Sign(ctx, chal.Challenge)
	if err != nil {
		return "", fmt.Errorf("push-relay sign challenge: %w", err)
	}
	var login struct {
		Token     string `json:"token"`
		ExpiresAt string `json:"expiresAt"`
	}
	if err := c.postJSON(ctx, "/auth/login", "", map[string]string{
		"aid":       aid,
		"challenge": chal.Challenge,
		"signature": sig,
	}, &login); err != nil {
		return "", fmt.Errorf("push-relay login: %w", err)
	}
	if login.Token == "" {
		return "", fmt.Errorf("push-relay login: empty token")
	}

	// Cache with a small safety margin so we refresh before the relay expires it.
	c.sessionToken = login.Token
	c.sessionExp = time.Now().Add(25 * time.Minute)
	if exp, perr := time.Parse(time.RFC3339, login.ExpiresAt); perr == nil {
		if margin := exp.Add(-30 * time.Second); margin.After(time.Now()) {
			c.sessionExp = margin
		}
	}
	return c.sessionToken, nil
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
	defer resp.Body.Close()
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
	defer resp.Body.Close()
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
