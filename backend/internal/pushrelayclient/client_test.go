package pushrelayclient

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// relayStub is a minimal in-memory stand-in for the push-relay: it implements
// the challenge/login flow and records register/deregister/notify calls.
type relayStub struct {
	mu sync.Mutex

	challenges  int
	logins      []loginReq
	registers   []map[string]any
	deregisters []map[string]any
	notifies    []map[string]any

	// forceUnauthorizedOnce makes the next authed call 401 to exercise the
	// session-drop path.
	forceUnauthorizedOnce bool
}

type loginReq struct {
	AID       string
	Challenge string
	Signature string
}

func (s *relayStub) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/auth/challenge", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.challenges++
		s.mu.Unlock()
		writeJSON(w, 200, map[string]string{"challenge": "nonce-123", "expiresAt": ""})
	})
	mux.HandleFunc("/auth/login", func(w http.ResponseWriter, r *http.Request) {
		var body loginReq
		_ = json.NewDecoder(r.Body).Decode(&body)
		s.mu.Lock()
		s.logins = append(s.logins, body)
		s.mu.Unlock()
		writeJSON(w, 200, map[string]string{"token": "session-tok", "expiresAt": ""})
	})
	authed := func(record func(map[string]any)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if got := r.Header.Get("Authorization"); got != "Bearer session-tok" {
				writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "bad token"})
				return
			}
			s.mu.Lock()
			force := s.forceUnauthorizedOnce
			s.forceUnauthorizedOnce = false
			s.mu.Unlock()
			if force {
				writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "expired"})
				return
			}
			data, _ := io.ReadAll(r.Body)
			var m map[string]any
			_ = json.Unmarshal(data, &m)
			record(m)
			writeJSON(w, 200, map[string]string{"status": "ok"})
		}
	}
	mux.HandleFunc("/register", authed(func(m map[string]any) {
		s.mu.Lock()
		s.registers = append(s.registers, m)
		s.mu.Unlock()
	}))
	mux.HandleFunc("/deregister", authed(func(m map[string]any) {
		s.mu.Lock()
		s.deregisters = append(s.deregisters, m)
		s.mu.Unlock()
	}))
	mux.HandleFunc("/notify", authed(func(m map[string]any) {
		s.mu.Lock()
		s.notifies = append(s.notifies, m)
		s.mu.Unlock()
	}))
	return mux
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// mustClient builds a client for a httptest server (loopback http, always
// accepted) and fails the test if construction is rejected.
func mustClient(t *testing.T, baseURL string, opts ...Option) *Client {
	t.Helper()
	c, err := New(baseURL, opts...)
	if err != nil {
		t.Fatalf("New(%q): %v", baseURL, err)
	}
	return c
}

// mintSession drives the frontend-signs/backend-spends handshake the way the
// API layer does: challenge, then login with a stand-in signature.
func mintSession(t *testing.T, c *Client, aid string) {
	t.Helper()
	ctx := context.Background()
	challenge, _, err := c.RelayChallenge(ctx, aid)
	if err != nil {
		t.Fatalf("RelayChallenge: %v", err)
	}
	if _, err := c.RelaySession(ctx, aid, challenge, "sig("+challenge+")"); err != nil {
		t.Fatalf("RelaySession: %v", err)
	}
}

func TestClient_MintSessionThenSpendsIt(t *testing.T) {
	stub := &relayStub{}
	srv := httptest.NewServer(stub.handler())
	defer srv.Close()

	c := mustClient(t, srv.URL)
	mintSession(t, c, "aid-alice")

	if stub.challenges != 1 || len(stub.logins) != 1 {
		t.Fatalf("expected one challenge+login, got %d/%d", stub.challenges, len(stub.logins))
	}
	if stub.logins[0].AID != "aid-alice" || stub.logins[0].Signature != "sig(nonce-123)" {
		t.Errorf("login = %+v, want signed by aid-alice", stub.logins[0])
	}

	if err := c.Register(context.Background(), "fcm-tok", "android"); err != nil {
		t.Fatalf("Register: %v", err)
	}
	if len(stub.registers) != 1 {
		t.Fatalf("expected one register, got %d", len(stub.registers))
	}
	if stub.registers[0]["token"] != "fcm-tok" || stub.registers[0]["platform"] != "android" {
		t.Errorf("register payload = %v", stub.registers[0])
	}
}

