package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/anyproto/any-sync/util/crypto"
	"github.com/matou-dao/backend/internal/anysync"
	"github.com/matou-dao/backend/internal/anystore"
	"github.com/matou-dao/backend/internal/keri"
	"github.com/matou-dao/backend/internal/trust"
)

// mockAnySyncClientForIntegration implements anysync.AnySyncClient for integration testing
type mockAnySyncClientForIntegration struct {
	spaces map[string]*anysync.SpaceCreateResult
}

func newMockAnySyncClientForIntegration() *mockAnySyncClientForIntegration {
	return &mockAnySyncClientForIntegration{
		spaces: make(map[string]*anysync.SpaceCreateResult),
	}
}

func (m *mockAnySyncClientForIntegration) CreateSpace(ctx context.Context, ownerAID string, spaceType string, signingKey crypto.PrivKey) (*anysync.SpaceCreateResult, error) {
	spaceID := fmt.Sprintf("space_%s_%s", spaceType, ownerAID[:8])
	if existing, ok := m.spaces[spaceID]; ok {
		return existing, nil
	}
	result := &anysync.SpaceCreateResult{
		SpaceID:   spaceID,
		CreatedAt: time.Now().UTC(),
		OwnerAID:  ownerAID,
		SpaceType: spaceType,
	}
	m.spaces[spaceID] = result
	return result, nil
}

func (m *mockAnySyncClientForIntegration) DeriveSpace(ctx context.Context, ownerAID string, spaceType string, signingKey crypto.PrivKey) (*anysync.SpaceCreateResult, error) {
	return m.CreateSpace(ctx, ownerAID, spaceType, signingKey)
}

func (m *mockAnySyncClientForIntegration) DeriveSpaceID(ctx context.Context, ownerAID string, spaceType string, signingKey crypto.PrivKey) (string, error) {
	return fmt.Sprintf("space_%s_%s", spaceType, ownerAID[:8]), nil
}

func (m *mockAnySyncClientForIntegration) AddToACL(ctx context.Context, spaceID string, peerID string, permissions []string) error {
	return nil
}

func (m *mockAnySyncClientForIntegration) SyncDocument(ctx context.Context, spaceID string, docID string, data []byte) error {
	return nil
}

func (m *mockAnySyncClientForIntegration) GetNetworkID() string      { return "test-network" }
func (m *mockAnySyncClientForIntegration) GetCoordinatorURL() string { return "http://localhost:1004" }
func (m *mockAnySyncClientForIntegration) GetPeerID() string         { return "test-peer-123" }
func (m *mockAnySyncClientForIntegration) Close() error              { return nil }

// IntegrationTestEnv provides a complete test environment for integration testing
type IntegrationTestEnv struct {
	store        *anystore.LocalStore
	spaceManager *anysync.SpaceManager
	spaceStore   anysync.SpaceStore
	keriClient   *keri.Client
	syncHandler  *SyncHandler
	trustHandler *TrustHandler
	credHandler  *CredentialsHandler
	mux          *http.ServeMux
	cleanup      func()
}

// setupIntegrationEnv creates a full integration test environment
func setupIntegrationEnv(t *testing.T) *IntegrationTestEnv {
	// Create temp directory for test database
	tmpDir, err := os.MkdirTemp("", "integration_test")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}

	// Create KERI client
	keriClient, err := keri.NewClient(&keri.Config{
		OrgAID:   "EOrg123456789TestOrg",
		OrgAlias: "test-org",
		OrgName:  "Test Organization",
	})
	if err != nil {
		os.RemoveAll(tmpDir)
		t.Fatalf("failed to create KERI client: %v", err)
	}

	// Create anystore
	store, err := anystore.NewLocalStore(anystore.DefaultConfig(tmpDir))
	if err != nil {
		os.RemoveAll(tmpDir)
		t.Fatalf("failed to create anystore: %v", err)
	}

	// Create any-sync mock client for testing (with space creation support)
	anysyncClient := newMockAnySyncClientForIntegration()

	// Create space manager
	spaceManager := anysync.NewSpaceManager(anysyncClient, &anysync.SpaceManagerConfig{
		CommunitySpaceID: "space-community-test",
		OrgAID:           "EOrg123456789TestOrg",
	})

	// Create space store adapter
	spaceStore := anystore.NewSpaceStoreAdapter(store)

	// Create handlers
	credHandler := NewCredentialsHandler(keriClient, store)
	syncHandler := NewSyncHandler(keriClient, store, spaceManager, spaceStore)
	trustHandler := NewTrustHandler(store, "EOrg123456789TestOrg")

	// Create mux and register routes
	mux := http.NewServeMux()
	credHandler.RegisterRoutes(mux)
	syncHandler.RegisterRoutes(mux)
	trustHandler.RegisterRoutes(mux)

	cleanup := func() {
		store.Close()
		os.RemoveAll(tmpDir)
	}

	return &IntegrationTestEnv{
		store:        store,
		spaceManager: spaceManager,
		spaceStore:   spaceStore,
		keriClient:   keriClient,
		syncHandler:  syncHandler,
		trustHandler: trustHandler,
		credHandler:  credHandler,
		mux:          mux,
		cleanup:      cleanup,
	}
}

