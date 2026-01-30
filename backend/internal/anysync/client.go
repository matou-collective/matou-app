// Package anysync provides any-sync integration for MATOU.
// This file implements a full any-sync client using the app.Component framework.
package anysync

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/anyproto/any-sync/accountservice"
	"github.com/anyproto/any-sync/app"
	"github.com/anyproto/any-sync/commonspace"
	"github.com/anyproto/any-sync/commonspace/config"
	"github.com/anyproto/any-sync/commonspace/credentialprovider"
	"github.com/anyproto/any-sync/commonspace/object/accountdata"
	"github.com/anyproto/any-sync/commonspace/peermanager"
	"github.com/anyproto/any-sync/commonspace/spacepayloads"
	"github.com/anyproto/any-sync/commonspace/spacestorage"
	"github.com/anyproto/any-sync/consensus/consensusproto"
	"github.com/anyproto/any-sync/coordinator/coordinatorclient"
	"github.com/anyproto/any-sync/coordinator/coordinatorproto"
	"github.com/anyproto/any-sync/identityrepo/identityrepoproto"
	"github.com/anyproto/any-sync/net/peer"
	"github.com/anyproto/any-sync/net/pool"
	"github.com/anyproto/any-sync/net/streampool"
	"github.com/anyproto/any-sync/node/nodeclient"
	"github.com/anyproto/any-sync/nodeconf"
	"github.com/anyproto/any-sync/util/crypto"
	"github.com/anyproto/any-sync/util/syncqueues"
	"github.com/anyproto/go-chash"
	anystore "github.com/anyproto/any-store"
	"gopkg.in/yaml.v3"
	"storj.io/drpc"
)

// Client provides access to any-sync infrastructure using the full SDK
type Client struct {
	mu              sync.RWMutex
	app             *app.App
	config          *ClientConfig
	spaceService    commonspace.SpaceService
	accountService  accountservice.Service
	storageProvider spacestorage.SpaceStorageProvider
	peerKeyManager  *PeerKeyManager
	dataDir         string
	networkID       string
	coordinatorURL  string
	initialized     bool
	spaceCache      sync.Map // spaceID → true (tracks created spaces)
}

// ClientConfig represents the any-sync client.yml structure
type ClientConfig struct {
	ID        string `yaml:"id"`
	NetworkID string `yaml:"networkId"`
	Nodes     []Node `yaml:"nodes"`
}

// Node represents a node in the any-sync network
type Node struct {
	PeerID    string   `yaml:"peerId"`
	Addresses []string `yaml:"addresses"`
	Types     []string `yaml:"types"`
}

// ClientOptions holds configuration for the client
type ClientOptions struct {
	// DataDir is the directory for local storage
	DataDir string
	// PeerKeyPath is the path to store/load the peer key
	PeerKeyPath string
	// Mnemonic for deterministic key derivation (optional)
	Mnemonic string
	// KeyIndex for mnemonic derivation (default 0)
	KeyIndex uint32
}

// NewClient creates a new any-sync client
// Note: Full SDK integration requires additional infrastructure components.
// This version provides local space management with network sync deferred.
func NewClient(clientConfigPath string, opts *ClientOptions) (*Client, error) {
	// Load client configuration
	config, err := loadClientConfig(clientConfigPath)
	if err != nil {
		return nil, fmt.Errorf("loading client config: %w", err)
	}

	// Find coordinator URL
	coordinatorURL := findCoordinatorURL(config.Nodes)
	if coordinatorURL == "" {
		return nil, fmt.Errorf("coordinator not found in client config")
	}

	// Set default data directory
	dataDir := "./data"
	if opts != nil && opts.DataDir != "" {
		dataDir = opts.DataDir
	}

	// Ensure data directory exists
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		return nil, fmt.Errorf("creating data directory: %w", err)
	}

	client := &Client{
		config:         config,
		networkID:      config.NetworkID,
		coordinatorURL: coordinatorURL,
		dataDir:        dataDir,
	}

	// Initialize peer key manager
	keyPath := filepath.Join(dataDir, "peer.key")
	if opts != nil && opts.PeerKeyPath != "" {
		keyPath = opts.PeerKeyPath
	}

	var mnemonic string
	var keyIndex uint32
	if opts != nil {
		mnemonic = opts.Mnemonic
		keyIndex = opts.KeyIndex
	}

	peerMgr, err := NewPeerKeyManager(&PeerKeyConfig{
		KeyPath:  keyPath,
		Mnemonic: mnemonic,
		KeyIndex: keyIndex,
	})
	if err != nil {
		return nil, fmt.Errorf("creating peer key manager: %w", err)
	}
	client.peerKeyManager = peerMgr

	// Initialize local storage provider (without full SDK app)
	storageDir := filepath.Join(dataDir, "spaces")
	client.storageProvider = newMatouStorageProvider(storageDir)

	// Note: Full any-sync network integration (CreateSpace via coordinator)
	// requires running the full app.Component framework with all dependencies.
	// For now, we provide local storage management and will sync with network
	// when full SDK integration is complete.
	//
	// TODO: Enable full SDK integration when infrastructure is ready:
	// if err := client.initApp(); err != nil {
	//     return nil, fmt.Errorf("initializing any-sync app: %w", err)
	// }

	client.initialized = true
	fmt.Printf("  any-sync client initialized (local mode)\n")
	fmt.Printf("   Full network sync requires additional infrastructure\n")
	return client, nil
}

