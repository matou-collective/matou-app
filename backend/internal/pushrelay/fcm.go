package pushrelay

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// fcmScope is the OAuth2 scope required to send FCM v1 messages.
const fcmScope = "https://www.googleapis.com/auth/firebase.messaging"

// defaultFCMBaseURL is Google's FCM v1 host. Overridden in tests by a
// mocked httptest endpoint.
const defaultFCMBaseURL = "https://fcm.googleapis.com"

// PushMessage is a single content-free wake signal for one device token. Data
// is the tiny field budget from §4 (t/c/k/v); Priority is "high" (DM) or
// "normal" (channel). There is deliberately no notification/title/body field —
// the relay must never carry renderable content.
type PushMessage struct {
	Token    string
	Data     map[string]string
	Priority string // "high" | "normal"
}

// PushResult reports the outcome of dispatching one PushMessage.
type PushResult struct {
	Token string
	// Unregistered is true when FCM reports the token as
	// NotRegistered/Unregistered, so the relay should prune it.
	Unregistered bool
	Err          error
}

// FCMSender dispatches content-free push messages. The relay depends on this
// interface so tests can substitute a recorder or point the concrete client at
// a mocked FCM endpoint.
type FCMSender interface {
	Send(ctx context.Context, msgs []PushMessage) []PushResult
}

// NoopFCM is an FCMSender that dispatches nothing and reports every message as
// delivered. Used when the relay runs without an FCM credential
// (MATOU_PUSH_RELAY_FCM_DISABLED) for dev/dry-run, keeping the relay's other
// behaviour (auth, store, opt-out) exercisable.
type NoopFCM struct{}

// Send reports every message as delivered without contacting FCM.
func (NoopFCM) Send(_ context.Context, msgs []PushMessage) []PushResult {
	out := make([]PushResult, len(msgs))
	for i, m := range msgs {
		out[i] = PushResult{Token: m.Token}
	}
	return out
}

// tokenSource yields a short-lived OAuth2 access token for the FCM API.
type tokenSource interface {
	token(ctx context.Context) (string, error)
}

// FCMClient sends data-only messages through the FCM v1 HTTP API.
type FCMClient struct {
	baseURL   string
	projectID string
	tokens    tokenSource
	http      *http.Client
}

// NewFCMClient builds an FCMClient from a Google service-account credential
// file (the JSON key Firebase issues). It is the only place the FCM server
// credential is read; the relay is the single holder of it (§3).
func NewFCMClient(credentialsPath string) (*FCMClient, error) {
	data, err := os.ReadFile(credentialsPath)
	if err != nil {
		return nil, fmt.Errorf("read FCM credentials: %w", err)
	}
	ts, projectID, err := newServiceAccountTokenSource(data)
	if err != nil {
		return nil, err
	}
	return &FCMClient{
		baseURL:   defaultFCMBaseURL,
		projectID: projectID,
		tokens:    ts,
		http:      &http.Client{Timeout: 10 * time.Second},
	}, nil
}

// Send dispatches each message individually (FCM v1 has no multicast) and
// returns a result per message in the same order.
func (c *FCMClient) Send(ctx context.Context, msgs []PushMessage) []PushResult {
	results := make([]PushResult, len(msgs))
	access, err := c.tokens.token(ctx)
	if err != nil {
		for i, m := range msgs {
			results[i] = PushResult{Token: m.Token, Err: fmt.Errorf("mint FCM access token: %w", err)}
		}
		return results
	}
	for i, m := range msgs {
		results[i] = c.sendOne(ctx, access, m)
	}
	return results
}

