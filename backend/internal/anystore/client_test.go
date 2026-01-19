package anystore

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestNewLocalStore(t *testing.T) {
	// Create temporary directory for test database
	tmpDir, err := os.MkdirTemp("", "anystore-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	cfg := &Config{
		DBPath:    filepath.Join(tmpDir, "test.db"),
		AutoFlush: true,
	}

	store, err := NewLocalStore(cfg)
	if err != nil {
		t.Fatalf("failed to create local store: %v", err)
	}
	defer store.Close()

	// Verify database was created
	if _, err := os.Stat(cfg.DBPath); os.IsNotExist(err) {
		t.Error("database file was not created")
	}

	// Verify path is correct
	if store.Path() != cfg.DBPath {
		t.Errorf("expected path %s, got %s", cfg.DBPath, store.Path())
	}
}

func TestNewLocalStore_NilConfig(t *testing.T) {
	_, err := NewLocalStore(nil)
	if err == nil {
		t.Error("expected error for nil config")
	}
}

func TestCredentialsCRUD(t *testing.T) {
	store := setupTestStore(t)
	defer store.Close()

	ctx := context.Background()

	// Create a test credential
	cred := &CachedCredential{
		ID:         "ESAID123456789",
		IssuerAID:  "EIssuer123",
		SubjectAID: "ESubject456",
		SchemaID:   "ESchemaXYZ",
		Data: map[string]interface{}{
			"role":               "Member",
			"verificationStatus": "community_verified",
		},
		CachedAt:  time.Now().UTC(),
		ExpiresAt: time.Now().UTC().Add(24 * time.Hour),
		Verified:  true,
	}

	// Store credential
	err := store.StoreCredential(ctx, cred)
	if err != nil {
		t.Fatalf("failed to store credential: %v", err)
	}

	// Retrieve credential
	retrieved, err := store.GetCredential(ctx, cred.ID)
	if err != nil {
		t.Fatalf("failed to get credential: %v", err)
	}

	// Verify fields
	if retrieved.ID != cred.ID {
		t.Errorf("expected ID %s, got %s", cred.ID, retrieved.ID)
	}
	if retrieved.IssuerAID != cred.IssuerAID {
		t.Errorf("expected IssuerAID %s, got %s", cred.IssuerAID, retrieved.IssuerAID)
	}
	if retrieved.SubjectAID != cred.SubjectAID {
		t.Errorf("expected SubjectAID %s, got %s", cred.SubjectAID, retrieved.SubjectAID)
	}
	if !retrieved.Verified {
		t.Error("expected Verified to be true")
	}
}

func TestTrustNodeCRUD(t *testing.T) {
	store := setupTestStore(t)
	defer store.Close()

	ctx := context.Background()

	// Create a test trust node
	node := &TrustGraphNode{
		AID:                "EAID123456789",
		DisplayName:        "Test User",
		VerificationStatus: "verified",
		TrustScore:         0.85,
		Connections:        []string{"EAID111", "EAID222", "EAID333"},
		Depth:              2,
		CachedAt:           time.Now().UTC(),
	}

	// Store node
	err := store.StoreTrustNode(ctx, node)
	if err != nil {
		t.Fatalf("failed to store trust node: %v", err)
	}

	// Retrieve node
	retrieved, err := store.GetTrustNode(ctx, node.AID)
	if err != nil {
		t.Fatalf("failed to get trust node: %v", err)
	}

	// Verify fields
	if retrieved.AID != node.AID {
		t.Errorf("expected AID %s, got %s", node.AID, retrieved.AID)
	}
	if retrieved.DisplayName != node.DisplayName {
		t.Errorf("expected DisplayName %s, got %s", node.DisplayName, retrieved.DisplayName)
	}
	if retrieved.TrustScore != node.TrustScore {
		t.Errorf("expected TrustScore %f, got %f", node.TrustScore, retrieved.TrustScore)
	}
	if len(retrieved.Connections) != len(node.Connections) {
		t.Errorf("expected %d connections, got %d", len(node.Connections), len(retrieved.Connections))
	}
}

