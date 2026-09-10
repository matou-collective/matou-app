package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/anyproto/any-sync/commonspace"
	"github.com/anyproto/any-sync/commonspace/acl/aclclient/mock_aclclient"
	"github.com/anyproto/any-sync/commonspace/mock_commonspace"
	"github.com/anyproto/any-sync/commonspace/object/acl/aclrecordproto"
	"github.com/anyproto/any-sync/commonspace/object/acl/list"
	"github.com/anyproto/any-sync/commonspace/object/acl/syncacl/mock_syncacl"
	"github.com/anyproto/any-sync/consensus/consensusproto"
	"github.com/anyproto/any-sync/net/pool"
	"github.com/anyproto/any-sync/nodeconf"
	"github.com/anyproto/any-sync/util/crypto"
	"github.com/matou-dao/backend/internal/anysync"
	"go.uber.org/mock/gomock"
)

// mockAnySyncClient implements anysync.AnySyncClient for testing
type mockAnySyncClient struct {
	spaces         map[string]*anysync.SpaceCreateResult
	createSpaceErr error
	addToACLErr    error
	networkID      string
	coordinatorURL string
	peerID         string
	space          commonspace.Space // optional: returned by GetSpace when set
}

func newMockClient() *mockAnySyncClient {
	return &mockAnySyncClient{
		spaces:         make(map[string]*anysync.SpaceCreateResult),
		networkID:      "test-network",
		coordinatorURL: "localhost:1004",
		peerID:         "test-peer-123",
	}
}

