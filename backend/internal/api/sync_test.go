package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/matou-dao/backend/internal/anysync"
	"github.com/matou-dao/backend/internal/anystore"
	"github.com/matou-dao/backend/internal/keri"
)

func setupSyncTestHandler(t *testing.T) (*SyncHandler, *anystore.LocalStore, func()) {
	// Create temp directory for test database
	tmpDir, err := os.MkdirTemp("", "sync_test")
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

	// Create any-sync client for testing
	anysyncClient := anysync.NewClientForTesting("http://localhost:1004", "test-network")

	// Create space manager
	spaceManager := anysync.NewSpaceManager(anysyncClient, &anysync.SpaceManagerConfig{
		CommunitySpaceID: "space-community-test",
		OrgAID:           "EAID123456789",
	})

	// Create space store adapter
	spaceStore := anystore.NewSpaceStoreAdapter(store)

	cleanup := func() {
		store.Close()
		os.RemoveAll(tmpDir)
	}

	return NewSyncHandler(keriClient, store, spaceManager, spaceStore), store, cleanup
}

// ============================================
// HandleSyncCredentials Tests
// ============================================

func TestHandleSyncCredentials_ValidCredentials(t *testing.T) {
	handler, _, cleanup := setupSyncTestHandler(t)
	defer cleanup()

	body := `{
		"userAid": "EUSER123",
		"credentials": [
			{
				"said": "ESAID001",
				"issuer": "EAID123456789",
				"recipient": "EUSER123",
				"schema": "EMatouMembershipSchemaV1",
				"data": {
					"communityName": "MATOU",
					"role": "Member",
					"verificationStatus": "unverified",
					"permissions": ["read", "comment"],
					"joinedAt": "2026-01-19T00:00:00Z"
				}
			}
		]
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/sync/credentials", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	handler.HandleSyncCredentials(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status %d, got %d: %s", http.StatusOK, w.Code, w.Body.String())
	}

	var resp SyncCredentialsResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if !resp.Success {
		t.Errorf("expected success, got errors: %v", resp.Errors)
	}
	if resp.Synced != 1 {
		t.Errorf("expected 1 synced, got %d", resp.Synced)
	}
	if resp.Failed != 0 {
		t.Errorf("expected 0 failed, got %d", resp.Failed)
	}
	if resp.PrivateSpace == "" {
		t.Error("expected private space to be set")
	}
}

func TestHandleSyncCredentials_MultipleCredentials(t *testing.T) {
	handler, _, cleanup := setupSyncTestHandler(t)
	defer cleanup()

	body := `{
		"userAid": "EUSER123",
		"credentials": [
			{
				"said": "ESAID001",
				"issuer": "EAID123456789",
				"recipient": "EUSER123",
				"schema": "EMatouMembershipSchemaV1",
				"data": {
					"communityName": "MATOU",
					"role": "Member",
					"verificationStatus": "unverified",
					"permissions": ["read"],
					"joinedAt": "2026-01-19T00:00:00Z"
				}
			},
			{
				"said": "ESAID002",
				"issuer": "EAID123456789",
				"recipient": "EUSER123",
				"schema": "EOperationsStewardSchemaV1",
				"data": {
					"communityName": "MATOU",
					"role": "Operations Steward",
					"verificationStatus": "expert_verified",
					"permissions": ["admin_keria", "manage_members"],
					"joinedAt": "2026-01-19T00:00:00Z"
				}
			}
		]
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/sync/credentials", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	handler.HandleSyncCredentials(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status %d, got %d: %s", http.StatusOK, w.Code, w.Body.String())
	}

	var resp SyncCredentialsResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp.Synced != 2 {
		t.Errorf("expected 2 synced, got %d", resp.Synced)
	}
}

func TestHandleSyncCredentials_MissingUserAID(t *testing.T) {
	handler, _, cleanup := setupSyncTestHandler(t)
	defer cleanup()

	body := `{
		"credentials": [
			{
				"said": "ESAID001",
				"issuer": "EAID123456789",
				"recipient": "EUSER123",
				"schema": "EMatouMembershipSchemaV1"
			}
		]
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/sync/credentials", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	handler.HandleSyncCredentials(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected status %d, got %d", http.StatusBadRequest, w.Code)
	}

	var resp SyncCredentialsResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp.Success {
		t.Error("expected failure")
	}
}

func TestHandleSyncCredentials_EmptyCredentials(t *testing.T) {
	handler, _, cleanup := setupSyncTestHandler(t)
	defer cleanup()

	body := `{
		"userAid": "EUSER123",
		"credentials": []
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/sync/credentials", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	handler.HandleSyncCredentials(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status %d, got %d", http.StatusOK, w.Code)
	}

	var resp SyncCredentialsResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if !resp.Success {
		t.Error("expected success with empty credentials")
	}
	if resp.Synced != 0 {
		t.Errorf("expected 0 synced, got %d", resp.Synced)
	}
}

