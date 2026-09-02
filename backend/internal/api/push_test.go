package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/matou-dao/backend/internal/pushrelayclient"
)

// fakeRegistrar records the token/platform forwarded to the relay. It never
// sees an AID on register — the relay client binds that from the signed session
// — which is exactly the property the handler must preserve. The session-mint
// round-trips are recorded so the challenge→signature→session wiring can be
// asserted.
type fakeRegistrar struct {
	registered   []regCall
	deregistered []string
	err          error

	challengeAID string     // AID the handler asked a challenge for
	sessionAID   string     // AID the live session is minted for (SessionAID)
	sessions     []sessCall // AID/challenge/signature exchanged for a session
	challengeErr error      // force RelayChallenge to fail
	sessionErr   error      // force RelaySession to fail
}

type regCall struct {
	token    string
	platform string
}

type sessCall struct {
	aid       string
	challenge string
	signature string
}

func (f *fakeRegistrar) RelayChallenge(_ context.Context, aid string) (string, time.Time, error) {
	if f.challengeErr != nil {
		return "", time.Time{}, f.challengeErr
	}
	f.challengeAID = aid
	return "nonce-for-" + aid, time.Time{}, nil
}

func (f *fakeRegistrar) RelaySession(_ context.Context, aid, challenge, signature string) (time.Time, error) {
	if f.sessionErr != nil {
		return time.Time{}, f.sessionErr
	}
	f.sessions = append(f.sessions, sessCall{aid: aid, challenge: challenge, signature: signature})
	return time.Time{}, nil
}

func (f *fakeRegistrar) SessionAID() string { return f.sessionAID }

func (f *fakeRegistrar) Register(_ context.Context, token, platform string) error {
	if f.err != nil {
		return f.err
	}
	f.registered = append(f.registered, regCall{token: token, platform: platform})
	return nil
}

func (f *fakeRegistrar) Deregister(_ context.Context, token string) error {
	if f.err != nil {
		return f.err
	}
	f.deregistered = append(f.deregistered, token)
	return nil
}

type fakeAID struct{ aid string }

func (f fakeAID) GetAID() string { return f.aid }