func (m *mockAnySyncClient) CreateSpace(_ context.Context, ownerAID string, spaceType string, _ crypto.PrivKey) (*anysync.SpaceCreateResult, error) {
	if m.createSpaceErr != nil {
		return nil, m.createSpaceErr
	}
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

func (m *mockAnySyncClient) DeriveSpace(ctx context.Context, ownerAID string, spaceType string, signingKey crypto.PrivKey) (*anysync.SpaceCreateResult, error) {
	return m.CreateSpace(ctx, ownerAID, spaceType, signingKey)
}

func (m *mockAnySyncClient) DeriveSpaceID(_ context.Context, ownerAID string, spaceType string, _ crypto.PrivKey) (string, error) {
	return fmt.Sprintf("space_%s_%s", spaceType, ownerAID[:8]), nil
}

func (m *mockAnySyncClient) AddToACL(_ context.Context, _ string, _ string, _ []string) error {
	return m.addToACLErr
}

func (m *mockAnySyncClient) SyncDocument(_ context.Context, _ string, _ string, _ []byte) error {
	return nil
}

func (m *mockAnySyncClient) GetNetworkID() string          { return m.networkID }
func (m *mockAnySyncClient) GetCoordinatorURL() string     { return m.coordinatorURL }
func (m *mockAnySyncClient) GetPeerID() string             { return m.peerID }
func (m *mockAnySyncClient) GetDataDir() string            { return "" }
func (m *mockAnySyncClient) GetSigningKey() crypto.PrivKey { return nil }
func (m *mockAnySyncClient) GetPool() pool.Pool            { return nil }
func (m *mockAnySyncClient) GetNodeConf() nodeconf.Service { return nil }
func (m *mockAnySyncClient) SetAccountFileLimits(_ context.Context, _ string, _ uint64) error {
	return nil
}
func (m *mockAnySyncClient) Ping() error  { return nil }
func (m *mockAnySyncClient) Close() error { return nil }

func (m *mockAnySyncClient) CreateSpaceWithKeys(ctx context.Context, ownerAID string, spaceType string, _ *anysync.SpaceKeySet) (*anysync.SpaceCreateResult, error) {
	return m.CreateSpace(ctx, ownerAID, spaceType, nil)
}

func (m *mockAnySyncClient) GetSpace(_ context.Context, _ string) (commonspace.Space, error) {
	if m.space != nil {
		return m.space, nil
	}
	return nil, fmt.Errorf("mock: GetSpace not supported")
}

func (m *mockAnySyncClient) MakeSpaceShareable(_ context.Context, _ string) error {
	return nil
}

// testACLRecordBuilder implements list.AclRecordBuilder for testing invite flow
type testACLRecordBuilder struct {
	buildInviteAnyoneResult list.InviteResult
	buildInviteAnyoneErr    error
}

func (m *testACLRecordBuilder) UnmarshallWithId(_ *consensusproto.RawRecordWithId) (*list.AclRecord, error) { //nolint:revive // method name fixed by list.AclRecordBuilder interface
	return nil, fmt.Errorf("not implemented")
}
func (m *testACLRecordBuilder) Unmarshall(_ *consensusproto.RawRecord) (*list.AclRecord, error) {
	return nil, fmt.Errorf("not implemented")
}
func (m *testACLRecordBuilder) BuildRoot(_ list.RootContent) (*consensusproto.RawRecordWithId, error) {
	return nil, fmt.Errorf("not implemented")
}
func (m *testACLRecordBuilder) BuildOneToOneRoot(_ list.RootContent, _ *aclrecordproto.AclOneToOneInfo) (*consensusproto.RawRecordWithId, error) {
	return nil, fmt.Errorf("not implemented")
}
func (m *testACLRecordBuilder) BuildBatchRequest(_ list.BatchRequestPayload) (list.BatchResult, error) {
	return list.BatchResult{}, fmt.Errorf("not implemented")
}
func (m *testACLRecordBuilder) BuildInvite() (list.InviteResult, error) {
	return list.InviteResult{}, fmt.Errorf("not implemented")
}
func (m *testACLRecordBuilder) BuildInviteAnyone(_ list.AclPermissions) (list.InviteResult, error) {
	return m.buildInviteAnyoneResult, m.buildInviteAnyoneErr
}
func (m *testACLRecordBuilder) BuildInviteChange(_ list.InviteChangePayload) (*consensusproto.RawRecord, error) {
	return nil, fmt.Errorf("not implemented")
}
func (m *testACLRecordBuilder) BuildInviteRevoke(_ string) (*consensusproto.RawRecord, error) {
	return nil, fmt.Errorf("not implemented")
}
func (m *testACLRecordBuilder) BuildInviteJoinWithoutApprove(_ list.InviteJoinPayload) (*consensusproto.RawRecord, error) {
	return nil, fmt.Errorf("not implemented")
}
func (m *testACLRecordBuilder) BuildRequestJoin(_ list.RequestJoinPayload) (*consensusproto.RawRecord, error) {
	return nil, fmt.Errorf("not implemented")
}
func (m *testACLRecordBuilder) BuildRequestAccept(_ list.RequestAcceptPayload) (*consensusproto.RawRecord, error) {
	return nil, fmt.Errorf("not implemented")
}
func (m *testACLRecordBuilder) BuildRequestDecline(_ string) (*consensusproto.RawRecord, error) {
	return nil, fmt.Errorf("not implemented")
}
func (m *testACLRecordBuilder) BuildRequestCancel(_ string) (*consensusproto.RawRecord, error) {
	return nil, fmt.Errorf("not implemented")
}
func (m *testACLRecordBuilder) BuildRequestRemove() (*consensusproto.RawRecord, error) {
	return nil, fmt.Errorf("not implemented")
}
func (m *testACLRecordBuilder) BuildPermissionChange(_ list.PermissionChangePayload) (*consensusproto.RawRecord, error) {
	return nil, fmt.Errorf("not implemented")
}
func (m *testACLRecordBuilder) BuildPermissionChanges(_ list.PermissionChangesPayload) (*consensusproto.RawRecord, error) {
	return nil, fmt.Errorf("not implemented")
}
func (m *testACLRecordBuilder) BuildOwnershipChange(_ list.OwnershipChangePayload) (*consensusproto.RawRecord, error) {
	return nil, fmt.Errorf("not implemented")
}
func (m *testACLRecordBuilder) BuildReadKeyChange(_ list.ReadKeyChangePayload) (*consensusproto.RawRecord, error) {
	return nil, fmt.Errorf("not implemented")
}
func (m *testACLRecordBuilder) BuildAccountRemove(_ list.AccountRemovePayload) (*consensusproto.RawRecord, error) {
	return nil, fmt.Errorf("not implemented")
}
func (m *testACLRecordBuilder) BuildAccountsAdd(_ list.AccountsAddPayload) (*consensusproto.RawRecord, error) {
	return nil, fmt.Errorf("not implemented")
}

// setupMockSpaceForInvite creates a gomock Space with the full ACL mock chain
// needed by MatouACLManager.CreateOpenInvite
func setupMockSpaceForInvite(t *testing.T) commonspace.Space {
	t.Helper()
	ctrl := gomock.NewController(t)

	inviteKey, _, err := crypto.GenerateRandomEd25519KeyPair()
	if err != nil {
		t.Fatalf("generating test key: %v", err)
	}

	inviteRec := &consensusproto.RawRecord{Payload: []byte("test-invite-record")}
	builder := &testACLRecordBuilder{
		buildInviteAnyoneResult: list.InviteResult{
			InviteRec: inviteRec,
			InviteKey: inviteKey,
		},
	}

	mockSpace := mock_commonspace.NewMockSpace(ctrl)
	mockACL := mock_syncacl.NewMockSyncAcl(ctrl)
	mockACLClient := mock_aclclient.NewMockAclSpaceClient(ctrl)

	mockSpace.EXPECT().Acl().Return(mockACL)
	mockACL.EXPECT().Lock()
	mockACL.EXPECT().Unlock()
	mockACL.EXPECT().RecordBuilder().Return(builder)
	mockSpace.EXPECT().AclClient().Return(mockACLClient)
	mockACLClient.EXPECT().AddRecord(gomock.Any(), inviteRec).Return(nil)

	return mockSpace
}

// mockSpaceStore implements anysync.SpaceStore for testing
type mockSpaceStore struct {
	spaces map[string]*anysync.Space
}

func newMockSpaceStore() *mockSpaceStore {
	return &mockSpaceStore{
		spaces: make(map[string]*anysync.Space),
	}
}

func (m *mockSpaceStore) GetUserSpace(_ context.Context, userAID string) (*anysync.Space, error) {
	for _, space := range m.spaces {
		if space.OwnerAID == userAID && space.SpaceType == anysync.SpaceTypePrivate {
			return space, nil
		}
	}
	return nil, nil
}

func (m *mockSpaceStore) SaveSpace(_ context.Context, space *anysync.Space) error {
	m.spaces[space.SpaceID] = space
	return nil
}

func (m *mockSpaceStore) ListAllSpaces(_ context.Context) ([]*anysync.Space, error) {
	spaces := make([]*anysync.Space, 0, len(m.spaces))
	for _, space := range m.spaces {
		spaces = append(spaces, space)
	}
	return spaces, nil
}

func setupTestSpacesHandler(t *testing.T) (*SpacesHandler, *mockAnySyncClient, *mockSpaceStore) {
	t.Helper()

	mockClient := newMockClient()
	mockStore := newMockSpaceStore()
	spaceManager := anysync.NewSpaceManager(mockClient, &anysync.SpaceManagerConfig{
		CommunitySpaceID: "test-community-space",
		OrgAID:           "EORG123456789",
	})

	handler := &SpacesHandler{
		spaceManager: spaceManager,
		spaceStore:   mockStore,
	}

	return handler, mockClient, mockStore
}

// grantStewardHandler wires a SpacesHandler over a SpaceManager whose client is
// the given mock, with both the community and community-readonly spaces
// configured, so HandleGrantStewardAdmin exercises the AID lookup path.
func grantStewardHandler(client *mockAnySyncClient) *SpacesHandler {
	spaceManager := anysync.NewSpaceManager(client, &anysync.SpaceManagerConfig{
		CommunitySpaceID:         "cs",
		CommunityReadOnlySpaceID: "ro",
	})
	return &SpacesHandler{spaceManager: spaceManager}
}

func callGrantStewardAdmin(h *SpacesHandler, aid string) *httptest.ResponseRecorder {
	body, _ := json.Marshal(GrantStewardAdminRequest{StewardAID: aid})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/spaces/grant-steward-admin", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.HandleGrantStewardAdmin(w, req)
	return w
}

// TestHandleGrantStewardAdmin_TransportFaultIs500 confirms a state/transport
// fault from the AID lookup surfaces as 500, not a 404 "unknown steward" — the
// outer lookup no longer collapses every error to a miss (#481).
func TestHandleGrantStewardAdmin_TransportFaultIs500(t *testing.T) {
	// space == nil makes GetSpace return a transport-style error, which does not
	// wrap ErrAccountNotFoundForAID.
	h := grantStewardHandler(newMockClient())

	w := callGrantStewardAdmin(h, "ESteward")
	if w.Code != http.StatusInternalServerError {
		t.Errorf("transport fault: expected 500, got %d: %s", w.Code, w.Body.String())
	}
}

// TestHandleGrantStewardAdmin_GenuineMissIs404 confirms a real "AID absent from
// the ACL" miss still reports 404 (#481).
func TestHandleGrantStewardAdmin_GenuineMissIs404(t *testing.T) {
	// Build a real ACL holding only the owner, whose metadata carries no AID, so
	// any steward lookup is a genuine ErrAccountNotFoundForAID miss.
	exec := list.NewAclExecutor("cs")
	if err := exec.Execute("a.init::a"); err != nil {
		t.Fatalf("building ACL: %v", err)
	}
	state := exec.ActualAccounts()["a"].Acl.AclState()

	ctrl := gomock.NewController(t)
	mockSpace := mock_commonspace.NewMockSpace(ctrl)
	mockACL := mock_syncacl.NewMockSyncAcl(ctrl)
	mockSpace.EXPECT().Acl().Return(mockACL)
	mockACL.EXPECT().RLock()
	mockACL.EXPECT().RUnlock()
	mockACL.EXPECT().AclState().Return(state)

	client := newMockClient()
	client.space = mockSpace
	h := grantStewardHandler(client)

	w := callGrantStewardAdmin(h, "ENoSuchSteward")
	if w.Code != http.StatusNotFound {
		t.Errorf("genuine miss: expected 404, got %d: %s", w.Code, w.Body.String())
	}
}

func TestHandleCreateCommunity_Success(t *testing.T) {
	handler, _, _ := setupTestSpacesHandler(t)

	reqBody := CreateCommunityRequest{
		OrgAID:  "EORG123456789",
		OrgName: "Test Org",
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/spaces/community", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	handler.HandleCreateCommunity(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", w.Code)
	}

	var resp CreateCommunityResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if !resp.Success {
		t.Errorf("expected success=true, got error: %s", resp.Error)
	}

	if resp.SpaceID == "" {
		t.Error("expected non-empty space ID")
	}
}

