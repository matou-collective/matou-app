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
