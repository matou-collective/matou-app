package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"

	"github.com/anyproto/any-sync/commonspace/object/tree/objecttree"
	"github.com/anyproto/any-sync/commonspace/object/tree/objecttree/mock_objecttree"
	"github.com/anyproto/any-sync/util/crypto"
	"github.com/matou-dao/backend/internal/anysync"
	"github.com/matou-dao/backend/internal/identity"
	"go.uber.org/mock/gomock"
)

// chatTestEnv holds the test environment for chat handler tests.
type chatTestEnv struct {
	tmpDir       string
	spaceManager *anysync.SpaceManager
	userIdentity *identity.UserIdentity
	eventBroker  *EventBroker
	chatHandler  *ChatHandler
	mux          *http.ServeMux
	cleanup      func()
}

// mockAnySyncClientForChat extends the integration mock with a configurable DataDir.
type mockAnySyncClientForChat struct {
	mockAnySyncClientForIntegration
	dataDir string
}

func (m *mockAnySyncClientForChat) GetDataDir() string { return m.dataDir }

// statefulMockTree wraps a gomock MockObjectTree with an in-memory change store.
// AddContent appends to the store; IterateRoot iterates over it.
type statefulMockTree struct {
	mu      sync.Mutex
	changes []storedChange
	headSeq int
}

type storedChange struct {
	data     []byte
	dataType string
}

func setupStatefulMock(ctrl *gomock.Controller, state *statefulMockTree) *mock_objecttree.MockObjectTree {
	mockTree := mock_objecttree.NewMockObjectTree(ctrl)

	mockTree.EXPECT().Lock().AnyTimes()
	mockTree.EXPECT().Unlock().AnyTimes()

	mockTree.EXPECT().AddContent(gomock.Any(), gomock.Any()).DoAndReturn(
		func(_ interface{}, content objecttree.SignableChangeContent) (objecttree.AddResult, error) {
			state.mu.Lock()
			defer state.mu.Unlock()

			state.headSeq++
			headID := fmt.Sprintf("head-%d", state.headSeq)
			state.changes = append(state.changes, storedChange{
				data:     content.Data,
				dataType: content.DataType,
			})
			return objecttree.AddResult{
				Heads: []string{headID},
			}, nil
		},
	).AnyTimes()

	mockTree.EXPECT().IterateRoot(gomock.Any(), gomock.Any()).DoAndReturn(
		func(convert objecttree.ChangeConvertFunc, iterate objecttree.ChangeIterateFunc) error {
			state.mu.Lock()
			snapshot := make([]storedChange, len(state.changes))
			copy(snapshot, state.changes)
			state.mu.Unlock()

			for i, sc := range snapshot {
				change := &objecttree.Change{
					Id:       fmt.Sprintf("change-%d", i+1),
					Data:     sc.data,
					DataType: sc.dataType,
				}
				model, err := convert(change, change.Data)
				if err != nil {
					return err
				}
				change.Model = model
				if !iterate(change) {
					break
				}
			}
			return nil
		},
	).AnyTimes()

	return mockTree
}

