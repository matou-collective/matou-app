package pushrelay

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
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
// in unregistered. It mimics the FCM v1 messages:send endpoint. It keeps the
// RAW request bytes as well as the decoded message: content-free assertions
// must be made against what actually goes on the wire, not against a struct
// that cannot represent the forbidden fields.
type mockFCM struct {
	server       *httptest.Server
	unregistered map[string]bool

	mu       sync.Mutex
	received []fcmV1Message
	raw      [][]byte
}

func newMockFCM(unregistered ...string) *mockFCM {
	m := &mockFCM{unregistered: map[string]bool{}}
	for _, t := range unregistered {
		m.unregistered[t] = true
	}
	m.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		var msg fcmV1Message
		if err := json.Unmarshal(body, &msg); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		m.mu.Lock()
		m.received = append(m.received, msg)
		m.raw = append(m.raw, body)
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

// rawBodies returns the exact bytes the relay POSTed to the FCM endpoint.
func (m *mockFCM) rawBodies() [][]byte {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([][]byte(nil), m.raw...)
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

// Data-only and content-free: the bytes the relay actually POSTs to FCM carry
// no notification block and nothing the caller could turn into readable text —
// for BOTH the DM and channel kinds, across the android AND apns blocks.
// Asserting on the RAW body matters — re-marshalling the decoded fcmV1Message
// would only restate a compile-time fact and could never fail.
func TestNotifyPayloadIsContentFreeOnTheWire(t *testing.T) {
	srv, res, store := newTestServer(nil)
	h := srv.Handler()
	sender, sPriv := testAID(res)
	tok := login(t, h, sender, sPriv)
	alice, _ := testAID(res)
	_ = store.Register(alice, "alice-1", "ios")

	// Both kinds are content-free background wakes: apns-push-type=background,
	// apns-priority=5 (APNs rejects 10 for a content-only push — see fcm.go and
	// the ADR 0174 ruling on #272), and an aps dict carrying ONLY
	// content-available:1. The channel id is the only caller-controlled value.
	cases := []struct{ kind, channel string }{
		{"dm", "ChatChannel-1756600000000000001"},
		{"ch", "ChatChannel-1756600000000000002"},
	}
	for _, tc := range cases {
		t.Run(tc.kind, func(t *testing.T) {
			mock := newMockFCM()
			defer mock.close()
			srv.fcm = mock.client()

			_ = do(h, http.MethodPost, "/notify", tok, map[string]any{
				"recipients": []string{alice}, "channel": tc.channel, "kind": tc.kind,
			})

			bodies := mock.rawBodies()
			if len(bodies) != 1 {
				t.Fatalf("expected 1 push, got %d", len(bodies))
			}
			raw := string(bodies[0])

			var wire map[string]any
			if err := json.Unmarshal(bodies[0], &wire); err != nil {
				t.Fatalf("FCM body is not JSON: %v", err)
			}
			msg, _ := wire["message"].(map[string]any)
			if msg == nil {
				t.Fatalf("FCM body has no message member: %s", raw)
			}

			// No notification block; no renderable text anywhere on the wire.
			if _, ok := msg["notification"]; ok {
				t.Fatalf("payload must not contain a notification block: %s", raw)
			}
			for _, banned := range []string{"notification", "alert", "title", "badge"} {
				if strings.Contains(strings.ToLower(raw), banned) {
					t.Fatalf("payload must not mention %q anywhere: %s", banned, raw)
				}
			}

			// The data block is exactly the §4 field budget and nothing else.
			data, _ := msg["data"].(map[string]any)
			want := map[string]any{"t": "m", "c": tc.channel, "k": tc.kind, "v": "1"}
			if len(data) != len(want) {
				t.Fatalf("data must carry exactly %d fields, got %+v", len(want), data)
			}
			for k, v := range want {
				if data[k] != v {
					t.Fatalf("data[%q] = %v, want %v", k, data[k], v)
				}
			}

			// The apns block wakes iOS in the background: push-type background,
			// content-free priority 5, content-available:1, and an aps dict
			// carrying nothing else (no alert/title/body/badge).
			apns, _ := msg["apns"].(map[string]any)
			if apns == nil {
				t.Fatalf("payload must carry an apns block to wake iOS in the background: %s", raw)
			}
			headers, _ := apns["headers"].(map[string]any)
			if headers["apns-push-type"] != "background" {
				t.Fatalf("apns-push-type must be background, got %v: %s", headers["apns-push-type"], raw)
			}
			if headers["apns-priority"] != "5" {
				t.Fatalf("apns-priority must be 5 for a content-free wake, got %v: %s", headers["apns-priority"], raw)
			}
			payload, _ := apns["payload"].(map[string]any)
			aps, _ := payload["aps"].(map[string]any)
			if aps == nil {
				t.Fatalf("apns.payload.aps must be present so a data-only push wakes the app: %s", raw)
			}
			if aps["content-available"] != float64(1) {
				t.Fatalf("aps.content-available must be 1, got %v: %s", aps["content-available"], raw)
			}
			if len(aps) != 1 {
				t.Fatalf("aps must carry ONLY content-available (no alert/title/body/badge), got %+v: %s", aps, raw)
			}
		})
	}
}

// The relay must not let a sender smuggle readable text onto a device through
// the one caller-supplied field that reaches it, the channel id (finding 1).
func TestNotifyRejectsNonOpaqueChannel(t *testing.T) {
	mock := newMockFCM()
	defer mock.close()
	srv, res, store := newTestServer(mock.client())
	h := srv.Handler()
	sender, sPriv := testAID(res)
	tok := login(t, h, sender, sPriv)
	alice, _ := testAID(res)
	_ = store.Register(alice, "alice-1", "android")

	for name, channel := range map[string]string{
		"spaces":      "Ben says: meet me at the pa at 8pm",
		"punctuation": "c1; DROP TABLE",
		"newline":     "c1\nsecret",
		"unicode":     "kia ora e te whanau \u2014 hui at 8",
		"emptyish":    " ",
		"tooLong":     strings.Repeat("a", maxOpaqueIDLen+1),
	} {
		rec := do(h, http.MethodPost, "/notify", tok, map[string]any{
			"recipients": []string{alice}, "channel": channel, "kind": "dm",
		})
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: expected 400 for channel %q, got %d", name, channel, rec.Code)
		}
	}
	if n := len(mock.rawBodies()); n != 0 {
		t.Fatalf("no FCM call must be made for a rejected channel, got %d", n)
	}

	// A well-formed opaque id still works.
	if rec := do(h, http.MethodPost, "/notify", tok, map[string]any{
		"recipients": []string{alice}, "channel": "ChatChannel-1756600000000000000", "kind": "dm",
	}); rec.Code != http.StatusOK {
		t.Fatalf("valid channel id rejected: %d %s", rec.Code, rec.Body.String())
	}
	if n := len(mock.rawBodies()); n != 1 {
		t.Fatalf("expected 1 push for the valid channel, got %d", n)
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

// The relay caps fan-out: a 1MB body would otherwise admit thousands of
// recipients, each dispatched to FCM sequentially (finding 6).
func TestNotifyRejectsOversizedRecipientList(t *testing.T) {
	mock := newMockFCM()
	defer mock.close()
	srv, res, store := newTestServer(mock.client())
	h := srv.Handler()
	sender, sPriv := testAID(res)
	tok := login(t, h, sender, sPriv)
	alice, _ := testAID(res)
	_ = store.Register(alice, "alice-1", "android")

	recipients := make([]string, maxNotifyRecipients+1)
	for i := range recipients {
		recipients[i] = alice
	}
	rec := do(h, http.MethodPost, "/notify", tok, map[string]any{
		"recipients": recipients, "channel": "c1", "kind": "dm",
	})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 over the recipient cap, got %d", rec.Code)
	}
	if n := len(mock.rawBodies()); n != 0 {
		t.Fatalf("no push must be dispatched for an oversized fan-out, got %d", n)
	}
}

// /notify is rate limited per sender AID: varying the channel id defeats
// coalescing, so the limiter is the only bound on wake-spam (finding 6).
func TestNotifyRateLimitedPerAID(t *testing.T) {
	mock := newMockFCM()
	defer mock.close()
	srv, res, store := newTestServer(mock.client())
	h := srv.Handler()
	sender, sPriv := testAID(res)
	tok := login(t, h, sender, sPriv)
	alice, _ := testAID(res)
	_ = store.Register(alice, "alice-1", "android")

	limited := false
	// Each call uses a distinct channel id, so coalescing cannot mask the flood.
	for i := 0; i < notifyLimitBurst+10; i++ {
		rec := do(h, http.MethodPost, "/notify", tok, map[string]any{
			"recipients": []string{alice},
			"channel":    fmt.Sprintf("ChatChannel-%d", i),
			"kind":       "dm",
		})
		if rec.Code == http.StatusTooManyRequests {
			limited = true
			break
		}
		if rec.Code != http.StatusOK {
			t.Fatalf("notify %d: unexpected %d %s", i, rec.Code, rec.Body.String())
		}
	}
	if !limited {
		t.Fatalf("expected /notify to rate limit a sender after %d calls", notifyLimitBurst)
	}

	// A second sender AID has its own bucket and is unaffected.
	other, oPriv := testAID(res)
	otherTok := login(t, h, other, oPriv)
	if rec := do(h, http.MethodPost, "/notify", otherTok, map[string]any{
		"recipients": []string{alice}, "channel": "c-other", "kind": "dm",
	}); rec.Code != http.StatusOK {
		t.Fatalf("a different sender must not be limited: %d %s", rec.Code, rec.Body.String())
	}
}

// Device tokens are echoed into the FCM request, so they are held to the same
// opaque shape as the channel id.
func TestRegisterRejectsNonOpaqueToken(t *testing.T) {
	srv, res, store := newTestServer(NoopFCM{})
	h := srv.Handler()
	aid, priv := testAID(res)
	tok := login(t, h, aid, priv)

	for name, device := range map[string]string{
		"spaces":  "not a token",
		"quotes":  `tok"1`,
		"tooLong": strings.Repeat("a", maxDeviceTokenLen+1),
		"empty":   "",
	} {
		if rec := do(h, http.MethodPost, "/register", tok, map[string]string{"token": device}); rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: expected 400 for token %q, got %d", name, device, rec.Code)
		}
	}
	// A realistic FCM token (contains ':' and '.') is accepted.
	real := "cXyZ0-9_a:APA91bH.xyz-123_ABC"
	if rec := do(h, http.MethodPost, "/register", tok, map[string]string{"token": real}); rec.Code != http.StatusOK {
		t.Fatalf("realistic FCM token rejected: %d %s", rec.Code, rec.Body.String())
	}
	if got := store.TokensForAID(aid); len(got) != 1 || got[0].Token != real {
		t.Fatalf("expected the valid token stored, got %+v", got)
	}
}

// Registering a token another AID already holds is refused (409), so a caller
// cannot steal a member's device (finding 5).
func TestRegisterRefusesTokenOwnedByAnotherAID(t *testing.T) {
	srv, res, store := newTestServer(NoopFCM{})
	h := srv.Handler()
	victim, vPriv := testAID(res)
	attacker, aPriv := testAID(res)
	vTok := login(t, h, victim, vPriv)
	aTok := login(t, h, attacker, aPriv)

	if rec := do(h, http.MethodPost, "/register", vTok, map[string]string{"token": "device-1"}); rec.Code != http.StatusOK {
		t.Fatalf("victim register: %d %s", rec.Code, rec.Body.String())
	}
	if rec := do(h, http.MethodPost, "/register", aTok, map[string]string{"token": "device-1"}); rec.Code != http.StatusConflict {
		t.Fatalf("expected 409 when claiming another AID's token, got %d %s", rec.Code, rec.Body.String())
	}
	if got := store.TokensForAID(victim); len(got) != 1 || got[0].Token != "device-1" {
		t.Fatalf("victim must keep its token, got %+v", got)
	}
	if got := store.TokensForAID(attacker); len(got) != 0 {
		t.Fatalf("attacker must not hold the token, got %+v", got)
	}

	// The supported handover: the owner deregisters, then the token is free.
	if rec := do(h, http.MethodPost, "/deregister", vTok, map[string]string{"token": "device-1"}); rec.Code != http.StatusOK {
		t.Fatalf("deregister: %d", rec.Code)
	}
	if rec := do(h, http.MethodPost, "/register", aTok, map[string]string{"token": "device-1"}); rec.Code != http.StatusOK {
		t.Fatalf("register after handover: %d %s", rec.Code, rec.Body.String())
	}
}

// An opted-out member whose device re-registers (FCM token rotation, §7) must
// stay opted out end to end — the rotation is invisible to the user, so it must
// not be read as consent (finding 4).
func TestNotifyStaysDroppedAfterReRegistration(t *testing.T) {
	mock := newMockFCM()
	defer mock.close()
	srv, res, store := newTestServer(mock.client())
	h := srv.Handler()
	sender, sPriv := testAID(res)
	senderTok := login(t, h, sender, sPriv)

	alice, aPriv := testAID(res)
	aliceTok := login(t, h, alice, aPriv)
	if rec := do(h, http.MethodPost, "/register", aliceTok, map[string]string{"token": "alice-old"}); rec.Code != http.StatusOK {
		t.Fatalf("register: %d", rec.Code)
	}
	if rec := do(h, http.MethodPost, "/optout", aliceTok, map[string]bool{"optOut": true}); rec.Code != http.StatusOK {
		t.Fatalf("optout: %d", rec.Code)
	}
	// FCM rotates the device token; the app re-registers without user action.
	if rec := do(h, http.MethodPost, "/register", aliceTok, map[string]string{"token": "alice-new"}); rec.Code != http.StatusOK {
		t.Fatalf("re-register: %d %s", rec.Code, rec.Body.String())
	}
	if !store.IsOptedOut(alice) {
		t.Fatal("re-registration must not clear the opt-out flag")
	}

	if rec := do(h, http.MethodPost, "/notify", senderTok, map[string]any{
		"recipients": []string{alice}, "channel": "c1", "kind": "dm",
	}); rec.Code != http.StatusOK {
		t.Fatalf("notify: %d %s", rec.Code, rec.Body.String())
	}
	if n := len(mock.rawBodies()); n != 0 {
		t.Fatalf("opted-out member must receive no push, got %d", n)
	}

	// An explicit opt-in resumes delivery.
	if rec := do(h, http.MethodPost, "/optout", aliceTok, map[string]bool{"optOut": false}); rec.Code != http.StatusOK {
		t.Fatalf("opt-in: %d", rec.Code)
	}
	if rec := do(h, http.MethodPost, "/notify", senderTok, map[string]any{
		"recipients": []string{alice}, "channel": "c2", "kind": "dm",
	}); rec.Code != http.StatusOK {
		t.Fatalf("notify after opt-in: %d", rec.Code)
	}
	if n := len(mock.rawBodies()); n != 2 {
		t.Fatalf("expected pushes to both devices after opt-in, got %d", n)
	}
}
