// Package anysync provides any-sync integration for MATOU.
// sdk_client.go implements the full any-sync SDK client with network connectivity.
package anysync

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/anyproto/any-sync/accountservice"
	"github.com/anyproto/any-sync/app"
	"github.com/anyproto/any-sync/commonspace"
	"github.com/anyproto/any-sync/commonspace/config"
	"github.com/anyproto/any-sync/commonspace/credentialprovider"
	"github.com/anyproto/any-sync/commonspace/object/accountdata"
	"github.com/anyproto/any-sync/commonspace/object/tree/objecttree"
	"github.com/anyproto/any-sync/commonspace/object/tree/synctree"
	"github.com/anyproto/any-sync/commonspace/object/tree/treestorage"
	"github.com/anyproto/any-sync/commonspace/object/treemanager"
	"github.com/anyproto/any-sync/commonspace/object/treesyncer"
	"github.com/anyproto/any-sync/commonspace/objecttreebuilder"
	"github.com/anyproto/any-sync/commonspace/peermanager"
	"github.com/anyproto/any-sync/commonspace/spacepayloads"
	"github.com/anyproto/any-sync/commonspace/spacestorage"
	"github.com/anyproto/any-sync/commonspace/spacesyncproto"
	"github.com/anyproto/any-sync/commonspace/sync/objectsync/objectmessages"
	"github.com/anyproto/any-sync/commonspace/syncstatus"
	"github.com/anyproto/any-sync/consensus/consensusproto"
	"github.com/anyproto/any-sync/coordinator/coordinatorclient"
	"github.com/anyproto/any-sync/net/peer"
	"github.com/anyproto/any-sync/net/peerservice"
	"github.com/anyproto/any-sync/net/pool"
	"github.com/anyproto/any-sync/net/rpc"
	"github.com/anyproto/any-sync/net/rpc/server"
	"github.com/anyproto/any-sync/net/secureservice"
	"github.com/anyproto/any-sync/net/streampool"
	"github.com/anyproto/any-sync/net/transport/quic"
	"github.com/anyproto/any-sync/net/transport/yamux"
	"github.com/anyproto/any-sync/node/nodeclient"
	"github.com/anyproto/any-sync/nodeconf"
	"github.com/anyproto/any-sync/util/crypto"
	"github.com/anyproto/any-sync/util/syncqueues"
	"github.com/anyproto/go-chash"
	anystore "github.com/anyproto/any-store"
	"storj.io/drpc"
)

// SDKClient provides full any-sync SDK integration with network connectivity
type SDKClient struct {
	mu              sync.RWMutex
	app             *app.App
	config          *ClientConfig
	spaceService    commonspace.SpaceService
	coordinator     coordinatorclient.CoordinatorClient
	storageProvider spacestorage.SpaceStorageProvider
	peerKeyManager  *PeerKeyManager
	dataDir         string
	networkID       string
	coordinatorURL  string
	initialized     bool
}

// NewSDKClient creates a new any-sync client with full network connectivity
func NewSDKClient(clientConfigPath string, opts *ClientOptions) (*SDKClient, error) {
	// Load client configuration
	clientConfig, err := loadClientConfig(clientConfigPath)
	if err != nil {
		return nil, fmt.Errorf("loading client config: %w", err)
	}

	// Find coordinator URL
	coordinatorURL := findCoordinatorURL(clientConfig.Nodes)
	if coordinatorURL == "" {
		return nil, fmt.Errorf("coordinator not found in client config")
	}

	// Set default data directory
	dataDir := "./data"
	if opts != nil && opts.DataDir != "" {
		dataDir = opts.DataDir
	}

	// Ensure directories exist
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		return nil, fmt.Errorf("creating data directory: %w", err)
	}
	spacesDir := filepath.Join(dataDir, "spaces")
	if err := os.MkdirAll(spacesDir, 0755); err != nil {
		return nil, fmt.Errorf("creating spaces directory: %w", err)
	}

	client := &SDKClient{
		config:         clientConfig,
		networkID:      clientConfig.NetworkID,
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

	// Initialize the full SDK app
	if err := client.initFullSDK(); err != nil {
		return nil, fmt.Errorf("initializing SDK: %w", err)
	}

	client.initialized = true
	return client, nil
}

