package api

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/matou-dao/backend/internal/identity"
	"github.com/matou-dao/backend/internal/pairing"
)

// memPairMailbox is an in-memory config-server mailbox for the pairing API
// tests: PUT / GET-long-poll(single-read) / DELETE against /api/pair/{id}/{slot}.
type memPairMailbox struct {
	mu    sync.Mutex
	slots map[string][]byte
}

func (m *memPairMailbox) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/pair/")
	parts := strings.SplitN(rest, "/", 2)
	id := parts[0]
	key := id + "/"
	if len(parts) == 2 {
		key += parts[1]
	}
	switch r.Method {
	case http.MethodPut:
		body, _ := io.ReadAll(r.Body)
		m.mu.Lock()
		defer m.mu.Unlock()
		if _, ok := m.slots[key]; ok {
			w.WriteHeader(http.StatusConflict)
			return
		}
		m.slots[key] = body
		w.WriteHeader(http.StatusOK)
	case http.MethodGet:
		wait, _ := strconv.Atoi(r.URL.Query().Get("wait"))
		deadline := time.Now().Add(time.Duration(wait) * time.Second)
		for {
			m.mu.Lock()
			if b, ok := m.slots[key]; ok {
				delete(m.slots, key)
				m.mu.Unlock()
				_, _ = w.Write(b)
				return
			}
			m.mu.Unlock()
			if time.Now().After(deadline) {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
	case http.MethodDelete:
		m.mu.Lock()
		for k := range m.slots {
			if strings.HasPrefix(k, id+"/") {
				delete(m.slots, k)
			}
		}
		m.mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}
}

// pairingTestRig is a displayer or scanner backend: identity + manager + mux.
type pairingTestRig struct {
	id  *identity.UserIdentity
	mgr *pairing.Manager
	mux *http.ServeMux
}

func newPairingRig(t *testing.T, mailboxURL string) *pairingTestRig {
	t.Helper()
	ui := identity.New(t.TempDir())
	mgr := pairing.NewManager(mailboxURL,
		pairing.WithHTTPClient(&http.Client{Timeout: 5 * time.Second}))
	h := NewPairingHandler(mgr, ui, mailboxURL, BearerAuthorizer(testPairingToken, nil))
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)
	return &pairingTestRig{id: ui, mgr: mgr, mux: mux}
}

// testPairingToken is the per-launch API token the rig's authorizer accepts.
const testPairingToken = "pairing-test-token"

// do issues a request carrying the API token, as the frontend's fetch wrapper
// does on every backend call.
func (r *pairingTestRig) do(method, path string, body any) *httptest.ResponseRecorder {
	return r.doWithToken(method, path, body, testPairingToken)
}

// doWithToken issues a request with an explicit bearer token ("" = none).
func (r *pairingTestRig) doWithToken(method, path string, body any, token string) *httptest.ResponseRecorder {
	var rdr io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	}
	req := httptest.NewRequest(method, path, rdr)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	r.mux.ServeHTTP(rec, req)
	return rec
}

// driveToDone runs a desktop→phone handshake through the API up to the point
// where the phone holds the identity, and returns the session id.
func driveToDone(t *testing.T, desktop, phone *pairingTestRig) string {
	t.Helper()
	rec := desktop.do(http.MethodPost, "/api/v1/pairing/sessions", map[string]string{"deviceName": "Desktop"})
	if rec.Code != http.StatusOK {
		t.Fatalf("create session: %d %s", rec.Code, rec.Body.String())
	}
	created := decode(t, rec)
	qr, _ := created["qrPayload"].(string)
	id, _ := created["sessionId"].(string)
	rec = phone.do(http.MethodPost, "/api/v1/pairing/scan", map[string]string{"qrPayload": qr, "deviceName": "Phone"})
	if rec.Code != http.StatusOK {
		t.Fatalf("scan: %d %s", rec.Code, rec.Body.String())
	}
	waitStatus(t, desktop, id, "acked")
	rec = desktop.do(http.MethodPost, "/api/v1/pairing/sessions/"+id+"/approve", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("approve: %d %s", rec.Code, rec.Body.String())
	}
	waitStatus(t, phone, id, "done")
	return id
}