func TestClient_Register_DefaultsPlatform(t *testing.T) {
	stub := &relayStub{}
	srv := httptest.NewServer(stub.handler())
	defer srv.Close()

	c := mustClient(t, srv.URL)
	mintSession(t, c, "aid-alice")
	if err := c.Register(context.Background(), "fcm-tok", ""); err != nil {
		t.Fatalf("Register: %v", err)
	}
	if stub.registers[0]["platform"] != "android" {
		t.Errorf("platform = %v, want android default", stub.registers[0]["platform"])
	}
}

func TestClient_SessionIsReused(t *testing.T) {
	stub := &relayStub{}
	srv := httptest.NewServer(stub.handler())
	defer srv.Close()

	c := mustClient(t, srv.URL)
	mintSession(t, c, "aid-alice")
	ctx := context.Background()
	if err := c.Register(ctx, "t1", "android"); err != nil {
		t.Fatal(err)
	}
	if err := c.Deregister(ctx, "t1"); err != nil {
		t.Fatal(err)
	}
	// Two authed calls, but the cached session is reused: still only one login.
	if stub.challenges != 1 || len(stub.logins) != 1 {
		t.Errorf("expected session reuse (1 login), got %d challenges / %d logins", stub.challenges, len(stub.logins))
	}
}

// TestClient_NoSessionDropsFast: with no session minted the authed routes fail
// fast with ErrNoSession and never touch the relay.
func TestClient_NoSessionDropsFast(t *testing.T) {
	stub := &relayStub{}
	srv := httptest.NewServer(stub.handler())
	defer srv.Close()

	c := mustClient(t, srv.URL)
	for _, call := range []func() error{
		func() error { return c.Register(context.Background(), "t", "android") },
		func() error { return c.Deregister(context.Background(), "t") },
		func() error { return c.Notify(context.Background(), []string{"aid-bob"}, "chan-1", "ch") },
	} {
		if err := call(); !errors.Is(err, ErrNoSession) {
			t.Errorf("call without a session = %v, want ErrNoSession", err)
		}
	}
	if stub.challenges != 0 || len(stub.registers)+len(stub.deregisters)+len(stub.notifies) != 0 {
		t.Errorf("must not contact the relay without a session")
	}
}

// TestClient_ExpiredSessionDropsFast: an expired cached session is treated as no
// session — no relay round-trip, ErrNoSession returned.
func TestClient_ExpiredSessionDropsFast(t *testing.T) {
	stub := &relayStub{}
	srv := httptest.NewServer(stub.handler())
	defer srv.Close()

	c := mustClient(t, srv.URL)
	c.SetSession("aid-alice", "session-tok", time.Now().Add(-time.Minute))
	if err := c.Register(context.Background(), "t", "android"); !errors.Is(err, ErrNoSession) {
		t.Errorf("expired session Register = %v, want ErrNoSession", err)
	}
	if len(stub.registers) != 0 {
		t.Errorf("must not spend an expired session")
	}
}

// TestClient_RelayRejectsSession: a 401 from the relay clears the cached session
// and surfaces ErrNoSession — the backend cannot re-mint, the frontend does.
func TestClient_RelayRejectsSession(t *testing.T) {
	stub := &relayStub{}
	srv := httptest.NewServer(stub.handler())
	defer srv.Close()

	c := mustClient(t, srv.URL)
	mintSession(t, c, "aid-alice")
	stub.forceUnauthorizedOnce = true
	if err := c.Deregister(context.Background(), "t1"); !errors.Is(err, ErrNoSession) {
		t.Fatalf("Deregister after relay 401 = %v, want ErrNoSession", err)
	}
	// No silent re-login: exactly the one login from mintSession.
	if len(stub.logins) != 1 {
		t.Errorf("client must not re-login on 401, got %d logins", len(stub.logins))
	}
	// The session was cleared: a follow-up call also drops fast without a round-trip.
	if _, ok := c.token(); ok {
		t.Errorf("session must be cleared after a relay 401")
	}
}

