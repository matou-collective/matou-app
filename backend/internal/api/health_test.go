package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/matou-dao/backend/internal/anysync"
	"github.com/matou-dao/backend/internal/anystore"
)

func setupHealthTestHandler(t *testing.T) (*HealthHandler, *anystore.LocalStore, anysync.SpaceStore, func()) {
	// Create temp directory for test database
	tmpDir, err := os.MkdirTemp("", "health_test")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}

	// Create anystore
	store, err := anystore.NewLocalStore(anystore.DefaultConfig(tmpDir))
	if err != nil {
		os.RemoveAll(tmpDir)
		t.Fatalf("failed to create anystore: %v", err)
	}

	// Create space store adapter
	spaceStore := anystore.NewSpaceStoreAdapter(store)

	cleanup := func() {
		store.Close()
		os.RemoveAll(tmpDir)
	}

	handler := NewHealthHandler(store, spaceStore, "EOrg123456789", "EAdmin123456789")
	return handler, store, spaceStore, cleanup
}

// ============================================
// NewHealthHandler Tests
// ============================================

func TestNewHealthHandler(t *testing.T) {
	handler, _, _, cleanup := setupHealthTestHandler(t)
	defer cleanup()

	if handler == nil {
		t.Fatal("expected non-nil handler")
	}
	if handler.orgAID != "EOrg123456789" {
		t.Errorf("expected orgAID EOrg123456789, got %s", handler.orgAID)
	}
	if handler.adminAID != "EAdmin123456789" {
		t.Errorf("expected adminAID EAdmin123456789, got %s", handler.adminAID)
	}
}

// ============================================
// HandleHealth Tests
// ============================================

