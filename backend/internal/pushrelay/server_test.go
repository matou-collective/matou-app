package pushrelay

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/matou-dao/backend/internal/auth"
)

// --- CESR test helpers (mirror internal/auth test helpers) ---

func encodeVerferD(pub ed25519.PublicKey) string {
	raw := make([]byte, 1+len(pub))
	copy(raw[1:], pub)
	b64 := base64.URLEncoding.EncodeToString(raw)
	return "D" + b64[1:]
}

func encodeSig0B(sig []byte) string {
	raw := make([]byte, 2+len(sig))
	copy(raw[2:], sig)
	b64 := base64.URLEncoding.EncodeToString(raw)
	return "0B" + b64[2:]
}

// staticToken is a tokenSource that always yields the same access token.
type staticToken string

func (s staticToken) token(context.Context) (string, error) { return string(s), nil }

// mockFCM records the messages it receives and returns UNREGISTERED for tokens
// in unregistered. It mimics the FCM v1 messages:send endpoint.
type mockFCM struct {
	server       *httptest.Server
	unregistered map[string]bool

	mu       sync.Mutex
	received []fcmV1Message
}

func newMockFCM(unregistered ...string) *mockFCM {
	m := &mockFCM{unregistered: map[string]bool{}}
	for _, t := range unregistered {
		m.unregistered[t] = true
	}
	m.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var msg fcmV1Message
		if err := json.NewDecoder(r.Body).Decode(&msg); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		m.mu.Lock()
		m.received = append(m.received, msg)
		m.mu.Unlock()
		if m.unregistered[msg.Message.Token] {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}`))
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"name":"projects/p/messages/1"}`))
	}))
	return m
}

func (m *mockFCM) client() *FCMClient {
	return &FCMClient{
		baseURL:   m.server.URL,
		projectID: "test-project",
		tokens:    staticToken("access"),
		http:      m.server.Client(),
	}
}

func (m *mockFCM) messages() []fcmV1Message {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]fcmV1Message(nil), m.received...)
}

func (m *mockFCM) close() { m.server.Close() }

// testAID returns a syntactically valid 44-char AID together with an ed25519
// keypair, and registers the key as the AID's key state on the resolver.
func testAID(res *auth.StaticKeyStateResolver) (aid string, priv ed25519.PrivateKey) {
	aidPub, _, _ := ed25519.GenerateKey(nil)
	pub, p, _ := ed25519.GenerateKey(nil)
	aid = encodeVerferD(aidPub)
	res.Set(aid, []string{encodeVerferD(pub)})
	return aid, p
}

// newTestServer wires a relay Server with a static resolver and the given FCM
// sender. It returns the server, the resolver (to register AID key state) and
// the underlying store.
func newTestServer(fcm FCMSender) (*Server, *auth.StaticKeyStateResolver, *Store) {
	res := auth.NewStaticKeyStateResolver()
	verifier := auth.NewVerifier(res, auth.NewChallengeStore(time.Minute), auth.NewSessionStore(time.Hour))
	store, _ := NewStore("", time.Hour)
	srv := NewServer(Config{Verifier: verifier, Store: store, FCM: fcm, CoalesceWindow: 0})
	return srv, res, store
}

// login runs the full signed-challenge flow against the relay HTTP surface and
// returns a bearer token — exercising the reused signed-auth verification.
func login(t *testing.T, h http.Handler, aid string, priv ed25519.PrivateKey) string {
	t.Helper()
	// challenge
	rec := do(h, http.MethodPost, "/auth/challenge", "", map[string]string{"aid": aid})
	if rec.Code != http.StatusOK {
		t.Fatalf("challenge: %d %s", rec.Code, rec.Body.String())
	}
	var ch struct {
		Challenge string `json:"challenge"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &ch)
	// login
	sig := encodeSig0B(ed25519.Sign(priv, auth.SignedMessage(aid, ch.Challenge)))
	rec = do(h, http.MethodPost, "/auth/login", "", map[string]any{"aid": aid, "challenge": ch.Challenge, "signature": sig})
	if rec.Code != http.StatusOK {
		t.Fatalf("login: %d %s", rec.Code, rec.Body.String())
	}
	var lg struct {
		Token string `json:"token"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &lg)
	if lg.Token == "" {
		t.Fatal("login returned empty token")
	}
	return lg.Token
}

