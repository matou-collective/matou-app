package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/matou-dao/backend/internal/anystore"
	"github.com/matou-dao/backend/internal/trust"
)

func setupTrustTestStore(t *testing.T) (*anystore.LocalStore, func()) {
	t.Helper()

	tmpDir, err := os.MkdirTemp("", "trust_api_test")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}

	config := anystore.DefaultConfig(tmpDir)
	store, err := anystore.NewLocalStore(config)
	if err != nil {
		_ = os.RemoveAll(tmpDir)
		t.Fatalf("Failed to create store: %v", err)
	}

	cleanup := func() {
		_ = store.Close()
		_ = os.RemoveAll(tmpDir)
	}

	return store, cleanup
}

func TestNewTrustHandler(t *testing.T) {
	store, cleanup := setupTrustTestStore(t)
	defer cleanup()

	handler := NewTrustHandler(store, "EORG123", nil)

	if handler == nil {
		t.Fatal("NewTrustHandler returned nil")
	}
	if handler.orgAID != "EORG123" {
		t.Errorf("expected orgAID EORG123, got %s", handler.orgAID)
	}
	if handler.calculator == nil {
		t.Error("expected calculator to be initialized")
	}
}

func TestHandleGetGraph_EmptyStore(t *testing.T) {
	store, cleanup := setupTrustTestStore(t)
	defer cleanup()

	handler := NewTrustHandler(store, "EORG123", nil)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/trust/graph", nil)
	w := httptest.NewRecorder()

	handler.HandleGetGraph(w, req)

	resp := w.Result()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected status 200, got %d", resp.StatusCode)
	}

	var result GraphResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		t.Fatalf("Failed to decode response: %v", err)
	}

	if result.Graph == nil {
		t.Error("expected graph in response")
	}
	if result.Graph.OrgAID != "EORG123" {
		t.Errorf("expected OrgAID EORG123, got %s", result.Graph.OrgAID)
	}
}

func TestHandleGetGraph_WithCredentials(t *testing.T) {
	store, cleanup := setupTrustTestStore(t)
	defer cleanup()

	ctx := context.Background()

	// Add test credentials
	_ = store.StoreCredential(ctx, &anystore.CachedCredential{
		ID:         "ESAID001",
		IssuerAID:  "EORG123",
		SubjectAID: "EUSER1",
		SchemaID:   "EMatouMembershipSchemaV1",
		CachedAt:   time.Now(),
		Data: map[string]interface{}{
			"role": "Member",
		},
	})
	_ = store.StoreCredential(ctx, &anystore.CachedCredential{
		ID:         "ESAID002",
		IssuerAID:  "EORG123",
		SubjectAID: "EUSER2",
		SchemaID:   "EMatouMembershipSchemaV1",
		CachedAt:   time.Now(),
		Data: map[string]interface{}{
			"role": "Member",
		},
	})

	handler := NewTrustHandler(store, "EORG123", nil)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/trust/graph", nil)
	w := httptest.NewRecorder()

	handler.HandleGetGraph(w, req)

	resp := w.Result()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected status 200, got %d", resp.StatusCode)
	}

	var result GraphResponse
	_ = json.NewDecoder(resp.Body).Decode(&result)

	if result.Graph.NodeCount() != 3 { // org + 2 users
		t.Errorf("expected 3 nodes, got %d", result.Graph.NodeCount())
	}
	if result.Graph.EdgeCount() != 2 {
		t.Errorf("expected 2 edges, got %d", result.Graph.EdgeCount())
	}
}

func TestHandleGetGraph_WithSummary(t *testing.T) {
	store, cleanup := setupTrustTestStore(t)
	defer cleanup()

	ctx := context.Background()
	_ = store.StoreCredential(ctx, &anystore.CachedCredential{
		ID:         "ESAID001",
		IssuerAID:  "EORG123",
		SubjectAID: "EUSER1",
		SchemaID:   "EMatouMembershipSchemaV1",
		CachedAt:   time.Now(),
		Data: map[string]interface{}{
			"role": "Member",
		},
	})

	handler := NewTrustHandler(store, "EORG123", nil)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/trust/graph?summary=true", nil)
	w := httptest.NewRecorder()

	handler.HandleGetGraph(w, req)

	var result GraphResponse
	_ = json.NewDecoder(w.Result().Body).Decode(&result)

	if result.Summary == nil {
		t.Error("expected summary when summary=true")
	}
	if result.Summary.TotalNodes != 2 {
		t.Errorf("expected 2 nodes in summary, got %d", result.Summary.TotalNodes)
	}
}

