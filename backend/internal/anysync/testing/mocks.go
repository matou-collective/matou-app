// Package testing provides test utilities and mocks for anysync package.
package testing

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/anyproto/any-sync/util/crypto"
	"github.com/matou-dao/backend/internal/anysync"
)

// MockAnySyncClient implements anysync.AnySyncClient for testing
type MockAnySyncClient struct {
	mu sync.RWMutex

	// Storage for created spaces
	Spaces map[string]*anysync.SpaceCreateResult

	// ACL entries per space
	ACLEntries map[string][]ACLEntry

	// Synced documents
	Documents map[string]map[string][]byte

	// Configuration
	NetworkID      string
	CoordinatorURL string
	PeerID         string
	Initialized    bool

	// Error injection
	CreateSpaceError    error
	DeriveSpaceError    error
	DeriveSpaceIDError  error
	AddToACLError       error
	SyncDocumentError   error
	CloseError          error

	// Call tracking
	CreateSpaceCalls    []CreateSpaceCall
	DeriveSpaceCalls    []DeriveSpaceCall
	AddToACLCalls       []AddToACLCall
	SyncDocumentCalls   []SyncDocumentCall
}

// CreateSpaceCall records a call to CreateSpace
type CreateSpaceCall struct {
	OwnerAID   string
	SpaceType  string
	SigningKey crypto.PrivKey
}

// DeriveSpaceCall records a call to DeriveSpace
type DeriveSpaceCall struct {
	OwnerAID   string
	SpaceType  string
	SigningKey crypto.PrivKey
}

// AddToACLCall records a call to AddToACL
type AddToACLCall struct {
	SpaceID     string
	PeerID      string
	Permissions []string
}

// SyncDocumentCall records a call to SyncDocument
type SyncDocumentCall struct {
	SpaceID string
	DocID   string
	Data    []byte
}

// ACLEntry represents an ACL entry in the mock
type ACLEntry struct {
	PeerID      string
	Permissions []string
}

// NewMockAnySyncClient creates a new mock client with sensible defaults
func NewMockAnySyncClient() *MockAnySyncClient {
	return &MockAnySyncClient{
		Spaces:         make(map[string]*anysync.SpaceCreateResult),
		ACLEntries:     make(map[string][]ACLEntry),
		Documents:      make(map[string]map[string][]byte),
		NetworkID:      "test-network-id",
		CoordinatorURL: "localhost:1004",
		PeerID:         "test-peer-id-12345",
		Initialized:    true,
	}
}

// CreateSpace implements AnySyncClient.CreateSpace
func (m *MockAnySyncClient) CreateSpace(ctx context.Context, ownerAID string, spaceType string, signingKey crypto.PrivKey) (*anysync.SpaceCreateResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.CreateSpaceCalls = append(m.CreateSpaceCalls, CreateSpaceCall{
		OwnerAID:   ownerAID,
		SpaceType:  spaceType,
		SigningKey: signingKey,
	})

	if m.CreateSpaceError != nil {
		return nil, m.CreateSpaceError
	}

	// Generate deterministic space ID
	spaceID := fmt.Sprintf("space_%s_%s", spaceType, ownerAID[:8])

	// Check if space already exists
	if existing, ok := m.Spaces[spaceID]; ok {
		return existing, nil
	}

	result := &anysync.SpaceCreateResult{
		SpaceID:   spaceID,
		CreatedAt: time.Now().UTC(),
		OwnerAID:  ownerAID,
		SpaceType: spaceType,
	}

	m.Spaces[spaceID] = result
	m.ACLEntries[spaceID] = []ACLEntry{}
	m.Documents[spaceID] = make(map[string][]byte)

	return result, nil
}