// ============================================
// Integration Test: Credential Sync to Anystore
// ============================================

func TestIntegration_CredentialSyncToAnystore(t *testing.T) {
	env := setupIntegrationEnv(t)
	defer env.cleanup()

	// Step 1: Sync a credential via the sync endpoint
	syncBody := `{
		"userAid": "EUSER001",
		"credentials": [
			{
				"said": "ESAID001",
				"issuer": "EOrg123456789TestOrg",
				"recipient": "EUSER001",
				"schema": "EMatouMembershipSchemaV1",
				"data": {
					"communityName": "MATOU",
					"role": "Member",
					"verificationStatus": "unverified",
					"permissions": ["read", "comment"],
					"joinedAt": "2026-01-19T00:00:00Z"
				}
			}
		]
	}`
	syncReq := httptest.NewRequest(http.MethodPost, "/api/v1/sync/credentials", bytes.NewBufferString(syncBody))
	syncReq.Header.Set("Content-Type", "application/json")
	syncW := httptest.NewRecorder()

	env.mux.ServeHTTP(syncW, syncReq)

	if syncW.Code != http.StatusOK {
		t.Fatalf("sync failed: expected %d, got %d: %s", http.StatusOK, syncW.Code, syncW.Body.String())
	}

	// Step 2: Verify credential is stored in anystore cache
	ctx := context.Background()
	cached, err := env.store.GetCredential(ctx, "ESAID001")
	if err != nil {
		t.Fatalf("failed to get credential from cache: %v", err)
	}

	if cached.ID != "ESAID001" {
		t.Errorf("expected credential ID ESAID001, got %s", cached.ID)
	}
	if cached.IssuerAID != "EOrg123456789TestOrg" {
		t.Errorf("expected issuer EOrg123456789TestOrg, got %s", cached.IssuerAID)
	}
	if cached.SubjectAID != "EUSER001" {
		t.Errorf("expected subject EUSER001, got %s", cached.SubjectAID)
	}
	if cached.SchemaID != "EMatouMembershipSchemaV1" {
		t.Errorf("expected schema EMatouMembershipSchemaV1, got %s", cached.SchemaID)
	}
	if !cached.Verified {
		t.Error("expected credential to be verified (org-issued)")
	}

	// Step 3: Verify credential is retrievable via credentials endpoint
	getReq := httptest.NewRequest(http.MethodGet, "/api/v1/credentials/ESAID001", nil)
	getW := httptest.NewRecorder()

	env.mux.ServeHTTP(getW, getReq)

	if getW.Code != http.StatusOK {
		t.Errorf("get credential failed: expected %d, got %d", http.StatusOK, getW.Code)
	}

	var credResp CredentialResponse
	if err := json.NewDecoder(getW.Body).Decode(&credResp); err != nil {
		t.Fatalf("failed to decode credential response: %v", err)
	}

	if credResp.Credential == nil {
		t.Fatal("expected credential in response")
	}
	if credResp.Credential.SAID != "ESAID001" {
		t.Errorf("expected SAID ESAID001, got %s", credResp.Credential.SAID)
	}
}

// ============================================
// Integration Test: Private Credential Routing
// ============================================

func TestIntegration_PrivateCredentialRouting(t *testing.T) {
	env := setupIntegrationEnv(t)
	defer env.cleanup()

	// Sync a private self-claim credential
	syncBody := `{
		"userAid": "EUSER001",
		"credentials": [
			{
				"said": "ESAID_SELFCLAIM001",
				"issuer": "EUSER001",
				"recipient": "EUSER001",
				"schema": "ESelfClaimSchemaV1",
				"data": {
					"communityName": "MATOU",
					"role": "Member",
					"displayName": "Alice Test",
					"bio": "Developer"
				}
			}
		]
	}`
	syncReq := httptest.NewRequest(http.MethodPost, "/api/v1/sync/credentials", bytes.NewBufferString(syncBody))
	syncReq.Header.Set("Content-Type", "application/json")
	syncW := httptest.NewRecorder()

	env.mux.ServeHTTP(syncW, syncReq)

	if syncW.Code != http.StatusOK {
		t.Fatalf("sync failed: %s", syncW.Body.String())
	}

	// Verify private credential does NOT appear in community credentials
	commReq := httptest.NewRequest(http.MethodGet, "/api/v1/community/credentials", nil)
	commW := httptest.NewRecorder()

	env.mux.ServeHTTP(commW, commReq)

	if commW.Code != http.StatusOK {
		t.Fatalf("community credentials failed: %s", commW.Body.String())
	}

	var commResp CommunityCredentialsResponse
	if err := json.NewDecoder(commW.Body).Decode(&commResp); err != nil {
		t.Fatalf("failed to decode community response: %v", err)
	}

	// Self-claim should be filtered out
	for _, cred := range commResp.Credentials {
		if cred.Schema == "ESelfClaimSchemaV1" {
			t.Errorf("self-claim credential should NOT appear in community credentials")
		}
	}
}