// initApp initializes the any-sync app.App with required components
func (c *Client) initApp() error {
	c.app = new(app.App)

	// Create account service with our keys
	accountKeys := accountdata.New(
		c.peerKeyManager.GetPrivKey(), // device/peer key
		c.peerKeyManager.GetPrivKey(), // sign key (using same for simplicity)
	)
	c.accountService = newMatouAccountService(accountKeys)

	// Create storage provider
	storageDir := filepath.Join(c.dataDir, "spaces")
	c.storageProvider = newMatouStorageProvider(storageDir)

	// Create node configuration
	nodeConf := newMatouNodeConf(c.config)

	// Register all required components
	c.app.
		Register(c.accountService).
		Register(syncqueues.New()).
		Register(newMatouConfig()).
		Register(newMatouPool()).
		Register(c.storageProvider).
		Register(credentialprovider.NewNoOp()).
		Register(streampool.New()).
		Register(newMatouStreamHandler()).
		Register(newMatouCoordinatorClient()).
		Register(newMatouNodeClient()).
		Register(nodeConf).
		Register(newMatouPeerManagerProvider()).
		Register(newMatouTreeManager()).
		Register(commonspace.New())

	// Start the app
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := c.app.Start(ctx); err != nil {
		return fmt.Errorf("starting app: %w", err)
	}

	// Get the space service
	c.spaceService = c.app.MustComponent(commonspace.CName).(commonspace.SpaceService)

	return nil
}

// NewClientForTesting creates a client with test configuration (no config file required)
func NewClientForTesting(coordinatorURL, networkID string) *Client {
	return &Client{
		coordinatorURL: coordinatorURL,
		networkID:      networkID,
		initialized:    true,
	}
}

// loadClientConfig loads the any-sync client.yml file
func loadClientConfig(path string) (*ClientConfig, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading client config: %w", err)
	}

	var config ClientConfig
	if err := yaml.Unmarshal(data, &config); err != nil {
		return nil, fmt.Errorf("parsing client config: %w", err)
	}

	return &config, nil
}

// findCoordinatorURL extracts the coordinator address from nodes
func findCoordinatorURL(nodes []Node) string {
	for _, node := range nodes {
		for _, nodeType := range node.Types {
			if nodeType == "coordinator" {
				if len(node.Addresses) > 0 {
					return node.Addresses[0]
				}
			}
		}
	}
	return ""
}

// SpaceCreateResult contains the result of space creation
type SpaceCreateResult struct {
	SpaceID   string        `json:"spaceId"`
	CreatedAt time.Time     `json:"createdAt"`
	OwnerAID  string        `json:"ownerAid"`
	SpaceType string        `json:"spaceType"`
	Keys      *SpaceKeySet  `json:"-"` // In-memory only, not serialized
}

