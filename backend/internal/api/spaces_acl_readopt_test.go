package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/anyproto/any-sync/commonspace/mock_commonspace"
	"github.com/anyproto/any-sync/commonspace/object/acl/list"
	"github.com/anyproto/any-sync/commonspace/object/acl/syncacl/mock_syncacl"
	"github.com/anyproto/any-sync/util/crypto"
	"github.com/matou-dao/backend/internal/anysync"
	"github.com/matou-dao/backend/internal/identity"
	"go.uber.org/mock/gomock"
)

const readoptTestMnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"

// readoptHandler wires a SpacesHandler whose cached community space "cs" has a
// real ACL owned by account "a", and whose client signs with signingKey — or
// with the ACL owner's own key when signingKey is nil. A mnemonic-less identity
// is used when withMnemonic is false.
func readoptHandler(t *testing.T, signingKey crypto.PrivKey, withMnemonic bool) (*SpacesHandler, *mockAnySyncClient) {
	t.Helper()

	exec := list.NewAclExecutor("cs")
	if err := exec.Execute("a.init::a"); err != nil {
		t.Fatalf("building ACL: %v", err)
	}
	owner := exec.ActualAccounts()["a"]
	state := owner.Acl.AclState()
	if signingKey == nil {
		signingKey = owner.Keys.SignKey
	}

	ctrl := gomock.NewController(t)
	mockSpace := mock_commonspace.NewMockSpace(ctrl)
	mockACL := mock_syncacl.NewMockSyncAcl(ctrl)
	mockSpace.EXPECT().Acl().Return(mockACL).AnyTimes()
	mockACL.EXPECT().RLock().AnyTimes()
	mockACL.EXPECT().RUnlock().AnyTimes()
	mockACL.EXPECT().AclState().Return(state).AnyTimes()

	client := newMockClient()
	client.space = mockSpace
	client.signingKey = signingKey
	client.dataDir = t.TempDir()

	var ui *identity.UserIdentity
	if withMnemonic {
		ui = identity.New(t.TempDir())
		if err := ui.SetIdentity("EAdmin", readoptTestMnemonic); err != nil {
			t.Fatalf("SetIdentity: %v", err)
		}
	}

	spaceManager := anysync.NewSpaceManager(client, &anysync.SpaceManagerConfig{
		CommunitySpaceID:         "cs",
		CommunityReadOnlySpaceID: "ro",
		AdminSpaceID:             "adm",
		OrgAID:                   "EORG123456789",
	})
	return &SpacesHandler{
		spaceManager: spaceManager,
		spaceStore:   newMockSpaceStore(),
		userIdentity: ui,
	}, client
}

func callCreateCommunity(h *SpacesHandler) (*httptest.ResponseRecorder, CreateCommunityResponse) {
	body, _ := json.Marshal(CreateCommunityRequest{OrgAID: "EORG123456789", OrgName: "Test Org"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/spaces/community", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.HandleCreateCommunity(w, req)
	var resp CreateCommunityResponse
	_ = json.NewDecoder(w.Body).Decode(&resp)
	return w, resp
}

// TestHandleCreateCommunity_IdentityNotInCachedACL_Recreates is the #290
// scenario: a fresh admin identity (a signing key the cached space's ACL has
// never seen) must NOT be handed the cached space, which it cannot read.
func TestHandleCreateCommunity_IdentityNotInCachedACL_Recreates(t *testing.T) {
	stranger, _, err := crypto.GenerateRandomEd25519KeyPair()
	if err != nil {
		t.Fatalf("keygen: %v", err)
	}
	// NewAclExecutor keys are ed25519 too; the ACL only knows "a".
	h, _ := readoptHandler(t, stranger, true)

	w, resp := callCreateCommunity(h)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if !resp.Success {
		t.Fatalf("expected success, got error %q", resp.Error)
	}
	if resp.CommunitySpaceID == "cs" || resp.SpaceID == "cs" {
		t.Fatalf("cached space 'cs' was re-adopted by an identity outside its ACL: %+v", resp)
	}
	if got := h.spaceManager.GetCommunitySpaceID(); got == "cs" || got == "" {
		t.Errorf("space manager should point at the recreated space, got %q", got)
	}
}

// TestHandleCreateCommunity_OwnerInCachedACL_ReturnsCached: the legitimate
// owner (same mnemonic → same signing key as the ACL root) keeps its space.
func TestHandleCreateCommunity_OwnerInCachedACL_ReturnsCached(t *testing.T) {
	h, _ := readoptHandler(t, nil, true)

	w, resp := callCreateCommunity(h)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if resp.CommunitySpaceID != "cs" {
		t.Fatalf("owner must get the cached space back, got %+v", resp)
	}
	if resp.ReadOnlySpaceID != "ro" || resp.AdminSpaceID != "adm" {
		t.Errorf("cached read-only/admin IDs must be preserved, got %+v", resp)
	}
}

// TestHandleCreateCommunity_NoMnemonic_NeverDemotesCachedSpace: without a
// configured identity the signing key is the random device key, which is in no
// ACL. Demoting would only wipe the runtime space IDs and then 409 on
// recreation, so the cached space must be returned untouched (pre-#290
// behaviour for identity-less callers).
func TestHandleCreateCommunity_NoMnemonic_NeverDemotesCachedSpace(t *testing.T) {
	deviceKey, _, err := crypto.GenerateRandomEd25519KeyPair()
	if err != nil {
		t.Fatalf("keygen: %v", err)
	}
	h, _ := readoptHandler(t, deviceKey, false)

	w, resp := callCreateCommunity(h)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if resp.CommunitySpaceID != "cs" {
		t.Fatalf("identity-less call must return the cached space, got %+v", resp)
	}
	if got := h.spaceManager.GetCommunitySpaceID(); got != "cs" {
		t.Errorf("runtime community space ID must be untouched, got %q", got)
	}
	if strings.Contains(w.Body.String(), "identity must be configured") {
		t.Errorf("cached space must not be demoted into the recreate path: %s", w.Body.String())
	}
}