// APNs config constants for the content-free wake. Firebase relays to iOS
// through APNs; without an apns block an iOS token gets default treatment and
// is not woken in the background, so the §5 wake-to-sync never runs.
const (
	// apnsPushTypeBackground is the only correct push type for this relay: it
	// never carries renderable text (§4 composes it on-device after sync), so
	// an "alert" push with no alert payload would neither display nor be
	// well-formed. content-available:1 in the aps dict is what wakes the app.
	apnsPushTypeBackground = "background"
	// apnsPriorityBackground is the apns-priority for a content-free background
	// push. APNs returns BadPriority for priority 10 when the payload carries
	// only content-available and no alert (Apple, "Sending notification
	// requests to APNs"); 10 is legal only alongside a visible alert, which the
	// content-free guarantee forbids. 5 is the highest legal background
	// priority, so the Android high/normal distinction has no APNs analogue for
	// these wakes — DM and channel both go out at 5. (Deviates from #272's
	// requested "10 for DM"; ruled under ADR 0174 on that issue.)
	apnsPriorityBackground = "5"
)

// fcmV1Message is the wire shape POSTed to messages:send. Data-only: there is
// no "notification" member, by design (§4). The apns block carries only the
// content-free background wake (headers + aps.content-available) — never an
// alert/title/body/badge.
type fcmV1Message struct {
	Message struct {
		Token   string            `json:"token"`
		Data    map[string]string `json:"data"`
		Android struct {
			Priority string `json:"priority"`
		} `json:"android"`
		APNS struct {
			Headers struct {
				Priority string `json:"apns-priority"`
				PushType string `json:"apns-push-type"`
			} `json:"headers"`
			Payload struct {
				APS struct {
					ContentAvailable int `json:"content-available"`
				} `json:"aps"`
			} `json:"payload"`
		} `json:"apns"`
	} `json:"message"`
}

func (c *FCMClient) sendOne(ctx context.Context, access string, m PushMessage) PushResult {
	var body fcmV1Message
	body.Message.Token = m.Token
	body.Message.Data = m.Data
	body.Message.Android.Priority = m.Priority
	// The apns block is sent for every token; FCM ignores it for Android
	// devices just as it ignores the android block for iOS ones.
	body.Message.APNS.Headers.PushType = apnsPushTypeBackground
	body.Message.APNS.Headers.Priority = apnsPriorityBackground
	body.Message.APNS.Payload.APS.ContentAvailable = 1
	buf, err := json.Marshal(body)
	if err != nil {
		return PushResult{Token: m.Token, Err: err}
	}
	endpoint := fmt.Sprintf("%s/v1/projects/%s/messages:send", strings.TrimRight(c.baseURL, "/"), c.projectID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(buf))
	if err != nil {
		return PushResult{Token: m.Token, Err: err}
	}
	req.Header.Set("Authorization", "Bearer "+access)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return PushResult{Token: m.Token, Err: err}
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode == http.StatusOK {
		return PushResult{Token: m.Token}
	}
	if isUnregistered(respBody) {
		return PushResult{Token: m.Token, Unregistered: true, Err: fmt.Errorf("token unregistered")}
	}
	return PushResult{Token: m.Token, Err: fmt.Errorf("FCM returned %d: %s", resp.StatusCode, strings.TrimSpace(string(respBody)))}
}

// fcmErrorEnvelope models the error body FCM v1 returns; errorCode UNREGISTERED
// or status NOT_FOUND both mean the token is dead and must be pruned.
type fcmErrorEnvelope struct {
	Error struct {
		Status  string `json:"status"`
		Details []struct {
			ErrorCode string `json:"errorCode"`
		} `json:"details"`
	} `json:"error"`
}

func isUnregistered(body []byte) bool {
	var env fcmErrorEnvelope
	if err := json.Unmarshal(body, &env); err != nil {
		return false
	}
	if env.Error.Status == "NOT_FOUND" {
		return true
	}
	for _, d := range env.Error.Details {
		if d.ErrorCode == "UNREGISTERED" || d.ErrorCode == "NOT_FOUND" {
			return true
		}
	}
	return false
}