// DeriveSpace implements AnySyncClient.DeriveSpace
func (m *MockAnySyncClient) DeriveSpace(ctx context.Context, ownerAID string, spaceType string, signingKey crypto.PrivKey) (*anysync.SpaceCreateResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.DeriveSpaceCalls = append(m.DeriveSpaceCalls, DeriveSpaceCall{
		OwnerAID:   ownerAID,
		SpaceType:  spaceType,
		SigningKey: signingKey,
	})

	if m.DeriveSpaceError != nil {
		return nil, m.DeriveSpaceError
	}

	// Same as CreateSpace for mock purposes
	return m.createSpaceInternal(ownerAID, spaceType)
}

// createSpaceInternal is a helper for creating spaces without locking
func (m *MockAnySyncClient) createSpaceInternal(ownerAID string, spaceType string) (*anysync.SpaceCreateResult, error) {
	spaceID := fmt.Sprintf("space_%s_%s", spaceType, ownerAID[:8])

	if existing, ok := m.Spaces[spaceID]; ok {
		return existing, nil
	}

	result := &anysync.SpaceCreateResult{
		SpaceID:   spaceID,
		CreatedAt: time.Now().UTC(),
		OwnerAID:  ownerAID,
		SpaceType: spaceType,
	}

	m.Spaces[spaceID] = result
	return result, nil
}

// DeriveSpaceID implements AnySyncClient.DeriveSpaceID
func (m *MockAnySyncClient) DeriveSpaceID(ctx context.Context, ownerAID string, spaceType string, signingKey crypto.PrivKey) (string, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if m.DeriveSpaceIDError != nil {
		return "", m.DeriveSpaceIDError
	}

	return fmt.Sprintf("space_%s_%s", spaceType, ownerAID[:8]), nil
}

// AddToACL implements AnySyncClient.AddToACL
func (m *MockAnySyncClient) AddToACL(ctx context.Context, spaceID string, peerID string, permissions []string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.AddToACLCalls = append(m.AddToACLCalls, AddToACLCall{
		SpaceID:     spaceID,
		PeerID:      peerID,
		Permissions: permissions,
	})

	if m.AddToACLError != nil {
		return m.AddToACLError
	}

	if _, ok := m.ACLEntries[spaceID]; !ok {
		m.ACLEntries[spaceID] = []ACLEntry{}
	}

	m.ACLEntries[spaceID] = append(m.ACLEntries[spaceID], ACLEntry{
		PeerID:      peerID,
		Permissions: permissions,
	})

	return nil
}

// SyncDocument implements AnySyncClient.SyncDocument
func (m *MockAnySyncClient) SyncDocument(ctx context.Context, spaceID string, docID string, data []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.SyncDocumentCalls = append(m.SyncDocumentCalls, SyncDocumentCall{
		SpaceID: spaceID,
		DocID:   docID,
		Data:    data,
	})

	if m.SyncDocumentError != nil {
		return m.SyncDocumentError
	}

	if _, ok := m.Documents[spaceID]; !ok {
		m.Documents[spaceID] = make(map[string][]byte)
	}

	m.Documents[spaceID][docID] = data
	return nil
}

// GetNetworkID implements AnySyncClient.GetNetworkID
func (m *MockAnySyncClient) GetNetworkID() string {
	return m.NetworkID
}

// GetCoordinatorURL implements AnySyncClient.GetCoordinatorURL
func (m *MockAnySyncClient) GetCoordinatorURL() string {
	return m.CoordinatorURL
}

// GetPeerID implements AnySyncClient.GetPeerID
func (m *MockAnySyncClient) GetPeerID() string {
	return m.PeerID
}

// Close implements AnySyncClient.Close
func (m *MockAnySyncClient) Close() error {
	if m.CloseError != nil {
		return m.CloseError
	}
	m.Initialized = false
	return nil
}

// Reset clears all recorded calls and state
func (m *MockAnySyncClient) Reset() {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.Spaces = make(map[string]*anysync.SpaceCreateResult)
	m.ACLEntries = make(map[string][]ACLEntry)
	m.Documents = make(map[string]map[string][]byte)
	m.CreateSpaceCalls = nil
	m.DeriveSpaceCalls = nil
	m.AddToACLCalls = nil
	m.SyncDocumentCalls = nil
	m.CreateSpaceError = nil
	m.DeriveSpaceError = nil
	m.AddToACLError = nil
	m.SyncDocumentError = nil
	m.CloseError = nil
}