func TestHandleHealth_BasicResponse(t *testing.T) {
	handler, _, _, cleanup := setupHealthTestHandler(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	w := httptest.NewRecorder()

	handler.HandleHealth(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status %d, got %d", http.StatusOK, w.Code)
	}

	var resp HealthResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp.Status != "healthy" {
		t.Errorf("expected status 'healthy', got '%s'", resp.Status)
	}
	if resp.Organization != "EOrg123456789" {
		t.Errorf("expected organization EOrg123456789, got %s", resp.Organization)
	}
	if resp.Admin != "EAdmin123456789" {
		t.Errorf("expected admin EAdmin123456789, got %s", resp.Admin)
	}
}

func TestHandleHealth_IncludesSyncStatus(t *testing.T) {
	handler, _, _, cleanup := setupHealthTestHandler(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	w := httptest.NewRecorder()

	handler.HandleHealth(w, req)

	var resp HealthResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp.Sync == nil {
		t.Fatal("expected sync status in response")
	}

	// Initially should be zeros
	if resp.Sync.CredentialsCached != 0 {
		t.Errorf("expected 0 credentials cached, got %d", resp.Sync.CredentialsCached)
	}
	if resp.Sync.SpacesCreated != 0 {
		t.Errorf("expected 0 spaces created, got %d", resp.Sync.SpacesCreated)
	}
	if resp.Sync.KELEventsStored != 0 {
		t.Errorf("expected 0 KEL events, got %d", resp.Sync.KELEventsStored)
	}
}

func TestHandleHealth_IncludesTrustStatus(t *testing.T) {
	handler, _, _, cleanup := setupHealthTestHandler(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	w := httptest.NewRecorder()

	handler.HandleHealth(w, req)

	var resp HealthResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp.Trust == nil {
		t.Fatal("expected trust status in response")
	}

	// Initially should have org node only
	if resp.Trust.TotalNodes < 1 {
		t.Errorf("expected at least 1 node (org), got %d", resp.Trust.TotalNodes)
	}
}

func TestHandleHealth_WithCredentials(t *testing.T) {
	handler, store, _, cleanup := setupHealthTestHandler(t)
	defer cleanup()

	ctx := context.Background()

	// Store some credentials
	for i := 0; i < 3; i++ {
		cred := &anystore.CachedCredential{
			ID:         "ESAID00" + string(rune('1'+i)),
			IssuerAID:  "EOrg123456789",
			SubjectAID: "EUSER00" + string(rune('1'+i)),
			SchemaID:   "EMatouMembershipSchemaV1",
			Data: map[string]interface{}{
				"communityName": "MATOU",
				"role":          "Member",
			},
			CachedAt: time.Now().UTC(),
			Verified: true,
		}
		if err := store.StoreCredential(ctx, cred); err != nil {
			t.Fatalf("failed to store credential: %v", err)
		}
	}

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	w := httptest.NewRecorder()

	handler.HandleHealth(w, req)

	var resp HealthResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp.Sync.CredentialsCached != 3 {
		t.Errorf("expected 3 credentials cached, got %d", resp.Sync.CredentialsCached)
	}

	// Trust graph should have org + 3 users
	if resp.Trust.TotalNodes < 4 {
		t.Errorf("expected at least 4 nodes, got %d", resp.Trust.TotalNodes)
	}
	if resp.Trust.TotalEdges < 3 {
		t.Errorf("expected at least 3 edges, got %d", resp.Trust.TotalEdges)
	}
}

func TestHandleHealth_WithSpaces(t *testing.T) {
	handler, _, spaceStore, cleanup := setupHealthTestHandler(t)
	defer cleanup()

	ctx := context.Background()

	// Create some spaces
	space1 := &anysync.Space{
		SpaceID:   "space-001",
		OwnerAID:  "EUSER001",
		SpaceType: "private",
		SpaceName: "User 1 Private",
		CreatedAt: time.Now().UTC(),
		LastSync:  time.Now().UTC(),
	}
	space2 := &anysync.Space{
		SpaceID:   "space-002",
		OwnerAID:  "EUSER002",
		SpaceType: "private",
		SpaceName: "User 2 Private",
		CreatedAt: time.Now().UTC(),
		LastSync:  time.Now().UTC(),
	}
	spaceStore.SaveSpace(ctx, space1)
	spaceStore.SaveSpace(ctx, space2)

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	w := httptest.NewRecorder()

	handler.HandleHealth(w, req)

	var resp HealthResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp.Sync.SpacesCreated != 2 {
		t.Errorf("expected 2 spaces created, got %d", resp.Sync.SpacesCreated)
	}
}

func TestHandleHealth_MethodNotAllowed(t *testing.T) {
	handler, _, _, cleanup := setupHealthTestHandler(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodPost, "/health", nil)
	w := httptest.NewRecorder()

	handler.HandleHealth(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected status %d, got %d", http.StatusMethodNotAllowed, w.Code)
	}
}

func TestHandleHealth_ContentType(t *testing.T) {
	handler, _, _, cleanup := setupHealthTestHandler(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	w := httptest.NewRecorder()

	handler.HandleHealth(w, req)

	contentType := w.Header().Get("Content-Type")
	if contentType != "application/json" {
		t.Errorf("expected Content-Type application/json, got %s", contentType)
	}
}

// ============================================
// SyncStatus Tests
// ============================================

func TestSyncStatus_EmptyStore(t *testing.T) {
	handler, _, _, cleanup := setupHealthTestHandler(t)
	defer cleanup()

	ctx := context.Background()
	status := handler.getSyncStatus(ctx)

	if status == nil {
		t.Fatal("expected non-nil sync status")
	}
	if status.CredentialsCached != 0 {
		t.Errorf("expected 0 credentials, got %d", status.CredentialsCached)
	}
	if status.SpacesCreated != 0 {
		t.Errorf("expected 0 spaces, got %d", status.SpacesCreated)
	}
	if status.KELEventsStored != 0 {
		t.Errorf("expected 0 KEL events, got %d", status.KELEventsStored)
	}
}

// ============================================
// TrustStatus Tests
// ============================================

func TestTrustStatus_EmptyStore(t *testing.T) {
	handler, _, _, cleanup := setupHealthTestHandler(t)
	defer cleanup()

	ctx := context.Background()
	status := handler.getTrustStatus(ctx)

	if status == nil {
		t.Fatal("expected non-nil trust status")
	}

	// Should have at least org node
	if status.TotalNodes < 1 {
		t.Errorf("expected at least 1 node, got %d", status.TotalNodes)
	}
}

func TestTrustStatus_WithCredentials(t *testing.T) {
	handler, store, _, cleanup := setupHealthTestHandler(t)
	defer cleanup()

	ctx := context.Background()

	// Store a membership credential
	cred := &anystore.CachedCredential{
		ID:         "ESAID001",
		IssuerAID:  "EOrg123456789",
		SubjectAID: "EUSER001",
		SchemaID:   "EMatouMembershipSchemaV1",
		Data: map[string]interface{}{
			"communityName":      "MATOU",
			"role":               "Member",
			"verificationStatus": "unverified",
			"permissions":        []string{"read"},
			"joinedAt":           time.Now().Format(time.RFC3339),
		},
		CachedAt: time.Now().UTC(),
		Verified: true,
	}
	if err := store.StoreCredential(ctx, cred); err != nil {
		t.Fatalf("failed to store credential: %v", err)
	}

	status := handler.getTrustStatus(ctx)

	if status == nil {
		t.Fatal("expected non-nil trust status")
	}

	// Should have org + 1 user = 2 nodes
	if status.TotalNodes < 2 {
		t.Errorf("expected at least 2 nodes, got %d", status.TotalNodes)
	}

	// Should have 1 edge (org -> user)
	if status.TotalEdges < 1 {
		t.Errorf("expected at least 1 edge, got %d", status.TotalEdges)
	}

	// Average score should be > 0
	if status.AverageScore <= 0 {
		t.Errorf("expected positive average score, got %f", status.AverageScore)
	}
}

// ============================================
// HealthResponse Structure Tests
// ============================================

func TestHealthResponse_JSONStructure(t *testing.T) {
	handler, store, _, cleanup := setupHealthTestHandler(t)
	defer cleanup()

	ctx := context.Background()

	// Add a credential to have real data
	cred := &anystore.CachedCredential{
		ID:         "ESAID001",
		IssuerAID:  "EOrg123456789",
		SubjectAID: "EUSER001",
		SchemaID:   "EMatouMembershipSchemaV1",
		Data: map[string]interface{}{
			"communityName": "MATOU",
			"role":          "Member",
		},
		CachedAt: time.Now().UTC(),
	}
	store.StoreCredential(ctx, cred)

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	w := httptest.NewRecorder()

	handler.HandleHealth(w, req)

	// Parse raw JSON to verify structure
	var rawResp map[string]interface{}
	if err := json.NewDecoder(w.Body).Decode(&rawResp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	// Check required fields exist
	requiredFields := []string{"status", "organization", "admin"}
	for _, field := range requiredFields {
		if _, ok := rawResp[field]; !ok {
			t.Errorf("missing required field: %s", field)
		}
	}

	// Check sync object structure
	sync, ok := rawResp["sync"].(map[string]interface{})
	if !ok {
		t.Fatal("expected sync to be an object")
	}
	syncFields := []string{"credentialsCached", "spacesCreated", "kelEventsStored"}
	for _, field := range syncFields {
		if _, ok := sync[field]; !ok {
			t.Errorf("missing sync field: %s", field)
		}
	}

	// Check trust object structure
	trust, ok := rawResp["trust"].(map[string]interface{})
	if !ok {
		t.Fatal("expected trust to be an object")
	}
	trustFields := []string{"totalNodes", "totalEdges", "averageScore"}
	for _, field := range trustFields {
		if _, ok := trust[field]; !ok {
			t.Errorf("missing trust field: %s", field)
		}
	}
}