// do issues a JSON request against the handler with an optional bearer token.
func do(h http.Handler, method, path, bearer string, body any) *httptest.ResponseRecorder {
	var buf bytes.Buffer
	if body != nil {
		_ = json.NewEncoder(&buf).Encode(body)
	}
	req := httptest.NewRequest(method, path, &buf)
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// doRaw issues a request with a raw (possibly malformed) JSON body.
func doRaw(h http.Handler, method, path, bearer, raw string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(raw))
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// --- tests ---

// Protected routes reject requests without a valid session (signed-auth).
func TestSignedAuthRejection(t *testing.T) {
	srv, _, _ := newTestServer(NoopFCM{})
	h := srv.Handler()

	for _, path := range []string{"/register", "/deregister", "/optout", "/notify"} {
		// No token.
		if rec := do(h, http.MethodPost, path, "", map[string]string{}); rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s without token: expected 401, got %d", path, rec.Code)
		}
		// Bogus token.
		if rec := do(h, http.MethodPost, path, "not-a-session", map[string]string{}); rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s with bogus token: expected 401, got %d", path, rec.Code)
		}
	}
}

func TestRegisterDeregister(t *testing.T) {
	srv, res, store := newTestServer(NoopFCM{})
	h := srv.Handler()
	aid, priv := testAID(res)
	tok := login(t, h, aid, priv)

	if rec := do(h, http.MethodPost, "/register", tok, map[string]string{"token": "device-1", "platform": "android"}); rec.Code != http.StatusOK {
		t.Fatalf("register: %d %s", rec.Code, rec.Body.String())
	}
	if got := store.TokensForAID(aid); len(got) != 1 || got[0].Token != "device-1" {
		t.Fatalf("token not stored for %s: %+v", aid, got)
	}
	if rec := do(h, http.MethodPost, "/deregister", tok, map[string]string{"token": "device-1"}); rec.Code != http.StatusOK {
		t.Fatalf("deregister: %d %s", rec.Code, rec.Body.String())
	}
	if got := store.TokensForAID(aid); len(got) != 0 {
		t.Fatalf("token not removed: %+v", got)
	}
}