func setupChatTestEnv(t *testing.T) *chatTestEnv {
	t.Helper()

	ctrl := gomock.NewController(t)

	tmpDir, err := os.MkdirTemp("", "chat_test")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}

	communitySpaceID := "space-community-chat-test"
	roSpaceID := "space-community-ro-chat-test"

	// Generate and persist key sets for both spaces
	communityKeys, err := anysync.GenerateSpaceKeySet()
	if err != nil {
		os.RemoveAll(tmpDir)
		t.Fatalf("generating community keys: %v", err)
	}
	if err := anysync.PersistSpaceKeySet(tmpDir, communitySpaceID, communityKeys); err != nil {
		os.RemoveAll(tmpDir)
		t.Fatalf("persisting community keys: %v", err)
	}

	roKeys, err := anysync.GenerateSpaceKeySet()
	if err != nil {
		os.RemoveAll(tmpDir)
		t.Fatalf("generating readonly keys: %v", err)
	}
	if err := anysync.PersistSpaceKeySet(tmpDir, roSpaceID, roKeys); err != nil {
		os.RemoveAll(tmpDir)
		t.Fatalf("persisting readonly keys: %v", err)
	}

	// Create mock client with DataDir pointing to tmpDir
	anysyncClient := &mockAnySyncClientForChat{
		mockAnySyncClientForIntegration: mockAnySyncClientForIntegration{
			spaces: make(map[string]*anysync.SpaceCreateResult),
		},
		dataDir: tmpDir,
	}

	// Create space manager
	spaceManager := anysync.NewSpaceManager(anysyncClient, &anysync.SpaceManagerConfig{
		CommunitySpaceID:         communitySpaceID,
		CommunityReadOnlySpaceID: roSpaceID,
		OrgAID:                   "EOrg_ChatTest",
	})

	// Register test tree factories — each object gets a fresh mock tree.
	// The factory is called by CreateObjectTree when getSpace fails (test mode).
	treeSeq := 0
	utm := spaceManager.TreeManager()
	makeFactory := func(c *gomock.Controller) anysync.TestTreeFactory {
		return func(objectID string) objecttree.ObjectTree {
			treeSeq++
			state := &statefulMockTree{}
			tree := setupStatefulMock(c, state)
			treeID := fmt.Sprintf("tree-%d-%s", treeSeq, objectID)
			tree.EXPECT().Id().Return(treeID).AnyTimes()
			tree.EXPECT().Header().Return(nil).AnyTimes()
			return tree
		}
	}
	utm.SetTestTreeFactory(communitySpaceID, makeFactory(ctrl))
	utm.SetTestTreeFactory(roSpaceID, makeFactory(ctrl))

	// Create user identity
	userIdentity := identity.New(tmpDir)
	userIdentity.SetIdentity("ETEST_CHAT_USER01", "test-mnemonic")

	// Create event broker
	eventBroker := NewEventBroker()

	// Create chat handler and register routes (nil store = tree-scan fallback, nil listener)
	chatHandler := NewChatHandler(spaceManager, userIdentity, eventBroker, nil, nil)
	mux := http.NewServeMux()
	chatHandler.RegisterRoutes(mux)

	cleanup := func() {
		os.RemoveAll(tmpDir)
	}

	return &chatTestEnv{
		tmpDir:       tmpDir,
		spaceManager: spaceManager,
		userIdentity: userIdentity,
		eventBroker:  eventBroker,
		chatHandler:  chatHandler,
		mux:          mux,
		cleanup:      cleanup,
	}
}

// --- Channel Tests ---

