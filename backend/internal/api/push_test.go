package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakeRegistrar records the token/platform forwarded to the relay. It never
// sees an AID — the relay client binds that from the signed session — which is
// exactly the property the handler must preserve.
type fakeRegistrar struct {
	registered   []regCall
	deregistered []string
	err          error
}

type regCall struct {
	token    string
	platform string
}

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