func TestHandleSyncCredentials_InvalidCredential(t *testing.T) {
	handler, _, cleanup := setupSyncTestHandler(t)
	defer cleanup()

	body := `{
		"userAid": "EUSER123",
		"credentials": [
			{
				"said": "",
				"issuer": "",
				"recipient": "",
				"schema": ""
			}
		]
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/sync/credentials", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	handler.HandleSyncCredentials(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected status %d, got %d: %s", http.StatusBadRequest, w.Code, w.Body.String())
	}

	var resp SyncCredentialsResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp.Success {
		t.Error("expected failure with invalid credential")
	}
	if resp.Failed != 1 {
		t.Errorf("expected 1 failed, got %d", resp.Failed)
	}
}

func TestHandleSyncCredentials_InvalidJSON(t *testing.T) {
	handler, _, cleanup := setupSyncTestHandler(t)
	defer cleanup()

	body := `{invalid json}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/sync/credentials", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	handler.HandleSyncCredentials(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected status %d, got %d", http.StatusBadRequest, w.Code)
	}
}

func TestHandleSyncCredentials_MethodNotAllowed(t *testing.T) {
	handler, _, cleanup := setupSyncTestHandler(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/sync/credentials", nil)
	w := httptest.NewRecorder()

	handler.HandleSyncCredentials(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected status %d, got %d", http.StatusMethodNotAllowed, w.Code)
	}
}

// ============================================
// HandleSyncKEL Tests
// ============================================

func TestHandleSyncKEL_ValidKEL(t *testing.T) {
	handler, _, cleanup := setupSyncTestHandler(t)
	defer cleanup()

	body := `{
		"userAid": "EUSER123",
		"kel": [
			{
				"type": "icp",
				"sequence": 0,
				"digest": "EDIGEST001",
				"data": {"keys": ["key1"]},
				"timestamp": "2026-01-19T00:00:00Z"
			}
		]
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/sync/kel", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	handler.HandleSyncKEL(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status %d, got %d: %s", http.StatusOK, w.Code, w.Body.String())
	}

	var resp SyncKELResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if !resp.Success {
		t.Errorf("expected success, got error: %s", resp.Error)
	}
	if resp.EventsStored != 1 {
		t.Errorf("expected 1 event stored, got %d", resp.EventsStored)
	}
	if resp.PrivateSpace == "" {
		t.Error("expected private space to be set")
	}
}

func TestHandleSyncKEL_MultipleEvents(t *testing.T) {
	handler, _, cleanup := setupSyncTestHandler(t)
	defer cleanup()

	body := `{
		"userAid": "EUSER123",
		"kel": [
			{
				"type": "icp",
				"sequence": 0,
				"digest": "EDIGEST001",
				"data": {"keys": ["key1"]},
				"timestamp": "2026-01-19T00:00:00Z"
			},
			{
				"type": "rot",
				"sequence": 1,
				"digest": "EDIGEST002",
				"data": {"keys": ["key2"]},
				"timestamp": "2026-01-19T01:00:00Z"
			},
			{
				"type": "ixn",
				"sequence": 2,
				"digest": "EDIGEST003",
				"data": {"anchor": "cred123"},
				"timestamp": "2026-01-19T02:00:00Z"
			}
		]
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/sync/kel", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	handler.HandleSyncKEL(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status %d, got %d", http.StatusOK, w.Code)
	}

	var resp SyncKELResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp.EventsStored != 3 {
		t.Errorf("expected 3 events stored, got %d", resp.EventsStored)
	}
}

func TestHandleSyncKEL_MissingUserAID(t *testing.T) {
	handler, _, cleanup := setupSyncTestHandler(t)
	defer cleanup()

	body := `{
		"kel": [
			{
				"type": "icp",
				"sequence": 0,
				"digest": "EDIGEST001"
			}
		]
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/sync/kel", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	handler.HandleSyncKEL(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected status %d, got %d", http.StatusBadRequest, w.Code)
	}

	var resp SyncKELResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp.Success {
		t.Error("expected failure")
	}
}

func TestHandleSyncKEL_EmptyKEL(t *testing.T) {
	handler, _, cleanup := setupSyncTestHandler(t)
	defer cleanup()

	body := `{
		"userAid": "EUSER123",
		"kel": []
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/sync/kel", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	handler.HandleSyncKEL(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected status %d, got %d", http.StatusBadRequest, w.Code)
	}

	var resp SyncKELResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp.Success {
		t.Error("expected failure with empty KEL")
	}
}