func TestHandleGetGraph_WithAIDFilter(t *testing.T) {
	store, cleanup := setupTrustTestStore(t)
	defer cleanup()

	ctx := context.Background()

	// Chain: Org -> User1 -> User2 -> User3
	_ = store.StoreCredential(ctx, &anystore.CachedCredential{
		ID:         "ESAID001",
		IssuerAID:  "EORG123",
		SubjectAID: "EUSER1",
		SchemaID:   "EMatouMembershipSchemaV1",
		CachedAt:   time.Now(),
		Data: map[string]interface{}{
			"role": "Member",
		},
	})
	_ = store.StoreCredential(ctx, &anystore.CachedCredential{
		ID:         "ESAID002",
		IssuerAID:  "EUSER1",
		SubjectAID: "EUSER2",
		SchemaID:   "EInvitationSchemaV1",
		CachedAt:   time.Now(),
		Data: map[string]interface{}{
			"role": "Member",
		},
	})
	_ = store.StoreCredential(ctx, &anystore.CachedCredential{
		ID:         "ESAID003",
		IssuerAID:  "EUSER2",
		SubjectAID: "EUSER3",
		SchemaID:   "EInvitationSchemaV1",
		CachedAt:   time.Now(),
		Data: map[string]interface{}{
			"role": "Member",
		},
	})

	handler := NewTrustHandler(store, "EORG123", nil)

	// Request subgraph for User1 with depth 1
	req := httptest.NewRequest(http.MethodGet, "/api/v1/trust/graph?aid=EUSER1&depth=1", nil)
	w := httptest.NewRecorder()

	handler.HandleGetGraph(w, req)

	var result GraphResponse
	_ = json.NewDecoder(w.Result().Body).Decode(&result)

	// Should have User1, Org, User2 (not User3)
	if result.Graph.GetNode("EUSER1") == nil {
		t.Error("expected EUSER1 in subgraph")
	}
	if result.Graph.GetNode("EUSER3") != nil {
		t.Error("EUSER3 should not be in depth-1 subgraph")
	}
}

func TestHandleGetGraph_MethodNotAllowed(t *testing.T) {
	store, cleanup := setupTrustTestStore(t)
	defer cleanup()

	handler := NewTrustHandler(store, "EORG123", nil)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/trust/graph", nil)
	w := httptest.NewRecorder()

	handler.HandleGetGraph(w, req)

	if w.Result().StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("expected status 405, got %d", w.Result().StatusCode)
	}
}

func TestHandleGetScore(t *testing.T) {
	store, cleanup := setupTrustTestStore(t)
	defer cleanup()

	ctx := context.Background()
	_ = store.StoreCredential(ctx, &anystore.CachedCredential{
		ID:         "ESAID001",
		IssuerAID:  "EORG123",
		SubjectAID: "EUSER1",
		SchemaID:   "EMatouMembershipSchemaV1",
		CachedAt:   time.Now(),
		Data: map[string]interface{}{
			"role":        "Member",
			"displayName": "alice",
		},
	})

	handler := NewTrustHandler(store, "EORG123", nil)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/trust/score/EUSER1", nil)
	w := httptest.NewRecorder()

	handler.HandleGetScore(w, req)

	resp := w.Result()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected status 200, got %d", resp.StatusCode)
	}

	var result ScoreResponse
	_ = json.NewDecoder(resp.Body).Decode(&result)

	if result.Score == nil {
		t.Fatal("expected score in response")
	}
	if result.Score.AID != "EUSER1" {
		t.Errorf("expected AID EUSER1, got %s", result.Score.AID)
	}
	if result.Score.Alias != "alice" {
		t.Errorf("expected alias alice, got %s", result.Score.Alias)
	}
	if result.Score.IncomingCredentials != 1 {
		t.Errorf("expected 1 incoming credential, got %d", result.Score.IncomingCredentials)
	}
}

