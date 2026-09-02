package pushrelay

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestIsUnregistered(t *testing.T) {
	cases := []struct {
		body string
		want bool
	}{
		{`{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}`, true},
		{`{"error":{"status":"NOT_FOUND"}}`, true},
		{`{"error":{"details":[{"errorCode":"UNREGISTERED"}]}}`, true},
		{`{"error":{"status":"INVALID_ARGUMENT","details":[{"errorCode":"INVALID_ARGUMENT"}]}}`, false},
		{`not json`, false},
	}
	for _, c := range cases {
		if got := isUnregistered([]byte(c.body)); got != c.want {
			t.Fatalf("isUnregistered(%q)=%v want %v", c.body, got, c.want)
		}
	}
}

// The service-account flow signs a JWT bearer assertion (RS256, stdlib) and
// exchanges it for an access token, which the client then uses to POST FCM.
func TestServiceAccountTokenSourceAndDispatch(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	pkcs8, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	pemKey := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: pkcs8})

	// Token endpoint that verifies the assertion's RS256 signature.
	var gotAssertion bool
	tokenSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		assertion := r.Form.Get("assertion")
		parts := strings.Split(assertion, ".")
		if len(parts) != 3 {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		signingInput := parts[0] + "." + parts[1]
		sig, err := base64.RawURLEncoding.DecodeString(parts[2])
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		digest := sha256.Sum256([]byte(signingInput))
		if err := rsa.VerifyPKCS1v15(&key.PublicKey, crypto.SHA256, digest[:], sig); err != nil {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		gotAssertion = true
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "minted-access", "expires_in": 3600})
	}))
	defer tokenSrv.Close()

	saJSON, _ := json.Marshal(map[string]string{
		"client_email": "relay@example.iam.gserviceaccount.com",
		"private_key":  string(pemKey),
		"token_uri":    tokenSrv.URL,
		"project_id":   "test-project",
	})
	ts, projectID, err := newServiceAccountTokenSource(saJSON)
	if err != nil {
		t.Fatal(err)
	}
	if projectID != "test-project" {
		t.Fatalf("projectID=%q", projectID)
	}

	access, err := ts.token(context.Background())
	if err != nil {
		t.Fatalf("token: %v", err)
	}
	if access != "minted-access" || !gotAssertion {
		t.Fatalf("expected minted token from verified assertion, got %q gotAssertion=%v", access, gotAssertion)
	}

	// Cached second call does not re-mint.
	access2, _ := ts.token(context.Background())
	if access2 != "minted-access" {
		t.Fatalf("cached token mismatch: %q", access2)
	}

	// Now dispatch through an FCM endpoint that checks the bearer.
	var sawBearer string
	fcmSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawBearer = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"name":"ok"}`))
	}))
	defer fcmSrv.Close()

	client := &FCMClient{baseURL: fcmSrv.URL, projectID: projectID, tokens: ts, http: fcmSrv.Client()}
	results := client.Send(context.Background(), []PushMessage{{Token: "dev-1", Priority: "high", Data: map[string]string{"t": "m"}}})
	if len(results) != 1 || results[0].Err != nil {
		t.Fatalf("dispatch failed: %+v", results)
	}
	if sawBearer != "Bearer minted-access" {
		t.Fatalf("FCM did not receive minted bearer, got %q", sawBearer)
	}
}

func TestNewServiceAccountTokenSourceRejectsBadKey(t *testing.T) {
	_, _, err := newServiceAccountTokenSource([]byte(`{"client_email":"x","private_key":"not-a-pem","project_id":"p"}`))
	if err == nil {
		t.Fatal("expected error for invalid private key")
	}
	_, _, err = newServiceAccountTokenSource([]byte(`{"client_email":"x"}`))
	if err == nil {
		t.Fatal("expected error for missing fields")
	}
}

// Ensure token TTL uses the now hook so the cache test is deterministic.
func TestTokenCacheExpiry(t *testing.T) {
	ts := &saTokenSource{
		sa:   serviceAccount{TokenURI: "http://unused"},
		now:  func() time.Time { return time.Unix(1000, 0) },
		http: &http.Client{},
	}
	ts.cached = "cached"
	ts.expiry = time.Unix(2000, 0)
	got, err := ts.token(context.Background())
	if err != nil || got != "cached" {
		t.Fatalf("expected cached token, got %q err=%v", got, err)
	}
}