func TestPreferencesCRUD(t *testing.T) {
	store := setupTestStore(t)
	defer store.Close()

	ctx := context.Background()

	// Set a string preference
	err := store.SetPreference(ctx, "theme", "dark")
	if err != nil {
		t.Fatalf("failed to set preference: %v", err)
	}

	// Get preference
	value, err := store.GetPreference(ctx, "theme")
	if err != nil {
		t.Fatalf("failed to get preference: %v", err)
	}

	if value != "dark" {
		t.Errorf("expected theme 'dark', got '%v'", value)
	}

	// Update preference
	err = store.SetPreference(ctx, "theme", "light")
	if err != nil {
		t.Fatalf("failed to update preference: %v", err)
	}

	// Verify update
	value, err = store.GetPreference(ctx, "theme")
	if err != nil {
		t.Fatalf("failed to get updated preference: %v", err)
	}

	if value != "light" {
		t.Errorf("expected theme 'light', got '%v'", value)
	}
}

func TestCollectionAccess(t *testing.T) {
	store := setupTestStore(t)
	defer store.Close()

	ctx := context.Background()

	// Test all collection accessors
	collections := []struct {
		name   string
		getter func(context.Context) (interface{}, error)
	}{
		{"CredentialsCache", func(ctx context.Context) (interface{}, error) { return store.CredentialsCache(ctx) }},
		{"TrustGraphCache", func(ctx context.Context) (interface{}, error) { return store.TrustGraphCache(ctx) }},
		{"UserPreferences", func(ctx context.Context) (interface{}, error) { return store.UserPreferences(ctx) }},
		{"KELCache", func(ctx context.Context) (interface{}, error) { return store.KELCache(ctx) }},
		{"SyncIndex", func(ctx context.Context) (interface{}, error) { return store.SyncIndex(ctx) }},
	}

	for _, tc := range collections {
		t.Run(tc.name, func(t *testing.T) {
			coll, err := tc.getter(ctx)
			if err != nil {
				t.Errorf("failed to get %s collection: %v", tc.name, err)
			}
			if coll == nil {
				t.Errorf("%s collection is nil", tc.name)
			}
		})
	}
}

func TestClearCache(t *testing.T) {
	store := setupTestStore(t)
	defer store.Close()

	ctx := context.Background()

	// Store some data
	err := store.SetPreference(ctx, "test_key", "test_value")
	if err != nil {
		t.Fatalf("failed to set preference: %v", err)
	}

	// Verify data exists
	_, err = store.GetPreference(ctx, "test_key")
	if err != nil {
		t.Fatalf("preference should exist: %v", err)
	}

	// Clear the cache
	err = store.ClearCache(ctx, CollectionUserPreferences)
	if err != nil {
		t.Fatalf("failed to clear cache: %v", err)
	}

	// Verify data is gone
	_, err = store.GetPreference(ctx, "test_key")
	if err == nil {
		t.Error("preference should not exist after clearing cache")
	}
}

func TestStats(t *testing.T) {
	store := setupTestStore(t)
	defer store.Close()

	ctx := context.Background()

	stats, err := store.Stats(ctx)
	if err != nil {
		t.Fatalf("failed to get stats: %v", err)
	}

	// Stats should have size information
	if stats.TotalSizeBytes < 0 {
		t.Error("expected non-negative total size")
	}
}

func TestDefaultConfig(t *testing.T) {
	cfg := DefaultConfig("/tmp/matou")

	if cfg.DBPath != "/tmp/matou/matou.db" {
		t.Errorf("expected DBPath '/tmp/matou/matou.db', got '%s'", cfg.DBPath)
	}

	if !cfg.AutoFlush {
		t.Error("expected AutoFlush to be true by default")
	}
}

// setupTestStore creates a temporary test store
func setupTestStore(t *testing.T) *LocalStore {
	t.Helper()

	tmpDir, err := os.MkdirTemp("", "anystore-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(tmpDir) })

	cfg := &Config{
		DBPath:    filepath.Join(tmpDir, "test.db"),
		AutoFlush: true,
	}

	store, err := NewLocalStore(cfg)
	if err != nil {
		t.Fatalf("failed to create local store: %v", err)
	}

	return store
}