func TestChat_CreateChannel(t *testing.T) {
	env := setupChatTestEnv(t)
	defer env.cleanup()

	body := `{"name":"general","description":"Main channel"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/chat/channels", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	env.mux.ServeHTTP(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp["success"] != true {
		t.Errorf("expected success=true, got %v", resp["success"])
	}
	if resp["channelId"] == nil || resp["channelId"] == "" {
		t.Error("expected non-empty channelId")
	}
	if resp["headId"] == nil || resp["headId"] == "" {
		t.Error("expected non-empty headId")
	}
}

func TestChat_CreateChannel_MissingName(t *testing.T) {
	env := setupChatTestEnv(t)
	defer env.cleanup()

	body := `{"description":"No name"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/chat/channels", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	env.mux.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
}

func TestChat_ListChannels(t *testing.T) {
	env := setupChatTestEnv(t)
	defer env.cleanup()

	// Create two channels
	for _, name := range []string{"general", "random"} {
		body := fmt.Sprintf(`{"name":"%s"}`, name)
		req := httptest.NewRequest(http.MethodPost, "/api/v1/chat/channels", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		env.mux.ServeHTTP(w, req)
		if w.Code != http.StatusCreated {
			t.Fatalf("failed to create channel %s: %d %s", name, w.Code, w.Body.String())
		}
	}

	// List channels
	req := httptest.NewRequest(http.MethodGet, "/api/v1/chat/channels", nil)
	w := httptest.NewRecorder()
	env.mux.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	count, ok := resp["count"].(float64)
	if !ok || count < 2 {
		t.Errorf("expected at least 2 channels, got %v", resp["count"])
	}
}

func TestChat_GetChannel(t *testing.T) {
	env := setupChatTestEnv(t)
	defer env.cleanup()

	// Create a channel
	body := `{"name":"test-get","description":"A channel to get"}`
	createReq := httptest.NewRequest(http.MethodPost, "/api/v1/chat/channels", bytes.NewBufferString(body))
	createReq.Header.Set("Content-Type", "application/json")
	createW := httptest.NewRecorder()
	env.mux.ServeHTTP(createW, createReq)

	if createW.Code != http.StatusCreated {
		t.Fatalf("create failed: %d %s", createW.Code, createW.Body.String())
	}

	var createResp map[string]interface{}
	json.NewDecoder(createW.Body).Decode(&createResp)
	channelID := createResp["channelId"].(string)

	// Get the channel
	getReq := httptest.NewRequest(http.MethodGet, "/api/v1/chat/channels/"+channelID, nil)
	getW := httptest.NewRecorder()
	env.mux.ServeHTTP(getW, getReq)

	if getW.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", getW.Code, getW.Body.String())
	}

	var channelResp ChannelResponse
	if err := json.NewDecoder(getW.Body).Decode(&channelResp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if channelResp.ID != channelID {
		t.Errorf("expected channel ID %s, got %s", channelID, channelResp.ID)
	}
	if channelResp.Name != "test-get" {
		t.Errorf("expected name 'test-get', got %s", channelResp.Name)
	}
}

func TestChat_UpdateChannel(t *testing.T) {
	env := setupChatTestEnv(t)
	defer env.cleanup()

	// Create a channel
	body := `{"name":"before-update"}`
	createReq := httptest.NewRequest(http.MethodPost, "/api/v1/chat/channels", bytes.NewBufferString(body))
	createReq.Header.Set("Content-Type", "application/json")
	createW := httptest.NewRecorder()
	env.mux.ServeHTTP(createW, createReq)

	var createResp map[string]interface{}
	json.NewDecoder(createW.Body).Decode(&createResp)
	channelID := createResp["channelId"].(string)

	// Update channel
	updateBody := `{"name":"after-update","description":"Updated desc"}`
	updateReq := httptest.NewRequest(http.MethodPut, "/api/v1/chat/channels/"+channelID, bytes.NewBufferString(updateBody))
	updateReq.Header.Set("Content-Type", "application/json")
	updateW := httptest.NewRecorder()
	env.mux.ServeHTTP(updateW, updateReq)

	if updateW.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", updateW.Code, updateW.Body.String())
	}

	// Verify the update
	getReq := httptest.NewRequest(http.MethodGet, "/api/v1/chat/channels/"+channelID, nil)
	getW := httptest.NewRecorder()
	env.mux.ServeHTTP(getW, getReq)

	var channelResp ChannelResponse
	json.NewDecoder(getW.Body).Decode(&channelResp)

	if channelResp.Name != "after-update" {
		t.Errorf("expected name 'after-update', got %s", channelResp.Name)
	}
	if channelResp.Description != "Updated desc" {
		t.Errorf("expected description 'Updated desc', got %s", channelResp.Description)
	}
}

func TestChat_ArchiveChannel(t *testing.T) {
	env := setupChatTestEnv(t)
	defer env.cleanup()

	// Create a channel
	body := `{"name":"to-archive"}`
	createReq := httptest.NewRequest(http.MethodPost, "/api/v1/chat/channels", bytes.NewBufferString(body))
	createReq.Header.Set("Content-Type", "application/json")
	createW := httptest.NewRecorder()
	env.mux.ServeHTTP(createW, createReq)

	var createResp map[string]interface{}
	json.NewDecoder(createW.Body).Decode(&createResp)
	channelID := createResp["channelId"].(string)

	// Archive channel
	deleteReq := httptest.NewRequest(http.MethodDelete, "/api/v1/chat/channels/"+channelID, nil)
	deleteW := httptest.NewRecorder()
	env.mux.ServeHTTP(deleteW, deleteReq)

	if deleteW.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", deleteW.Code, deleteW.Body.String())
	}

	var archiveResp map[string]interface{}
	json.NewDecoder(deleteW.Body).Decode(&archiveResp)
	if archiveResp["archived"] != true {
		t.Error("expected archived=true")
	}

	// Verify GetChannel returns the channel with isArchived=true
	// (ReadLatestByID returns the highest-version entry)
	getReq := httptest.NewRequest(http.MethodGet, "/api/v1/chat/channels/"+channelID, nil)
	getW := httptest.NewRecorder()
	env.mux.ServeHTTP(getW, getReq)

	if getW.Code != http.StatusOK {
		t.Fatalf("get archived channel failed: %d %s", getW.Code, getW.Body.String())
	}

	var channelResp ChannelResponse
	json.NewDecoder(getW.Body).Decode(&channelResp)
	if !channelResp.IsArchived {
		t.Error("expected isArchived=true on GetChannel after archive")
	}
}

