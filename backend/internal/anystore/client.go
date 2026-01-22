// Package anystore provides a local document database wrapper using any-store.
// This package handles local caching of credentials, trust graph data, and user preferences.
// The frontend communicates with this via gRPC - it does NOT use any-store directly.
package anystore

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	anystore "github.com/anyproto/any-store"
	"github.com/anyproto/any-store/anyenc"
)

// LocalStore wraps an any-store database for MATOU local storage needs.
type LocalStore struct {
	db     anystore.DB
	dbPath string
}

// Config holds configuration for the local store.
type Config struct {
	DBPath    string
	AutoFlush bool
}

// DefaultConfig returns a default configuration.
func DefaultConfig(dataDir string) *Config {
	return &Config{
		DBPath:    dataDir + "/matou.db",
		AutoFlush: true,
	}
}

// NewLocalStore creates a new LocalStore instance.
func NewLocalStore(cfg *Config) (*LocalStore, error) {
	if cfg == nil {
		return nil, fmt.Errorf("config cannot be nil")
	}

	ctx := context.Background()

	// Configure any-store with durability settings
	storeConfig := &anystore.Config{
		Durability: anystore.DurabilityConfig{
			AutoFlush: cfg.AutoFlush,
			IdleAfter: 20 * time.Second,
			FlushMode: anystore.FlushModeCheckpointPassive,
		},
	}

	db, err := anystore.Open(ctx, cfg.DBPath, storeConfig)
	if err != nil {
		return nil, fmt.Errorf("failed to open any-store database: %w", err)
	}

	return &LocalStore{
		db:     db,
		dbPath: cfg.DBPath,
	}, nil
}

// Close closes the database connection.
func (s *LocalStore) Close() error {
	if s.db != nil {
		return s.db.Close()
	}
	return nil
}

// Path returns the database file path.
func (s *LocalStore) Path() string {
	return s.dbPath
}

// Collection names for MATOU
const (
	CollectionCredentialsCache = "credentials_cache"
	CollectionTrustGraphCache  = "trust_graph_cache"
	CollectionUserPreferences  = "user_preferences"
	CollectionKELCache         = "kel_cache"
	CollectionSyncIndex        = "sync_index"
	CollectionSpaces           = "spaces"
)

// CredentialsCache returns the credentials cache collection.
func (s *LocalStore) CredentialsCache(ctx context.Context) (anystore.Collection, error) {
	return s.db.Collection(ctx, CollectionCredentialsCache)
}

// TrustGraphCache returns the trust graph cache collection.
func (s *LocalStore) TrustGraphCache(ctx context.Context) (anystore.Collection, error) {
	return s.db.Collection(ctx, CollectionTrustGraphCache)
}

// UserPreferences returns the user preferences collection.
func (s *LocalStore) UserPreferences(ctx context.Context) (anystore.Collection, error) {
	return s.db.Collection(ctx, CollectionUserPreferences)
}

// KELCache returns the KEL (Key Event Log) cache collection.
func (s *LocalStore) KELCache(ctx context.Context) (anystore.Collection, error) {
	return s.db.Collection(ctx, CollectionKELCache)
}

// SyncIndex returns the sync index collection for tracking any-sync objects.
func (s *LocalStore) SyncIndex(ctx context.Context) (anystore.Collection, error) {
	return s.db.Collection(ctx, CollectionSyncIndex)
}

// CachedCredential represents a cached ACDC credential.
type CachedCredential struct {
	ID         string    `json:"id"`         // SAID of the credential
	IssuerAID  string    `json:"issuerAID"`  // Issuer's AID
	SubjectAID string    `json:"subjectAID"` // Subject's AID
	SchemaID   string    `json:"schemaID"`   // Schema identifier
	Data       any       `json:"data"`       // Credential data
	CachedAt   time.Time `json:"cachedAt"`   // When it was cached
	ExpiresAt  time.Time `json:"expiresAt"`  // Cache expiration
	Verified   bool      `json:"verified"`   // Whether signature was verified
}

// TrustGraphNode represents a cached trust graph node.
type TrustGraphNode struct {
	AID                string    `json:"id"`                 // AID (used as document ID)
	DisplayName        string    `json:"displayName"`        // Display name
	VerificationStatus string    `json:"verificationStatus"` // member/verified/trusted/expert
	TrustScore         float64   `json:"trustScore"`         // Computed trust score
	Connections        []string  `json:"connections"`        // Connected AIDs
	Depth              int       `json:"depth"`              // Depth from root
	CachedAt           time.Time `json:"cachedAt"`           // When computed
}

// UserPreference represents a user preference setting.
type UserPreference struct {
	Key       string    `json:"id"`        // Preference key (used as document ID)
	Value     any       `json:"value"`     // Preference value
	UpdatedAt time.Time `json:"updatedAt"` // Last update time
}