// ============================================
// Integration Test: Community Credential Routing
// ============================================

func TestIntegration_CommunityCredentialRouting(t *testing.T) {
	env := setupIntegrationEnv(t)
	defer env.cleanup()

	// Sync a membership credential (community-visible)
	syncBody := `{
		"userAid": "EUSER001",
		"credentials": [
			{
				"said": "ESAID_MEMBERSHIP001",
				"issuer": "EOrg123456789TestOrg",
				"recipient": "EUSER001",
				"schema": "EMatouMembershipSchemaV1",
				"data": {
					"communityName": "MATOU",
					"role": "Member",
					"verificationStatus": "community_verified",
					"permissions": ["read", "comment", "vote"],
					"joinedAt": "2026-01-19T00:00:00Z"
				}
			}
		]
	}`
	syncReq := httptest.NewRequest(http.MethodPost, "/api/v1/sync/credentials", bytes.NewBufferString(syncBody))
	syncReq.Header.Set("Content-Type", "application/json")
	syncW := httptest.NewRecorder()

	env.mux.ServeHTTP(syncW, syncReq)

	if syncW.Code != http.StatusOK {
		t.Fatalf("sync failed: %s", syncW.Body.String())
	}

	var syncResp SyncCredentialsResponse
	if err := json.NewDecoder(syncW.Body).Decode(&syncResp); err != nil {
		t.Fatalf("failed to decode sync response: %v", err)
	}

	// Verify private space was created
	if syncResp.PrivateSpace == "" {
		t.Error("expected private space to be created")
	}

	// Verify community space is returned
	if syncResp.CommunitySpace == "" {
		t.Error("expected community space to be set")
	}

	// Verify credential appears in community credentials
	commReq := httptest.NewRequest(http.MethodGet, "/api/v1/community/credentials", nil)
	commW := httptest.NewRecorder()

	env.mux.ServeHTTP(commW, commReq)

	var commResp CommunityCredentialsResponse
	if err := json.NewDecoder(commW.Body).Decode(&commResp); err != nil {
		t.Fatalf("failed to decode community response: %v", err)
	}

	if commResp.Total != 1 {
		t.Errorf("expected 1 community credential, got %d", commResp.Total)
	}

	// Verify credential appears in community members
	membersReq := httptest.NewRequest(http.MethodGet, "/api/v1/community/members", nil)
	membersW := httptest.NewRecorder()

	env.mux.ServeHTTP(membersW, membersReq)

	var membersResp CommunityMembersResponse
	if err := json.NewDecoder(membersW.Body).Decode(&membersResp); err != nil {
		t.Fatalf("failed to decode members response: %v", err)
	}

	if membersResp.Total != 1 {
		t.Errorf("expected 1 community member, got %d", membersResp.Total)
	}
	if len(membersResp.Members) > 0 && membersResp.Members[0].AID != "EUSER001" {
		t.Errorf("expected member EUSER001, got %s", membersResp.Members[0].AID)
	}
}

// ============================================
// Integration Test: Trust Graph Updates on Sync
// ============================================