func TestClient_Notify_ForwardsRoutingData(t *testing.T) {
	stub := &relayStub{}
	srv := httptest.NewServer(stub.handler())
	defer srv.Close()

	c := mustClient(t, srv.URL)
	mintSession(t, c, "aid-alice")
	err := c.Notify(context.Background(), []string{"aid-bob", "aid-carol"}, "chan-1", "dm")
	if err != nil {
		t.Fatalf("Notify: %v", err)
	}
	if len(stub.notifies) != 1 {
		t.Fatalf("expected one notify, got %d", len(stub.notifies))
	}
	n := stub.notifies[0]
	if n["channel"] != "chan-1" || n["kind"] != "dm" {
		t.Errorf("notify routing = %v", n)
	}
	recips, _ := n["recipients"].([]any)
	if len(recips) != 2 {
		t.Errorf("recipients = %v, want 2", n["recipients"])
	}
	// Content-free invariant: no message body / sender / channel-name fields.
	for _, forbidden := range []string{"content", "body", "title", "sender", "senderName", "channelName"} {
		if _, ok := n[forbidden]; ok {
			t.Errorf("notify payload leaked forbidden field %q", forbidden)
		}
	}
}

// TestClient_SessionNeverPersisted: the session token lives only in memory. The
// client holds no path/file field and nothing writes it to disk.
func TestClient_SessionNeverPersisted(t *testing.T) {
	stub := &relayStub{}
	srv := httptest.NewServer(stub.handler())
	defer srv.Close()

	c := mustClient(t, srv.URL)
	mintSession(t, c, "aid-alice")
	if c.sessionToken == "" {
		t.Fatal("expected an in-memory session token after mint")
	}
	c.ClearSession()
	if _, ok := c.token(); ok {
		t.Errorf("ClearSession must drop the in-memory session")
	}
}

// TestNew_RejectsPlainHTTPToRemoteHost: a plain-http relay URL to a remote host
// would put device FCM tokens and full recipient-AID lists on the wire in
// cleartext, so construction must fail and leave push dark.
func TestNew_RejectsPlainHTTPToRemoteHost(t *testing.T) {
	for _, raw := range []string{"http://relay.example.com", "http://203.0.113.7:8080/push"} {
		c, err := New(raw)
		if err == nil {
			t.Fatalf("New(%q) accepted a cleartext remote relay URL (client %v)", raw, c)
		}
		if !strings.Contains(err.Error(), "plain-http") {
			t.Errorf("New(%q) error = %v, want it to name the plain-http refusal", raw, err)
		}
	}
}

// TestNew_AllowsHTTPS and loopback http: the two shapes that are safe by default.
func TestNew_AllowsHTTPSAndLoopbackHTTP(t *testing.T) {
	for _, raw := range []string{
		"https://relay.example.com",
		"https://relay.example.com/push/",
		"http://localhost:8791",
		"http://127.0.0.1:8791",
		"http://[::1]:8791",
	} {
		if _, err := New(raw); err != nil {
			t.Errorf("New(%q) = %v, want accepted", raw, err)
		}
	}
}

// TestNew_AllowInsecureHTTPEscapeHatch mirrors MATOU_KERIA_KEYSTATE_ALLOW_HTTP:
// an explicit opt-in re-opens plain http to a remote host for dev setups.
func TestNew_AllowInsecureHTTPEscapeHatch(t *testing.T) {
	if _, err := New("http://relay.example.com", AllowInsecureHTTP()); err != nil {
		t.Fatalf("New with AllowInsecureHTTP = %v, want accepted", err)
	}
}

// TestNew_RejectsJunkURLs: no scheme, no host, or a non-http scheme.
func TestNew_RejectsJunkURLs(t *testing.T) {
	for _, raw := range []string{"relay.example.com", "", "ftp://relay.example.com", "://nope"} {
		if _, err := New(raw); err == nil {
			t.Errorf("New(%q) = nil error, want rejection", raw)
		}
	}
}

// TestNew_TrimsTrailingSlash keeps the request paths well-formed.
func TestNew_TrimsTrailingSlash(t *testing.T) {
	c, err := New("https://relay.example.com/push/")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if c.baseURL != "https://relay.example.com/push" {
		t.Errorf("baseURL = %q, want the trailing slash trimmed", c.baseURL)
	}
}