func TestHandleGetScore_NotFound(t *testing.T) {
	store, cleanup := setupTrustTestStore(t)
	defer cleanup()

	handler := NewTrustHandler(store, "EORG123", nil)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/trust/score/ENONEXISTENT", nil)
	w := httptest.NewRecorder()

	handler.HandleGetScore(w, req)

	if w.Result().StatusCode != http.StatusNotFound {
		t.Errorf("expected status 404, got %d", w.Result().StatusCode)
	}
}

func TestHandleGetScore_MissingAID(t *testing.T) {
	store, cleanup := setupTrustTestStore(t)
	defer cleanup()

	handler := NewTrustHandler(store, "EORG123", nil)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/trust/score/", nil)
	w := httptest.NewRecorder()

	handler.HandleGetScore(w, req)

	if w.Result().StatusCode != http.StatusBadRequest {
		t.Errorf("expected status 400, got %d", w.Result().StatusCode)
	}
}

func TestHandleGetScores(t *testing.T) {
	store, cleanup := setupTrustTestStore(t)
	defer cleanup()

	ctx := context.Background()

	// Add multiple users
	_ = store.StoreCredential(ctx, &anystore.CachedCredential{
		ID:         "ESAID001",
		IssuerAID:  "EORG123",
		SubjectAID: "EUSER1",
		SchemaID:   "EMatouMembershipSchemaV1",
		CachedAt:   time.Now(),
		Data: map[string]interface{}{
			"role": "Member",
		},
	})
	_ = store.StoreCredential(ctx, &anystore.CachedCredential{
		ID:         "ESAID002",
		IssuerAID:  "EORG123",
		SubjectAID: "EUSER2",
		SchemaID:   "EMatouMembershipSchemaV1",
		CachedAt:   time.Now(),
		Data: map[string]interface{}{
			"role": "Member",
		},
	})
	// Give User1 extra credential
	_ = store.StoreCredential(ctx, &anystore.CachedCredential{
		ID:         "ESAID003",
		IssuerAID:  "EUSER2",
		SubjectAID: "EUSER1",
		SchemaID:   "EInvitationSchemaV1",
		CachedAt:   time.Now(),
		Data: map[string]interface{}{
			"role": "Member",
		},
	})

	handler := NewTrustHandler(store, "EORG123", nil)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/trust/scores?limit=10", nil)
	w := httptest.NewRecorder()

	handler.HandleGetScores(w, req)

	resp := w.Result()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected status 200, got %d", resp.StatusCode)
	}

	var result ScoresResponse
	_ = json.NewDecoder(resp.Body).Decode(&result)

	if len(result.Scores) != 3 { // org + 2 users
		t.Errorf("expected 3 scores, got %d", len(result.Scores))
	}
	if result.Total != 3 {
		t.Errorf("expected total 3, got %d", result.Total)
	}

	// Should be sorted by score descending
	for i := 1; i < len(result.Scores); i++ {
		if result.Scores[i].Score > result.Scores[i-1].Score {
			t.Error("scores should be sorted descending")
			break
		}
	}
}

func TestHandleGetScores_WithLimit(t *testing.T) {
	store, cleanup := setupTrustTestStore(t)
	defer cleanup()

	ctx := context.Background()

	// Add 5 users
	for i := 1; i <= 5; i++ {
		_ = store.StoreCredential(ctx, &anystore.CachedCredential{
			ID:         "ESAID00" + string(rune('0'+i)),
			IssuerAID:  "EORG123",
			SubjectAID: "EUSER" + string(rune('0'+i)),
			SchemaID:   "EMatouMembershipSchemaV1",
			CachedAt:   time.Now(),
			Data: map[string]interface{}{
				"role": "Member",
			},
		})
	}

	handler := NewTrustHandler(store, "EORG123", nil)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/trust/scores?limit=3", nil)
	w := httptest.NewRecorder()

	handler.HandleGetScores(w, req)

	var result ScoresResponse
	_ = json.NewDecoder(w.Result().Body).Decode(&result)

	if len(result.Scores) != 3 {
		t.Errorf("expected 3 scores (limited), got %d", len(result.Scores))
	}
}