// CreateSpaceWithKeys creates a new space using a full SpaceKeySet.
// In local mode, this uses StoragePayloadForSpaceCreate to produce real
// CID-based space IDs and proper crypto artifacts.
func (c *Client) CreateSpaceWithKeys(ctx context.Context, ownerAID string, spaceType string, keys *SpaceKeySet) (*SpaceCreateResult, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if !c.initialized {
		return nil, fmt.Errorf("client not initialized")
	}

	// Compute replication key
	repKey, err := ComputeReplicationKey(keys.SigningKey)
	if err != nil {
		return nil, fmt.Errorf("computing replication key: %w", err)
	}

	metadata := []byte(fmt.Sprintf(`{"owner":"%s","type":"%s","created":"%s"}`,
		ownerAID, spaceType, time.Now().UTC().Format(time.RFC3339)))

	payload := spacepayloads.SpaceCreatePayload{
		SigningKey:     keys.SigningKey,
		MasterKey:      keys.MasterKey,
		SpaceType:      spaceType,
		ReplicationKey: repKey,
		SpacePayload:   []byte(ownerAID),
		ReadKey:        keys.ReadKey,
		MetadataKey:    keys.MetadataKey,
		Metadata:       metadata,
	}

	// Generate real storage payload with CID-based ID
	storagePayload, err := spacepayloads.StoragePayloadForSpaceCreate(payload)
	if err != nil {
		return nil, fmt.Errorf("creating storage payload: %w", err)
	}

	spaceID := storagePayload.SpaceHeaderWithId.Id

	// Store via local storage provider
	if c.storageProvider != nil {
		if _, err := c.storageProvider.CreateSpaceStorage(ctx, storagePayload); err != nil {
			// If already exists, that's OK
			if err.Error() != "space storage already exists" {
				return nil, fmt.Errorf("creating space storage: %w", err)
			}
		}
	}

	// Persist keys
	if err := PersistSpaceKeySet(c.dataDir, spaceID, keys); err != nil {
		return nil, fmt.Errorf("persisting space keys: %w", err)
	}

	// Cache the space
	c.spaceCache.Store(spaceID, true)

	return &SpaceCreateResult{
		SpaceID:   spaceID,
		CreatedAt: time.Now().UTC(),
		OwnerAID:  ownerAID,
		SpaceType: spaceType,
		Keys:      keys,
	}, nil
}

// GetSpace returns nil in local mode — full space objects require the SDK client.
// Local mode tracks spaces by ID but doesn't open full commonspace.Space instances.
func (c *Client) GetSpace(ctx context.Context, spaceID string) (commonspace.Space, error) {
	return nil, fmt.Errorf("GetSpace not supported in local mode; use SDKClient for full space access")
}

// GetDataDir returns the data directory path
func (c *Client) GetDataDir() string {
	return c.dataDir
}

// CreateSpace creates a new space.
// In local mode, this generates a SpaceKeySet internally and delegates to
// CreateSpaceWithKeys for real CID-based space IDs.
func (c *Client) CreateSpace(ctx context.Context, ownerAID string, spaceType string, signingKey crypto.PrivKey) (*SpaceCreateResult, error) {
	if !c.initialized {
		return nil, fmt.Errorf("client not initialized")
	}

	if signingKey == nil {
		signingKey = c.peerKeyManager.GetPrivKey()
	}

	masterKey, _, err := crypto.GenerateRandomEd25519KeyPair()
	if err != nil {
		return nil, fmt.Errorf("generating master key: %w", err)
	}

	readKey, err := crypto.NewRandomAES()
	if err != nil {
		return nil, fmt.Errorf("generating read key: %w", err)
	}

	metadataKey, _, err := crypto.GenerateRandomEd25519KeyPair()
	if err != nil {
		return nil, fmt.Errorf("generating metadata key: %w", err)
	}

	keys := &SpaceKeySet{
		SigningKey:   signingKey,
		MasterKey:    masterKey,
		ReadKey:      readKey,
		MetadataKey:  metadataKey,
	}

	return c.CreateSpaceWithKeys(ctx, ownerAID, spaceType, keys)
}

// generateSpaceID creates a deterministic space ID from owner and type
func generateSpaceID(ownerAID, spaceType string, signingKey crypto.PrivKey) string {
	// Use the public key to generate a deterministic ID
	pubKeyBytes, _ := signingKey.GetPublic().Raw()

	// Create a hash of owner + type + pubkey for deterministic ID
	input := fmt.Sprintf("%s:%s:%x", ownerAID, spaceType, pubKeyBytes)
	hash := sha256.Sum256([]byte(input))

	// Format as a space ID (base58 or hex)
	return fmt.Sprintf("space_%x", hash[:16])
}

// DeriveSpace creates a deterministic space derived from the signing key
// This is an alias for CreateSpace in local mode as both generate deterministic IDs
func (c *Client) DeriveSpace(ctx context.Context, ownerAID string, spaceType string, signingKey crypto.PrivKey) (*SpaceCreateResult, error) {
	return c.CreateSpace(ctx, ownerAID, spaceType, signingKey)
}