func TestHandleCreateCommunity_MissingOrgAID(t *testing.T) {
	handler, _, _ := setupTestSpacesHandler(t)

	reqBody := CreateCommunityRequest{
		OrgAID:  "",
		OrgName: "Test Org",
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/spaces/community", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	handler.HandleCreateCommunity(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected status 400, got %d", w.Code)
	}

	var resp CreateCommunityResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp.Success {
		t.Error("expected success=false")
	}

	if resp.Error == "" {
		t.Error("expected error message")
	}
}

func TestHandleCreateCommunity_Idempotent(t *testing.T) {
	handler, _, _ := setupTestSpacesHandler(t)

	reqBody := CreateCommunityRequest{
		OrgAID:  "EORG123456789",
		OrgName: "Test Org",
	}
	body, _ := json.Marshal(reqBody)

	// First request
	req1 := httptest.NewRequest(http.MethodPost, "/api/v1/spaces/community", bytes.NewBuffer(body))
	req1.Header.Set("Content-Type", "application/json")
	w1 := httptest.NewRecorder()
	handler.HandleCreateCommunity(w1, req1)

	// Get the existing space ID from response
	var resp1 CreateCommunityResponse
	_ = json.NewDecoder(w1.Body).Decode(&resp1)

	// Since community space was already configured in setup, returns existing
	if w1.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", w1.Code)
	}
}