// The registered AID is taken from the session, never the request body.
func TestRegisterAIDFromSessionNotBody(t *testing.T) {
	srv, res, store := newTestServer(NoopFCM{})
	h := srv.Handler()
	aid, priv := testAID(res)
	tok := login(t, h, aid, priv)

	// Attempt to smuggle an "aid" field — DisallowUnknownFields rejects it.
	rec := doRaw(h, http.MethodPost, "/register", tok, `{"token":"device-1","platform":"android","aid":"Emallory"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for unknown aid field, got %d", rec.Code)
	}
	// A clean register binds to the session AID only.
	_ = do(h, http.MethodPost, "/register", tok, map[string]string{"token": "device-1"})
	if got := store.TokensForAID(aid); len(got) != 1 {
		t.Fatalf("expected token under session AID, got %+v", got)
	}
}

func TestNotifyFanoutAndPriority(t *testing.T) {
	mock := newMockFCM()
	defer mock.close()
	srv, res, store := newTestServer(mock.client())
	h := srv.Handler()

	sender, sPriv := testAID(res)
	senderTok := login(t, h, sender, sPriv)

	// Two recipients, one with two devices.
	alice, _ := testAID(res)
	bob, _ := testAID(res)
	_ = store.Register(alice, "alice-1", "android")
	_ = store.Register(alice, "alice-2", "android")
	_ = store.Register(bob, "bob-1", "android")

	rec := do(h, http.MethodPost, "/notify", senderTok, map[string]any{
		"recipients": []string{alice, bob},
		"channel":    "chan-xyz",
		"kind":       "dm",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("notify: %d %s", rec.Code, rec.Body.String())
	}
	msgs := mock.messages()
	if len(msgs) != 3 {
		t.Fatalf("expected 3 pushes (2 alice + 1 bob), got %d", len(msgs))
	}
	for _, m := range msgs {
		if m.Message.Android.Priority != "high" {
			t.Fatalf("dm must be high priority, got %q", m.Message.Android.Priority)
		}
		if m.Message.Data["k"] != "dm" || m.Message.Data["t"] != "m" || m.Message.Data["c"] != "chan-xyz" || m.Message.Data["v"] != "1" {
			t.Fatalf("unexpected data payload: %+v", m.Message.Data)
		}
	}

	// Channel messages are normal priority.
	mock2 := newMockFCM()
	defer mock2.close()
	srv.fcm = mock2.client()
	_ = do(h, http.MethodPost, "/notify", senderTok, map[string]any{
		"recipients": []string{bob}, "channel": "chan-xyz", "kind": "ch",
	})
	ch := mock2.messages()
	if len(ch) != 1 || ch[0].Message.Android.Priority != "normal" || ch[0].Message.Data["k"] != "ch" {
		t.Fatalf("channel push must be normal priority with k=ch, got %+v", ch)
	}
}

// Data-only: no notification block ever leaves the relay (content-free).
func TestNotifyPayloadHasNoNotificationBlock(t *testing.T) {
	mock := newMockFCM()
	defer mock.close()
	srv, res, store := newTestServer(mock.client())
	h := srv.Handler()
	sender, sPriv := testAID(res)
	tok := login(t, h, sender, sPriv)
	alice, _ := testAID(res)
	_ = store.Register(alice, "alice-1", "android")

	_ = do(h, http.MethodPost, "/notify", tok, map[string]any{
		"recipients": []string{alice}, "channel": "c1", "kind": "dm",
	})
	// The wire type has no notification field; assert the raw JSON too.
	msgs := mock.messages()
	if len(msgs) != 1 {
		t.Fatalf("expected 1 push, got %d", len(msgs))
	}
	raw, _ := json.Marshal(msgs[0])
	if strings.Contains(strings.ToLower(string(raw)), "notification") {
		t.Fatalf("payload must not contain a notification block: %s", raw)
	}
}

func TestNotifyOptOutDrop(t *testing.T) {
	mock := newMockFCM()
	defer mock.close()
	srv, res, store := newTestServer(mock.client())
	h := srv.Handler()
	sender, sPriv := testAID(res)
	tok := login(t, h, sender, sPriv)

	alice, _ := testAID(res)
	bob, _ := testAID(res)
	_ = store.Register(alice, "alice-1", "android")
	_ = store.Register(bob, "bob-1", "android")
	_ = store.SetOptOut(bob, true)

	_ = do(h, http.MethodPost, "/notify", tok, map[string]any{
		"recipients": []string{alice, bob}, "channel": "c1", "kind": "dm",
	})
	msgs := mock.messages()
	if len(msgs) != 1 || msgs[0].Message.Token != "alice-1" {
		t.Fatalf("opted-out bob must be dropped, got %+v", msgs)
	}
}

func TestNotifyPrunesUnregisteredToken(t *testing.T) {
	mock := newMockFCM("dead-token")
	defer mock.close()
	srv, res, store := newTestServer(mock.client())
	h := srv.Handler()
	sender, sPriv := testAID(res)
	tok := login(t, h, sender, sPriv)

	alice, _ := testAID(res)
	_ = store.Register(alice, "dead-token", "android")
	_ = store.Register(alice, "live-token", "android")

	_ = do(h, http.MethodPost, "/notify", tok, map[string]any{
		"recipients": []string{alice}, "channel": "c1", "kind": "dm",
	})
	got := store.TokensForAID(alice)
	if len(got) != 1 || got[0].Token != "live-token" {
		t.Fatalf("dead token must be pruned, live kept: %+v", got)
	}
}

// A notify body with any unexpected field (content smuggling) is rejected and
// nothing is dispatched.
func TestNotifyRejectsUnknownFields(t *testing.T) {
	mock := newMockFCM()
	defer mock.close()
	srv, res, store := newTestServer(mock.client())
	h := srv.Handler()
	sender, sPriv := testAID(res)
	tok := login(t, h, sender, sPriv)
	alice, _ := testAID(res)
	_ = store.Register(alice, "alice-1", "android")

	for _, raw := range []string{
		`{"recipients":["` + alice + `"],"channel":"c1","kind":"dm","body":"secret message"}`,
		`{"recipients":["` + alice + `"],"channel":"c1","kind":"dm","title":"Alice"}`,
		`{"recipients":["` + alice + `"],"channel":"c1","kind":"dm","sender":"Ebob"}`,
	} {
		rec := doRaw(h, http.MethodPost, "/notify", tok, raw)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 for content field, got %d (%s)", rec.Code, raw)
		}
	}
	if len(mock.messages()) != 0 {
		t.Fatalf("no push must be dispatched for rejected bodies, got %d", len(mock.messages()))
	}
}

func TestNotifyRejectsBadKind(t *testing.T) {
	srv, res, store := newTestServer(NoopFCM{})
	h := srv.Handler()
	sender, sPriv := testAID(res)
	tok := login(t, h, sender, sPriv)
	alice, _ := testAID(res)
	_ = store.Register(alice, "alice-1", "android")

	rec := do(h, http.MethodPost, "/notify", tok, map[string]any{
		"recipients": []string{alice}, "channel": "c1", "kind": "email",
	})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for bad kind, got %d", rec.Code)
	}
}

func TestOptOutEndpoint(t *testing.T) {
	srv, res, store := newTestServer(NoopFCM{})
	h := srv.Handler()
	aid, priv := testAID(res)
	tok := login(t, h, aid, priv)

	if rec := do(h, http.MethodPost, "/optout", tok, map[string]bool{"optOut": true}); rec.Code != http.StatusOK {
		t.Fatalf("optout: %d %s", rec.Code, rec.Body.String())
	}
	if !store.IsOptedOut(aid) {
		t.Fatal("expected AID opted out")
	}
}

// Coalescing collapses a burst for the same recipient+channel into one push.
func TestNotifyCoalesces(t *testing.T) {
	mock := newMockFCM()
	defer mock.close()
	res := auth.NewStaticKeyStateResolver()
	verifier := auth.NewVerifier(res, auth.NewChallengeStore(time.Minute), auth.NewSessionStore(time.Hour))
	store, _ := NewStore("", time.Hour)
	srv := NewServer(Config{Verifier: verifier, Store: store, FCM: mock.client(), CoalesceWindow: time.Minute})
	h := srv.Handler()

	sender, sPriv := testAID(res)
	tok := login(t, h, sender, sPriv)
	alice, _ := testAID(res)
	_ = store.Register(alice, "alice-1", "android")

	for i := 0; i < 3; i++ {
		_ = do(h, http.MethodPost, "/notify", tok, map[string]any{
			"recipients": []string{alice}, "channel": "c1", "kind": "dm",
		})
	}
	if n := len(mock.messages()); n != 1 {
		t.Fatalf("burst must coalesce to 1 push, got %d", n)
	}
}

func TestHealth(t *testing.T) {
	srv, _, _ := newTestServer(NoopFCM{})
	rec := do(srv.Handler(), http.MethodGet, "/health", "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("health: %d", rec.Code)
	}
}