func TestHandleSyncKEL_InvalidJSON(t *testing.T) {
	handler, _, cleanup := setupSyncTestHandler(t)
	defer cleanup()

	body := `{invalid}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/sync/kel", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	handler.HandleSyncKEL(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected status %d, got %d", http.StatusBadRequest, w.Code)
	}
}

func TestHandleSyncKEL_MethodNotAllowed(t *testing.T) {
	handler, _, cleanup := setupSyncTestHandler(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/sync/kel", nil)
	w := httptest.NewRecorder()

	handler.HandleSyncKEL(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected status %d, got %d", http.StatusMethodNotAllowed, w.Code)
	}
}

// ============================================
// HandleGetCommunityMembers Tests
// ============================================

func TestHandleGetCommunityMembers_Empty(t *testing.T) {
	handler, _, cleanup := setupSyncTestHandler(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/community/members", nil)
	w := httptest.NewRecorder()

	handler.HandleGetCommunityMembers(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status %d, got %d: %s", http.StatusOK, w.Code, w.Body.String())
	}

	var resp CommunityMembersResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp.Members == nil {
		t.Error("expected non-nil members array")
	}
	if resp.Total != 0 {
		t.Errorf("expected 0 members, got %d", resp.Total)
	}
}

func TestHandleGetCommunityMembers_WithMembers(t *testing.T) {
	handler, store, cleanup := setupSyncTestHandler(t)
	defer cleanup()

	// Store a membership credential
	ctx := context.Background()
	cred := &anystore.CachedCredential{
		ID:         "ESAID001",
		IssuerAID:  "EAID123456789",
		SubjectAID: "EUSER123",
		SchemaID:   "EMatouMembershipSchemaV1",
		Data: map[string]interface{}{
			"communityName":      "MATOU",
			"role":               "Member",
			"verificationStatus": "community_verified",
			"permissions":        []string{"read", "comment"},
			"joinedAt":           "2026-01-19T00:00:00Z",
		},
		Verified: true,
	}
	if err := store.StoreCredential(ctx, cred); err != nil {
		t.Fatalf("failed to store credential: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/community/members", nil)
	w := httptest.NewRecorder()

	handler.HandleGetCommunityMembers(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status %d, got %d: %s", http.StatusOK, w.Code, w.Body.String())
	}

	var resp CommunityMembersResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp.Total != 1 {
		t.Errorf("expected 1 member, got %d", resp.Total)
	}
	if len(resp.Members) != 1 {
		t.Errorf("expected 1 member in array, got %d", len(resp.Members))
	}
	if resp.Members[0].AID != "EUSER123" {
		t.Errorf("expected AID EUSER123, got %s", resp.Members[0].AID)
	}
}

func TestHandleGetCommunityMembers_MethodNotAllowed(t *testing.T) {
	handler, _, cleanup := setupSyncTestHandler(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodPost, "/api/v1/community/members", nil)
	w := httptest.NewRecorder()

	handler.HandleGetCommunityMembers(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected status %d, got %d", http.StatusMethodNotAllowed, w.Code)
	}
}

// ============================================
// HandleGetCommunityCredentials Tests
// ============================================

func TestHandleGetCommunityCredentials_Empty(t *testing.T) {
	handler, _, cleanup := setupSyncTestHandler(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/community/credentials", nil)
	w := httptest.NewRecorder()

	handler.HandleGetCommunityCredentials(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status %d, got %d: %s", http.StatusOK, w.Code, w.Body.String())
	}

	var resp CommunityCredentialsResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp.Credentials == nil {
		t.Error("expected non-nil credentials array")
	}
	if resp.Total != 0 {
		t.Errorf("expected 0 credentials, got %d", resp.Total)
	}
}

func TestHandleGetCommunityCredentials_WithCredentials(t *testing.T) {
	handler, store, cleanup := setupSyncTestHandler(t)
	defer cleanup()

	ctx := context.Background()

	// Store a membership credential (community-visible)
	cred1 := &anystore.CachedCredential{
		ID:         "ESAID001",
		IssuerAID:  "EAID123456789",
		SubjectAID: "EUSER123",
		SchemaID:   "EMatouMembershipSchemaV1",
		Data: map[string]interface{}{
			"communityName":      "MATOU",
			"role":               "Member",
			"verificationStatus": "unverified",
			"permissions":        []string{"read"},
			"joinedAt":           "2026-01-19T00:00:00Z",
		},
		Verified: true,
	}
	if err := store.StoreCredential(ctx, cred1); err != nil {
		t.Fatalf("failed to store credential: %v", err)
	}

	// Store a steward credential (community-visible)
	cred2 := &anystore.CachedCredential{
		ID:         "ESAID002",
		IssuerAID:  "EAID123456789",
		SubjectAID: "EUSER123",
		SchemaID:   "EOperationsStewardSchemaV1",
		Data: map[string]interface{}{
			"role":        "operations_steward",
			"permissions": []string{"admin_keria"},
			"grantedAt":   "2026-01-19T00:00:00Z",
		},
		Verified: true,
	}
	if err := store.StoreCredential(ctx, cred2); err != nil {
		t.Fatalf("failed to store credential: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/community/credentials", nil)
	w := httptest.NewRecorder()

	handler.HandleGetCommunityCredentials(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status %d, got %d: %s", http.StatusOK, w.Code, w.Body.String())
	}

	var resp CommunityCredentialsResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp.Total != 2 {
		t.Errorf("expected 2 credentials, got %d", resp.Total)
	}
}

func TestHandleGetCommunityCredentials_FiltersPrivate(t *testing.T) {
	handler, store, cleanup := setupSyncTestHandler(t)
	defer cleanup()

	ctx := context.Background()

	// Store a membership credential (community-visible)
	cred1 := &anystore.CachedCredential{
		ID:         "ESAID001",
		IssuerAID:  "EAID123456789",
		SubjectAID: "EUSER123",
		SchemaID:   "EMatouMembershipSchemaV1",
		Data: map[string]interface{}{
			"communityName":      "MATOU",
			"role":               "Member",
			"verificationStatus": "unverified",
			"permissions":        []string{"read"},
			"joinedAt":           "2026-01-19T00:00:00Z",
		},
		Verified: true,
	}
	if err := store.StoreCredential(ctx, cred1); err != nil {
		t.Fatalf("failed to store credential: %v", err)
	}

	// Store a self-claim credential (private - should be filtered)
	cred2 := &anystore.CachedCredential{
		ID:         "ESAID002",
		IssuerAID:  "EUSER123",
		SubjectAID: "EUSER123",
		SchemaID:   "ESelfClaimSchemaV1",
		Data: map[string]interface{}{
			"displayName": "Alice",
			"bio":         "Developer",
		},
		Verified: false,
	}
	if err := store.StoreCredential(ctx, cred2); err != nil {
		t.Fatalf("failed to store credential: %v", err)
	}

	// Store an invitation credential (private - should be filtered)
	cred3 := &anystore.CachedCredential{
		ID:         "ESAID003",
		IssuerAID:  "EUSER123",
		SubjectAID: "EUSER456",
		SchemaID:   "EInvitationSchemaV1",
		Data: map[string]interface{}{
			"message": "Join us!",
		},
		Verified: false,
	}
	if err := store.StoreCredential(ctx, cred3); err != nil {
		t.Fatalf("failed to store credential: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/community/credentials", nil)
	w := httptest.NewRecorder()

	handler.HandleGetCommunityCredentials(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status %d, got %d: %s", http.StatusOK, w.Code, w.Body.String())
	}

	var resp CommunityCredentialsResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	// Only the membership credential should be returned
	if resp.Total != 1 {
		t.Errorf("expected 1 credential (private filtered), got %d", resp.Total)
	}
	if len(resp.Credentials) > 0 && resp.Credentials[0].SAID != "ESAID001" {
		t.Errorf("expected membership credential, got %s", resp.Credentials[0].SAID)
	}
}

func TestHandleGetCommunityCredentials_MethodNotAllowed(t *testing.T) {
	handler, _, cleanup := setupSyncTestHandler(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodPost, "/api/v1/community/credentials", nil)
	w := httptest.NewRecorder()

	handler.HandleGetCommunityCredentials(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected status %d, got %d", http.StatusMethodNotAllowed, w.Code)
	}
}

// ============================================
// RegisterRoutes Tests
// ============================================

func TestSyncHandler_RegisterRoutes(t *testing.T) {
	handler, _, cleanup := setupSyncTestHandler(t)
	defer cleanup()

	mux := http.NewServeMux()
	handler.RegisterRoutes(mux)

	// Test that routes are registered
	paths := []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/api/v1/sync/credentials"},
		{http.MethodPost, "/api/v1/sync/kel"},
		{http.MethodGet, "/api/v1/community/members"},
		{http.MethodGet, "/api/v1/community/credentials"},
	}

	for _, p := range paths {
		t.Run(p.path, func(t *testing.T) {
			var body *bytes.Buffer
			if p.method == http.MethodPost {
				body = bytes.NewBufferString(`{"userAid": "test", "credentials": [], "kel": []}`)
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