// DeriveSpaceID returns the deterministic space ID without creating the space
func (c *Client) DeriveSpaceID(ctx context.Context, ownerAID string, spaceType string, signingKey crypto.PrivKey) (string, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	if !c.initialized {
		return "", fmt.Errorf("client not initialized")
	}

	if signingKey == nil {
		signingKey = c.peerKeyManager.GetPrivKey()
	}

	return generateSpaceID(ownerAID, spaceType, signingKey), nil
}

// MakeSpaceShareable is a no-op for the local client. The local client does
// not interact with a coordinator, so sharing is always implicitly allowed.
func (c *Client) MakeSpaceShareable(ctx context.Context, spaceID string) error {
	return nil
}

// AddToACL adds a peer to a space's access control list
func (c *Client) AddToACL(ctx context.Context, spaceID string, peerID string, permissions []string) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if !c.initialized {
		return fmt.Errorf("client not initialized")
	}

	// Ensure space directory exists
	spaceDir := filepath.Join(c.dataDir, "spaces", spaceID)
	if err := os.MkdirAll(spaceDir, 0755); err != nil {
		return fmt.Errorf("creating space directory: %w", err)
	}

	aclPath := filepath.Join(spaceDir, "acl.json")

	// Load existing ACL entries
	var entries []localACLEntry
	if data, err := os.ReadFile(aclPath); err == nil {
		if err := json.Unmarshal(data, &entries); err != nil {
			return fmt.Errorf("parsing existing ACL: %w", err)
		}
	}

	// Check if peer already exists — update in place (idempotent)
	now := time.Now().UTC().Format(time.RFC3339)
	found := false
	for i := range entries {
		if entries[i].PeerID == peerID {
			entries[i].Permissions = permissions
			entries[i].UpdatedAt = now
			found = true
			break
		}
	}

	if !found {
		entries = append(entries, localACLEntry{
			PeerID:      peerID,
			Permissions: permissions,
			AddedAt:     now,
			UpdatedAt:   now,
		})
	}

	if err := writeJSONFile(aclPath, entries); err != nil {
		return fmt.Errorf("writing ACL: %w", err)
	}

	fmt.Printf("[any-sync] AddToACL: space=%s peer=%s permissions=%v\n", spaceID, peerID, permissions)
	return nil
}

// SyncDocument syncs a document to a space
func (c *Client) SyncDocument(ctx context.Context, spaceID string, docID string, data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if !c.initialized {
		return fmt.Errorf("client not initialized")
	}

	// Create documents directory for this space
	docsDir := filepath.Join(c.dataDir, "spaces", spaceID, "documents")
	if err := os.MkdirAll(docsDir, 0755); err != nil {
		return fmt.Errorf("creating documents directory: %w", err)
	}

	doc := localDocument{
		DocID:    docID,
		SpaceID:  spaceID,
		Data:     json.RawMessage(data),
		SyncedAt: time.Now().UTC().Format(time.RFC3339),
	}

	docPath := filepath.Join(docsDir, docID+".json")
	if err := writeJSONFile(docPath, doc); err != nil {
		return fmt.Errorf("writing document: %w", err)
	}

	fmt.Printf("[any-sync] SyncDocument: space=%s doc=%s size=%d\n", spaceID, docID, len(data))
	return nil
}

// GetNetworkID returns the any-sync network ID
func (c *Client) GetNetworkID() string {
	return c.networkID
}

// GetCoordinatorURL returns the coordinator address
func (c *Client) GetCoordinatorURL() string {
	return c.coordinatorURL
}

// GetPeerID returns the client's peer ID
func (c *Client) GetPeerID() string {
	if c.peerKeyManager != nil {
		return c.peerKeyManager.GetPeerID()
	}
	return ""
}

// GetPeerInfo returns information about the peer identity
func (c *Client) GetPeerInfo() (*PeerInfo, error) {
	if c.peerKeyManager == nil {
		return nil, fmt.Errorf("peer key manager not initialized")
	}
	return c.peerKeyManager.GetPeerInfo()
}

// Ping tests if the client is properly initialized
func (c *Client) Ping() error {
	if !c.initialized {
		return fmt.Errorf("client not initialized")
	}
	if c.coordinatorURL == "" {
		return fmt.Errorf("coordinator URL not configured")
	}
	return nil
}