func TestHandleGetSummary(t *testing.T) {
	store, cleanup := setupTrustTestStore(t)
	defer cleanup()

	ctx := context.Background()

	// Org -> User1 <-> User2
	_ = store.StoreCredential(ctx, &anystore.CachedCredential{
		ID:         "ESAID001",
		IssuerAID:  "EORG123",
		SubjectAID: "EUSER1",
		SchemaID:   "EMatouMembershipSchemaV1",
		CachedAt:   time.Now(),
		Data: map[string]interface{}{
			"role": "Member",
		},
	})
	_ = store.StoreCredential(ctx, &anystore.CachedCredential{
		ID:         "ESAID002",
		IssuerAID:  "EORG123",
		SubjectAID: "EUSER2",
		SchemaID:   "EMatouMembershipSchemaV1",
		CachedAt:   time.Now(),
		Data: map[string]interface{}{
			"role": "Member",
		},
	})
	_ = store.StoreCredential(ctx, &anystore.CachedCredential{
		ID:         "ESAID003",
		IssuerAID:  "EUSER1",
		SubjectAID: "EUSER2",
		SchemaID:   "EInvitationSchemaV1",
		CachedAt:   time.Now(),
		Data: map[string]interface{}{
			"role": "Member",
		},
	})
	_ = store.StoreCredential(ctx, &anystore.CachedCredential{
		ID:         "ESAID004",
		IssuerAID:  "EUSER2",
		SubjectAID: "EUSER1",
		SchemaID:   "EInvitationSchemaV1",
		CachedAt:   time.Now(),
		Data: map[string]interface{}{
			"role": "Member",
		},
	})

	handler := NewTrustHandler(store, "EORG123", nil)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/trust/summary", nil)
	w := httptest.NewRecorder()

	handler.HandleGetSummary(w, req)

	resp := w.Result()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected status 200, got %d", resp.StatusCode)
	}

	var summary trust.ScoreSummary
	_ = json.NewDecoder(resp.Body).Decode(&summary)

	if summary.TotalNodes != 3 {
		t.Errorf("expected 3 nodes, got %d", summary.TotalNodes)
	}
	if summary.TotalEdges != 4 {
		t.Errorf("expected 4 edges, got %d", summary.TotalEdges)
	}
	if summary.BidirectionalCount != 1 {
		t.Errorf("expected 1 bidirectional pair, got %d", summary.BidirectionalCount)
	}
	if summary.AverageScore <= 0 {
		t.Errorf("expected positive average score, got %f", summary.AverageScore)
	}
}

func TestHandleGetSummary_MethodNotAllowed(t *testing.T) {
	store, cleanup := setupTrustTestStore(t)
	defer cleanup()

	handler := NewTrustHandler(store, "EORG123", nil)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/trust/summary", nil)
	w := httptest.NewRecorder()

	handler.HandleGetSummary(w, req)

	if w.Result().StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("expected status 405, got %d", w.Result().StatusCode)
	}
}

func TestTrustHandler_RegisterRoutes(t *testing.T) {
	store, cleanup := setupTrustTestStore(t)
	defer cleanup()

	handler := NewTrustHandler(store, "EORG123", nil)
	mux := http.NewServeMux()

	handler.RegisterRoutes(mux)

	// Test that routes are registered by making requests
	tests := []struct {
		path   string
		status int
	}{
		{"/api/v1/trust/graph", http.StatusOK},
		{"/api/v1/trust/scores", http.StatusOK},
		{"/api/v1/trust/summary", http.StatusOK},
	}

	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tt.path, nil)
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, req)

			if w.Result().StatusCode != tt.status {
				t.Errorf("expected status %d, got %d", tt.status, w.Result().StatusCode)
			}
		})
	}
}