func TestPushHandler_Register_ForwardsTokenAndPlatform(t *testing.T) {
	relay := &fakeRegistrar{}
	h := NewPushHandler(relay, fakeAID{aid: "aid-alice"})

	body := `{"token":"fcm-tok-123","platform":"android"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/push/register", strings.NewReader(body))
	rec := httptest.NewRecorder()
	h.HandleRegister(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if len(relay.registered) != 1 {
		t.Fatalf("expected 1 forwarded registration, got %d", len(relay.registered))
	}
	if got := relay.registered[0]; got.token != "fcm-tok-123" || got.platform != "android" {
		t.Errorf("forwarded %+v, want {fcm-tok-123 android}", got)
	}
}

func TestPushHandler_Register_AIDFromSessionNotBody(t *testing.T) {
	relay := &fakeRegistrar{}
	h := NewPushHandler(relay, fakeAID{aid: "aid-session"})

	// A malicious body tries to smuggle a different AID; the handler must ignore
	// it entirely (the relay client binds the AID from the signed session).
	body := `{"token":"fcm-tok","platform":"android","aid":"aid-attacker"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/push/register", strings.NewReader(body))
	req = withVerifiedAID(req, "aid-session")
	rec := httptest.NewRecorder()
	h.HandleRegister(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	// The forwarded payload carries no AID at all — the token/platform are the
	// only caller-supplied values, so the body's "aid" can never reach the relay.
	if len(relay.registered) != 1 || relay.registered[0].token != "fcm-tok" {
		t.Fatalf("unexpected forwarded registration: %+v", relay.registered)
	}
}

func TestPushHandler_Register_DefaultsPlatform(t *testing.T) {
	relay := &fakeRegistrar{}
	h := NewPushHandler(relay, fakeAID{aid: "aid-alice"})

	req := httptest.NewRequest(http.MethodPost, "/api/v1/push/register", strings.NewReader(`{"token":"t"}`))
	rec := httptest.NewRecorder()
	h.HandleRegister(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	// The relay client fills in the default platform; the handler forwards the
	// empty string it received unchanged.
	if len(relay.registered) != 1 || relay.registered[0].platform != "" {
		t.Fatalf("expected empty platform forwarded, got %+v", relay.registered)
	}
}

func TestPushHandler_Register_RejectsMissingToken(t *testing.T) {
	relay := &fakeRegistrar{}
	h := NewPushHandler(relay, fakeAID{aid: "aid-alice"})

	req := httptest.NewRequest(http.MethodPost, "/api/v1/push/register", strings.NewReader(`{"platform":"android"}`))
	rec := httptest.NewRecorder()
	h.HandleRegister(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if len(relay.registered) != 0 {
		t.Errorf("must not forward without a token")
	}
}

func TestPushHandler_Register_RejectsWrongMethod(t *testing.T) {
	h := NewPushHandler(&fakeRegistrar{}, fakeAID{aid: "aid-alice"})
	req := httptest.NewRequest(http.MethodGet, "/api/v1/push/register", nil)
	rec := httptest.NewRecorder()
	h.HandleRegister(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", rec.Code)
	}
}

func TestPushHandler_Register_NoIdentityUnauthorized(t *testing.T) {
	h := NewPushHandler(&fakeRegistrar{}, fakeAID{aid: ""})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/push/register", strings.NewReader(`{"token":"t"}`))
	rec := httptest.NewRecorder()
	h.HandleRegister(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 when no identity is configured", rec.Code)
	}
}

func TestPushHandler_NilRelayUnavailable(t *testing.T) {
	h := NewPushHandler(nil, fakeAID{aid: "aid-alice"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/push/register", strings.NewReader(`{"token":"t"}`))
	rec := httptest.NewRecorder()
	h.HandleRegister(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 when relay unconfigured", rec.Code)
	}
}

func TestPushHandler_Register_RelayErrorIsBadGateway(t *testing.T) {
	relay := &fakeRegistrar{err: context.DeadlineExceeded}
	h := NewPushHandler(relay, fakeAID{aid: "aid-alice"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/push/register", strings.NewReader(`{"token":"t"}`))
	rec := httptest.NewRecorder()
	h.HandleRegister(rec, req)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502 on relay failure", rec.Code)
	}
}

func TestPushHandler_Deregister_ForwardsToken(t *testing.T) {
	relay := &fakeRegistrar{}
	h := NewPushHandler(relay, fakeAID{aid: "aid-alice"})

	req := httptest.NewRequest(http.MethodPost, "/api/v1/push/deregister", strings.NewReader(`{"token":"gone"}`))
	rec := httptest.NewRecorder()
	h.HandleDeregister(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if len(relay.deregistered) != 1 || relay.deregistered[0] != "gone" {
		t.Fatalf("expected token 'gone' deregistered, got %v", relay.deregistered)
	}
}

func TestPushHandler_Deregister_RejectsMissingToken(t *testing.T) {
	relay := &fakeRegistrar{}
	h := NewPushHandler(relay, fakeAID{aid: "aid-alice"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/push/deregister", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()
	h.HandleDeregister(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if len(relay.deregistered) != 0 {
		t.Errorf("must not forward deregister without a token")
	}
}

// Sanity: responses are JSON so the frontend can parse errors uniformly.
func TestPushHandler_ResponsesAreJSON(t *testing.T) {
	h := NewPushHandler(&fakeRegistrar{}, fakeAID{aid: "aid-alice"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/push/register", strings.NewReader(`{"token":"t"}`))
	rec := httptest.NewRecorder()
	h.HandleRegister(rec, req)
	var out map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("response not JSON: %v", err)
	}
	if out["status"] != "registered" {
		t.Errorf("status field = %q, want registered", out["status"])
	}
}

// --- relay-session mint surface (#277) ---

// TestPushHandler_RelayChallenge_BindsSessionAID: the challenge is requested for
// the authenticated AID, never a client-supplied one, and echoed back so the
// WebView signs the right message.
func TestPushHandler_RelayChallenge_BindsSessionAID(t *testing.T) {
	relay := &fakeRegistrar{}
	h := NewPushHandler(relay, fakeAID{aid: "aid-local"})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/push/relay-challenge", nil)
	req = withVerifiedAID(req, "aid-session")
	rec := httptest.NewRecorder()
	h.HandleRelayChallenge(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if relay.challengeAID != "aid-session" {
		t.Errorf("challenge requested for %q, want the verified session AID", relay.challengeAID)
	}
	var out map[string]string
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["aid"] != "aid-session" || out["challenge"] != "nonce-for-aid-session" {
		t.Errorf("challenge response = %v", out)
	}
}

func TestPushHandler_RelayChallenge_RejectsWrongMethod(t *testing.T) {
	h := NewPushHandler(&fakeRegistrar{}, fakeAID{aid: "aid-local"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/push/relay-challenge", nil)
	rec := httptest.NewRecorder()
	h.HandleRelayChallenge(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", rec.Code)
	}
}

func TestPushHandler_RelayChallenge_NoIdentityUnauthorized(t *testing.T) {
	h := NewPushHandler(&fakeRegistrar{}, fakeAID{aid: ""})
	req := httptest.NewRequest(http.MethodGet, "/api/v1/push/relay-challenge", nil)
	rec := httptest.NewRecorder()
	h.HandleRelayChallenge(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

// TestPushHandler_RelaySession_ForwardsSignatureWithSessionAID: the handler
// forwards the WebView's challenge+signature to the relay login under the
// authenticated AID, and ignores any AID a caller tries to smuggle in the body.
func TestPushHandler_RelaySession_ForwardsSignatureWithSessionAID(t *testing.T) {
	relay := &fakeRegistrar{}
	h := NewPushHandler(relay, fakeAID{aid: "aid-local"})

	body := `{"challenge":"nonce-123","signature":"0Bsig","aid":"aid-attacker"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/push/relay-session", strings.NewReader(body))
	req = withVerifiedAID(req, "aid-session")
	rec := httptest.NewRecorder()
	h.HandleRelaySession(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if len(relay.sessions) != 1 {
		t.Fatalf("expected one session mint, got %d", len(relay.sessions))
	}
	got := relay.sessions[0]
	if got.aid != "aid-session" || got.challenge != "nonce-123" || got.signature != "0Bsig" {
		t.Errorf("relay login = %+v, want aid-session/nonce-123/0Bsig (body AID ignored)", got)
	}
}

func TestPushHandler_RelaySession_RejectsMissingFields(t *testing.T) {
	h := NewPushHandler(&fakeRegistrar{}, fakeAID{aid: "aid-local"})
	for _, body := range []string{`{"challenge":"n"}`, `{"signature":"s"}`, `{}`} {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/push/relay-session", strings.NewReader(body))
		rec := httptest.NewRecorder()
		h.HandleRelaySession(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("body %s: status = %d, want 400", body, rec.Code)
		}
	}
}

func TestPushHandler_RelaySession_RelayErrorIsBadGateway(t *testing.T) {
	relay := &fakeRegistrar{sessionErr: context.DeadlineExceeded}
	h := NewPushHandler(relay, fakeAID{aid: "aid-local"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/push/relay-session", strings.NewReader(`{"challenge":"n","signature":"s"}`))
	rec := httptest.NewRecorder()
	h.HandleRelaySession(rec, req)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502 on relay login failure", rec.Code)
	}
}

// TestPushHandler_Register_NoSessionIs401: when the relay client has no live
// session (ErrNoSession), register answers 401 — the signal the frontend uses to
// re-mint a session — rather than the generic 502.
func TestPushHandler_Register_NoSessionIs401(t *testing.T) {
	relay := &fakeRegistrar{err: pushrelayclient.ErrNoSession}
	h := NewPushHandler(relay, fakeAID{aid: "aid-local"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/push/register", strings.NewReader(`{"token":"t"}`))
	rec := httptest.NewRecorder()
	h.HandleRegister(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 when the relay session is missing", rec.Code)
	}
}

// TestPushHandler_Register_StaleSessionForOtherAIDIs401: a live relay session
// minted for a previous identity must not be spent on a register — that would
// bind the device token to the OLD AID at the relay. The handler answers 401 so
// the frontend mints a session for the current identity first. (Deregister has
// no such check on purpose: releasing the old identity's token must spend the
// old session, since the relay enforces token ownership.)
func TestPushHandler_Register_StaleSessionForOtherAIDIs401(t *testing.T) {
	relay := &fakeRegistrar{sessionAID: "aid-old-identity"}
	h := NewPushHandler(relay, fakeAID{aid: "aid-new-identity"})

	rec := httptest.NewRecorder()
	h.HandleRegister(rec, httptest.NewRequest(http.MethodPost, "/api/v1/push/register",
		strings.NewReader(`{"token":"tok-1","platform":"android"}`)))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("register with a session for another AID = %d, want 401", rec.Code)
	}
	if len(relay.registered) != 0 {
		t.Fatalf("the stale session was spent: %+v", relay.registered)
	}

	// Deregister must still go through — the old token belongs to the old AID.
	rec = httptest.NewRecorder()
	h.HandleDeregister(rec, httptest.NewRequest(http.MethodPost, "/api/v1/push/deregister",
		strings.NewReader(`{"token":"tok-0"}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("deregister with the old session = %d, want 200", rec.Code)
	}
}