// IsInitialized returns whether the client is properly initialized
func (c *Client) IsInitialized() bool {
	return c.initialized
}

// GetConfig returns the client configuration
func (c *Client) GetConfig() *ClientConfig {
	return c.config
}

// Close closes the client and releases resources
func (c *Client) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.app != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := c.app.Close(ctx); err != nil {
			return fmt.Errorf("closing app: %w", err)
		}
	}

	c.initialized = false
	return nil
}

// localACLEntry represents a single ACL entry stored in a local JSON file
type localACLEntry struct {
	PeerID      string   `json:"peerId"`
	Permissions []string `json:"permissions"`
	AddedAt     string   `json:"addedAt"`
	UpdatedAt   string   `json:"updatedAt"`
}

// localDocument represents a document stored in a local JSON file
type localDocument struct {
	DocID    string          `json:"docId"`
	SpaceID  string          `json:"spaceId"`
	Data     json.RawMessage `json:"data"`
	SyncedAt string          `json:"syncedAt"`
}

// writeJSONFile marshals v to JSON and writes it to path
func writeJSONFile(path string, v interface{}) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return fmt.Errorf("marshaling JSON: %w", err)
	}
	return os.WriteFile(path, data, 0644)
}

// parseJSONFile unmarshals JSON data into v
func parseJSONFile(data []byte, v interface{}) error {
	return json.Unmarshal(data, v)
}

// generateReplicationKey generates a replication key from a signing key
func generateReplicationKey(signingKey crypto.PrivKey) uint64 {
	pubKey, _ := signingKey.GetPublic().Raw()
	var key uint64
	for i := 0; i < 8 && i < len(pubKey); i++ {
		key = (key << 8) | uint64(pubKey[i])
	}
	return key
}

// =============================================================================
// Component implementations for any-sync app.Component framework
// =============================================================================

// matouAccountService implements accountservice.Service
type matouAccountService struct {
	keys *accountdata.AccountKeys
}

func newMatouAccountService(keys *accountdata.AccountKeys) *matouAccountService {
	return &matouAccountService{keys: keys}
}

func (s *matouAccountService) Init(a *app.App) error { return nil }
func (s *matouAccountService) Name() string         { return accountservice.CName }
func (s *matouAccountService) Account() *accountdata.AccountKeys { return s.keys }

// matouConfig implements config.ConfigGetter
type matouConfig struct{}

func newMatouConfig() *matouConfig { return &matouConfig{} }

func (c *matouConfig) Init(a *app.App) error { return nil }
func (c *matouConfig) Name() string          { return "config" }
func (c *matouConfig) GetSpace() config.Config {
	return config.Config{
		GCTTL:                60,
		SyncPeriod:           5,
		KeepTreeDataInMemory: true,
	}
}
func (c *matouConfig) GetStreamConfig() streampool.StreamConfig {
	return streampool.StreamConfig{
		SendQueueSize:    100,
		DialQueueWorkers: 4,
		DialQueueSize:    100,
	}
}

// matouPool implements pool.Pool (no-op for local usage)
type matouPool struct{}

func newMatouPool() *matouPool { return &matouPool{} }

func (p *matouPool) Init(a *app.App) error                          { return nil }
func (p *matouPool) Name() string                                   { return pool.CName }
func (p *matouPool) Run(ctx context.Context) error                  { return nil }
func (p *matouPool) Close(ctx context.Context) error                { return nil }
func (p *matouPool) Get(ctx context.Context, id string) (peer.Peer, error) {
	return nil, fmt.Errorf("no peers available")
}
func (p *matouPool) Dial(ctx context.Context, id string) (peer.Peer, error) {
	return nil, fmt.Errorf("dial not supported")
}
func (p *matouPool) GetOneOf(ctx context.Context, ids []string) (peer.Peer, error) {
	return nil, fmt.Errorf("no peers available")
}
func (p *matouPool) DialOneOf(ctx context.Context, ids []string) (peer.Peer, error) {
	return nil, fmt.Errorf("dial not supported")
}
func (p *matouPool) Pick(ctx context.Context, id string) (peer.Peer, error) {
	return nil, fmt.Errorf("no peers available")
}
func (p *matouPool) AddPeer(ctx context.Context, peer peer.Peer) error { return nil }
func (p *matouPool) Flush(ctx context.Context) error                   { return nil }

// matouNodeConf implements nodeconf.Service
type matouNodeConf struct {
	config *ClientConfig
	conf   nodeconf.Configuration
}