func TestIntegration_TrustGraphUpdatesOnSync(t *testing.T) {
	env := setupIntegrationEnv(t)
	defer env.cleanup()

	// Sync multiple credentials
	syncBody := `{
		"userAid": "EUSER001",
		"credentials": [
			{
				"said": "ESAID001",
				"issuer": "EOrg123456789TestOrg",
				"recipient": "EUSER001",
				"schema": "EMatouMembershipSchemaV1",
				"data": {
					"communityName": "MATOU",
					"role": "Member",
					"verificationStatus": "community_verified",
					"permissions": ["read"],
					"joinedAt": "2026-01-20T00:00:00Z"
				}
			},
			{
				"said": "ESAID002",
				"issuer": "EOrg123456789TestOrg",
				"recipient": "EUSER002",
				"schema": "EMatouMembershipSchemaV1",
				"data": {
					"communityName": "MATOU",
					"role": "Verified Member",
					"verificationStatus": "community_verified",
					"permissions": ["read", "vote"],
					"joinedAt": "2026-01-21T00:00:00Z"
				}
			}
		]
	}`
	syncReq := httptest.NewRequest(http.MethodPost, "/api/v1/sync/credentials", bytes.NewBufferString(syncBody))
	syncReq.Header.Set("Content-Type", "application/json")
	syncW := httptest.NewRecorder()

	env.mux.ServeHTTP(syncW, syncReq)

	if syncW.Code != http.StatusOK {
		t.Fatalf("sync failed: %s", syncW.Body.String())
	}

	// Get trust graph
	graphReq := httptest.NewRequest(http.MethodGet, "/api/v1/trust/graph?summary=true", nil)
	graphW := httptest.NewRecorder()

	env.mux.ServeHTTP(graphW, graphReq)

	if graphW.Code != http.StatusOK {
		t.Fatalf("trust graph failed: %s", graphW.Body.String())
	}

	var graphResp GraphResponse
	if err := json.NewDecoder(graphW.Body).Decode(&graphResp); err != nil {
		t.Fatalf("failed to decode graph response: %v", err)
	}

	// Verify graph has nodes
	if graphResp.Graph == nil {
		t.Fatal("expected graph in response")
	}

	// Should have: org + 2 users = 3 nodes
	if graphResp.Graph.NodeCount() < 3 {
		t.Errorf("expected at least 3 nodes, got %d", graphResp.Graph.NodeCount())
	}

	// Should have 2 edges (org -> user1, org -> user2)
	if graphResp.Graph.EdgeCount() < 2 {
		t.Errorf("expected at least 2 edges, got %d", graphResp.Graph.EdgeCount())
	}

	// Verify summary is included
	if graphResp.Summary == nil {
		t.Error("expected summary in response")
	}
	if graphResp.Summary != nil && graphResp.Summary.TotalNodes < 3 {
		t.Errorf("expected at least 3 nodes in summary, got %d", graphResp.Summary.TotalNodes)
	}

	// Verify individual trust score
	scoreReq := httptest.NewRequest(http.MethodGet, "/api/v1/trust/score/EUSER001", nil)
	scoreW := httptest.NewRecorder()

	env.mux.ServeHTTP(scoreW, scoreReq)

	if scoreW.Code != http.StatusOK {
		t.Fatalf("trust score failed: %s", scoreW.Body.String())
	}

	var scoreResp ScoreResponse
	if err := json.NewDecoder(scoreW.Body).Decode(&scoreResp); err != nil {
		t.Fatalf("failed to decode score response: %v", err)
	}

	if scoreResp.Score == nil {
		t.Fatal("expected score in response")
	}
	if scoreResp.Score.AID != "EUSER001" {
		t.Errorf("expected score for EUSER001, got %s", scoreResp.Score.AID)
	}
	// User has 1 incoming credential from org
	if scoreResp.Score.IncomingCredentials != 1 {
		t.Errorf("expected 1 incoming credential, got %d", scoreResp.Score.IncomingCredentials)
	}
}

// ============================================
// Integration Test: Bidirectional Trust Relations
// ============================================

func TestIntegration_BidirectionalTrustRelations(t *testing.T) {
	env := setupIntegrationEnv(t)
	defer env.cleanup()

	// Sync credentials to create bidirectional relationship
	// User1 invites User2, User2 invites User1
	syncBody := `{
		"userAid": "EUSER001",
		"credentials": [
			{
				"said": "ESAID_MEMBERSHIP001",
				"issuer": "EOrg123456789TestOrg",
				"recipient": "EUSER001",
				"schema": "EMatouMembershipSchemaV1",
				"data": {
					"communityName": "MATOU",
					"role": "Member",
					"verificationStatus": "unverified",
					"permissions": ["read"],
					"joinedAt": "2026-01-20T00:00:00Z"
				}
			},
			{
				"said": "ESAID_MEMBERSHIP002",
				"issuer": "EOrg123456789TestOrg",
				"recipient": "EUSER002",
				"schema": "EMatouMembershipSchemaV1",
				"data": {
					"communityName": "MATOU",
					"role": "Member",
					"verificationStatus": "unverified",
					"permissions": ["read"],
					"joinedAt": "2026-01-20T00:00:00Z"
				}
			},
			{
				"said": "ESAID_INVITE001",
				"issuer": "EUSER001",
				"recipient": "EUSER002",
				"schema": "EInvitationSchemaV1",
				"data": {
					"communityName": "MATOU",
					"role": "Member",
					"message": "Join us!"
				}
			},
			{
				"said": "ESAID_INVITE002",
				"issuer": "EUSER002",
				"recipient": "EUSER001",
				"schema": "EInvitationSchemaV1",
				"data": {
					"communityName": "MATOU",
					"role": "Member",
					"message": "Thanks!"
				}
			}
		]
	}`
	syncReq := httptest.NewRequest(http.MethodPost, "/api/v1/sync/credentials", bytes.NewBufferString(syncBody))
	syncReq.Header.Set("Content-Type", "application/json")
	syncW := httptest.NewRecorder()

	env.mux.ServeHTTP(syncW, syncReq)

	if syncW.Code != http.StatusOK {
		t.Fatalf("sync failed: %s", syncW.Body.String())
	}

	// Build trust graph directly to verify bidirectional detection
	ctx := context.Background()
	builder := trust.NewBuilder(env.store, "EOrg123456789TestOrg")
	graph, err := builder.Build(ctx)
	if err != nil {
		t.Fatalf("failed to build trust graph: %v", err)
	}

	// Check for bidirectional relationship between EUSER001 and EUSER002
	hasBidirectional := graph.HasBidirectionalRelation("EUSER001", "EUSER002")
	if !hasBidirectional {
		t.Error("expected bidirectional relationship between EUSER001 and EUSER002")
	}

	// Get trust summary to verify bidirectional count
	summaryReq := httptest.NewRequest(http.MethodGet, "/api/v1/trust/summary", nil)
	summaryW := httptest.NewRecorder()

	env.mux.ServeHTTP(summaryW, summaryReq)

	if summaryW.Code != http.StatusOK {
		t.Fatalf("summary failed: %s", summaryW.Body.String())
	}

	var summary trust.ScoreSummary
	if err := json.NewDecoder(summaryW.Body).Decode(&summary); err != nil {
		t.Fatalf("failed to decode summary: %v", err)
	}

	if summary.BidirectionalCount < 1 {
		t.Errorf("expected at least 1 bidirectional relationship, got %d", summary.BidirectionalCount)
	}
}