// MockSpaceStore implements anysync.SpaceStore for testing
type MockSpaceStore struct {
	mu     sync.RWMutex
	spaces map[string]*anysync.Space // keyed by ownerAID

	// Error injection
	GetUserSpaceError  error
	SaveSpaceError     error
	ListAllSpacesError error
}

// NewMockSpaceStore creates a new mock space store
func NewMockSpaceStore() *MockSpaceStore {
	return &MockSpaceStore{
		spaces: make(map[string]*anysync.Space),
	}
}

// GetUserSpace implements SpaceStore.GetUserSpace
func (s *MockSpaceStore) GetUserSpace(ctx context.Context, userAID string) (*anysync.Space, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if s.GetUserSpaceError != nil {
		return nil, s.GetUserSpaceError
	}

	space, ok := s.spaces[userAID]
	if !ok {
		return nil, fmt.Errorf("space not found for user %s", userAID)
	}
	return space, nil
}

// SaveSpace implements SpaceStore.SaveSpace
func (s *MockSpaceStore) SaveSpace(ctx context.Context, space *anysync.Space) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.SaveSpaceError != nil {
		return s.SaveSpaceError
	}

	s.spaces[space.OwnerAID] = space
	return nil
}

// ListAllSpaces implements SpaceStore.ListAllSpaces
func (s *MockSpaceStore) ListAllSpaces(ctx context.Context) ([]*anysync.Space, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if s.ListAllSpacesError != nil {
		return nil, s.ListAllSpacesError
	}

	var result []*anysync.Space
	for _, space := range s.spaces {
		result = append(result, space)
	}
	return result, nil
}

// Reset clears all stored spaces
func (s *MockSpaceStore) Reset() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.spaces = make(map[string]*anysync.Space)
	s.GetUserSpaceError = nil
	s.SaveSpaceError = nil
	s.ListAllSpacesError = nil
}

// MockCoordinatorClient provides a mock for coordinator operations
type MockCoordinatorClient struct {
	mu sync.RWMutex

	// Registered spaces
	RegisteredSpaces map[string]bool

	// Error injection
	RegisterSpaceError error
	StatusCheckError   error
}

// NewMockCoordinatorClient creates a new mock coordinator client
func NewMockCoordinatorClient() *MockCoordinatorClient {
	return &MockCoordinatorClient{
		RegisteredSpaces: make(map[string]bool),
	}
}

// RegisterSpace simulates registering a space with the coordinator
func (c *MockCoordinatorClient) RegisterSpace(spaceID string) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.RegisterSpaceError != nil {
		return c.RegisterSpaceError
	}

	c.RegisteredSpaces[spaceID] = true
	return nil
}

// IsRegistered checks if a space is registered
func (c *MockCoordinatorClient) IsRegistered(spaceID string) bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.RegisteredSpaces[spaceID]
}

// MockPeerManager provides a mock for peer management
type MockPeerManager struct {
	mu sync.RWMutex

	// Connected peers
	ConnectedPeers map[string]bool

	// Error injection
	ConnectError    error
	DisconnectError error
}

// NewMockPeerManager creates a new mock peer manager
func NewMockPeerManager() *MockPeerManager {
	return &MockPeerManager{
		ConnectedPeers: make(map[string]bool),
	}
}

// Connect simulates connecting to a peer
func (p *MockPeerManager) Connect(peerID string) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.ConnectError != nil {
		return p.ConnectError
	}

	p.ConnectedPeers[peerID] = true
	return nil
}

// Disconnect simulates disconnecting from a peer
func (p *MockPeerManager) Disconnect(peerID string) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.DisconnectError != nil {
		return p.DisconnectError
	}

	delete(p.ConnectedPeers, peerID)
	return nil
}

// IsConnected checks if a peer is connected
func (p *MockPeerManager) IsConnected(peerID string) bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.ConnectedPeers[peerID]
}