// StoreCredential caches a credential locally.
func (s *LocalStore) StoreCredential(ctx context.Context, cred *CachedCredential) error {
	coll, err := s.CredentialsCache(ctx)
	if err != nil {
		return fmt.Errorf("failed to get credentials collection: %w", err)
	}

	data, err := json.Marshal(cred)
	if err != nil {
		return fmt.Errorf("failed to marshal credential: %w", err)
	}

	doc := anyenc.MustParseJson(string(data))
	return coll.UpsertOne(ctx, doc)
}

// GetCredential retrieves a cached credential by SAID.
func (s *LocalStore) GetCredential(ctx context.Context, said string) (*CachedCredential, error) {
	coll, err := s.CredentialsCache(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get credentials collection: %w", err)
	}

	doc, err := coll.FindId(ctx, said)
	if err != nil {
		return nil, fmt.Errorf("credential not found: %w", err)
	}

	var cred CachedCredential
	if err := json.Unmarshal([]byte(doc.Value().String()), &cred); err != nil {
		return nil, fmt.Errorf("failed to unmarshal credential: %w", err)
	}

	return &cred, nil
}

// StoreTrustNode caches a trust graph node.
func (s *LocalStore) StoreTrustNode(ctx context.Context, node *TrustGraphNode) error {
	coll, err := s.TrustGraphCache(ctx)
	if err != nil {
		return fmt.Errorf("failed to get trust graph collection: %w", err)
	}

	data, err := json.Marshal(node)
	if err != nil {
		return fmt.Errorf("failed to marshal trust node: %w", err)
	}

	doc := anyenc.MustParseJson(string(data))
	return coll.UpsertOne(ctx, doc)
}

// GetTrustNode retrieves a cached trust graph node by AID.
func (s *LocalStore) GetTrustNode(ctx context.Context, aid string) (*TrustGraphNode, error) {
	coll, err := s.TrustGraphCache(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get trust graph collection: %w", err)
	}

	doc, err := coll.FindId(ctx, aid)
	if err != nil {
		return nil, fmt.Errorf("trust node not found: %w", err)
	}

	var node TrustGraphNode
	if err := json.Unmarshal([]byte(doc.Value().String()), &node); err != nil {
		return nil, fmt.Errorf("failed to unmarshal trust node: %w", err)
	}

	return &node, nil
}

// SetPreference stores a user preference.
func (s *LocalStore) SetPreference(ctx context.Context, key string, value any) error {
	coll, err := s.UserPreferences(ctx)
	if err != nil {
		return fmt.Errorf("failed to get preferences collection: %w", err)
	}

	pref := UserPreference{
		Key:       key,
		Value:     value,
		UpdatedAt: time.Now().UTC(),
	}

	data, err := json.Marshal(pref)
	if err != nil {
		return fmt.Errorf("failed to marshal preference: %w", err)
	}

	doc := anyenc.MustParseJson(string(data))
	return coll.UpsertOne(ctx, doc)
}

// GetPreference retrieves a user preference.
func (s *LocalStore) GetPreference(ctx context.Context, key string) (any, error) {
	coll, err := s.UserPreferences(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get preferences collection: %w", err)
	}

	doc, err := coll.FindId(ctx, key)
	if err != nil {
		return nil, fmt.Errorf("preference not found: %w", err)
	}

	var pref UserPreference
	if err := json.Unmarshal([]byte(doc.Value().String()), &pref); err != nil {
		return nil, fmt.Errorf("failed to unmarshal preference: %w", err)
	}

	return pref.Value, nil
}

// ClearCache clears all cached data from a specific collection.
func (s *LocalStore) ClearCache(ctx context.Context, collectionName string) error {
	coll, err := s.db.Collection(ctx, collectionName)
	if err != nil {
		return fmt.Errorf("failed to get collection: %w", err)
	}

	return coll.Drop(ctx)
}

// Stats returns database statistics.
func (s *LocalStore) Stats(ctx context.Context) (anystore.DBStats, error) {
	return s.db.Stats(ctx)
}

// Flush forces a database flush to disk.
func (s *LocalStore) Flush(ctx context.Context) error {
	return s.db.Flush(ctx, 0, anystore.FlushModeCheckpointPassive)
}

// MustParseJSON is a helper that wraps anyenc.MustParseJson for external packages
func MustParseJSON(jsonStr string) *anyenc.Value {
	return anyenc.MustParseJson(jsonStr)
}

// SpaceRecord represents a space registry entry.
// This maps user AIDs to their any-sync space IDs.
type SpaceRecord struct {
	ID        string    `json:"id"`        // SpaceID (used as document ID)
	UserAID   string    `json:"userAid"`   // Owner's AID
	SpaceType string    `json:"spaceType"` // "private" or "community"
	SpaceName string    `json:"spaceName"` // Human-readable name
	CreatedAt time.Time `json:"createdAt"` // When space was created
	LastSync  time.Time `json:"lastSync"`  // Last sync timestamp
}

// Spaces returns the spaces collection.
func (s *LocalStore) Spaces(ctx context.Context) (anystore.Collection, error) {
	return s.db.Collection(ctx, CollectionSpaces)
}

