package api

import (
	"crypto/ed25519"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/matou-dao/backend/internal/auth"
	"github.com/matou-dao/backend/internal/pushrelay"
	"github.com/matou-dao/backend/internal/pushrelayclient"
)

// encodeVerferD / encodeSig0B (the signify-ts verfer "D" and Cigar "0B"
// encodings) are shared with auth_test.go in this package — reused here to pin
// the frontend signing encoding against the relay's verification.

// TestPushRelaySession_EndToEnd_FrontendEncoding drives the whole
// "the frontend signs, the backend spends" handshake against a real relay
// Server and pins the two encodings together: the WebView signs a relay-issued
// challenge in the exact signify-ts encoding (matou-auth:<aid>:<nonce>, 0B
// Cigar), the backend spends the resulting session, and a device registration
// lands in the relay store. If the frontend and relay encodings ever drift, this
// fails — it is the acceptance precondition for #250 in unit-test form.
func TestPushRelaySession_EndToEnd_FrontendEncoding(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	// A basic transferable prefix doubles as the AID here: 44 chars, so it passes
	// auth.ValidAID, and the resolver maps it to its own signing key.
	aid := encodeVerferD(pub)

	resolver := auth.NewStaticKeyStateResolver()
	resolver.Set(aid, []string{encodeVerferD(pub)})
	verifier := auth.NewVerifier(resolver, nil, nil)

	store, err := pushrelay.NewStore("", time.Hour)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	relaySrv := pushrelay.NewServer(pushrelay.Config{
		Verifier:       verifier,
		Store:          store,
		FCM:            pushrelay.NoopFCM{},
		CoalesceWindow: 0,
	})
	ts := httptest.NewServer(relaySrv.Handler())
	defer ts.Close()

	client, err := pushrelayclient.New(ts.URL) // loopback http, accepted
	if err != nil {
		t.Fatalf("pushrelayclient.New: %v", err)
	}
	h := NewPushHandler(client, fakeAID{aid: aid})

	// 1. GET relay-challenge → the nonce the WebView must sign.
	rec := httptest.NewRecorder()
	h.HandleRelayChallenge(rec, httptest.NewRequest(http.MethodGet, "/api/v1/push/relay-challenge", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("relay-challenge status = %d; body=%s", rec.Code, rec.Body.String())
	}
	var chal struct {
		AID       string `json:"aid"`
		Challenge string `json:"challenge"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &chal); err != nil {
		t.Fatalf("decoding challenge: %v", err)
	}
	if chal.AID != aid || chal.Challenge == "" {
		t.Fatalf("challenge response = %+v", chal)
	}

	// 2. Sign matou-auth:<aid>:<nonce> exactly as the frontend does.
	sig := encodeSig0B(ed25519.Sign(priv, auth.SignedMessage(aid, chal.Challenge)))

	// 3. POST relay-session → the backend exchanges the signature for a session.
	body := `{"challenge":"` + chal.Challenge + `","signature":"` + sig + `"}`
	rec = httptest.NewRecorder()
	h.HandleRelaySession(rec, httptest.NewRequest(http.MethodPost, "/api/v1/push/relay-session", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("relay-session status = %d (relay rejected the frontend-encoded signature); body=%s", rec.Code, rec.Body.String())
	}

	// 4. POST register → the session is spent, the token lands in the relay store.
	rec = httptest.NewRecorder()
	h.HandleRegister(rec, httptest.NewRequest(http.MethodPost, "/api/v1/push/register", strings.NewReader(`{"token":"fcmtoken123","platform":"android"}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("register status = %d; body=%s", rec.Code, rec.Body.String())
	}
	toks := store.TokensForAID(aid)
	if len(toks) != 1 || toks[0].Token != "fcmtoken123" {
		t.Fatalf("relay store for %s = %+v, want the registered token", aid, toks)
	}
}

// TestPushRelaySession_EndToEnd_RejectsBareNonceSignature guards the domain
// separation: a signature over the bare nonce (not the matou-auth:<aid>:<nonce>
// message) must be rejected, so a signature captured for another purpose cannot
// be replayed as a relay login.
func TestPushRelaySession_EndToEnd_RejectsBareNonceSignature(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	aid := encodeVerferD(pub)
	resolver := auth.NewStaticKeyStateResolver()
	resolver.Set(aid, []string{encodeVerferD(pub)})
	verifier := auth.NewVerifier(resolver, nil, nil)
	store, _ := pushrelay.NewStore("", time.Hour)
	relaySrv := pushrelay.NewServer(pushrelay.Config{Verifier: verifier, Store: store, FCM: pushrelay.NoopFCM{}})
	ts := httptest.NewServer(relaySrv.Handler())
	defer ts.Close()

	client, _ := pushrelayclient.New(ts.URL)
	h := NewPushHandler(client, fakeAID{aid: aid})

	rec := httptest.NewRecorder()
	h.HandleRelayChallenge(rec, httptest.NewRequest(http.MethodGet, "/api/v1/push/relay-challenge", nil))
	var chal struct {
		Challenge string `json:"challenge"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &chal)

	// Sign the bare nonce — the wrong message.
	sig := encodeSig0B(ed25519.Sign(priv, []byte(chal.Challenge)))
	body := `{"challenge":"` + chal.Challenge + `","signature":"` + sig + `"}`
	rec = httptest.NewRecorder()
	h.HandleRelaySession(rec, httptest.NewRequest(http.MethodPost, "/api/v1/push/relay-session", strings.NewReader(body)))
	if rec.Code == http.StatusOK {
		t.Fatal("relay accepted a bare-nonce signature; domain separation is broken")
	}
}