func TestHandleCreateCommunity_MethodNotAllowed(t *testing.T) {
	handler, _, _ := setupTestSpacesHandler(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/spaces/community", nil)
	w := httptest.NewRecorder()

	handler.HandleCreateCommunity(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected status 405, got %d", w.Code)
	}
}

func TestHandleGetCommunity_Exists(t *testing.T) {
	handler, _, _ := setupTestSpacesHandler(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/spaces/community", nil)
	w := httptest.NewRecorder()

	handler.HandleGetCommunity(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", w.Code)
	}

	var resp GetCommunityResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp.SpaceID == "" {
		t.Error("expected non-empty space ID")
	}
}

func TestHandleGetCommunity_NotConfigured(t *testing.T) {
	mockClient := newMockClient()
	mockStore := newMockSpaceStore()
	spaceManager := anysync.NewSpaceManager(mockClient, &anysync.SpaceManagerConfig{
		CommunitySpaceID: "", // Not configured
		OrgAID:           "EORG123456789",
	})

	handler := &SpacesHandler{
		spaceManager: spaceManager,
		spaceStore:   mockStore,
	}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/spaces/community", nil)
	w := httptest.NewRecorder()

	handler.HandleGetCommunity(w, req)

	if w.Code != http.StatusNotFound {
		t.Errorf("expected status 404, got %d", w.Code)
	}
}

func TestHandleCreatePrivate_Success(t *testing.T) {
	handler, _, _ := setupTestSpacesHandler(t)

	reqBody := CreatePrivateRequest{
		UserAID: "EUSER123456789",
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/spaces/private", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	handler.HandleCreatePrivate(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", w.Code)
	}

	var resp CreatePrivateResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if !resp.Success {
		t.Errorf("expected success=true, got error: %s", resp.Error)
	}

	if resp.SpaceID == "" {
		t.Error("expected non-empty space ID")
	}

	if !resp.Created {
		t.Error("expected created=true for new space")
	}
}

func TestHandleCreatePrivate_MissingUserAID(t *testing.T) {
	handler, _, _ := setupTestSpacesHandler(t)

	reqBody := CreatePrivateRequest{
		UserAID: "",
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/spaces/private", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	handler.HandleCreatePrivate(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected status 400, got %d", w.Code)
	}

	var resp CreatePrivateResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp.Success {
		t.Error("expected success=false")
	}
}

