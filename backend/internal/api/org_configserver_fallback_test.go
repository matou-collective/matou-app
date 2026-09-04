package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// These tests cover the config-server read fallback added for issue #265: on a
// cache miss the org-config GET handler sources org config from the config
// server server-side, so a fresh mobile install reaches onboarding without the
// WebView ever touching the remote plain-http host. This mirrors the #99
// client-config handler test.

func TestFetchFromConfigServer_ReturnsConfigOn200(t *testing.T) {
	want := testOrgData()
	want.Registry = &Registry{ID: "EReg", Name: "reg"}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("Method = %q, want GET", r.Method)
		}
		if r.URL.Path != "/api/config" {
			t.Errorf("Path = %q, want /api/config", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(want)
	}))
	defer srv.Close()

	got, err := FetchFromConfigServer(srv.Client(), srv.URL, false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got == nil {
		t.Fatal("expected config, got nil")
	}
	if got.Organization.AID != want.Organization.AID {
		t.Errorf("AID = %q, want %q", got.Organization.AID, want.Organization.AID)
	}
	if got.Registry == nil || got.Registry.ID != "EReg" {
		t.Errorf("Registry = %+v, want id EReg", got.Registry)
	}
}

func TestFetchFromConfigServer_NotFoundIsNilNoError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	got, err := FetchFromConfigServer(srv.Client(), srv.URL, false)
	if err != nil {
		t.Fatalf("expected nil error on 404, got %v", err)
	}
	if got != nil {
		t.Fatalf("expected nil config on 404, got %+v", got)
	}
}

func TestFetchFromConfigServer_SetsTestConfigHeaderWhenIsTest(t *testing.T) {
	var gotHeader string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHeader = r.Header.Get("X-Test-Config")
		_ = json.NewEncoder(w).Encode(testOrgData())
	}))
	defer srv.Close()

	if _, err := FetchFromConfigServer(srv.Client(), srv.URL, true); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotHeader != "true" {
		t.Errorf("X-Test-Config = %q, want %q", gotHeader, "true")
	}
}

func TestFetchFromConfigServer_ServerErrorReturnsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	if _, err := FetchFromConfigServer(srv.Client(), srv.URL, false); err == nil {
		t.Fatal("expected error on 500 response")
	}
}

func TestFetchFromConfigServer_UnreachableReturnsError(t *testing.T) {
	if _, err := FetchFromConfigServer(http.DefaultClient, "http://127.0.0.1:1", false); err == nil {
		t.Fatal("expected error when config server is unreachable")
	}
}

// HandleGetConfig, on a cache miss, sources config from the config server and
// serves it (and caches it in memory for subsequent requests).
func TestHandleGetConfig_FallsBackToConfigServerOnCacheMiss(t *testing.T) {
	org := testOrgData()
	org.Organization.Name = "Fallback Org"
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits++
		_ = json.NewEncoder(w).Encode(org)
	}))
	defer srv.Close()

	h := NewOrgConfigHandler(t.TempDir(), nil) // empty cache (no org-config.yaml)
	h.SetConfigServerSource(srv.Client(), srv.URL, false)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/org/config", nil)
	rec := httptest.NewRecorder()
	h.HandleGetConfig(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("got status %d, want %d", rec.Code, http.StatusOK)
	}
	var got OrgConfigData
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("response is not valid JSON: %v", err)
	}
	if got.Organization.Name != "Fallback Org" {
		t.Errorf("Organization.Name = %q, want %q", got.Organization.Name, "Fallback Org")
	}

	// Second GET is served from the in-memory cache — no further config-server hit.
	rec2 := httptest.NewRecorder()
	h.HandleGetConfig(rec2, httptest.NewRequest(http.MethodGet, "/api/v1/org/config", nil))
	if rec2.Code != http.StatusOK {
		t.Fatalf("second GET status %d, want 200", rec2.Code)
	}
	if hits != 1 {
		t.Errorf("config server was hit %d times, want 1 (result should be cached)", hits)
	}
}

// A config server that has no org yet (404) leaves the handler a 404 so
// first-run org creation still bootstraps.
func TestHandleGetConfig_ConfigServer404StaysNotConfigured(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	h := NewOrgConfigHandler(t.TempDir(), nil)
	h.SetConfigServerSource(srv.Client(), srv.URL, false)

	rec := httptest.NewRecorder()
	h.HandleGetConfig(rec, httptest.NewRequest(http.MethodGet, "/api/v1/org/config", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("got status %d, want %d", rec.Code, http.StatusNotFound)
	}
	if h.IsConfigured() {
		t.Error("handler should not be configured after a 404 from the config server")
	}
}

// With no config-server source set (dev/test/desktop), a cache miss stays a 404
// and no network call is attempted.
func TestHandleGetConfig_NoFallbackWhenSourceUnset(t *testing.T) {
	h := NewOrgConfigHandler(t.TempDir(), nil)

	rec := httptest.NewRecorder()
	h.HandleGetConfig(rec, httptest.NewRequest(http.MethodGet, "/api/v1/org/config", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("got status %d, want %d", rec.Code, http.StatusNotFound)
	}
}