// serviceAccount is the subset of a Google service-account key we use.
type serviceAccount struct {
	ClientEmail string `json:"client_email"`
	PrivateKey  string `json:"private_key"`
	TokenURI    string `json:"token_uri"`
	ProjectID   string `json:"project_id"`
}

// saTokenSource mints FCM access tokens by signing a JWT bearer grant with the
// service-account private key (RS256, standard library only) and exchanging it
// at the account's token endpoint. Tokens are cached until shortly before
// expiry.
type saTokenSource struct {
	sa      serviceAccount
	key     *rsa.PrivateKey
	http    *http.Client
	now     func() time.Time
	baseURL string // overridable token endpoint host for tests; "" = sa.TokenURI

	mu     sync.Mutex
	cached string
	expiry time.Time
}

func newServiceAccountTokenSource(data []byte) (*saTokenSource, string, error) {
	var sa serviceAccount
	if err := json.Unmarshal(data, &sa); err != nil {
		return nil, "", fmt.Errorf("parse service account: %w", err)
	}
	if sa.ClientEmail == "" || sa.PrivateKey == "" || sa.ProjectID == "" {
		return nil, "", fmt.Errorf("service account missing client_email, private_key or project_id")
	}
	if sa.TokenURI == "" {
		sa.TokenURI = "https://oauth2.googleapis.com/token"
	}
	key, err := parseRSAPrivateKey(sa.PrivateKey)
	if err != nil {
		return nil, "", err
	}
	return &saTokenSource{sa: sa, key: key, http: &http.Client{Timeout: 10 * time.Second}, now: time.Now}, sa.ProjectID, nil
}

func parseRSAPrivateKey(pemStr string) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode([]byte(pemStr))
	if block == nil {
		return nil, fmt.Errorf("no PEM block in private key")
	}
	if key, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return key, nil
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse private key: %w", err)
	}
	key, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("service account key is not RSA")
	}
	return key, nil
}

func (t *saTokenSource) token(ctx context.Context) (string, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.cached != "" && t.now().Before(t.expiry.Add(-30*time.Second)) {
		return t.cached, nil
	}
	assertion, err := t.signedJWT()
	if err != nil {
		return "", err
	}
	form := url.Values{}
	form.Set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer")
	form.Set("assertion", assertion)

	endpoint := t.sa.TokenURI
	if t.baseURL != "" {
		endpoint = t.baseURL
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := t.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("token endpoint returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var tok struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &tok); err != nil {
		return "", fmt.Errorf("parse token response: %w", err)
	}
	if tok.AccessToken == "" {
		return "", fmt.Errorf("token endpoint returned no access_token")
	}
	ttl := time.Duration(tok.ExpiresIn) * time.Second
	if ttl <= 0 {
		ttl = time.Hour
	}
	t.cached = tok.AccessToken
	t.expiry = t.now().Add(ttl)
	return t.cached, nil
}

// signedJWT builds and RS256-signs the JWT bearer assertion for the token
// exchange (RFC 7523 / Google service-account flow).
func (t *saTokenSource) signedJWT() (string, error) {
	now := t.now()
	header := map[string]string{"alg": "RS256", "typ": "JWT"}
	claims := map[string]any{
		"iss":   t.sa.ClientEmail,
		"scope": fcmScope,
		"aud":   t.sa.TokenURI,
		"iat":   now.Unix(),
		"exp":   now.Add(time.Hour).Unix(),
	}
	headerJSON, err := json.Marshal(header)
	if err != nil {
		return "", err
	}
	claimsJSON, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	signingInput := base64.RawURLEncoding.EncodeToString(headerJSON) + "." + base64.RawURLEncoding.EncodeToString(claimsJSON)
	digest := sha256.Sum256([]byte(signingInput))
	sig, err := rsa.SignPKCS1v15(rand.Reader, t.key, crypto.SHA256, digest[:])
	if err != nil {
		return "", fmt.Errorf("sign JWT: %w", err)
	}
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(sig), nil
}