// initFullSDK initializes the any-sync app with real network components
func (c *SDKClient) initFullSDK() error {
	c.app = new(app.App)

	// 1. Create account service with our keys
	accountKeys := accountdata.New(
		c.peerKeyManager.GetPrivKey(), // peer/device key
		c.peerKeyManager.GetPrivKey(), // sign key
	)
	accountSvc := &sdkAccountService{keys: accountKeys}

	// 2. Create unified config provider
	cfg := newSDKConfig(c.config)

	// 3. Create node configuration from client config
	nodeConf := newSDKNodeConf(c.config)

	// 4. Create storage provider
	storageDir := filepath.Join(c.dataDir, "spaces")
	c.storageProvider = newSDKStorageProvider(storageDir)

	// Register components in dependency order:
	// Layer 0: Shared space resolver (lazy init, no deps)
	c.app.Register(newSDKSpaceResolver())

	// Layer 1: Core services (no deps)
	c.app.Register(accountSvc)
	c.app.Register(cfg)
	c.app.Register(nodeConf)

	// Layer 2: Security and RPC
	c.app.Register(secureservice.New())
	c.app.Register(server.New())

	// Layer 3: Transports
	c.app.Register(yamux.New())
	c.app.Register(quic.New())

	// Layer 4: Networking and sync utilities
	c.app.Register(pool.New())
	c.app.Register(peerservice.New())
	c.app.Register(streampool.New())
	c.app.Register(syncqueues.New())

	// Layer 5: Coordination and node client
	c.app.Register(coordinatorclient.New())
	c.app.Register(nodeclient.New())

	// Layer 6: Space services (peer manager, tree manager, then space service)
	c.app.Register(c.storageProvider)
	c.app.Register(newSDKCredentialProvider())
	c.app.Register(newSDKPeerManagerProvider())
	c.app.Register(newSDKTreeManager())
	c.app.Register(commonspace.New())

	// Layer 7: Stream handler and SpaceSync RPC server
	// Stream handler: opens/reads ObjectSyncStream for outgoing sync
	// SpaceSync RPC: handles incoming RPCs from tree nodes (ObjectSyncRequestStream,
	// HeadSync) so tree nodes can pull trees they learn about via HeadUpdate.
	c.app.Register(newSDKStreamHandler())
	c.app.Register(newSDKSpaceSyncRPC())

	// Start the app
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	fmt.Println("  Starting any-sync SDK components...")
	if err := c.app.Start(ctx); err != nil {
		return fmt.Errorf("starting app: %w", err)
	}

	// Get references to key services
	c.spaceService = c.app.MustComponent(commonspace.CName).(commonspace.SpaceService)
	c.coordinator = c.app.MustComponent(coordinatorclient.CName).(coordinatorclient.CoordinatorClient)

	fmt.Println("  any-sync SDK initialized with network connectivity")
	return nil
}

// CreateSpace creates a new space and registers it with the coordinator.
// This generates a SpaceKeySet internally. For explicit key control, use
// CreateSpaceWithKeys instead.
func (c *SDKClient) CreateSpace(ctx context.Context, ownerAID string, spaceType string, signingKey crypto.PrivKey) (*SpaceCreateResult, error) {
	if signingKey == nil {
		c.mu.RLock()
		signingKey = c.peerKeyManager.GetPrivKey()
		c.mu.RUnlock()
	}

	// Build a SpaceKeySet
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

// CreateSpaceWithKeys creates a new space using a full SpaceKeySet and registers
// it with the coordinator. Keys are persisted and the space is cached.
func (c *SDKClient) CreateSpaceWithKeys(ctx context.Context, ownerAID string, spaceType string, keys *SpaceKeySet) (*SpaceCreateResult, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if !c.initialized {
		return nil, fmt.Errorf("client not initialized")
	}

	// Compute replication key using FNV-64
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

	// Create space via the space service (handles coordinator registration)
	spaceID, err := c.spaceService.CreateSpace(ctx, payload)
	if err != nil {
		return nil, fmt.Errorf("creating space: %w", err)
	}

	// Open and initialize the space via shared resolver so all components
	// use the same Space instance
	resolver := c.app.MustComponent(spaceResolverCName).(*sdkSpaceResolver)
	if _, err := resolver.GetSpace(ctx, spaceID); err != nil {
		return nil, fmt.Errorf("opening newly created space: %w", err)
	}

	// Persist keys
	if err := PersistSpaceKeySet(c.dataDir, spaceID, keys); err != nil {
		return nil, fmt.Errorf("persisting space keys: %w", err)
	}

	fmt.Printf("[any-sync SDK] Created space with keys: %s (type: %s)\n", spaceID[:20]+"...", spaceType)

	return &SpaceCreateResult{
		SpaceID:   spaceID,
		CreatedAt: time.Now().UTC(),
		OwnerAID:  ownerAID,
		SpaceType: spaceType,
		Keys:      keys,
	}, nil
}

// GetSpace returns an opened Space by ID. If not cached, it attempts to open
// the space via the space service. Uses the shared space resolver to ensure
// all components share the same Space instances.
func (c *SDKClient) GetSpace(ctx context.Context, spaceID string) (commonspace.Space, error) {
	resolver := c.app.MustComponent(spaceResolverCName).(*sdkSpaceResolver)
	return resolver.GetSpace(ctx, spaceID)
}

// GetDataDir returns the data directory path
func (c *SDKClient) GetDataDir() string {
	return c.dataDir
}

// DeriveSpace creates a deterministic space derived from the signing key
func (c *SDKClient) DeriveSpace(ctx context.Context, ownerAID string, spaceType string, signingKey crypto.PrivKey) (*SpaceCreateResult, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

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

	payload := spacepayloads.SpaceDerivePayload{
		SigningKey:   signingKey,
		MasterKey:    masterKey,
		SpaceType:    spaceType,
		SpacePayload: []byte(ownerAID),
	}

	spaceID, err := c.spaceService.DeriveSpace(ctx, payload)
	if err != nil {
		return nil, fmt.Errorf("deriving space: %w", err)
	}

	fmt.Printf("[any-sync SDK] Derived space: %s (type: %s)\n", spaceID[:20]+"...", spaceType)

	return &SpaceCreateResult{
		SpaceID:   spaceID,
		CreatedAt: time.Now().UTC(),
		OwnerAID:  ownerAID,
		SpaceType: spaceType,
	}, nil
}

// DeriveSpaceID returns the deterministic space ID without creating the space
func (c *SDKClient) DeriveSpaceID(ctx context.Context, ownerAID string, spaceType string, signingKey crypto.PrivKey) (string, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	if !c.initialized {
		return "", fmt.Errorf("client not initialized")
	}

	if signingKey == nil {
		signingKey = c.peerKeyManager.GetPrivKey()
	}

	masterKey, _, err := crypto.GenerateRandomEd25519KeyPair()
	if err != nil {
		return "", fmt.Errorf("generating master key: %w", err)
	}

	payload := spacepayloads.SpaceDerivePayload{
		SigningKey:   signingKey,
		MasterKey:    masterKey,
		SpaceType:    spaceType,
		SpacePayload: []byte(ownerAID),
	}

	spaceID, err := c.spaceService.DeriveId(ctx, payload)
	if err != nil {
		return "", fmt.Errorf("deriving space ID: %w", err)
	}

	return spaceID, nil
}

// Deprecated: AddToACL builds raw JSON as a proto record which is rejected by the
// consensus node. Use MatouACLManager.CreateOpenInvite/JoinWithInvite instead.
func (c *SDKClient) AddToACL(ctx context.Context, spaceID string, peerID string, permissions []string) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if !c.initialized {
		return fmt.Errorf("client not initialized")
	}

	// Build ACL record payload
	payload := map[string]interface{}{
		"peerId":      peerID,
		"spaceId":     spaceID,
		"permissions": permissions,
		"timestamp":   time.Now().UTC().Format(time.RFC3339),
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshaling ACL record: %w", err)
	}

	record := &consensusproto.RawRecord{
		Payload: data,
	}

	_, err = c.coordinator.AclAddRecord(ctx, spaceID, record)
	if err != nil {
		// Tolerate "already exists" errors gracefully
		errStr := err.Error()
		if strings.Contains(errStr, "already exists") ||
			strings.Contains(errStr, "duplicate") {
			fmt.Printf("[any-sync SDK] AddToACL: peer %s already in ACL for space %s\n", peerID, spaceID)
			return nil
		}
		return fmt.Errorf("adding ACL record via coordinator: %w", err)
	}

	fmt.Printf("[any-sync SDK] AddToACL: space=%s peer=%s permissions=%v\n", spaceID, peerID, permissions)
	return nil
}