// --- Message Tests ---

// createTestChannel is a helper that creates a channel and returns its ID.
func createTestChannel(t *testing.T, env *chatTestEnv, name string) string {
	t.Helper()
	body := fmt.Sprintf(`{"name":"%s"}`, name)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/chat/channels", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	env.mux.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("failed to create channel: %d %s", w.Code, w.Body.String())
	}
	var resp map[string]interface{}
	json.NewDecoder(w.Body).Decode(&resp)
	return resp["channelId"].(string)
}

func TestChat_SendMessage(t *testing.T) {
	env := setupChatTestEnv(t)
	defer env.cleanup()

	channelID := createTestChannel(t, env, "msg-test")

	body := `{"content":"Hello, world!"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/chat/channels/"+channelID+"/messages", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	env.mux.ServeHTTP(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["success"] != true {
		t.Errorf("expected success=true, got %v", resp["success"])
	}
	if resp["messageId"] == nil || resp["messageId"] == "" {
		t.Error("expected non-empty messageId")
	}
}

func TestChat_SendMessage_EmptyContent(t *testing.T) {
	env := setupChatTestEnv(t)
	defer env.cleanup()

	channelID := createTestChannel(t, env, "msg-empty")

	body := `{"content":""}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/chat/channels/"+channelID+"/messages", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	env.mux.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
}

func TestChat_ListMessages(t *testing.T) {
	env := setupChatTestEnv(t)
	defer env.cleanup()

	channelID := createTestChannel(t, env, "msg-list")

	// Send two messages
	for _, content := range []string{"First message", "Second message"} {
		body := fmt.Sprintf(`{"content":"%s"}`, content)
		req := httptest.NewRequest(http.MethodPost, "/api/v1/chat/channels/"+channelID+"/messages", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		env.mux.ServeHTTP(w, req)
		if w.Code != http.StatusCreated {
			t.Fatalf("failed to send message: %d %s", w.Code, w.Body.String())
		}
	}

	// List messages
	req := httptest.NewRequest(http.MethodGet, "/api/v1/chat/channels/"+channelID+"/messages", nil)
	w := httptest.NewRecorder()
	env.mux.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	json.NewDecoder(w.Body).Decode(&resp)

	count, ok := resp["count"].(float64)
	if !ok || count < 2 {
		t.Errorf("expected at least 2 messages, got %v", resp["count"])
	}
}

// sendTestMessage is a helper that sends a message and returns the message ID.
func sendTestMessage(t *testing.T, env *chatTestEnv, channelID, content string) string {
	t.Helper()
	body := fmt.Sprintf(`{"content":"%s"}`, content)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/chat/channels/"+channelID+"/messages", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	env.mux.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("failed to send message: %d %s", w.Code, w.Body.String())
	}
	var resp map[string]interface{}
	json.NewDecoder(w.Body).Decode(&resp)
	return resp["messageId"].(string)
}

func TestChat_EditMessage(t *testing.T) {
	env := setupChatTestEnv(t)
	defer env.cleanup()

	channelID := createTestChannel(t, env, "msg-edit")
	messageID := sendTestMessage(t, env, channelID, "Original content")

	// Edit the message
	editBody := `{"content":"Edited content"}`
	editReq := httptest.NewRequest(http.MethodPut, "/api/v1/chat/messages/"+messageID, bytes.NewBufferString(editBody))
	editReq.Header.Set("Content-Type", "application/json")
	editW := httptest.NewRecorder()
	env.mux.ServeHTTP(editW, editReq)

	if editW.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", editW.Code, editW.Body.String())
	}

	var editResp map[string]interface{}
	json.NewDecoder(editW.Body).Decode(&editResp)

	if editResp["editedAt"] == nil || editResp["editedAt"] == "" {
		t.Error("expected non-empty editedAt")
	}
	if editResp["version"].(float64) != 2 {
		t.Errorf("expected version 2, got %v", editResp["version"])
	}
}