// ============================================
// Integration Test: Full Sync Flow
// ============================================

func TestIntegration_FullSyncFlow(t *testing.T) {
	env := setupIntegrationEnv(t)
	defer env.cleanup()

	// Step 1: Sync credentials
	credSyncBody := `{
		"userAid": "EUSER001",
		"credentials": [
			{
				"said": "ESAID001",
				"issuer": "EOrg123456789TestOrg",
				"recipient": "EUSER001",
				"schema": "EMatouMembershipSchemaV1",
				"data": {
					"communityName": "MATOU",
					"role": "Trusted Member",
					"verificationStatus": "community_verified",
					"permissions": ["read", "comment", "vote", "propose"],
					"joinedAt": "2026-01-20T00:00:00Z"
				}
			}
		]
	}`
	credSyncReq := httptest.NewRequest(http.MethodPost, "/api/v1/sync/credentials", bytes.NewBufferString(credSyncBody))
	credSyncReq.Header.Set("Content-Type", "application/json")
	credSyncW := httptest.NewRecorder()

	env.mux.ServeHTTP(credSyncW, credSyncReq)

	if credSyncW.Code != http.StatusOK {
		t.Fatalf("credential sync failed: %s", credSyncW.Body.String())
	}

	var credSyncResp SyncCredentialsResponse
	json.NewDecoder(credSyncW.Body).Decode(&credSyncResp)

	if !credSyncResp.Success {
		t.Errorf("credential sync not successful: %v", credSyncResp.Errors)
	}
	if credSyncResp.Synced != 1 {
		t.Errorf("expected 1 synced, got %d", credSyncResp.Synced)
	}

	// Step 2: Sync KEL
	kelSyncBody := `{
		"userAid": "EUSER001",
		"kel": [
			{
				"type": "icp",
				"sequence": 0,
				"digest": "EDIGEST001",
				"data": {"keys": ["key1", "key2"]},
				"timestamp": "2026-01-20T00:00:00Z"
			},
			{
				"type": "ixn",
				"sequence": 1,
				"digest": "EDIGEST002",
				"data": {"anchor": "ESAID001"},
				"timestamp": "2026-01-20T01:00:00Z"
			}
		]
	}`
	kelSyncReq := httptest.NewRequest(http.MethodPost, "/api/v1/sync/kel", bytes.NewBufferString(kelSyncBody))
	kelSyncReq.Header.Set("Content-Type", "application/json")
	kelSyncW := httptest.NewRecorder()

	env.mux.ServeHTTP(kelSyncW, kelSyncReq)

	if kelSyncW.Code != http.StatusOK {
		t.Fatalf("KEL sync failed: %s", kelSyncW.Body.String())
	}

	var kelSyncResp SyncKELResponse
	json.NewDecoder(kelSyncW.Body).Decode(&kelSyncResp)

	if !kelSyncResp.Success {
		t.Errorf("KEL sync not successful: %s", kelSyncResp.Error)
	}
	if kelSyncResp.EventsStored != 2 {
		t.Errorf("expected 2 events stored, got %d", kelSyncResp.EventsStored)
	}

	// Step 3: Verify trust graph
	graphReq := httptest.NewRequest(http.MethodGet, "/api/v1/trust/graph?summary=true", nil)
	graphW := httptest.NewRecorder()

	env.mux.ServeHTTP(graphW, graphReq)

	if graphW.Code != http.StatusOK {
		t.Fatalf("trust graph failed: %s", graphW.Body.String())
	}

	var graphResp GraphResponse
	json.NewDecoder(graphW.Body).Decode(&graphResp)

	// Verify user is in graph with "Trusted Member" role
	userNode := graphResp.Graph.GetNode("EUSER001")
	if userNode == nil {
		t.Fatal("expected user node in graph")
	}
	if userNode.Role != "Trusted Member" {
		t.Errorf("expected role 'Trusted Member', got '%s'", userNode.Role)
	}

	// Step 4: Verify community members
	membersReq := httptest.NewRequest(http.MethodGet, "/api/v1/community/members", nil)
	membersW := httptest.NewRecorder()

	env.mux.ServeHTTP(membersW, membersReq)

	var membersResp CommunityMembersResponse
	json.NewDecoder(membersW.Body).Decode(&membersResp)

	if membersResp.Total != 1 {
		t.Errorf("expected 1 member, got %d", membersResp.Total)
	}
	if len(membersResp.Members) > 0 {
		if membersResp.Members[0].Role != "Trusted Member" {
			t.Errorf("expected member role 'Trusted Member', got '%s'", membersResp.Members[0].Role)
		}
	}
}