func TestHandleCreatePrivate_Idempotent(t *testing.T) {
	handler, _, mockStore := setupTestSpacesHandler(t)

	userAID := "EUSER123456789"

	// Pre-create a space in the store
	existingSpace := &anysync.Space{
		SpaceID:   "existing-space-id",
		OwnerAID:  userAID,
		SpaceType: anysync.SpaceTypePrivate,
		SpaceName: "Existing Space",
		CreatedAt: time.Now(),
	}
	_ = mockStore.SaveSpace(context.Background(), existingSpace)

	reqBody := CreatePrivateRequest{
		UserAID: userAID,
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/spaces/private", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	handler.HandleCreatePrivate(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", w.Code)
	}

	var resp CreatePrivateResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if !resp.Success {
		t.Errorf("expected success=true")
	}

	if resp.SpaceID != "existing-space-id" {
		t.Errorf("expected existing-space-id, got %s", resp.SpaceID)
	}

	if resp.Created {
		t.Error("expected created=false for existing space")
	}
}

func TestHandleInvite_Success(t *testing.T) {
	handler, mockClient, _ := setupTestSpacesHandler(t)
	mockClient.space = setupMockSpaceForInvite(t)

	reqBody := InviteRequest{
		RecipientAID:   "EUSER123456789",
		CredentialSAID: "ESAID123456789",
		Schema:         "EMatouMembershipSchemaV1",
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/spaces/community/invite", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	handler.HandleInvite(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", w.Code)
	}

	var resp InviteResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if !resp.Success {
		t.Errorf("expected success=true, got error: %s", resp.Error)
	}

	if resp.CommunitySpaceID == "" {
		t.Error("expected non-empty community space ID")
	}

}

func TestHandleInvite_MissingRecipientAID(t *testing.T) {
	handler, _, _ := setupTestSpacesHandler(t)

	reqBody := InviteRequest{
		RecipientAID:   "",
		CredentialSAID: "ESAID123456789",
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/spaces/community/invite", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	handler.HandleInvite(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected status 400, got %d", w.Code)
	}
}

func TestHandleInvite_MissingCredentialSAID(t *testing.T) {
	handler, _, _ := setupTestSpacesHandler(t)

	reqBody := InviteRequest{
		RecipientAID:   "EUSER123456789",
		CredentialSAID: "",
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/spaces/community/invite", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	handler.HandleInvite(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected status 400, got %d", w.Code)
	}
}

func TestHandleInvite_InvalidSchema(t *testing.T) {
	handler, _, _ := setupTestSpacesHandler(t)

	reqBody := InviteRequest{
		RecipientAID:   "EUSER123456789",
		CredentialSAID: "ESAID123456789",
		Schema:         "ESomeOtherSchema",
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/spaces/community/invite", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	handler.HandleInvite(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected status 400, got %d", w.Code)
	}

	var resp InviteResponse
	_ = json.NewDecoder(w.Body).Decode(&resp)

	if resp.Success {
		t.Error("expected success=false")
	}
}

