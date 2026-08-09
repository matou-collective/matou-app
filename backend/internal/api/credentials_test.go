package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/matou-dao/backend/internal/anystore"
	"github.com/matou-dao/backend/internal/keri"
)

func setupTestHandler(t *testing.T) (*CredentialsHandler, func()) {
	// Create temp directory for test database
	tmpDir, err := os.MkdirTemp("", "credentials_test")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}

	// Create KERI client
	keriClient, err := keri.NewClient(&keri.Config{
		OrgAID:   "EAID123456789",
		OrgAlias: "test-org",
		OrgName:  "Test Organization",
	})
	if err != nil {
		os.RemoveAll(tmpDir)
		t.Fatalf("failed to create KERI client: %v", err)
	}

	// Create anystore
	store, err := anystore.NewLocalStore(anystore.DefaultConfig(tmpDir))
	if err != nil {
		os.RemoveAll(tmpDir)
		t.Fatalf("failed to create anystore: %v", err)
	}

	cleanup := func() {
		store.Close()
		os.RemoveAll(tmpDir)
	}

	return NewCredentialsHandler(keriClient, store), cleanup
}

func TestHandleRoles(t *testing.T) {
	handler, cleanup := setupTestHandler(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/credentials/roles", nil)
	w := httptest.NewRecorder()

	handler.HandleRoles(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status %d, got %d", http.StatusOK, w.Code)
	}

	var resp RolesResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if len(resp.Roles) != 10 {
		t.Errorf("expected 10 roles, got %d", len(resp.Roles))
	}

	// Check that each role has permissions
	for _, role := range resp.Roles {
		if role.Name == "" {
			t.Error("role name should not be empty")
		}
		if len(role.Permissions) == 0 {
			t.Errorf("role %s should have permissions", role.Name)
		}
	}
}

func TestHandleRoles_MethodNotAllowed(t *testing.T) {
	handler, cleanup := setupTestHandler(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodPost, "/api/v1/credentials/roles", nil)
	w := httptest.NewRecorder()

	handler.HandleRoles(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected status %d, got %d", http.StatusMethodNotAllowed, w.Code)
	}
}

func TestHandleOrg(t *testing.T) {
	handler, cleanup := setupTestHandler(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/org", nil)
	w := httptest.NewRecorder()

	handler.HandleOrg(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status %d, got %d", http.StatusOK, w.Code)
	}

	var resp keri.OrgInfo
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp.AID != "EAID123456789" {
		t.Errorf("expected AID EAID123456789, got %s", resp.AID)
	}
	if resp.Alias != "test-org" {
		t.Errorf("expected alias test-org, got %s", resp.Alias)
	}
	if len(resp.Roles) != 10 {
		t.Errorf("expected 10 roles, got %d", len(resp.Roles))
	}
}

func TestHandleStore_ValidCredential(t *testing.T) {
	handler, cleanup := setupTestHandler(t)
	defer cleanup()

	body := `{
		"credential": {
			"said": "ESAID123",
			"issuer": "EAID123456789",
			"recipient": "ERECIPIENT123",
			"schema": "EMatouMembershipSchemaV1",
			"data": {
				"communityName": "MATOU",
				"role": "Member",
				"verificationStatus": "unverified",
				"permissions": ["read", "comment"],
				"joinedAt": "2026-01-18T00:00:00Z"
			}
		}
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/credentials", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	handler.HandleStore(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status %d, got %d: %s", http.StatusOK, w.Code, w.Body.String())
	}

	var resp StoreResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if !resp.Success {
		t.Errorf("expected success, got error: %s", resp.Error)
	}
	if resp.SAID != "ESAID123" {
		t.Errorf("expected SAID ESAID123, got %s", resp.SAID)
	}
}

func TestHandleStore_InvalidCredential(t *testing.T) {
	handler, cleanup := setupTestHandler(t)
	defer cleanup()

	body := `{
		"credential": {
			"said": "",
			"issuer": "EAID123456789",
			"recipient": "ERECIPIENT123",
			"schema": "EMatouMembershipSchemaV1",
			"data": {
				"role": "Member"
			}
		}
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/credentials", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	handler.HandleStore(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected status %d, got %d", http.StatusBadRequest, w.Code)
	}

	var resp StoreResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp.Success {
		t.Error("expected failure")
	}
}

func TestHandleStore_InvalidJSON(t *testing.T) {
	handler, cleanup := setupTestHandler(t)
	defer cleanup()

	body := `{invalid json}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/credentials", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	handler.HandleStore(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected status %d, got %d", http.StatusBadRequest, w.Code)
	}
}

func TestHandleValidate_ValidCredential(t *testing.T) {
	handler, cleanup := setupTestHandler(t)
	defer cleanup()

	body := `{
		"credential": {
			"said": "ESAID123",
			"issuer": "EAID123456789",
			"recipient": "ERECIPIENT123",
			"schema": "EMatouMembershipSchemaV1",
			"data": {
				"communityName": "MATOU",
				"role": "Operations Steward",
				"verificationStatus": "community_verified",
				"permissions": ["read", "admin"],
				"joinedAt": "2026-01-18T00:00:00Z"
			}
		}
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/credentials/validate", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	handler.HandleValidate(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status %d, got %d", http.StatusOK, w.Code)
	}

	var resp ValidateResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if !resp.Valid {
		t.Errorf("expected valid credential, got error: %s", resp.Error)
	}
	if !resp.OrgIssued {
		t.Error("expected orgIssued to be true")
	}
	if resp.Role != "Operations Steward" {
		t.Errorf("expected role Operations Steward, got %s", resp.Role)
	}
}

func TestHandleValidate_InvalidCredential(t *testing.T) {
	handler, cleanup := setupTestHandler(t)
	defer cleanup()

	body := `{
		"credential": {
			"said": "",
			"issuer": ""
		}
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/credentials/validate", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	handler.HandleValidate(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status %d, got %d", http.StatusOK, w.Code)
	}

	var resp ValidateResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp.Valid {
		t.Error("expected invalid credential")
	}
}

func TestHandleValidate_MissingCredential(t *testing.T) {
	handler, cleanup := setupTestHandler(t)
	defer cleanup()

	body := `{}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/credentials/validate", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	handler.HandleValidate(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected status %d, got %d", http.StatusBadRequest, w.Code)
	}
}

func TestHandleList(t *testing.T) {
	handler, cleanup := setupTestHandler(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/credentials", nil)
	w := httptest.NewRecorder()

	handler.handleList(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status %d, got %d", http.StatusOK, w.Code)
	}

	var resp ListResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp.Credentials == nil {
		t.Error("expected non-nil credentials array")
	}
}

func TestRegisterRoutes(t *testing.T) {
	handler, cleanup := setupTestHandler(t)
	defer cleanup()

	mux := http.NewServeMux()
	handler.RegisterRoutes(mux)

	// Test that routes are registered
	paths := []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/v1/org"},
		{http.MethodGet, "/api/v1/credentials/roles"},
		{http.MethodPost, "/api/v1/credentials"},
		{http.MethodPost, "/api/v1/credentials/validate"},
	}

	for _, p := range paths {
		t.Run(p.path, func(t *testing.T) {
			var body *bytes.Buffer
			if p.method == http.MethodPost {
				body = bytes.NewBufferString("{}")
			} else {
				body = &bytes.Buffer{}
			}
			req := httptest.NewRequest(p.method, p.path, body)
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, req)

			// Should not be 404
			if w.Code == http.StatusNotFound {
				t.Errorf("route %s %s not registered", p.method, p.path)
			}
		})
	}
}