func newMatouNodeConf(config *ClientConfig) *matouNodeConf {
	// Build node list from config
	var nodes []nodeconf.Node
	for _, n := range config.Nodes {
		nodes = append(nodes, nodeconf.Node{
			PeerId:    n.PeerID,
			Addresses: n.Addresses,
			Types:     nodeTypesToProto(n.Types),
		})
	}

	return &matouNodeConf{
		config: config,
		conf: nodeconf.Configuration{
			Id:        config.ID,
			NetworkId: config.NetworkID,
			Nodes:     nodes,
		},
	}
}

func nodeTypesToProto(types []string) []nodeconf.NodeType {
	var result []nodeconf.NodeType
	for _, t := range types {
		switch t {
		case "tree":
			result = append(result, nodeconf.NodeTypeTree)
		case "coordinator":
			result = append(result, nodeconf.NodeTypeCoordinator)
		case "file":
			result = append(result, nodeconf.NodeTypeFile)
		case "consensus":
			result = append(result, nodeconf.NodeTypeConsensus)
		}
	}
	return result
}

func (n *matouNodeConf) Init(a *app.App) error             { return nil }
func (n *matouNodeConf) Name() string                      { return nodeconf.CName }
func (n *matouNodeConf) Run(ctx context.Context) error     { return nil }
func (n *matouNodeConf) Close(ctx context.Context) error   { return nil }
func (n *matouNodeConf) Id() string                        { return n.conf.Id }
func (n *matouNodeConf) Configuration() nodeconf.Configuration { return n.conf }

// NetworkCompatibilityStatus implements nodeconf.Service
func (n *matouNodeConf) NetworkCompatibilityStatus() nodeconf.NetworkCompatibilityStatus {
	return nodeconf.NetworkCompatibilityStatusOk
}

// NodeIds returns peer IDs for a given space (distributes across tree nodes)
func (n *matouNodeConf) NodeIds(spaceId string) []string {
	var ids []string
	for _, node := range n.conf.Nodes {
		for _, t := range node.Types {
			if t == nodeconf.NodeTypeTree {
				ids = append(ids, node.PeerId)
			}
		}
	}
	return ids
}

func (n *matouNodeConf) nodeIdsByType(tp nodeconf.NodeType) []string {
	var ids []string
	for _, node := range n.conf.Nodes {
		for _, t := range node.Types {
			if t == tp {
				ids = append(ids, node.PeerId)
			}
		}
	}
	return ids
}

func (n *matouNodeConf) CoordinatorPeers() []string {
	return n.nodeIdsByType(nodeconf.NodeTypeCoordinator)
}
func (n *matouNodeConf) ConsensusPeers() []string {
	return n.nodeIdsByType(nodeconf.NodeTypeConsensus)
}
func (n *matouNodeConf) FilePeers() []string {
	return n.nodeIdsByType(nodeconf.NodeTypeFile)
}
func (n *matouNodeConf) NamingNodePeers() []string {
	return n.nodeIdsByType(nodeconf.NodeTypeNamingNode)
}
func (n *matouNodeConf) PaymentProcessingNodePeers() []string {
	return n.nodeIdsByType(nodeconf.NodeTypePaymentProcessingNode)
}
func (n *matouNodeConf) IsResponsible(spaceId string) bool { return false }
func (n *matouNodeConf) Partition(spaceId string) int      { return 0 }
func (n *matouNodeConf) NodeTypes(nodeId string) []nodeconf.NodeType {
	for _, node := range n.conf.Nodes {
		if node.PeerId == nodeId {
			return node.Types
		}
	}
	return nil
}
func (n *matouNodeConf) PeerAddresses(peerId string) ([]string, bool) {
	for _, node := range n.conf.Nodes {
		if node.PeerId == peerId {
			return node.Addresses, true
		}
	}
	return nil, false
}

// CHash returns the consistent hash table (nil is acceptable for simple setups)
func (n *matouNodeConf) CHash() chash.CHash { return nil }

// matouStorageProvider implements spacestorage.SpaceStorageProvider
type matouStorageProvider struct {
	rootPath string
	spaces   sync.Map
}

func newMatouStorageProvider(rootPath string) *matouStorageProvider {
	os.MkdirAll(rootPath, 0755)
	return &matouStorageProvider{rootPath: rootPath}
}