// ============================================
// Integration Test: Space Creation on First Sync
// ============================================

func TestIntegration_SpaceCreationOnFirstSync(t *testing.T) {
	env := setupIntegrationEnv(t)
	defer env.cleanup()

	ctx := context.Background()

	// Verify no spaces exist yet
	spaces, _ := env.spaceStore.ListAllSpaces(ctx)
	if len(spaces) != 0 {
		t.Errorf("expected 0 spaces initially, got %d", len(spaces))
	}

	// Sync credential for new user
	syncBody := `{
		"userAid": "ENEWUSER001",
		"credentials": [
			{
				"said": "ESAID_NEW001",
				"issuer": "EOrg123456789TestOrg",
				"recipient": "ENEWUSER001",
				"schema": "EMatouMembershipSchemaV1",
				"data": {
					"communityName": "MATOU",
					"role": "Member",
					"verificationStatus": "unverified",
					"permissions": ["read"],
					"joinedAt": "2026-01-22T00:00:00Z"
				}
			}
		]
	}`
	syncReq := httptest.NewRequest(http.MethodPost, "/api/v1/sync/credentials", bytes.NewBufferString(syncBody))
	syncReq.Header.Set("Content-Type", "application/json")
	syncW := httptest.NewRecorder()

	env.mux.ServeHTTP(syncW, syncReq)

	if syncW.Code != http.StatusOK {
		t.Fatalf("sync failed: %s", syncW.Body.String())
	}

	var syncResp SyncCredentialsResponse
	json.NewDecoder(syncW.Body).Decode(&syncResp)

	// Verify private space was created
	if syncResp.PrivateSpace == "" {
		t.Error("expected private space to be created")
	}

	// Verify space exists in store
	spaces, err := env.spaceStore.ListAllSpaces(ctx)
	if err != nil {
		t.Fatalf("failed to list spaces: %v", err)
	}

	if len(spaces) != 1 {
		t.Errorf("expected 1 space, got %d", len(spaces))
	}

	if len(spaces) > 0 {
		if spaces[0].OwnerAID != "ENEWUSER001" {
			t.Errorf("expected owner ENEWUSER001, got %s", spaces[0].OwnerAID)
		}
		if spaces[0].SpaceType != "private" {
			t.Errorf("expected private space type, got %s", spaces[0].SpaceType)
		}
	}
}

// ============================================
// Integration Test: Credentials Endpoint Reads from Cache
// ============================================