// TestPairingIdentityRouteRequiresToken: GET …/identity returns the mnemonic,
// and the global TokenGuard waves GETs through, so the route itself must demand
// the bearer token. Without it (or with a wrong one) the identity is neither
// returned nor consumed; the status route stays a plain read.
func TestPairingIdentityRouteRequiresToken(t *testing.T) {
	mem := &memPairMailbox{slots: map[string][]byte{}}
	srv := httptest.NewServer(mem)
	defer srv.Close()

	desktop := newPairingRig(t, srv.URL)
	if err := desktop.id.SetIdentity("AIDdesk", "word1 word2 word3"); err != nil {
		t.Fatal(err)
	}
	phone := newPairingRig(t, srv.URL)
	id := driveToDone(t, desktop, phone)

	for _, token := range []string{"", "wrong-token"} {
		rec := phone.doWithToken(http.MethodGet, "/api/v1/pairing/sessions/"+id+"/identity", nil, token)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("identity with token %q = %d, want 401 (body %s)", token, rec.Code, rec.Body.String())
		}
		if strings.Contains(rec.Body.String(), "word1") {
			t.Fatalf("identity leaked without a token: %s", rec.Body.String())
		}
	}
	// The status read needs no token (it carries no secret).
	if rec := phone.doWithToken(http.MethodGet, "/api/v1/pairing/sessions/"+id, nil, ""); rec.Code != http.StatusOK {
		t.Fatalf("status without token = %d, want 200", rec.Code)
	}
	// The unauthenticated attempts must not have consumed the single read.
	rec := phone.do(http.MethodGet, "/api/v1/pairing/sessions/"+id+"/identity", nil)
	if rec.Code != http.StatusOK || decode(t, rec)["mnemonic"] != "word1 word2 word3" {
		t.Fatalf("identity with token = %d %s", rec.Code, rec.Body.String())
	}

	// A handler built without an authorizer fails closed.
	bare := NewPairingHandler(phone.mgr, phone.id, srv.URL, nil)
	mux := http.NewServeMux()
	bare.RegisterRoutes(mux)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/pairing/sessions/"+id+"/identity", nil)
	req.Header.Set("Authorization", "Bearer "+testPairingToken)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("nil authorizer = %d, want 401", rr.Code)
	}
}

// TestPairingScanRejectsForeignConfigServer: a QR whose cs names another config
// server (cross-environment scan) is refused with 400 before any mailbox call.
func TestPairingScanRejectsForeignConfigServer(t *testing.T) {
	mem := &memPairMailbox{slots: map[string][]byte{}}
	srv := httptest.NewServer(mem)
	defer srv.Close()

	desktop := newPairingRig(t, srv.URL)
	_ = desktop.id.SetIdentity("AIDdesk", "word1 word2 word3")
	rec := desktop.do(http.MethodPost, "/api/v1/pairing/sessions", nil)
	created := decode(t, rec)
	qr := created["qrPayload"].(string)
	// Stop the displayer's long-poll at the end so srv.Close does not wait it out.
	defer desktop.do(http.MethodPost, "/api/v1/pairing/sessions/"+created["sessionId"].(string)+"/cancel", nil)

	phone := newPairingRig(t, "http://other-config-server.example:3904")
	rec = phone.do(http.MethodPost, "/api/v1/pairing/scan", map[string]string{"qrPayload": qr, "deviceName": "Phone"})
	if rec.Code != http.StatusBadRequest || decode(t, rec)["error"] != "config-server-mismatch" {
		t.Fatalf("foreign-cs scan = %d %s, want 400 config-server-mismatch", rec.Code, rec.Body.String())
	}
	mem.mu.Lock()
	n := len(mem.slots)
	mem.mu.Unlock()
	if n != 0 {
		t.Fatalf("scanner wrote %d slot(s) to the foreign mailbox", n)
	}
}

func decode(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
	return m
}