func (p *matouStorageProvider) Init(a *app.App) error { return nil }
func (p *matouStorageProvider) Name() string          { return spacestorage.CName }
func (p *matouStorageProvider) Run(ctx context.Context) error { return nil }
func (p *matouStorageProvider) Close(ctx context.Context) error { return nil }

func (p *matouStorageProvider) WaitSpaceStorage(ctx context.Context, id string) (spacestorage.SpaceStorage, error) {
	if s, ok := p.spaces.Load(id); ok {
		return s.(spacestorage.SpaceStorage), nil
	}
	return nil, spacestorage.ErrSpaceStorageMissing
}

func (p *matouStorageProvider) SpaceStorage(id string) (spacestorage.SpaceStorage, error) {
	return p.WaitSpaceStorage(context.Background(), id)
}

func (p *matouStorageProvider) CreateSpaceStorage(ctx context.Context, payload spacestorage.SpaceStorageCreatePayload) (spacestorage.SpaceStorage, error) {
	spaceId := payload.SpaceHeaderWithId.Id

	// Check if already exists
	if _, ok := p.spaces.Load(spaceId); ok {
		return nil, spacestorage.ErrSpaceStorageExists
	}

	// Create storage directory for this space
	spacePath := filepath.Join(p.rootPath, spaceId)
	if err := os.MkdirAll(spacePath, 0755); err != nil {
		return nil, fmt.Errorf("creating space directory: %w", err)
	}

	// Create anystore database for this space
	dbPath := filepath.Join(spacePath, "data.db")
	store, err := anystore.Open(ctx, dbPath, nil)
	if err != nil {
		return nil, fmt.Errorf("creating anystore database: %w", err)
	}

	// Create the space storage using the Create function
	storage, err := spacestorage.Create(ctx, store, payload)
	if err != nil {
		store.Close()
		return nil, fmt.Errorf("creating space storage: %w", err)
	}

	p.spaces.Store(spaceId, storage)
	return storage, nil
}

func (p *matouStorageProvider) SpaceExists(id string) bool {
	_, ok := p.spaces.Load(id)
	return ok
}

// matouCoordinatorClient implements coordinatorclient.CoordinatorClient (no-op for local)
type matouCoordinatorClient struct{}

func newMatouCoordinatorClient() *matouCoordinatorClient { return &matouCoordinatorClient{} }

func (c *matouCoordinatorClient) Init(a *app.App) error { return nil }
func (c *matouCoordinatorClient) Name() string          { return coordinatorclient.CName }
func (c *matouCoordinatorClient) SpaceDelete(ctx context.Context, spaceId string, conf *coordinatorproto.DeletionConfirmPayloadWithSignature) error {
	return nil
}
func (c *matouCoordinatorClient) AccountDelete(ctx context.Context, conf *coordinatorproto.DeletionConfirmPayloadWithSignature) (int64, error) {
	return 0, nil
}
func (c *matouCoordinatorClient) AccountRevertDeletion(ctx context.Context) error { return nil }
func (c *matouCoordinatorClient) StatusCheckMany(ctx context.Context, spaceIds []string) ([]*coordinatorproto.SpaceStatusPayload, *coordinatorproto.AccountLimits, error) {
	return nil, nil, nil
}
func (c *matouCoordinatorClient) StatusCheck(ctx context.Context, spaceId string) (*coordinatorproto.SpaceStatusPayload, error) {
	return nil, nil
}
func (c *matouCoordinatorClient) SpaceSign(ctx context.Context, payload coordinatorclient.SpaceSignPayload) (*coordinatorproto.SpaceReceiptWithSignature, error) {
	return nil, nil
}
func (c *matouCoordinatorClient) SpaceMakeShareable(ctx context.Context, spaceId string) error { return nil }
func (c *matouCoordinatorClient) SpaceMakeUnshareable(ctx context.Context, spaceId, aclId string) error {
	return nil
}
func (c *matouCoordinatorClient) NetworkConfiguration(ctx context.Context, currentId string) (*coordinatorproto.NetworkConfigurationResponse, error) {
	return nil, nil
}
func (c *matouCoordinatorClient) IsNetworkNeedsUpdate(ctx context.Context) (bool, error) { return false, nil }
func (c *matouCoordinatorClient) DeletionLog(ctx context.Context, lastRecordId string, limit int) ([]*coordinatorproto.DeletionLogRecord, error) {
	return nil, nil
}
func (c *matouCoordinatorClient) IdentityRepoPut(ctx context.Context, identity string, data []*identityrepoproto.Data) error {
	return nil
}
func (c *matouCoordinatorClient) IdentityRepoGet(ctx context.Context, identities []string, kinds []string) ([]*identityrepoproto.DataWithIdentity, error) {
	return nil, nil
}
func (c *matouCoordinatorClient) AclAddRecord(ctx context.Context, spaceId string, rec *consensusproto.RawRecord) (*consensusproto.RawRecordWithId, error) {
	return nil, nil
}
func (c *matouCoordinatorClient) AclGetRecords(ctx context.Context, spaceId, aclHead string) ([]*consensusproto.RawRecordWithId, error) {
	return nil, nil
}
func (c *matouCoordinatorClient) AccountLimitsSet(ctx context.Context, req *coordinatorproto.AccountLimitsSetRequest) error {
	return nil
}
func (c *matouCoordinatorClient) AclEventLog(ctx context.Context, accountId, lastRecordId string, limit int) ([]*coordinatorproto.AclEventLogRecord, error) {
	return nil, nil
}