// MakeSpaceShareable marks a space as shareable on the coordinator,
// enabling ACL invite operations (CreateOpenInvite / JoinWithInvite).
// Must be called after space creation and propagation to tree nodes.
func (c *SDKClient) MakeSpaceShareable(ctx context.Context, spaceID string) error {
	c.mu.RLock()
	defer c.mu.RUnlock()

	if !c.initialized {
		return fmt.Errorf("client not initialized")
	}

	if err := c.coordinator.SpaceMakeShareable(ctx, spaceID); err != nil {
		return fmt.Errorf("making space shareable: %w", err)
	}

	fmt.Printf("[any-sync SDK] MakeSpaceShareable: %s\n", spaceID)
	return nil
}

// SyncDocument syncs a document to a space.
//
// Deprecated: Use CredentialTreeManager.AddCredential instead. This method
// exists for backward compatibility and logs a deprecation warning. All data
// should go through ObjectTree-based operations for P2P sync support.
func (c *SDKClient) SyncDocument(ctx context.Context, spaceID string, docID string, data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if !c.initialized {
		return fmt.Errorf("client not initialized")
	}

	fmt.Printf("[any-sync SDK] DEPRECATED: SyncDocument called for space=%s doc=%s — use CredentialTreeManager.AddCredential instead\n", spaceID, docID)

	// Delegate to tree-based credential storage via the space's ObjectTree.
	// Callers should migrate to CredentialTreeManager.AddCredential directly.
	treeMgr := NewCredentialTreeManager(c, nil)
	keys, err := LoadSpaceKeySet(c.dataDir, spaceID)
	if err != nil {
		return fmt.Errorf("loading space keys for tree sync: %w", err)
	}

	payload := &CredentialPayload{
		SAID:      docID,
		Data:      data,
		Timestamp: time.Now().Unix(),
	}

	_, err = treeMgr.AddCredential(ctx, spaceID, payload, keys.SigningKey)
	if err != nil {
		return fmt.Errorf("adding credential via tree manager: %w", err)
	}

	return nil
}

// Ping tests connectivity to the any-sync coordinator
func (c *SDKClient) Ping() error {
	if !c.initialized {
		return fmt.Errorf("client not initialized")
	}
	// Use coordinator StatusCheck with a dummy space ID to verify connectivity.
	// A "space not found" error still means the coordinator is reachable.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := c.coordinator.StatusCheck(ctx, "ping-test")
	if err != nil {
		// Any response from the coordinator (including "space not exists") means it's reachable
		errStr := err.Error()
		if strings.Contains(errStr, "not found") ||
			strings.Contains(errStr, "not exists") ||
			strings.Contains(errStr, "SpaceNotExists") ||
			strings.Contains(errStr, "unknown") {
			return nil
		}
		return fmt.Errorf("coordinator unreachable: %w", err)
	}
	return nil
}

// GetNetworkID returns the network ID
func (c *SDKClient) GetNetworkID() string {
	return c.networkID
}

// GetCoordinatorURL returns the coordinator URL
func (c *SDKClient) GetCoordinatorURL() string {
	return c.coordinatorURL
}

// GetPeerID returns the peer ID
func (c *SDKClient) GetPeerID() string {
	if c.peerKeyManager != nil {
		return c.peerKeyManager.GetPeerID()
	}
	return ""
}

// GetSigningKey returns the client's signing key (used as the ACL identity).
// This is the peer's Ed25519 private key, which signs ObjectTree changes.
func (c *SDKClient) GetSigningKey() crypto.PrivKey {
	if c.peerKeyManager != nil {
		return c.peerKeyManager.GetPrivKey()
	}
	return nil
}