func TestHandleInvite_NoCommunitySpace(t *testing.T) {
	mockClient := newMockClient()
	mockStore := newMockSpaceStore()
	spaceManager := anysync.NewSpaceManager(mockClient, &anysync.SpaceManagerConfig{
		CommunitySpaceID: "", // Not configured
		OrgAID:           "EORG123456789",
	})

	handler := &SpacesHandler{
		spaceManager: spaceManager,
		spaceStore:   mockStore,
	}

	reqBody := InviteRequest{
		RecipientAID:   "EUSER123456789",
		CredentialSAID: "ESAID123456789",
		Schema:         "EMatouMembershipSchemaV1",
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/spaces/community/invite", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	handler.HandleInvite(w, req)

	if w.Code != http.StatusConflict {
		t.Errorf("expected status 409, got %d", w.Code)
	}
}

func TestHandleCommunitySpace_RoutesByMethod(t *testing.T) {
	handler, _, _ := setupTestSpacesHandler(t)

	// Test GET
	req := httptest.NewRequest(http.MethodGet, "/api/v1/spaces/community", nil)
	w := httptest.NewRecorder()
	handler.handleCommunitySpace(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("GET: expected status 200, got %d", w.Code)
	}

	// Test POST
	reqBody := CreateCommunityRequest{OrgAID: "EORG123456789", OrgName: "Test"}
	body, _ := json.Marshal(reqBody)
	req = httptest.NewRequest(http.MethodPost, "/api/v1/spaces/community", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	handler.handleCommunitySpace(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("POST: expected status 200, got %d", w.Code)
	}

	// Test unsupported method
	req = httptest.NewRequest(http.MethodPut, "/api/v1/spaces/community", nil)
	w = httptest.NewRecorder()
	handler.handleCommunitySpace(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("PUT: expected status 405, got %d", w.Code)
	}
}

func TestSpacesHandler_RegisterRoutes(t *testing.T) {
	handler, _, _ := setupTestSpacesHandler(t)

	mux := http.NewServeMux()
	handler.RegisterRoutes(mux, nil)

	// Test that routes are registered by making requests
	testCases := []struct {
		method   string
		path     string
		expected int
	}{
		{http.MethodGet, "/api/v1/spaces/community", http.StatusOK},
		{http.MethodPost, "/api/v1/spaces/private", http.StatusBadRequest},          // No body
		{http.MethodPost, "/api/v1/spaces/community/invite", http.StatusBadRequest}, // No body
	}

	for _, tc := range testCases {
		req := httptest.NewRequest(tc.method, tc.path, nil)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)

		// Just check that routes are registered (not 404)
		if w.Code == http.StatusNotFound {
			t.Errorf("%s %s: route not found", tc.method, tc.path)
		}
	}
}

func TestCreateCommunityRequest(t *testing.T) {
	req := CreateCommunityRequest{
		OrgAID:  "EORG123",
		OrgName: "Test Organization",
	}

	if req.OrgAID != "EORG123" {
		t.Errorf("OrgAID mismatch")
	}
	if req.OrgName != "Test Organization" {
		t.Errorf("OrgName mismatch")
	}
}

func TestCreatePrivateRequest(t *testing.T) {
	req := CreatePrivateRequest{
		UserAID: "EUSER123",
	}

	if req.UserAID != "EUSER123" {
		t.Errorf("UserAID mismatch")
	}
}

func TestInviteRequest(t *testing.T) {
	req := InviteRequest{
		RecipientAID:   "EUSER123",
		CredentialSAID: "ESAID456",
		Schema:         "EMatouMembershipSchemaV1",
	}

	if req.RecipientAID != "EUSER123" {
		t.Errorf("RecipientAID mismatch")
	}
	if req.CredentialSAID != "ESAID456" {
		t.Errorf("CredentialSAID mismatch")
	}
	if req.Schema != "EMatouMembershipSchemaV1" {
		t.Errorf("Schema mismatch")
	}
}

// spaceAccessState (#469 slice S2, spec §3.6) had zero test coverage. This
// pins the "pending" mapping — the state a linked/recovered device reports
// while its read key hasn't arrived from ACL yet — against the plumbing that
// actually calls SpaceManager.SpaceReadKeyReady, not just the lower-level
// function in package anysync. The mock client's default GetSpace errors, so
// this is the "space open but no read key" / "space not yet reachable" case;
// the "ok" case needs a real ACL with a delivered read key (out of scope for
// a unit test, per the PR's own "needs live verification" note).
func TestSpaceAccessState_PendingWhenSpaceUnreachable(t *testing.T) {
	handler, _, _ := setupTestSpacesHandler(t)

	got := handler.spaceAccessState(context.Background(), "space-1")
	if got != anysync.SpaceAccessPending {
		t.Errorf("spaceAccessState = %q, want %q (SpaceReadKeyReady must default to pending, never ok, on a GetSpace error)", got, anysync.SpaceAccessPending)
	}
}
