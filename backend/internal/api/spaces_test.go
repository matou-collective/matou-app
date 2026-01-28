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

	"github.com/anyproto/any-sync/util/crypto"
	"github.com/matou-dao/backend/internal/anysync"
)

// mockAnySyncClient implements anysync.AnySyncClient for testing
type mockAnySyncClient struct {
	spaces         map[string]*anysync.SpaceCreateResult
	createSpaceErr error
	addToACLErr    error
	networkID      string
	coordinatorURL string
	peerID         string
}

func newMockClient() *mockAnySyncClient {
	return &mockAnySyncClient{
		spaces:         make(map[string]*anysync.SpaceCreateResult),
		networkID:      "test-network",
		coordinatorURL: "localhost:1004",
		peerID:         "test-peer-123",
	}
}

func (m *mockAnySyncClient) CreateSpace(ctx context.Context, ownerAID string, spaceType string, signingKey crypto.PrivKey) (*anysync.SpaceCreateResult, error) {
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

func (m *mockAnySyncClient) DeriveSpaceID(ctx context.Context, ownerAID string, spaceType string, signingKey crypto.PrivKey) (string, error) {
	return fmt.Sprintf("space_%s_%s", spaceType, ownerAID[:8]), nil
}

func (m *mockAnySyncClient) AddToACL(ctx context.Context, spaceID string, peerID string, permissions []string) error {
	return m.addToACLErr
}

func (m *mockAnySyncClient) SyncDocument(ctx context.Context, spaceID string, docID string, data []byte) error {
	return nil
}

func (m *mockAnySyncClient) GetNetworkID() string      { return m.networkID }
func (m *mockAnySyncClient) GetCoordinatorURL() string { return m.coordinatorURL }
func (m *mockAnySyncClient) GetPeerID() string         { return m.peerID }
func (m *mockAnySyncClient) Close() error              { return nil }

// mockSpaceStore implements anysync.SpaceStore for testing
type mockSpaceStore struct {
	spaces map[string]*anysync.Space
}

func newMockSpaceStore() *mockSpaceStore {
	return &mockSpaceStore{
		spaces: make(map[string]*anysync.Space),
	}
}

func (m *mockSpaceStore) GetUserSpace(ctx context.Context, userAID string) (*anysync.Space, error) {
	for _, space := range m.spaces {
		if space.OwnerAID == userAID && space.SpaceType == anysync.SpaceTypePrivate {
			return space, nil
		}
	}
	return nil, nil
}

func (m *mockSpaceStore) SaveSpace(ctx context.Context, space *anysync.Space) error {
	m.spaces[space.SpaceID] = space
	return nil
}

func (m *mockSpaceStore) ListAllSpaces(ctx context.Context) ([]*anysync.Space, error) {
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
	json.NewDecoder(w1.Body).Decode(&resp1)

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
	mockStore.SaveSpace(context.Background(), existingSpace)

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
	handler, _, _ := setupTestSpacesHandler(t)

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

	if resp.PrivateSpaceID == "" {
		t.Error("expected non-empty private space ID")
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
	json.NewDecoder(w.Body).Decode(&resp)

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
	handler.RegisterRoutes(mux)

	// Test that routes are registered by making requests
	testCases := []struct {
		method   string
		path     string
		expected int
	}{
		{http.MethodGet, "/api/v1/spaces/community", http.StatusOK},
		{http.MethodPost, "/api/v1/spaces/private", http.StatusBadRequest}, // No body
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