// Reinitialize shuts down all any-sync components, overwrites the peer key
// with a mnemonic-derived key, and restarts the SDK with the new identity.
// This is called by POST /api/v1/identity/set when the user's identity is
// established (org setup, registration, or claim flow).
func (c *SDKClient) Reinitialize(mnemonic string) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	fmt.Println("[any-sync SDK] Reinitializing with mnemonic-derived peer key...")

	// 1. Shut down the current app
	if c.app != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := c.app.Close(ctx); err != nil {
			fmt.Printf("[any-sync SDK] Warning: error closing app during reinit: %v\n", err)
		}
		c.app = nil
		c.initialized = false
	}

	// 2. Derive new peer key from mnemonic
	privKey, err := DeriveKeyFromMnemonic(mnemonic, 0)
	if err != nil {
		return fmt.Errorf("deriving key from mnemonic: %w", err)
	}

	// 3. Overwrite {dataDir}/peer.key with the derived key
	keyPath := filepath.Join(c.dataDir, "peer.key")
	keyData, err := privKey.Marshall()
	if err != nil {
		return fmt.Errorf("marshaling derived key: %w", err)
	}
	if err := os.WriteFile(keyPath, keyData, 0600); err != nil {
		return fmt.Errorf("writing peer.key: %w", err)
	}

	// 4. Create new PeerKeyManager with the derived key
	peerMgr, err := NewPeerKeyManager(&PeerKeyConfig{
		KeyPath:  keyPath,
		Mnemonic: mnemonic,
		KeyIndex: 0,
	})
	if err != nil {
		return fmt.Errorf("creating peer key manager: %w", err)
	}
	c.peerKeyManager = peerMgr

	// 5. Restart the SDK
	if err := c.initFullSDK(); err != nil {
		return fmt.Errorf("reinitializing SDK: %w", err)
	}

	c.initialized = true
	fmt.Printf("[any-sync SDK] Reinitialized with new peer ID: %s\n", c.peerKeyManager.GetPeerID())
	return nil
}

// GetPeerKeyManager returns the peer key manager (used by identity handler).
func (c *SDKClient) GetPeerKeyManager() *PeerKeyManager {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.peerKeyManager
}