func TestIntegration_CredentialsEndpointReadsFromCache(t *testing.T) {
	env := setupIntegrationEnv(t)
	defer env.cleanup()

	ctx := context.Background()

	// First store credential directly in cache (bypassing sync endpoint)
	directCred := &anystore.CachedCredential{
		ID:         "EDIRECT001",
		IssuerAID:  "EOrg123456789TestOrg",
		SubjectAID: "EUSER_DIRECT",
		SchemaID:   "EMatouMembershipSchemaV1",
		Data: map[string]interface{}{
			"communityName":      "MATOU",
			"role":               "Expert Member",
			"verificationStatus": "expert_verified",
			"permissions":        []string{"read", "comment", "vote", "propose", "review"},
			"joinedAt":           time.Now().Format(time.RFC3339),
		},
		CachedAt: time.Now().UTC(),
		Verified: true,
	}
	if err := env.store.StoreCredential(ctx, directCred); err != nil {
		t.Fatalf("failed to store credential directly: %v", err)
	}

	// Retrieve via GET endpoint
	getReq := httptest.NewRequest(http.MethodGet, "/api/v1/credentials/EDIRECT001", nil)
	getW := httptest.NewRecorder()

	env.mux.ServeHTTP(getW, getReq)

	if getW.Code != http.StatusOK {
		t.Fatalf("get credential failed: %d - %s", getW.Code, getW.Body.String())
	}

	var credResp CredentialResponse
	if err := json.NewDecoder(getW.Body).Decode(&credResp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if credResp.Credential == nil {
		t.Fatal("expected credential in response")
	}
	if credResp.Credential.SAID != "EDIRECT001" {
		t.Errorf("expected SAID EDIRECT001, got %s", credResp.Credential.SAID)
	}
	if credResp.Credential.Issuer != "EOrg123456789TestOrg" {
		t.Errorf("expected issuer EOrg123456789TestOrg, got %s", credResp.Credential.Issuer)
	}
}

// ============================================
// Integration Test: Mixed Credential Types Routing
// ============================================

func TestIntegration_MixedCredentialTypesRouting(t *testing.T) {
	env := setupIntegrationEnv(t)
	defer env.cleanup()

	// Sync a mix of credential types
	syncBody := `{
		"userAid": "EUSER001",
		"credentials": [
			{
				"said": "ESAID_MEMBERSHIP",
				"issuer": "EOrg123456789TestOrg",
				"recipient": "EUSER001",
				"schema": "EMatouMembershipSchemaV1",
				"data": {
					"communityName": "MATOU",
					"role": "Member",
					"verificationStatus": "unverified",
					"permissions": ["read"],
					"joinedAt": "2026-01-22T00:00:00Z"
				}
			},
			{
				"said": "ESAID_STEWARD",
				"issuer": "EOrg123456789TestOrg",
				"recipient": "EUSER001",
				"schema": "EOperationsStewardSchemaV1",
				"data": {
					"communityName": "MATOU",
					"role": "Operations Steward",
					"permissions": ["admin_keria", "manage_members"],
					"grantedAt": "2026-01-22T00:00:00Z"
				}
			},
			{
				"said": "ESAID_SELFCLAIM",
				"issuer": "EUSER001",
				"recipient": "EUSER001",
				"schema": "ESelfClaimSchemaV1",
				"data": {
					"communityName": "MATOU",
					"role": "Member",
					"displayName": "Alice",
					"bio": "Developer"
				}
			},
			{
				"said": "ESAID_INVITE",
				"issuer": "EUSER001",
				"recipient": "EUSER002",
				"schema": "EInvitationSchemaV1",
				"data": {
					"communityName": "MATOU",
					"role": "Member",
					"message": "Welcome!"
				}
			}
		]
	}`
	syncReq := httptest.NewRequest(http.MethodPost, "/api/v1/sync/credentials", bytes.NewBufferString(syncBody))
	syncReq.Header.Set("Content-Type", "application/json")
	syncW := httptest.NewRecorder()

	env.mux.ServeHTTP(syncW, syncReq)

	if syncW.Code != http.StatusOK {
		t.Fatalf("sync failed: %s", syncW.Body.String())
	}

	var syncResp SyncCredentialsResponse
	json.NewDecoder(syncW.Body).Decode(&syncResp)

	if syncResp.Synced != 4 {
		t.Errorf("expected 4 synced, got %d", syncResp.Synced)
	}

	// Check community credentials - should only have membership and steward
	commReq := httptest.NewRequest(http.MethodGet, "/api/v1/community/credentials", nil)
	commW := httptest.NewRecorder()

	env.mux.ServeHTTP(commW, commReq)

	var commResp CommunityCredentialsResponse
	json.NewDecoder(commW.Body).Decode(&commResp)

	// Should have exactly 2 community-visible credentials
	if commResp.Total != 2 {
		t.Errorf("expected 2 community credentials, got %d", commResp.Total)
	}

	// Verify only community-visible types
	for _, cred := range commResp.Credentials {
		if cred.Schema != "EMatouMembershipSchemaV1" && cred.Schema != "EOperationsStewardSchemaV1" {
			t.Errorf("unexpected schema in community credentials: %s", cred.Schema)
		}
	}
}

// ============================================
// Integration Test: Trust Score Calculation
// ============================================

func TestIntegration_TrustScoreCalculation(t *testing.T) {
	env := setupIntegrationEnv(t)
	defer env.cleanup()

	// Create a chain: Org -> User1 -> User2
	// User1 should have higher score (direct from org)
	syncBody := `{
		"userAid": "EUSER001",
		"credentials": [
			{
				"said": "ESAID001",
				"issuer": "EOrg123456789TestOrg",
				"recipient": "EUSER001",
				"schema": "EMatouMembershipSchemaV1",
				"data": {
					"communityName": "MATOU",
					"role": "Trusted Member",
					"verificationStatus": "community_verified",
					"permissions": ["read", "vote"],
					"joinedAt": "2026-01-20T00:00:00Z"
				}
			},
			{
				"said": "ESAID002",
				"issuer": "EUSER001",
				"recipient": "EUSER002",
				"schema": "EInvitationSchemaV1",
				"data": {
					"communityName": "MATOU",
					"role": "Member",
					"message": "Join via invitation"
				}
			}
		]
	}`
	syncReq := httptest.NewRequest(http.MethodPost, "/api/v1/sync/credentials", bytes.NewBufferString(syncBody))
	syncReq.Header.Set("Content-Type", "application/json")
	syncW := httptest.NewRecorder()

	env.mux.ServeHTTP(syncW, syncReq)

	if syncW.Code != http.StatusOK {
		t.Fatalf("sync failed: %s", syncW.Body.String())
	}

	// Get top scores
	scoresReq := httptest.NewRequest(http.MethodGet, "/api/v1/trust/scores?limit=10", nil)
	scoresW := httptest.NewRecorder()

	env.mux.ServeHTTP(scoresW, scoresReq)

	if scoresW.Code != http.StatusOK {
		t.Fatalf("scores failed: %s", scoresW.Body.String())
	}

	var scoresResp ScoresResponse
	json.NewDecoder(scoresW.Body).Decode(&scoresResp)

	// Should have org + 2 users
	if scoresResp.Total < 2 {
		t.Errorf("expected at least 2 scores, got %d", scoresResp.Total)
	}

	// Find user scores
	var user1Score, user2Score float64
	for _, s := range scoresResp.Scores {
		if s.AID == "EUSER001" {
			user1Score = s.Score
		}
		if s.AID == "EUSER002" {
			user2Score = s.Score
		}
	}

	// User1 (direct from org) should have higher or equal score than User2 (invited)
	// User1 has: org-issued credential (+2 bonus, +1 incoming, +1 unique issuer) = ~5
	// User2 has: user-issued invitation (+1 incoming, +1 unique issuer) = ~3
	if user1Score < user2Score {
		t.Errorf("expected EUSER001 score (%.2f) >= EUSER002 score (%.2f)", user1Score, user2Score)
	}
}

// ============================================
// Integration Test: List All Credentials
// ============================================

func TestIntegration_ListAllCredentials(t *testing.T) {
	env := setupIntegrationEnv(t)
	defer env.cleanup()

	// Sync multiple credentials
	syncBody := `{
		"userAid": "EUSER001",
		"credentials": [
			{
				"said": "ESAID001",
				"issuer": "EOrg123456789TestOrg",
				"recipient": "EUSER001",
				"schema": "EMatouMembershipSchemaV1",
				"data": {
					"communityName": "MATOU",
					"role": "Member",
					"verificationStatus": "unverified",
					"permissions": ["read"],
					"joinedAt": "2026-01-22T00:00:00Z"
				}
			},
			{
				"said": "ESAID002",
				"issuer": "EOrg123456789TestOrg",
				"recipient": "EUSER002",
				"schema": "EMatouMembershipSchemaV1",
				"data": {
					"communityName": "MATOU",
					"role": "Verified Member",
					"verificationStatus": "community_verified",
					"permissions": ["read", "vote"],
					"joinedAt": "2026-01-22T00:00:00Z"
				}
			}
		]
	}`
	syncReq := httptest.NewRequest(http.MethodPost, "/api/v1/sync/credentials", bytes.NewBufferString(syncBody))
	syncReq.Header.Set("Content-Type", "application/json")
	syncW := httptest.NewRecorder()

	env.mux.ServeHTTP(syncW, syncReq)

	if syncW.Code != http.StatusOK {
		t.Fatalf("sync failed: %s", syncW.Body.String())
	}

	// List all credentials via GET /api/v1/credentials
	listReq := httptest.NewRequest(http.MethodGet, "/api/v1/credentials", nil)
	listW := httptest.NewRecorder()

	env.mux.ServeHTTP(listW, listReq)

	if listW.Code != http.StatusOK {
		t.Fatalf("list credentials failed: %d - %s", listW.Code, listW.Body.String())
	}

	var listResp ListResponse
	if err := json.NewDecoder(listW.Body).Decode(&listResp); err != nil {
		t.Fatalf("failed to decode list response: %v", err)
	}

	if listResp.Total != 2 {
		t.Errorf("expected 2 credentials, got %d", listResp.Total)
	}
	if len(listResp.Credentials) != 2 {
		t.Errorf("expected 2 credentials in array, got %d", len(listResp.Credentials))
	}
}