func TestChat_EditMessage_WrongOwner(t *testing.T) {
	env := setupChatTestEnv(t)
	defer env.cleanup()

	channelID := createTestChannel(t, env, "msg-wrong-owner")

	// Send a message as ETEST_CHAT_USER01
	messageID := sendTestMessage(t, env, channelID, "My message")

	// Switch identity to a different user
	env.userIdentity.SetIdentity("EOTHER_USER_999", "other-mnemonic")

	// Try to edit — should fail with 403
	editBody := `{"content":"Hacked!"}`
	editReq := httptest.NewRequest(http.MethodPut, "/api/v1/chat/messages/"+messageID, bytes.NewBufferString(editBody))
	editReq.Header.Set("Content-Type", "application/json")
	editW := httptest.NewRecorder()
	env.mux.ServeHTTP(editW, editReq)

	if editW.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d: %s", editW.Code, editW.Body.String())
	}
}

func TestChat_DeleteMessage(t *testing.T) {
	env := setupChatTestEnv(t)
	defer env.cleanup()

	channelID := createTestChannel(t, env, "msg-delete")
	messageID := sendTestMessage(t, env, channelID, "To be deleted")

	// Delete the message
	deleteReq := httptest.NewRequest(http.MethodDelete, "/api/v1/chat/messages/"+messageID, nil)
	deleteW := httptest.NewRecorder()
	env.mux.ServeHTTP(deleteW, deleteReq)

	if deleteW.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", deleteW.Code, deleteW.Body.String())
	}

	var deleteResp map[string]interface{}
	json.NewDecoder(deleteW.Body).Decode(&deleteResp)

	if deleteResp["deleted"] != true {
		t.Error("expected deleted=true")
	}
}

func TestChat_MessageThread(t *testing.T) {
	env := setupChatTestEnv(t)
	defer env.cleanup()

	channelID := createTestChannel(t, env, "msg-thread")
	parentID := sendTestMessage(t, env, channelID, "Parent message")

	// Send two replies
	for _, content := range []string{"Reply 1", "Reply 2"} {
		body := fmt.Sprintf(`{"content":"%s","replyTo":"%s"}`, content, parentID)
		req := httptest.NewRequest(http.MethodPost, "/api/v1/chat/channels/"+channelID+"/messages", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		env.mux.ServeHTTP(w, req)
		if w.Code != http.StatusCreated {
			t.Fatalf("failed to send reply: %d %s", w.Code, w.Body.String())
		}
	}

	// Get thread
	threadReq := httptest.NewRequest(http.MethodGet, "/api/v1/chat/messages/"+parentID+"/thread", nil)
	threadW := httptest.NewRecorder()
	env.mux.ServeHTTP(threadW, threadReq)

	if threadW.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", threadW.Code, threadW.Body.String())
	}

	var threadResp map[string]interface{}
	json.NewDecoder(threadW.Body).Decode(&threadResp)

	count := threadResp["count"].(float64)
	if count != 2 {
		t.Errorf("expected 2 thread replies, got %v", count)
	}
	if threadResp["parentMessageId"] != parentID {
		t.Errorf("expected parentMessageId %s, got %v", parentID, threadResp["parentMessageId"])
	}
}

// --- Reaction Tests ---