// Close shuts down the SDK client
func (c *SDKClient) Close() error {
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

// =============================================================================
// SDK Component implementations
// =============================================================================

// sdkAccountService implements accountservice.Service
type sdkAccountService struct {
	keys *accountdata.AccountKeys
}

func (s *sdkAccountService) Init(a *app.App) error { return nil }
func (s *sdkAccountService) Name() string          { return accountservice.CName }
func (s *sdkAccountService) Account() *accountdata.AccountKeys {
	return s.keys
}

// sdkConfig implements all config interfaces required by any-sync components
type sdkConfig struct {
	clientConfig *ClientConfig
}

func newSDKConfig(cc *ClientConfig) *sdkConfig {
	return &sdkConfig{clientConfig: cc}
}

func (c *sdkConfig) Init(a *app.App) error { return nil }
func (c *sdkConfig) Name() string          { return "config" }

// GetSpace implements config.ConfigGetter for commonspace
func (c *sdkConfig) GetSpace() config.Config {
	return config.Config{
		GCTTL:                60,
		SyncPeriod:           5,
		KeepTreeDataInMemory: true,
	}
}

// GetStreamConfig implements streampool config
func (c *sdkConfig) GetStreamConfig() streampool.StreamConfig {
	return streampool.StreamConfig{
		SendQueueSize:    100,
		DialQueueWorkers: 4,
		DialQueueSize:    100,
	}
}

// GetDrpc implements rpc.ConfigGetter
func (c *sdkConfig) GetDrpc() rpc.Config {
	return rpc.Config{
		Stream: rpc.StreamConfig{
			MaxMsgSizeMb: 256,
		},
	}
}

// GetYamux implements yamux config
func (c *sdkConfig) GetYamux() yamux.Config {
	return yamux.Config{
		DialTimeoutSec:     10,
		WriteTimeoutSec:    10,
		KeepAlivePeriodSec: 30,
	}
}

// GetQuic implements quic config
func (c *sdkConfig) GetQuic() quic.Config {
	return quic.Config{
		DialTimeoutSec:  10,
		WriteTimeoutSec: 10,
	}
}

// GetSecureService implements secureservice config
func (c *sdkConfig) GetSecureService() secureservice.Config {
	return secureservice.Config{
		RequireClientAuth: false,
	}
}

// sdkSpaceResolver provides a shared space cache across all SDK components.
// Without this, each component (SDKClient, sdkTreeManager, sdkStreamHandler,
// sdkSpaceSyncRPC) creates its own Space instances for the same spaceId,
// leading to multiple HeadSync diffs and inconsistent StoredIds() results.
const spaceResolverCName = "matou.space.resolver"

type sdkSpaceResolver struct {
	a     *app.App
	cache sync.Map // spaceId → commonspace.Space
}

func newSDKSpaceResolver() *sdkSpaceResolver { return &sdkSpaceResolver{} }

func (r *sdkSpaceResolver) Init(a *app.App) error {
	r.a = a
	return nil
}

func (r *sdkSpaceResolver) Name() string { return spaceResolverCName }

func (r *sdkSpaceResolver) spaceService() commonspace.SpaceService {
	return r.a.MustComponent(commonspace.CName).(commonspace.SpaceService)
}

func (r *sdkSpaceResolver) GetSpace(ctx context.Context, spaceId string) (commonspace.Space, error) {
	if val, ok := r.cache.Load(spaceId); ok {
		return val.(commonspace.Space), nil
	}
	sp, err := r.spaceService().NewSpace(ctx, spaceId, newSpaceDeps(spaceId))
	if err != nil {
		return nil, err
	}
	if err := sp.Init(ctx); err != nil {
		return nil, err
	}
	r.cache.Store(spaceId, sp)
	return sp, nil
}

func (r *sdkSpaceResolver) StoreSpace(spaceId string, space commonspace.Space) {
	r.cache.Store(spaceId, space)
}

// sdkNodeConf implements nodeconf.Service with full configuration
type sdkNodeConf struct {
	clientConfig *ClientConfig
	conf         nodeconf.Configuration
}

func newSDKNodeConf(cc *ClientConfig) *sdkNodeConf {
	var nodes []nodeconf.Node
	for _, n := range cc.Nodes {
		nodes = append(nodes, nodeconf.Node{
			PeerId:    n.PeerID,
			Addresses: n.Addresses,
			Types:     nodeTypesToProto(n.Types),
		})
	}

	return &sdkNodeConf{
		clientConfig: cc,
		conf: nodeconf.Configuration{
			Id:        cc.ID,
			NetworkId: cc.NetworkID,
			Nodes:     nodes,
		},
	}
}

func (n *sdkNodeConf) Init(a *app.App) error           { return nil }
func (n *sdkNodeConf) Name() string                    { return nodeconf.CName }
func (n *sdkNodeConf) Run(ctx context.Context) error   { return nil }
func (n *sdkNodeConf) Close(ctx context.Context) error { return nil }
func (n *sdkNodeConf) Id() string                      { return n.conf.Id }
func (n *sdkNodeConf) Configuration() nodeconf.Configuration {
	return n.conf
}

func (n *sdkNodeConf) NetworkCompatibilityStatus() nodeconf.NetworkCompatibilityStatus {
	return nodeconf.NetworkCompatibilityStatusOk
}

func (n *sdkNodeConf) NodeIds(spaceId string) []string {
	return n.nodeIdsByType(nodeconf.NodeTypeTree)
}

func (n *sdkNodeConf) nodeIdsByType(tp nodeconf.NodeType) []string {
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

func (n *sdkNodeConf) CoordinatorPeers() []string {
	return n.nodeIdsByType(nodeconf.NodeTypeCoordinator)
}

func (n *sdkNodeConf) ConsensusPeers() []string {
	return n.nodeIdsByType(nodeconf.NodeTypeConsensus)
}

func (n *sdkNodeConf) FilePeers() []string {
	return n.nodeIdsByType(nodeconf.NodeTypeFile)
}

func (n *sdkNodeConf) NamingNodePeers() []string {
	return n.nodeIdsByType(nodeconf.NodeTypeNamingNode)
}

func (n *sdkNodeConf) PaymentProcessingNodePeers() []string {
	return n.nodeIdsByType(nodeconf.NodeTypePaymentProcessingNode)
}

func (n *sdkNodeConf) IsResponsible(spaceId string) bool { return false }
func (n *sdkNodeConf) Partition(spaceId string) int      { return 0 }

func (n *sdkNodeConf) NodeTypes(nodeId string) []nodeconf.NodeType {
	for _, node := range n.conf.Nodes {
		if node.PeerId == nodeId {
			return node.Types
		}
	}
	return nil
}

func (n *sdkNodeConf) PeerAddresses(peerId string) ([]string, bool) {
	for _, node := range n.conf.Nodes {
		if node.PeerId == peerId {
			return node.Addresses, true
		}
	}
	return nil, false
}

func (n *sdkNodeConf) CHash() chash.CHash {
	return nil
}

// sdkStorageProvider implements spacestorage.SpaceStorageProvider
type sdkStorageProvider struct {
	rootPath string
	spaces   sync.Map
}

func newSDKStorageProvider(rootPath string) *sdkStorageProvider {
	os.MkdirAll(rootPath, 0755)
	return &sdkStorageProvider{rootPath: rootPath}
}

func (p *sdkStorageProvider) Init(a *app.App) error           { return nil }
func (p *sdkStorageProvider) Name() string                    { return spacestorage.CName }
func (p *sdkStorageProvider) Run(ctx context.Context) error   { return nil }
func (p *sdkStorageProvider) Close(ctx context.Context) error { return nil }

func (p *sdkStorageProvider) WaitSpaceStorage(ctx context.Context, id string) (spacestorage.SpaceStorage, error) {
	if s, ok := p.spaces.Load(id); ok {
		return s.(spacestorage.SpaceStorage), nil
	}

	// Try to reopen an existing space database from disk.
	dbPath := filepath.Join(p.rootPath, id, "data.db")
	if _, err := os.Stat(dbPath); err != nil {
		return nil, spacestorage.ErrSpaceStorageMissing
	}

	store, err := anystore.Open(ctx, dbPath, nil)
	if err != nil {
		return nil, fmt.Errorf("reopening space database %s: %w", id, err)
	}

	storage, err := spacestorage.New(ctx, id, store)
	if err != nil {
		store.Close()
		return nil, fmt.Errorf("loading space storage %s: %w", id, err)
	}

	p.spaces.Store(id, storage)
	return storage, nil
}

func (p *sdkStorageProvider) SpaceStorage(id string) (spacestorage.SpaceStorage, error) {
	return p.WaitSpaceStorage(context.Background(), id)
}

func (p *sdkStorageProvider) CreateSpaceStorage(ctx context.Context, payload spacestorage.SpaceStorageCreatePayload) (spacestorage.SpaceStorage, error) {
	spaceId := payload.SpaceHeaderWithId.Id

	if _, ok := p.spaces.Load(spaceId); ok {
		return nil, spacestorage.ErrSpaceStorageExists
	}

	spacePath := filepath.Join(p.rootPath, spaceId)
	if err := os.MkdirAll(spacePath, 0755); err != nil {
		return nil, fmt.Errorf("creating space directory: %w", err)
	}

	dbPath := filepath.Join(spacePath, "data.db")
	store, err := anystore.Open(ctx, dbPath, nil)
	if err != nil {
		return nil, fmt.Errorf("creating anystore database: %w", err)
	}

	storage, err := spacestorage.Create(ctx, store, payload)
	if err != nil {
		store.Close()
		return nil, fmt.Errorf("creating space storage: %w", err)
	}

	p.spaces.Store(spaceId, storage)
	return storage, nil
}

func (p *sdkStorageProvider) SpaceExists(id string) bool {
	if _, ok := p.spaces.Load(id); ok {
		return true
	}
	dbPath := filepath.Join(p.rootPath, id, "data.db")
	_, err := os.Stat(dbPath)
	return err == nil
}

// sdkPeerManagerProvider implements peermanager.PeerManagerProvider using real
// network components for peer discovery and HeadUpdate broadcasting.
type sdkPeerManagerProvider struct {
	nodeConf   nodeconf.Service
	pool       pool.Pool
	streamPool streampool.StreamPool
}

func newSDKPeerManagerProvider() *sdkPeerManagerProvider { return &sdkPeerManagerProvider{} }

func (p *sdkPeerManagerProvider) Init(a *app.App) error {
	p.nodeConf = a.MustComponent(nodeconf.CName).(nodeconf.Service)
	p.pool = a.MustComponent(pool.CName).(pool.Pool)
	p.streamPool = a.MustComponent(streampool.CName).(streampool.StreamPool)
	return nil
}

func (p *sdkPeerManagerProvider) Name() string { return peermanager.CName }

func (p *sdkPeerManagerProvider) NewPeerManager(ctx context.Context, spaceId string) (peermanager.PeerManager, error) {
	return &sdkPeerManager{
		spaceId:    spaceId,
		nodeConf:   p.nodeConf,
		pool:       p.pool,
		streamPool: p.streamPool,
	}, nil
}

// sdkPeerManager implements peermanager.PeerManager for a specific space.
// It uses the node configuration's consistent hash ring to find responsible
// tree-node peers and the stream pool for broadcasting HeadUpdate messages.
type sdkPeerManager struct {
	spaceId    string
	nodeConf   nodeconf.Service
	pool       pool.Pool
	streamPool streampool.StreamPool
}

func (m *sdkPeerManager) Init(a *app.App) error { return nil }
func (m *sdkPeerManager) Name() string          { return peermanager.CName }

func (m *sdkPeerManager) GetResponsiblePeers(ctx context.Context) ([]peer.Peer, error) {
	nodeIds := m.nodeConf.NodeIds(m.spaceId)
	var peers []peer.Peer
	for _, id := range nodeIds {
		p, err := m.pool.Get(ctx, id)
		if err != nil {
			continue // skip unreachable peers
		}
		peers = append(peers, p)
	}
	return peers, nil
}

func (m *sdkPeerManager) GetNodePeers(ctx context.Context) ([]peer.Peer, error) {
	return m.GetResponsiblePeers(ctx)
}

func (m *sdkPeerManager) BroadcastMessage(ctx context.Context, msg drpc.Message) error {
	return m.streamPool.Send(ctx, msg, m.GetResponsiblePeers)
}

func (m *sdkPeerManager) SendMessage(ctx context.Context, peerId string, msg drpc.Message) error {
	return m.streamPool.Send(ctx, msg, func(ctx context.Context) ([]peer.Peer, error) {
		p, err := m.pool.Get(ctx, peerId)
		if err != nil {
			return nil, err
		}
		return []peer.Peer{p}, nil
	})
}

func (m *sdkPeerManager) KeepAlive(ctx context.Context) {}

// sdkTreeManager implements treemanager.TreeManager using the space service's
// ObjectTreeBuilder for real tree operations. Trees are cached in a sync.Map
// for efficient reuse across sync requests. Uses sdkSpaceResolver to share
// Space instances with other components.
type sdkTreeManager struct {
	a     *app.App
	cache sync.Map // treeId → objecttree.ObjectTree
}

func newSDKTreeManager() *sdkTreeManager { return &sdkTreeManager{} }

func (t *sdkTreeManager) Init(a *app.App) error {
	// Store the app reference for lazy resolution of SpaceService/SpaceResolver.
	// SpaceService depends on TreeManager, so we cannot resolve it during Init.
	t.a = a
	return nil
}

func (t *sdkTreeManager) Name() string                    { return "common.object.treemanager" }
func (t *sdkTreeManager) Run(ctx context.Context) error   { return nil }
func (t *sdkTreeManager) Close(ctx context.Context) error { return nil }

func (t *sdkTreeManager) getSpace(ctx context.Context, spaceId string) (commonspace.Space, error) {
	resolver := t.a.MustComponent(spaceResolverCName).(*sdkSpaceResolver)
	return resolver.GetSpace(ctx, spaceId)
}

func (t *sdkTreeManager) GetTree(ctx context.Context, spaceId, treeId string) (objecttree.ObjectTree, error) {
	// Check cache first
	if val, ok := t.cache.Load(treeId); ok {
		return val.(objecttree.ObjectTree), nil
	}

	// Build tree from storage via the space's TreeBuilder
	sp, err := t.getSpace(ctx, spaceId)
	if err != nil {
		return nil, err
	}

	tree, err := sp.TreeBuilder().BuildTree(ctx, treeId, objecttreebuilder.BuildTreeOpts{})
	if err != nil {
		return nil, fmt.Errorf("building tree %s: %w", treeId, err)
	}

	t.cache.Store(treeId, tree)
	return tree, nil
}

func (t *sdkTreeManager) ValidateAndPutTree(ctx context.Context, spaceId string, payload treestorage.TreeStorageCreatePayload) error {
	sp, err := t.getSpace(ctx, spaceId)
	if err != nil {
		return err
	}

	tree, err := sp.TreeBuilder().PutTree(ctx, payload, nil)
	if err != nil {
		return fmt.Errorf("putting tree in space %s: %w", spaceId, err)
	}

	t.cache.Store(tree.Id(), tree)
	return nil
}

func (t *sdkTreeManager) MarkTreeDeleted(ctx context.Context, spaceId, treeId string) error {
	tree, err := t.GetTree(ctx, spaceId, treeId)
	if err != nil {
		return err
	}
	return tree.Delete()
}

func (t *sdkTreeManager) DeleteTree(ctx context.Context, spaceId, treeId string) error {
	tree, err := t.GetTree(ctx, spaceId, treeId)
	if err != nil {
		return err
	}
	if err := tree.Delete(); err != nil {
		return err
	}
	t.cache.Delete(treeId)
	return nil
}

// sdkStreamHandler implements streamhandler.StreamHandler for P2P sync.
// It opens ObjectSyncStream DRPC streams and routes incoming HeadUpdate
// messages to the correct space's sync service. Uses sdkSpaceResolver to
// share Space instances with other components.
type sdkStreamHandler struct {
	resolver   *sdkSpaceResolver
	streamPool streampool.StreamPool
}

func newSDKStreamHandler() *sdkStreamHandler { return &sdkStreamHandler{} }

func (s *sdkStreamHandler) Init(a *app.App) error {
	s.resolver = a.MustComponent(spaceResolverCName).(*sdkSpaceResolver)
	s.streamPool = a.MustComponent(streampool.CName).(streampool.StreamPool)
	return nil
}

func (s *sdkStreamHandler) Name() string { return "common.streampool.streamhandler" }

func (s *sdkStreamHandler) OpenStream(ctx context.Context, p peer.Peer) (drpc.Stream, []string, int, error) {
	conn, err := p.AcquireDrpcConn(ctx)
	if err != nil {
		return nil, nil, 0, err
	}

	stream, err := spacesyncproto.NewDRPCSpaceSyncClient(conn).ObjectSyncStream(ctx)
	if err != nil {
		return nil, nil, 0, err
	}

	return stream, nil, 200, nil
}

func (s *sdkStreamHandler) HandleMessage(ctx context.Context, peerId string, msg drpc.Message) error {
	headUpdate, ok := msg.(*objectmessages.HeadUpdate)
	if !ok {
		return fmt.Errorf("unexpected message type %T", msg)
	}

	spaceId := headUpdate.SpaceId()
	if spaceId == "" {
		// Subscription message — handle tag add/remove
		var sub spacesyncproto.SpaceSubscription
		if err := sub.UnmarshalVT(headUpdate.Bytes); err != nil {
			return fmt.Errorf("unmarshaling subscription: %w", err)
		}
		if sub.Action == spacesyncproto.SpaceSubscriptionAction_Subscribe {
			return s.streamPool.AddTagsCtx(ctx, sub.SpaceIds...)
		}
		return s.streamPool.RemoveTagsCtx(ctx, sub.SpaceIds...)
	}

	// Route to the space's sync handler via shared resolver
	space, err := s.resolver.GetSpace(ctx, spaceId)
	if err != nil {
		return fmt.Errorf("getting space %s: %w", spaceId, err)
	}
	return space.HandleMessage(ctx, headUpdate)
}

func (s *sdkStreamHandler) NewReadMessage() drpc.Message {
	return &objectmessages.HeadUpdate{}
}

// sdkSpaceSyncRPC implements DRPCSpaceSyncServer to handle incoming RPC calls
// from tree nodes. When a tree node receives a HeadUpdate for an unknown tree,
// it calls ObjectSyncRequestStream back to the originating client to fetch the
// tree. Without this handler, trees broadcast via HeadUpdate are never fetched
// by tree nodes (they can't pull the data).
type sdkSpaceSyncRPC struct {
	spacesyncproto.DRPCSpaceSyncUnimplementedServer
	resolver   *sdkSpaceResolver
	streamPool streampool.StreamPool
}

func newSDKSpaceSyncRPC() *sdkSpaceSyncRPC { return &sdkSpaceSyncRPC{} }

func (r *sdkSpaceSyncRPC) Init(a *app.App) error {
	r.resolver = a.MustComponent(spaceResolverCName).(*sdkSpaceResolver)
	r.streamPool = a.MustComponent(streampool.CName).(streampool.StreamPool)
	drpcServer := a.MustComponent(server.CName).(server.DRPCServer)
	return spacesyncproto.DRPCRegisterSpaceSync(drpcServer, r)
}

func (r *sdkSpaceSyncRPC) Name() string { return "matou.spacesync.rpc" }

func (r *sdkSpaceSyncRPC) HeadSync(ctx context.Context, req *spacesyncproto.HeadSyncRequest) (*spacesyncproto.HeadSyncResponse, error) {
	sp, err := r.resolver.GetSpace(ctx, req.SpaceId)
	if err != nil {
		return nil, err
	}
	return sp.HandleRangeRequest(ctx, req)
}

func (r *sdkSpaceSyncRPC) ObjectSyncStream(stream spacesyncproto.DRPCSpaceSync_ObjectSyncStreamStream) error {
	return r.streamPool.ReadStream(stream, 100)
}

func (r *sdkSpaceSyncRPC) ObjectSyncRequestStream(msg *spacesyncproto.ObjectSyncMessage, stream spacesyncproto.DRPCSpaceSync_ObjectSyncRequestStreamStream) error {
	sp, err := r.resolver.GetSpace(stream.Context(), msg.SpaceId)
	if err != nil {
		return err
	}
	return sp.HandleStreamSyncRequest(stream.Context(), msg, stream)
}

// sdkCredentialProvider implements credentialprovider.CredentialProvider by
// calling the coordinator's SpaceSign RPC to obtain a valid space receipt.
// Tree nodes validate this receipt before accepting a space push.
type sdkCredentialProvider struct {
	coordinator coordinatorclient.CoordinatorClient
	account     accountservice.Service
}

func newSDKCredentialProvider() *sdkCredentialProvider { return &sdkCredentialProvider{} }

func (p *sdkCredentialProvider) Init(a *app.App) error {
	p.coordinator = a.MustComponent(coordinatorclient.CName).(coordinatorclient.CoordinatorClient)
	p.account = a.MustComponent(accountservice.CName).(accountservice.Service)
	return nil
}

func (p *sdkCredentialProvider) Name() string {
	return credentialprovider.CName
}

func (p *sdkCredentialProvider) GetCredential(ctx context.Context, spaceHeader *spacesyncproto.RawSpaceHeaderWithId) ([]byte, error) {
	keys := p.account.Account()
	receipt, err := p.coordinator.SpaceSign(ctx, coordinatorclient.SpaceSignPayload{
		SpaceId:     spaceHeader.Id,
		SpaceHeader: spaceHeader.RawHeader,
		OldAccount:  keys.SignKey,
		Identity:    keys.SignKey,
	})
	if err != nil {
		return nil, fmt.Errorf("signing space receipt: %w", err)
	}
	return receipt.MarshalVT()
}

// newSpaceDeps creates the Deps required by SpaceService.NewSpace.
// Uses matouTreeSyncer for real P2P tree sync and no-op sync status.
func newSpaceDeps(spaceID string) commonspace.Deps {
	return commonspace.Deps{
		SyncStatus: &noOpSyncStatus{},
		TreeSyncer: newMatouTreeSyncer(spaceID),
	}
}

// noOpSyncStatus implements syncstatus.StatusUpdater as a no-op.
type noOpSyncStatus struct{}

func (n *noOpSyncStatus) Init(a *app.App) error                                   { return nil }
func (n *noOpSyncStatus) Name() string                                             { return syncstatus.CName }
func (n *noOpSyncStatus) HeadsChange(treeId string, heads []string)                {}
func (n *noOpSyncStatus) HeadsReceive(senderId, treeId string, heads []string)     {}
func (n *noOpSyncStatus) ObjectReceive(senderId, treeId string, heads []string)    {}
func (n *noOpSyncStatus) HeadsApply(senderId, treeId string, heads []string, allAdded bool) {}

// matouTreeSyncer implements treesyncer.TreeSyncer using the space's tree
// manager to fetch and sync trees with peers. HeadSync discovers missing/changed
// trees via diff, then matouTreeSyncer syncs them using the ObjectSync protocol.
// For missing trees, BuildSyncTreeOrGetRemote fetches the full tree from the peer.
type matouTreeSyncer struct {
	spaceId     string
	treeManager treemanager.TreeManager
}

func newMatouTreeSyncer(spaceId string) *matouTreeSyncer {
	return &matouTreeSyncer{spaceId: spaceId}
}

func (t *matouTreeSyncer) Init(a *app.App) error {
	// Resolves to the objectManager in the child space app, which wraps
	// the parent app's sdkTreeManager. GetTree calls BuildSyncTreeOrGetRemote
	// which handles fetching missing trees from remote peers.
	t.treeManager = a.MustComponent(treemanager.CName).(treemanager.TreeManager)
	return nil
}

func (t *matouTreeSyncer) Name() string                    { return treesyncer.CName }
func (t *matouTreeSyncer) Run(ctx context.Context) error   { return nil }
func (t *matouTreeSyncer) Close(ctx context.Context) error { return nil }
func (t *matouTreeSyncer) StartSync()                      {}
func (t *matouTreeSyncer) StopSync()                       {}
func (t *matouTreeSyncer) ShouldSync(peerId string) bool   { return true }

func (t *matouTreeSyncer) SyncAll(ctx context.Context, p peer.Peer, existing, missing []string) error {
	// For missing trees, set the peer ID in context so BuildSyncTreeOrGetRemote
	// knows which peer to fetch the tree from via ObjectSyncRequestStream.
	// Without this, treeRemoteGetter.getPeers returns ErrPeerIdNotFoundInContext
	// and the remote fetch silently fails with "tree does not exist".
	peerCtx := peer.CtxWithPeerId(ctx, p.Id())

	for _, id := range missing {
		tr, err := t.treeManager.GetTree(peerCtx, t.spaceId, id)
		if err != nil {
			continue
		}
		if st, ok := tr.(synctree.SyncTree); ok {
			_ = st.SyncWithPeer(ctx, p)
		}
	}
	for _, id := range existing {
		tr, err := t.treeManager.GetTree(ctx, t.spaceId, id)
		if err != nil {
			continue
		}
		if st, ok := tr.(synctree.SyncTree); ok {
			_ = st.SyncWithPeer(ctx, p)
		}
	}
	return nil
}
