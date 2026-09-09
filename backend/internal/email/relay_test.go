package email

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/matou-dao/backend/internal/config"
)

func testSMTPConfig(relayURL string) config.SMTPConfig {
	return config.SMTPConfig{
		From:     "invites@matou.nz",
		FromName: "MATOU",
		RelayURL: relayURL,
	}
}

func TestSendViaRelay_SendsBearerToken(t *testing.T) {
	var gotAuth, gotContentType string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotContentType = r.Header.Get("Content-Type")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer srv.Close()

	sender := NewSender(testSMTPConfig(srv.URL), "s3cr3t")
	if err := sender.SendGeneric("someone@example.com", "subject", "<p>hi</p>"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if gotAuth != "Bearer s3cr3t" {
		t.Errorf("Authorization = %q, want %q", gotAuth, "Bearer s3cr3t")
	}
	if gotContentType != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", gotContentType)
	}
}

func TestSendViaRelay_OmitsAuthHeaderWhenTokenEmpty(t *testing.T) {
	headerPresent := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			headerPresent = true
		}
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer srv.Close()

	sender := NewSender(testSMTPConfig(srv.URL), "")
	if err := sender.SendGeneric("someone@example.com", "subject", "<p>hi</p>"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if headerPresent {
		t.Error("expected no Authorization header when relayToken is empty")
	}
}

func TestSendViaRelay_PropagatesRelayError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"success":false,"error":"unauthorized"}`))
	}))
	defer srv.Close()

	sender := NewSender(testSMTPConfig(srv.URL), "wrong-token")
	err := sender.SendGeneric("someone@example.com", "subject", "<p>hi</p>")
	if err == nil {
		t.Fatal("expected error when relay rejects the request")
	}
}