// SaveSpaceRecord saves a space record to the local store.
func (s *LocalStore) SaveSpaceRecord(ctx context.Context, record *SpaceRecord) error {
	coll, err := s.Spaces(ctx)
	if err != nil {
		return fmt.Errorf("failed to get spaces collection: %w", err)
	}

	data, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("failed to marshal space record: %w", err)
	}

	doc := anyenc.MustParseJson(string(data))
	return coll.UpsertOne(ctx, doc)
}

// GetSpaceByID retrieves a space record by space ID.
func (s *LocalStore) GetSpaceByID(ctx context.Context, spaceID string) (*SpaceRecord, error) {
	coll, err := s.Spaces(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get spaces collection: %w", err)
	}

	doc, err := coll.FindId(ctx, spaceID)
	if err != nil {
		return nil, fmt.Errorf("space not found: %w", err)
	}

	var record SpaceRecord
	if err := json.Unmarshal([]byte(doc.Value().String()), &record); err != nil {
		return nil, fmt.Errorf("failed to unmarshal space record: %w", err)
	}

	return &record, nil
}

// GetUserSpaceRecord retrieves a space record by user AID.
func (s *LocalStore) GetUserSpaceRecord(ctx context.Context, userAID string) (*SpaceRecord, error) {
	coll, err := s.Spaces(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get spaces collection: %w", err)
	}

	// Query for space with matching userAID and private type
	query := anyenc.MustParseJson(fmt.Sprintf(`{"userAid": "%s", "spaceType": "private"}`, userAID))

	iter, err := coll.Find(query).Iter(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to query spaces: %w", err)
	}
	defer iter.Close()

	if !iter.Next() {
		return nil, fmt.Errorf("space not found for user: %s", userAID)
	}

	doc, err := iter.Doc()
	if err != nil {
		return nil, fmt.Errorf("failed to get document: %w", err)
	}

	var record SpaceRecord
	if err := json.Unmarshal([]byte(doc.Value().String()), &record); err != nil {
		return nil, fmt.Errorf("failed to unmarshal space record: %w", err)
	}

	return &record, nil
}

// ListAllSpaceRecords retrieves all space records.
func (s *LocalStore) ListAllSpaceRecords(ctx context.Context) ([]*SpaceRecord, error) {
	coll, err := s.Spaces(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get spaces collection: %w", err)
	}

	iter, err := coll.Find(nil).Iter(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to query spaces: %w", err)
	}
	defer iter.Close()

	var records []*SpaceRecord
	for iter.Next() {
		doc, err := iter.Doc()
		if err != nil {
			continue
		}

		var record SpaceRecord
		if err := json.Unmarshal([]byte(doc.Value().String()), &record); err != nil {
			continue
		}
		records = append(records, &record)
	}

	return records, nil
}

// UpdateSpaceLastSync updates the last sync timestamp for a space.
func (s *LocalStore) UpdateSpaceLastSync(ctx context.Context, spaceID string) error {
	record, err := s.GetSpaceByID(ctx, spaceID)
	if err != nil {
		return err
	}

	record.LastSync = time.Now().UTC()
	return s.SaveSpaceRecord(ctx, record)
}

// GetAllCredentials retrieves all cached credentials from the store.
func (s *LocalStore) GetAllCredentials(ctx context.Context) ([]*CachedCredential, error) {
	coll, err := s.CredentialsCache(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get credentials collection: %w", err)
	}

	iter, err := coll.Find(nil).Iter(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to query credentials: %w", err)
	}
	defer iter.Close()

	var credentials []*CachedCredential
	for iter.Next() {
		doc, err := iter.Doc()
		if err != nil {
			continue
		}

		var cred CachedCredential
		if err := json.Unmarshal([]byte(doc.Value().String()), &cred); err != nil {
			continue
		}
		credentials = append(credentials, &cred)
	}

	return credentials, nil
}

// CountCredentials returns the count of cached credentials.
func (s *LocalStore) CountCredentials(ctx context.Context) (int, error) {
	coll, err := s.CredentialsCache(ctx)
	if err != nil {
		return 0, fmt.Errorf("failed to get credentials collection: %w", err)
	}

	count, err := coll.Count(ctx)
	if err != nil {
		return 0, fmt.Errorf("failed to count credentials: %w", err)
	}

	return int(count), nil
}

// CountKELEvents returns the count of cached KEL events.
func (s *LocalStore) CountKELEvents(ctx context.Context) (int, error) {
	coll, err := s.KELCache(ctx)
	if err != nil {
		return 0, fmt.Errorf("failed to get KEL collection: %w", err)
	}

	count, err := coll.Count(ctx)
	if err != nil {
		return 0, fmt.Errorf("failed to count KEL events: %w", err)
	}

	return int(count), nil
}

// CountSpaces returns the count of spaces.
func (s *LocalStore) CountSpaces(ctx context.Context) (int, error) {
	coll, err := s.Spaces(ctx)
	if err != nil {
		return 0, fmt.Errorf("failed to get spaces collection: %w", err)
	}

	count, err := coll.Count(ctx)
	if err != nil {
		return 0, fmt.Errorf("failed to count spaces: %w", err)
	}

	return int(count), nil
}