// matouNodeClient implements nodeclient.NodeClient
type matouNodeClient struct{}

func newMatouNodeClient() *matouNodeClient { return &matouNodeClient{} }

func (c *matouNodeClient) Init(a *app.App) error { return nil }
func (c *matouNodeClient) Name() string          { return nodeclient.CName }
func (c *matouNodeClient) AclGetRecords(ctx context.Context, spaceId, aclHead string) ([]*consensusproto.RawRecordWithId, error) {
	return nil, nil
}
func (c *matouNodeClient) AclAddRecord(ctx context.Context, spaceId string, rec *consensusproto.RawRecord) (*consensusproto.RawRecordWithId, error) {
	return nil, nil
}

// matouPeerManagerProvider implements peermanager.PeerManagerProvider
type matouPeerManagerProvider struct{}

func newMatouPeerManagerProvider() *matouPeerManagerProvider { return &matouPeerManagerProvider{} }

func (p *matouPeerManagerProvider) Init(a *app.App) error { return nil }
func (p *matouPeerManagerProvider) Name() string          { return peermanager.CName }
func (p *matouPeerManagerProvider) NewPeerManager(ctx context.Context, spaceId string) (peermanager.PeerManager, error) {
	return &matouPeerManager{}, nil
}

// matouPeerManager implements peermanager.PeerManager
type matouPeerManager struct{}

func (m *matouPeerManager) Init(a *app.App) error { return nil }
func (m *matouPeerManager) Name() string          { return peermanager.CName }
func (m *matouPeerManager) GetResponsiblePeers(ctx context.Context) ([]peer.Peer, error) { return nil, nil }
func (m *matouPeerManager) GetNodePeers(ctx context.Context) ([]peer.Peer, error) { return nil, nil }
func (m *matouPeerManager) BroadcastMessage(ctx context.Context, msg drpc.Message) error { return nil }
func (m *matouPeerManager) SendMessage(ctx context.Context, peerId string, msg drpc.Message) error { return nil }
func (m *matouPeerManager) KeepAlive(ctx context.Context) {}

// matouTreeManager implements treemanager.TreeManager (minimal)
type matouTreeManager struct{}

func newMatouTreeManager() *matouTreeManager { return &matouTreeManager{} }

func (t *matouTreeManager) Init(a *app.App) error { return nil }
func (t *matouTreeManager) Name() string          { return "common.commonspace.treemanager" }
func (t *matouTreeManager) Run(ctx context.Context) error { return nil }
func (t *matouTreeManager) Close(ctx context.Context) error { return nil }

// matouStreamHandler implements streamhandler.StreamHandler (no-op)
type matouStreamHandler struct{}

func newMatouStreamHandler() *matouStreamHandler { return &matouStreamHandler{} }

func (s *matouStreamHandler) Init(a *app.App) error { return nil }
func (s *matouStreamHandler) Name() string          { return "common.streampool.streamhandler" }
func (s *matouStreamHandler) OpenStream(ctx context.Context, p peer.Peer) (drpc.Stream, []string, int, error) {
	return nil, nil, 0, fmt.Errorf("streams not supported")
}
func (s *matouStreamHandler) HandleMessage(ctx context.Context, peerId string, msg drpc.Message) error {
	return nil
}
func (s *matouStreamHandler) NewReadMessage() drpc.Message {
	return nil
}
