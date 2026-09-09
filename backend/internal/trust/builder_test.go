package trust

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/matou-dao/backend/internal/anystore"
)

func setupTestStore(t *testing.T) (*anystore.LocalStore, func()) {
	t.Helper()

	// Create temp directory
	tmpDir, err := os.MkdirTemp("", "trust_builder_test")
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

func TestNewBuilder(t *testing.T) {
	store, cleanup := setupTestStore(t)
	defer cleanup()

	builder := NewBuilder(store, "EORG123")
	if builder == nil {
		t.Fatal("NewBuilder returned nil")
	}
	if builder.orgAID != "EORG123" {
		t.Errorf("expected orgAID EORG123, got %s", builder.orgAID)
	}
}

func TestBuilder_Build_EmptyStore(t *testing.T) {
	store, cleanup := setupTestStore(t)
	defer cleanup()

	builder := NewBuilder(store, "EORG123")
	graph, err := builder.Build(context.Background())

	if err != nil {
		t.Fatalf("Build failed: %v", err)
	}
	if graph == nil {
		t.Fatal("Build returned nil graph")
	}
	if graph.OrgAID != "EORG123" {
		t.Errorf("expected OrgAID EORG123, got %s", graph.OrgAID)
	}
	// Should have org node added
	if graph.NodeCount() != 1 {
		t.Errorf("expected 1 node (org), got %d", graph.NodeCount())
	}
	if graph.GetNode("EORG123") == nil {
		t.Error("expected org node to exist")
	}
}

func TestBuilder_Build_WithCredentials(t *testing.T) {
	store, cleanup := setupTestStore(t)
	defer cleanup()

	ctx := context.Background()

	// Store membership credentials
	cred1 := &anystore.CachedCredential{
		ID:         "ESAID001",
		IssuerAID:  "EORG123",
		SubjectAID: "EUSER1",
		SchemaID:   "EMatouMembershipSchemaV1",
		CachedAt:   time.Now(),
		Data: map[string]interface{}{
			"role":        "Member",
			"displayName": "alice",
		},
	}
	cred2 := &anystore.CachedCredential{
		ID:         "ESAID002",
		IssuerAID:  "EORG123",
		SubjectAID: "EUSER2",
		SchemaID:   "EMatouMembershipSchemaV1",
		CachedAt:   time.Now(),
		Data: map[string]interface{}{
			"role":        "Member",
			"displayName": "bob",
		},
	}

	if err := store.StoreCredential(ctx, cred1); err != nil {
		t.Fatalf("Failed to store cred1: %v", err)
	}
	if err := store.StoreCredential(ctx, cred2); err != nil {
		t.Fatalf("Failed to store cred2: %v", err)
	}

	builder := NewBuilder(store, "EORG123")
	graph, err := builder.Build(ctx)

	if err != nil {
		t.Fatalf("Build failed: %v", err)
	}

	// Should have 3 nodes: org + 2 users
	if graph.NodeCount() != 3 {
		t.Errorf("expected 3 nodes, got %d", graph.NodeCount())
	}

	// Should have 2 edges
	if graph.EdgeCount() != 2 {
		t.Errorf("expected 2 edges, got %d", graph.EdgeCount())
	}

	// Check user1 node
	user1 := graph.GetNode("EUSER1")
	if user1 == nil {
		t.Error("expected EUSER1 node")
	} else if user1.Alias != "alice" {
		t.Errorf("expected alias alice, got %s", user1.Alias)
	}

	// Check user2 node
	user2 := graph.GetNode("EUSER2")
	if user2 == nil {
		t.Error("expected EUSER2 node")
	} else if user2.Alias != "bob" {
		t.Errorf("expected alias bob, got %s", user2.Alias)
	}
}

func TestBuilder_Build_WithInvitations(t *testing.T) {
	store, cleanup := setupTestStore(t)
	defer cleanup()

	ctx := context.Background()

	// Org -> User1 (membership)
	cred1 := &anystore.CachedCredential{
		ID:         "ESAID001",
		IssuerAID:  "EORG123",
		SubjectAID: "EUSER1",
		SchemaID:   "EMatouMembershipSchemaV1",
		CachedAt:   time.Now(),
		Data: map[string]interface{}{
			"role": "Member",
		},
	}
	// User1 -> User2 (invitation)
	cred2 := &anystore.CachedCredential{
		ID:         "ESAID002",
		IssuerAID:  "EUSER1",
		SubjectAID: "EUSER2",
		SchemaID:   "EInvitationSchemaV1",
		CachedAt:   time.Now(),
		Data: map[string]interface{}{
			"role": "Member",
		},
	}

	_ = store.StoreCredential(ctx, cred1)
	_ = store.StoreCredential(ctx, cred2)

	builder := NewBuilder(store, "EORG123")
	graph, err := builder.Build(ctx)

	if err != nil {
		t.Fatalf("Build failed: %v", err)
	}

	// Check edge types
	orgEdges := graph.GetEdgesFrom("EORG123")
	if len(orgEdges) != 1 {
		t.Errorf("expected 1 edge from org, got %d", len(orgEdges))
	} else if orgEdges[0].Type != EdgeTypeMembership {
		t.Errorf("expected membership edge, got %s", orgEdges[0].Type)
	}

	userEdges := graph.GetEdgesFrom("EUSER1")
	if len(userEdges) != 1 {
		t.Errorf("expected 1 edge from user1, got %d", len(userEdges))
	} else if userEdges[0].Type != EdgeTypeInvitation {
		t.Errorf("expected invitation edge, got %s", userEdges[0].Type)
	}
}

func TestBuilder_Build_BidirectionalRelations(t *testing.T) {
	store, cleanup := setupTestStore(t)
	defer cleanup()

	ctx := context.Background()

	// Org -> User1, Org -> User2
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

	// User1 <-> User2 (bidirectional invitations)
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

	builder := NewBuilder(store, "EORG123")
	graph, err := builder.Build(ctx)

	if err != nil {
		t.Fatalf("Build failed: %v", err)
	}

	// Check bidirectional is detected
	if !graph.HasBidirectionalRelation("EUSER1", "EUSER2") {
		t.Error("expected bidirectional relation between EUSER1 and EUSER2")
	}

	// Count bidirectional edges
	bidirectionalCount := 0
	for _, edge := range graph.Edges {
		if edge.Bidirectional {
			bidirectionalCount++
		}
	}
	if bidirectionalCount != 2 {
		t.Errorf("expected 2 bidirectional edges, got %d", bidirectionalCount)
	}
}

func TestBuilder_BuildForAID(t *testing.T) {
	store, cleanup := setupTestStore(t)
	defer cleanup()

	ctx := context.Background()

	// Create a chain: Org -> User1 -> User2 -> User3
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

	builder := NewBuilder(store, "EORG123")

	// Build subgraph for User1 with depth 1
	graph, err := builder.BuildForAID(ctx, "EUSER1", 1)
	if err != nil {
		t.Fatalf("BuildForAID failed: %v", err)
	}

	// Should have User1 and immediate neighbors (Org, User2)
	if graph.GetNode("EUSER1") == nil {
		t.Error("expected EUSER1 in subgraph")
	}
	if graph.GetNode("EORG123") == nil {
		t.Error("expected EORG123 in subgraph (incoming)")
	}
	if graph.GetNode("EUSER2") == nil {
		t.Error("expected EUSER2 in subgraph (outgoing)")
	}

	// User3 should not be included (depth 2 from User1)
	if graph.GetNode("EUSER3") != nil {
		t.Error("EUSER3 should not be in depth-1 subgraph")
	}
}

func TestBuilder_BuildForAID_Depth2(t *testing.T) {
	store, cleanup := setupTestStore(t)
	defer cleanup()

	ctx := context.Background()

	// Create a chain: Org -> User1 -> User2 -> User3
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

	builder := NewBuilder(store, "EORG123")

	// Build subgraph for User1 with depth 2
	graph, err := builder.BuildForAID(ctx, "EUSER1", 2)
	if err != nil {
		t.Fatalf("BuildForAID failed: %v", err)
	}

	// Should include all nodes in chain
	if graph.GetNode("EUSER1") == nil {
		t.Error("expected EUSER1 in subgraph")
	}
	if graph.GetNode("EORG123") == nil {
		t.Error("expected EORG123 in subgraph")
	}
	if graph.GetNode("EUSER2") == nil {
		t.Error("expected EUSER2 in subgraph")
	}
	if graph.GetNode("EUSER3") == nil {
		t.Error("expected EUSER3 in depth-2 subgraph")
	}
}

func TestBuilder_BuildForAID_NonExistent(t *testing.T) {
	store, cleanup := setupTestStore(t)
	defer cleanup()

	builder := NewBuilder(store, "EORG123")

	// Build for non-existent AID - should still work, returns empty subgraph
	// (no nodes reachable from non-existent AID)
	graph, err := builder.BuildForAID(context.Background(), "ENONEXISTENT", 1)
	if err != nil {
		t.Fatalf("BuildForAID failed: %v", err)
	}

	// Subgraph is empty since no nodes are reachable from a non-existent AID
	if graph.NodeCount() != 0 {
		t.Errorf("expected 0 nodes for non-existent AID, got %d", graph.NodeCount())
	}
}

// Helper to check if file exists
func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func TestBuilder_Build_StoresPersistently(t *testing.T) {
	// Create temp directory
	tmpDir, err := os.MkdirTemp("", "trust_builder_persist_test")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer func() { _ = os.RemoveAll(tmpDir) }()

	ctx := context.Background()

	// First store - add credentials
	{
		config := anystore.DefaultConfig(tmpDir)
		store, err := anystore.NewLocalStore(config)
		if err != nil {
			t.Fatalf("Failed to create store: %v", err)
		}

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

		_ = store.Close()
	}

	// Verify database file exists
	dbPath := filepath.Join(tmpDir, "matou.db")
	if !fileExists(dbPath) {
		t.Error("Database file should exist after store close")
	}

	// Second store - verify data persists
	{
		config := anystore.DefaultConfig(tmpDir)
		store, err := anystore.NewLocalStore(config)
		if err != nil {
			t.Fatalf("Failed to create store: %v", err)
		}
		defer func() { _ = store.Close() }()

		builder := NewBuilder(store, "EORG123")
		graph, err := builder.Build(ctx)

		if err != nil {
			t.Fatalf("Build failed: %v", err)
		}

		// Should find persisted credential
		if graph.NodeCount() != 2 { // org + user1
			t.Errorf("expected 2 nodes, got %d", graph.NodeCount())
		}
		if graph.GetNode("EUSER1") == nil {
			t.Error("expected EUSER1 from persisted credential")
		}
	}
}