func TestChat_AddReaction(t *testing.T) {
	env := setupChatTestEnv(t)
	defer env.cleanup()

	channelID := createTestChannel(t, env, "react-test")
	messageID := sendTestMessage(t, env, channelID, "React to me")

	body := `{"emoji":"👍"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/chat/messages/"+messageID+"/reactions", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	env.mux.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	json.NewDecoder(w.Body).Decode(&resp)

	if resp["success"] != true {
		t.Errorf("expected success=true, got %v", resp["success"])
	}
	if resp["emoji"] != "👍" {
		t.Errorf("expected emoji '👍', got %v", resp["emoji"])
	}
	if resp["count"].(float64) != 1 {
		t.Errorf("expected count=1, got %v", resp["count"])
	}
}

func TestChat_DuplicateReaction(t *testing.T) {
	env := setupChatTestEnv(t)
	defer env.cleanup()

	channelID := createTestChannel(t, env, "react-dup")
	messageID := sendTestMessage(t, env, channelID, "Double react")

	body := `{"emoji":"❤️"}`

	// First reaction — should succeed
	req1 := httptest.NewRequest(http.MethodPost, "/api/v1/chat/messages/"+messageID+"/reactions", bytes.NewBufferString(body))
	req1.Header.Set("Content-Type", "application/json")
	w1 := httptest.NewRecorder()
	env.mux.ServeHTTP(w1, req1)

	if w1.Code != http.StatusOK {
		t.Fatalf("first reaction expected 200, got %d: %s", w1.Code, w1.Body.String())
	}

	// Second reaction with same emoji — should return 409
	req2 := httptest.NewRequest(http.MethodPost, "/api/v1/chat/messages/"+messageID+"/reactions", bytes.NewBufferString(body))
	req2.Header.Set("Content-Type", "application/json")
	w2 := httptest.NewRecorder()
	env.mux.ServeHTTP(w2, req2)

	if w2.Code != http.StatusConflict {
		t.Fatalf("duplicate reaction expected 409, got %d: %s", w2.Code, w2.Body.String())
	}
}

func TestChat_RemoveReaction(t *testing.T) {
	env := setupChatTestEnv(t)
	defer env.cleanup()

	channelID := createTestChannel(t, env, "react-remove")
	messageID := sendTestMessage(t, env, channelID, "Remove my reaction")

	// Add reaction
	addBody := `{"emoji":"🔥"}`
	addReq := httptest.NewRequest(http.MethodPost, "/api/v1/chat/messages/"+messageID+"/reactions", bytes.NewBufferString(addBody))
	addReq.Header.Set("Content-Type", "application/json")
	addW := httptest.NewRecorder()
	env.mux.ServeHTTP(addW, addReq)

	if addW.Code != http.StatusOK {
		t.Fatalf("add reaction failed: %d %s", addW.Code, addW.Body.String())
	}

	// Remove reaction
	removeReq := httptest.NewRequest(http.MethodDelete, "/api/v1/chat/messages/"+messageID+"/reactions/🔥", nil)
	removeW := httptest.NewRecorder()
	env.mux.ServeHTTP(removeW, removeReq)

	if removeW.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", removeW.Code, removeW.Body.String())
	}

	var resp map[string]interface{}
	json.NewDecoder(removeW.Body).Decode(&resp)

	if resp["success"] != true {
		t.Errorf("expected success=true, got %v", resp["success"])
	}
	if resp["count"].(float64) != 0 {
		t.Errorf("expected count=0 after removal, got %v", resp["count"])
	}
}

// --- SSE Event Tests ---

func TestChat_SSEEvents(t *testing.T) {
	env := setupChatTestEnv(t)
	defer env.cleanup()

	// Subscribe to events
	ch := env.eventBroker.Subscribe()
	defer env.eventBroker.Unsubscribe(ch)

	// Create a channel — should broadcast "chat:channel:new"
	createBody := `{"name":"sse-test"}`
	createReq := httptest.NewRequest(http.MethodPost, "/api/v1/chat/channels", bytes.NewBufferString(createBody))
	createReq.Header.Set("Content-Type", "application/json")
	createW := httptest.NewRecorder()
	env.mux.ServeHTTP(createW, createReq)

	if createW.Code != http.StatusCreated {
		t.Fatalf("create channel failed: %d %s", createW.Code, createW.Body.String())
	}

	var createResp map[string]interface{}
	json.NewDecoder(createW.Body).Decode(&createResp)
	channelID := createResp["channelId"].(string)

	// Check channel creation event
	select {
	case event := <-ch:
		if event.Type != "chat:channel:new" {
			t.Errorf("expected event type 'chat:channel:new', got %s", event.Type)
		}
	default:
		t.Error("expected channel creation event, got none")
	}

	// Send a message — should broadcast "chat:message:new"
	msgBody := `{"content":"SSE test message"}`
	msgReq := httptest.NewRequest(http.MethodPost, "/api/v1/chat/channels/"+channelID+"/messages", bytes.NewBufferString(msgBody))
	msgReq.Header.Set("Content-Type", "application/json")
	msgW := httptest.NewRecorder()
	env.mux.ServeHTTP(msgW, msgReq)

	select {
	case event := <-ch:
		if event.Type != "chat:message:new" {
			t.Errorf("expected event type 'chat:message:new', got %s", event.Type)
		}
	default:
		t.Error("expected message event, got none")
	}
}

// Ensure unused import for crypto doesn't cause build failure.
var _ = crypto.GenerateRandomEd25519KeyPair
