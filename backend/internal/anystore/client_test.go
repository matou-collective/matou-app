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

func TestSpaceRecordCRUD(t *testing.T) {
	store := setupTestStore(t)
	defer store.Close()

	ctx := context.Background()

	// Create a test space record
	record := &SpaceRecord{
		ID:        "space-123456789",
		UserAID:   "EUSER123456789",
		SpaceType: "private",
		SpaceName: "Test User's Private Space",
		CreatedAt: time.Now().UTC(),
		LastSync:  time.Now().UTC(),
	}

	// Save space record
	err := store.SaveSpaceRecord(ctx, record)
	if err != nil {
		t.Fatalf("failed to save space record: %v", err)
	}

	// Retrieve by ID
	retrieved, err := store.GetSpaceByID(ctx, record.ID)
	if err != nil {
		t.Fatalf("failed to get space by ID: %v", err)
	}

	// Verify fields
	if retrieved.ID != record.ID {
		t.Errorf("expected ID %s, got %s", record.ID, retrieved.ID)
	}
	if retrieved.UserAID != record.UserAID {
		t.Errorf("expected UserAID %s, got %s", record.UserAID, retrieved.UserAID)
	}
	if retrieved.SpaceType != record.SpaceType {
		t.Errorf("expected SpaceType %s, got %s", record.SpaceType, retrieved.SpaceType)
	}
	if retrieved.SpaceName != record.SpaceName {
		t.Errorf("expected SpaceName %s, got %s", record.SpaceName, retrieved.SpaceName)
	}
}

func TestGetUserSpaceRecord(t *testing.T) {
	store := setupTestStore(t)
	defer store.Close()

	ctx := context.Background()
	userAID := "EUSER987654321"

	// Create a private space for the user
	record := &SpaceRecord{
		ID:        "space-user-987",
		UserAID:   userAID,
		SpaceType: "private",
		SpaceName: "User's Space",
		CreatedAt: time.Now().UTC(),
		LastSync:  time.Now().UTC(),
	}

	err := store.SaveSpaceRecord(ctx, record)
	if err != nil {
		t.Fatalf("failed to save space record: %v", err)
	}

	// Retrieve by user AID
	retrieved, err := store.GetUserSpaceRecord(ctx, userAID)
	if err != nil {
		t.Fatalf("failed to get user space record: %v", err)
	}

	if retrieved.UserAID != userAID {
		t.Errorf("expected UserAID %s, got %s", userAID, retrieved.UserAID)
	}

	// Test non-existent user
	_, err = store.GetUserSpaceRecord(ctx, "ENONEXISTENT")
	if err == nil {
		t.Error("expected error for non-existent user")
	}
}

func TestListAllSpaceRecords(t *testing.T) {
	store := setupTestStore(t)
	defer store.Close()

	ctx := context.Background()

	// Create multiple space records
	records := []*SpaceRecord{
		{
			ID:        "space-1",
			UserAID:   "EUSER1",
			SpaceType: "private",
			SpaceName: "User 1 Space",
			CreatedAt: time.Now().UTC(),
			LastSync:  time.Now().UTC(),
		},
		{
			ID:        "space-2",
			UserAID:   "EUSER2",
			SpaceType: "private",
			SpaceName: "User 2 Space",
			CreatedAt: time.Now().UTC(),
			LastSync:  time.Now().UTC(),
		},
		{
			ID:        "space-community",
			UserAID:   "EORG123",
			SpaceType: "community",
			SpaceName: "Community Space",
			CreatedAt: time.Now().UTC(),
			LastSync:  time.Now().UTC(),
		},
	}

	for _, record := range records {
		err := store.SaveSpaceRecord(ctx, record)
		if err != nil {
			t.Fatalf("failed to save space record: %v", err)
		}
	}

	// List all spaces
	allRecords, err := store.ListAllSpaceRecords(ctx)
	if err != nil {
		t.Fatalf("failed to list space records: %v", err)
	}

	if len(allRecords) != 3 {
		t.Errorf("expected 3 records, got %d", len(allRecords))
	}
}

func TestUpdateSpaceLastSync(t *testing.T) {
	store := setupTestStore(t)
	defer store.Close()

	ctx := context.Background()

	// Create a space record with old sync time
	oldTime := time.Now().UTC().Add(-24 * time.Hour)
	record := &SpaceRecord{
		ID:        "space-sync-test",
		UserAID:   "EUSER_SYNC",
		SpaceType: "private",
		SpaceName: "Sync Test Space",
		CreatedAt: oldTime,
		LastSync:  oldTime,
	}

	err := store.SaveSpaceRecord(ctx, record)
	if err != nil {
		t.Fatalf("failed to save space record: %v", err)
	}

	// Update last sync
	err = store.UpdateSpaceLastSync(ctx, record.ID)
	if err != nil {
		t.Fatalf("failed to update last sync: %v", err)
	}

	// Verify last sync was updated
	updated, err := store.GetSpaceByID(ctx, record.ID)
	if err != nil {
		t.Fatalf("failed to get updated record: %v", err)
	}

	if !updated.LastSync.After(oldTime) {
		t.Error("LastSync should be after the old time")
	}
}

func TestSpacesCollectionAccess(t *testing.T) {
	store := setupTestStore(t)
	defer store.Close()

	ctx := context.Background()

	coll, err := store.Spaces(ctx)
	if err != nil {
		t.Fatalf("failed to get Spaces collection: %v", err)
	}
	if coll == nil {
		t.Error("Spaces collection is nil")
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
