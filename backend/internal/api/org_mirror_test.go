package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func testOrgData() *OrgConfigData {
	return &OrgConfigData{
		Organization: OrgInfo{AID: "EOrgAID", Name: "Test Org"},
		Admins:       []AdminData{{AID: "EAdminAID", Name: "Admin"}},
	}
}

func TestMirrorToConfigServer_NoTokenIsNoop(t *testing.T) {
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		called = true
	}))
	defer srv.Close()

	err := MirrorToConfigServer(srv.Client(), srv.URL, "", false, testOrgData())
	if err != nil {
		t.Fatalf("expected nil error with empty token, got %v", err)
	}
	if called {
		t.Fatal("expected no request to be sent when token is empty")
	}
}

func TestMirrorToConfigServer_SendsBearerTokenAndBody(t *testing.T) {
	var gotAuth, gotMethod, gotPath, gotContentType string
	var gotBody OrgConfigData
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotContentType = r.Header.Get("Content-Type")
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	orgData := testOrgData()
	if err := MirrorToConfigServer(srv.Client(), srv.URL, "s3cr3t", false, orgData); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if gotAuth != "Bearer s3cr3t" {
		t.Errorf("Authorization = %q, want %q", gotAuth, "Bearer s3cr3t")
	}
	if gotMethod != http.MethodPost {
		t.Errorf("Method = %q, want POST", gotMethod)
	}
	if gotPath != "/api/config" {
		t.Errorf("Path = %q, want /api/config", gotPath)
	}
	if gotContentType != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", gotContentType)
	}
	if gotBody.Organization.AID != orgData.Organization.AID {
		t.Errorf("posted body AID = %q, want %q", gotBody.Organization.AID, orgData.Organization.AID)
	}
}

func TestMirrorToConfigServer_SetsTestConfigHeaderWhenIsTest(t *testing.T) {
	var gotHeader string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHeader = r.Header.Get("X-Test-Config")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	if err := MirrorToConfigServer(srv.Client(), srv.URL, "tok", true, testOrgData()); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotHeader != "true" {
		t.Errorf("X-Test-Config = %q, want %q", gotHeader, "true")
	}
}

func TestMirrorToConfigServer_OmitsTestConfigHeaderByDefault(t *testing.T) {
	headerSet := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Test-Config") != "" {
			headerSet = true
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	if err := MirrorToConfigServer(srv.Client(), srv.URL, "tok", false, testOrgData()); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if headerSet {
		t.Error("expected X-Test-Config to be absent when isTest is false")
	}
}

func TestMirrorToConfigServer_ConflictIsTreatedAsSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
	}))
	defer srv.Close()

	if err := MirrorToConfigServer(srv.Client(), srv.URL, "tok", false, testOrgData()); err != nil {
		t.Errorf("expected 409 to be treated as success, got error: %v", err)
	}
}

func TestMirrorToConfigServer_UnauthorizedReturnsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
	}))
	defer srv.Close()

	err := MirrorToConfigServer(srv.Client(), srv.URL, "wrong-token", false, testOrgData())
	if err == nil {
		t.Fatal("expected error on 401 response")
	}
}

func TestMirrorToConfigServer_UnreachableServerReturnsError(t *testing.T) {
	// Port 0 on loopback that nothing listens on - connection refused.
	err := MirrorToConfigServer(http.DefaultClient, "http://127.0.0.1:1", "tok", false, testOrgData())
	if err == nil {
		t.Fatal("expected error when config server is unreachable")
	}
}