func TestPairingHandlerFullDesktopToPhone(t *testing.T) {
	mem := &memPairMailbox{slots: map[string][]byte{}}
	srv := httptest.NewServer(mem)
	defer srv.Close()

	desktop := newPairingRig(t, srv.URL)
	if err := desktop.id.SetIdentity("AIDdesk", "word1 word2 word3"); err != nil {
		t.Fatal(err)
	}
	_ = desktop.id.SetOrgConfig("ORGaid", "")
	phone := newPairingRig(t, srv.URL)

	// Displayer creates the session.
	rec := desktop.do(http.MethodPost, "/api/v1/pairing/sessions", map[string]string{"deviceName": "Desktop"})
	if rec.Code != http.StatusOK {
		t.Fatalf("create session: %d %s", rec.Code, rec.Body.String())
	}
	created := decode(t, rec)
	qr, _ := created["qrPayload"].(string)
	id, _ := created["sessionId"].(string)
	if !strings.HasPrefix(qr, "matou://pair?") || id == "" {
		t.Fatalf("bad create response: %v", created)
	}
	if created["expiresAt"] == "" {
		t.Fatal("missing expiresAt")
	}

	// Scanner scans.
	rec = phone.do(http.MethodPost, "/api/v1/pairing/scan", map[string]string{"qrPayload": qr, "deviceName": "Phone"})
	if rec.Code != http.StatusOK {
		t.Fatalf("scan: %d %s", rec.Code, rec.Body.String())
	}
	scan := decode(t, rec)
	if scan["outcome"] != string(pairing.OutcomeDesktopToPhone) {
		t.Fatalf("scan outcome = %v", scan["outcome"])
	}
	if scan["code"] == "" {
		t.Fatal("scan missing code")
	}

	// Poll the displayer status until acked.
	waitStatus(t, desktop, id, "acked")

	// Approve on the displayer (holder).
	rec = desktop.do(http.MethodPost, "/api/v1/pairing/sessions/"+id+"/approve", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("approve: %d %s", rec.Code, rec.Body.String())
	}

	// The receiver reaches done and can read the identity exactly once.
	waitStatus(t, phone, id, "done")
	rec = phone.do(http.MethodGet, "/api/v1/pairing/sessions/"+id+"/identity", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("identity: %d %s", rec.Code, rec.Body.String())
	}
	idResp := decode(t, rec)
	if idResp["mnemonic"] != "word1 word2 word3" || idResp["aid"] != "AIDdesk" || idResp["orgAid"] != "ORGaid" {
		t.Fatalf("unexpected identity: %v", idResp)
	}
	// Second read → 404.
	rec = phone.do(http.MethodGet, "/api/v1/pairing/sessions/"+id+"/identity", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("second identity read = %d, want 404", rec.Code)
	}
}

func waitStatus(t *testing.T, rig *pairingTestRig, id, want string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		rec := rig.do(http.MethodGet, "/api/v1/pairing/sessions/"+id, nil)
		if rec.Code == http.StatusOK {
			m := decode(t, rec)
			if m["state"] == want {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for state %q", want)
}

func TestPairingHandlerUnknownSession(t *testing.T) {
	rig := newPairingRig(t, "http://unused")
	rec := rig.do(http.MethodGet, "/api/v1/pairing/sessions/nope", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown session = %d, want 404", rec.Code)
	}
}

func TestPairingHandlerScanValidation(t *testing.T) {
	rig := newPairingRig(t, "http://unused")
	rec := rig.do(http.MethodPost, "/api/v1/pairing/scan", map[string]string{})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("empty scan = %d, want 400", rec.Code)
	}
	// Method not allowed on a POST-only route.
	rec = rig.do(http.MethodGet, "/api/v1/pairing/scan", nil)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET scan = %d, want 405", rec.Code)
	}
}

func TestPairingHandlerIdentityPresent409(t *testing.T) {
	mem := &memPairMailbox{slots: map[string][]byte{}}
	srv := httptest.NewServer(mem)
	defer srv.Close()

	desktop := newPairingRig(t, srv.URL)
	_ = desktop.id.SetIdentity("AIDdesk", "word1 word2 word3")
	// Scanner also already holds an identity → the receiver-side identity read
	// must refuse. Drive a session to acked first.
	phone := newPairingRig(t, srv.URL)
	_ = phone.id.SetIdentity("AIDphone", "other words here")

	rec := desktop.do(http.MethodPost, "/api/v1/pairing/sessions", nil)
	created := decode(t, rec)
	qr := created["qrPayload"].(string)
	id := created["sessionId"].(string)

	rec = phone.do(http.MethodPost, "/api/v1/pairing/scan", map[string]string{"qrPayload": qr, "deviceName": "Phone"})
	if rec.Code != http.StatusOK {
		t.Fatalf("scan: %d %s", rec.Code, rec.Body.String())
	}
	// Both hold different AIDs → conflict; identity read on a configured backend
	// returns 409 identity-present.
	rec = phone.do(http.MethodGet, "/api/v1/pairing/sessions/"+id+"/identity", nil)
	if rec.Code != http.StatusConflict {
		t.Fatalf("identity read = %d, want 409", rec.Code)
	}
	body := decode(t, rec)
	if body["error"] != "identity-present" || body["aid"] != "AIDphone" {
		t.Fatalf("unexpected 409 body: %v", body)
	}
}
