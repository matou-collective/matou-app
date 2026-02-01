package api

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"time"

	"github.com/anyproto/any-sync/commonspace/object/acl/list"
	"github.com/anyproto/any-sync/util/crypto"
	"github.com/matou-dao/backend/internal/anystore"
	"github.com/matou-dao/backend/internal/anysync"
	"github.com/matou-dao/backend/internal/identity"
)

// SpacesHandler handles space-related HTTP requests
type SpacesHandler struct {
	spaceManager *anysync.SpaceManager
	store        *anystore.LocalStore
	spaceStore   anysync.SpaceStore
	userIdentity *identity.UserIdentity
}

// NewSpacesHandler creates a new spaces handler
func NewSpacesHandler(spaceManager *anysync.SpaceManager, store *anystore.LocalStore, userIdentity *identity.UserIdentity) *SpacesHandler {
	return &SpacesHandler{
		spaceManager: spaceManager,
		store:        store,
		spaceStore:   anystore.NewSpaceStoreAdapter(store),
		userIdentity: userIdentity,
	}
}

// CreateCommunityRequest represents a request to create a community space
type CreateCommunityRequest struct {
	OrgAID  string `json:"orgAid"`
	OrgName string `json:"orgName"`
}

// CreateCommunityResponse represents the response for community space creation
type CreateCommunityResponse struct {
	Success bool   `json:"success"`
	SpaceID string `json:"spaceId,omitempty"`
	Error   string `json:"error,omitempty"`
}

// GetCommunityResponse represents the response for getting community space info
type GetCommunityResponse struct {
	SpaceID   string    `json:"spaceId,omitempty"`
	OrgAID    string    `json:"orgAid,omitempty"`
	SpaceName string    `json:"spaceName,omitempty"`
	CreatedAt time.Time `json:"createdAt,omitempty"`
	Error     string    `json:"error,omitempty"`
}

// CreatePrivateRequest represents a request to create a private space
type CreatePrivateRequest struct {
	UserAID  string `json:"userAid"`
	Mnemonic string `json:"mnemonic,omitempty"`
}

// CreatePrivateResponse represents the response for private space creation
type CreatePrivateResponse struct {
	Success bool   `json:"success"`
	SpaceID string `json:"spaceId,omitempty"`
	Created bool   `json:"created,omitempty"` // false if space already existed
	Error   string `json:"error,omitempty"`
}

// InviteRequest represents a request to invite a user to the community space
type InviteRequest struct {
	RecipientAID   string `json:"recipientAid"`
	CredentialSAID string `json:"credentialSaid"`
	Schema         string `json:"schema"`
}

// InviteResponse represents the response for space invitation
type InviteResponse struct {
	Success          bool   `json:"success"`
	CommunitySpaceID string `json:"communitySpaceId,omitempty"`
	InviteKey        string `json:"inviteKey,omitempty"` // base64-encoded invite private key
	Error            string `json:"error,omitempty"`
}

// GetUserSpacesResponse represents the response for getting a user's spaces
type GetUserSpacesResponse struct {
	PrivateSpace   *SpaceInfo `json:"privateSpace,omitempty"`
	CommunitySpace *SpaceInfo `json:"communitySpace,omitempty"`
}

// SpaceInfo represents summary info for a single space
type SpaceInfo struct {
	SpaceID       string    `json:"spaceId"`
	SpaceName     string    `json:"spaceName"`
	CreatedAt     time.Time `json:"createdAt"`
	KeysAvailable bool      `json:"keysAvailable"`
}

// HandleGetUserSpaces handles GET /api/v1/spaces/user?aid=<prefix>
// In per-user mode, the ?aid= query param is optional; falls back to local identity.
func (h *SpacesHandler) HandleGetUserSpaces(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{
			"error": "method not allowed",
		})
		return
	}

	aid := r.URL.Query().Get("aid")
	if aid == "" && h.userIdentity != nil {
		aid = h.userIdentity.GetAID()
	}
	if aid == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "identity not configured",
		})
		return
	}

	ctx := r.Context()
	resp := GetUserSpacesResponse{}

	// Look up the user's private space
	if privateSpace, err := h.spaceStore.GetUserSpace(ctx, aid); err == nil && privateSpace != nil {
		info := &SpaceInfo{
			SpaceID:   privateSpace.SpaceID,
			SpaceName: privateSpace.SpaceName,
			CreatedAt: privateSpace.CreatedAt,
		}
		// Check if keys are available on disk
		client := h.spaceManager.GetClient()
		if client != nil {
			if _, keyErr := anysync.LoadSpaceKeySet(client.GetDataDir(), privateSpace.SpaceID); keyErr == nil {
				info.KeysAvailable = true
			}
		}
		resp.PrivateSpace = info
	}

	// Look up the community space (shared by all users)
	if communitySpace, err := h.spaceManager.GetCommunitySpace(ctx); err == nil && communitySpace != nil {
		info := &SpaceInfo{
			SpaceID:   communitySpace.SpaceID,
			SpaceName: communitySpace.SpaceName,
			CreatedAt: communitySpace.CreatedAt,
		}
		client := h.spaceManager.GetClient()
		if client != nil {
			if _, keyErr := anysync.LoadSpaceKeySet(client.GetDataDir(), communitySpace.SpaceID); keyErr == nil {
				info.KeysAvailable = true
			}
		}
		resp.CommunitySpace = info
	}

	writeJSON(w, http.StatusOK, resp)
}

// HandleCreateCommunity handles POST /api/v1/spaces/community
func (h *SpacesHandler) HandleCreateCommunity(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, CreateCommunityResponse{
			Success: false,
			Error:   "method not allowed",
		})
		return
	}

	var req CreateCommunityRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, CreateCommunityResponse{
			Success: false,
			Error:   fmt.Sprintf("invalid request: %v", err),
		})
		return
	}

	if req.OrgAID == "" {
		writeJSON(w, http.StatusBadRequest, CreateCommunityResponse{
			Success: false,
			Error:   "orgAid is required",
		})
		return
	}

	// Check if community space already exists
	existingSpace, err := h.spaceManager.GetCommunitySpace(r.Context())
	if err == nil && existingSpace != nil {
		writeJSON(w, http.StatusOK, CreateCommunityResponse{
			Success: true,
			SpaceID: existingSpace.SpaceID,
		})
		return
	}

	// Create new community space via any-sync client using mnemonic-derived keys.
	// The admin's identity must be set first (POST /api/v1/identity/set) so we
	// can derive deterministic keys from the stored mnemonic. This makes the admin
	// the recoverable owner of the community space.
	ctx := r.Context()
	client := h.spaceManager.GetClient()
	if client == nil {
		writeJSON(w, http.StatusServiceUnavailable, CreateCommunityResponse{
			Success: false,
			Error:   "any-sync client not available",
		})
		return
	}

	// Derive community space keys from stored mnemonic (index 1; index 0 = private space)
	mnemonic := ""
	if h.userIdentity != nil {
		mnemonic = h.userIdentity.GetMnemonic()
	}
	if mnemonic == "" {
		writeJSON(w, http.StatusConflict, CreateCommunityResponse{
			Success: false,
			Error:   "identity must be configured before creating community space (call POST /api/v1/identity/set first)",
		})
		return
	}

	keys, err := anysync.DeriveSpaceKeySet(mnemonic, 1)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, CreateCommunityResponse{
			Success: false,
			Error:   fmt.Sprintf("failed to derive community space keys: %v", err),
		})
		return
	}

	result, err := client.CreateSpaceWithKeys(ctx, req.OrgAID, anysync.SpaceTypeCommunity, keys)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, CreateCommunityResponse{
			Success: false,
			Error:   fmt.Sprintf("failed to create community space: %v", err),
		})
		return
	}

	// Make space shareable on coordinator (required before CreateOpenInvite)
	if err := client.MakeSpaceShareable(ctx, result.SpaceID); err != nil {
		fmt.Printf("Warning: failed to make space shareable: %v\n", err)
	}

	// Save space record to local store
	space := &anysync.Space{
		SpaceID:   result.SpaceID,
		OwnerAID:  req.OrgAID,
		SpaceType: anysync.SpaceTypeCommunity,
		SpaceName: req.OrgName + " Community",
		CreatedAt: result.CreatedAt,
		LastSync:  result.CreatedAt,
	}

	if err := h.spaceStore.SaveSpace(ctx, space); err != nil {
		// Log but don't fail - space was created in any-sync
		fmt.Printf("Warning: failed to save community space record: %v\n", err)
	}

	// Update space manager with the new community space ID
	h.spaceManager.SetCommunitySpaceID(result.SpaceID)

	writeJSON(w, http.StatusOK, CreateCommunityResponse{
		Success: true,
		SpaceID: result.SpaceID,
	})
}

// HandleGetCommunity handles GET /api/v1/spaces/community
func (h *SpacesHandler) HandleGetCommunity(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, GetCommunityResponse{
			Error: "method not allowed",
		})
		return
	}

	space, err := h.spaceManager.GetCommunitySpace(r.Context())
	if err != nil {
		writeJSON(w, http.StatusNotFound, GetCommunityResponse{
			Error: "community space not configured",
		})
		return
	}

	writeJSON(w, http.StatusOK, GetCommunityResponse{
		SpaceID:   space.SpaceID,
		OrgAID:    space.OwnerAID,
		SpaceName: space.SpaceName,
		CreatedAt: space.CreatedAt,
	})
}

// HandleCreatePrivate handles POST /api/v1/spaces/private
func (h *SpacesHandler) HandleCreatePrivate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, CreatePrivateResponse{
			Success: false,
			Error:   "method not allowed",
		})
		return
	}

	var req CreatePrivateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, CreatePrivateResponse{
			Success: false,
			Error:   fmt.Sprintf("invalid request: %v", err),
		})
		return
	}

	// In per-user mode, use local identity as fallback
	if req.UserAID == "" && h.userIdentity != nil {
		req.UserAID = h.userIdentity.GetAID()
	}
	if req.UserAID == "" {
		writeJSON(w, http.StatusBadRequest, CreatePrivateResponse{
			Success: false,
			Error:   "userAid is required (or set identity first)",
		})
		return
	}

	ctx := r.Context()

	// Check if space already exists
	existingSpace, err := h.spaceStore.GetUserSpace(ctx, req.UserAID)
	if err == nil && existingSpace != nil {
		// Even if space exists, persist peer key if mnemonic is provided
		// (handles upgrades where peer key wasn't stored on initial creation)
		if req.Mnemonic != "" {
			if client := h.spaceManager.GetClient(); client != nil {
				if peerKey, peerErr := anysync.DeriveKeyFromMnemonic(req.Mnemonic, 0); peerErr == nil {
					anysync.PersistUserPeerKey(client.GetDataDir(), req.UserAID, peerKey)
				}
			}
		}
		writeJSON(w, http.StatusOK, CreatePrivateResponse{
			Success: true,
			SpaceID: existingSpace.SpaceID,
			Created: false,
		})
		return
	}

	// Create new private space — use mnemonic-derived keys if provided
	if req.Mnemonic != "" {
		if err := anysync.ValidateMnemonic(req.Mnemonic); err != nil {
			writeJSON(w, http.StatusBadRequest, CreatePrivateResponse{
				Success: false,
				Error:   fmt.Sprintf("invalid mnemonic: %v", err),
			})
			return
		}

		keys, err := anysync.DeriveSpaceKeySet(req.Mnemonic, 0)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, CreatePrivateResponse{
				Success: false,
				Error:   fmt.Sprintf("failed to derive space keys: %v", err),
			})
			return
		}

		client := h.spaceManager.GetClient()
		if client == nil {
			writeJSON(w, http.StatusServiceUnavailable, CreatePrivateResponse{
				Success: false,
				Error:   "any-sync client not available",
			})
			return
		}

		// Derive and persist user's peer key for future operations (e.g. JoinWithInvite)
		peerKey, peerErr := anysync.DeriveKeyFromMnemonic(req.Mnemonic, 0)
		if peerErr != nil {
			fmt.Printf("Warning: failed to derive peer key: %v\n", peerErr)
		} else {
			if persistErr := anysync.PersistUserPeerKey(client.GetDataDir(), req.UserAID, peerKey); persistErr != nil {
				fmt.Printf("Warning: failed to persist peer key: %v\n", persistErr)
			}
		}

		result, err := client.CreateSpaceWithKeys(ctx, req.UserAID, anysync.SpaceTypePrivate, keys)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, CreatePrivateResponse{
				Success: false,
				Error:   fmt.Sprintf("failed to create private space: %v", err),
			})
			return
		}

		space := &anysync.Space{
			SpaceID:   result.SpaceID,
			OwnerAID:  req.UserAID,
			SpaceType: anysync.SpaceTypePrivate,
			SpaceName: fmt.Sprintf("Private Space - %s", truncateAID(req.UserAID)),
			CreatedAt: result.CreatedAt,
			LastSync:  result.CreatedAt,
		}

		if err := h.spaceStore.SaveSpace(ctx, space); err != nil {
			fmt.Printf("Warning: failed to save private space record: %v\n", err)
		}

		writeJSON(w, http.StatusOK, CreatePrivateResponse{
			Success: true,
			SpaceID: space.SpaceID,
			Created: true,
		})
		return
	}

	// Fallback: create with random keys via SpaceManager
	space, err := h.spaceManager.CreatePrivateSpace(ctx, req.UserAID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, CreatePrivateResponse{
			Success: false,
			Error:   fmt.Sprintf("failed to create private space: %v", err),
		})
		return
	}

	// Save space record
	if err := h.spaceStore.SaveSpace(ctx, space); err != nil {
		fmt.Printf("Warning: failed to save private space record: %v\n", err)
	}

	writeJSON(w, http.StatusOK, CreatePrivateResponse{
		Success: true,
		SpaceID: space.SpaceID,
		Created: true,
	})
}

// HandleInvite handles POST /api/v1/spaces/community/invite
func (h *SpacesHandler) HandleInvite(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, InviteResponse{
			Success: false,
			Error:   "method not allowed",
		})
		return
	}

	var req InviteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, InviteResponse{
			Success: false,
			Error:   fmt.Sprintf("invalid request: %v", err),
		})
		return
	}

	if req.RecipientAID == "" {
		writeJSON(w, http.StatusBadRequest, InviteResponse{
			Success: false,
			Error:   "recipientAid is required",
		})
		return
	}

	if req.CredentialSAID == "" {
		writeJSON(w, http.StatusBadRequest, InviteResponse{
			Success: false,
			Error:   "credentialSaid is required",
		})
		return
	}

	// Validate that it's a membership credential
	if req.Schema != "" && req.Schema != "EMatouMembershipSchemaV1" {
		writeJSON(w, http.StatusBadRequest, InviteResponse{
			Success: false,
			Error:   "only membership credentials can grant community access",
		})
		return
	}

	ctx := r.Context()

	// Get community space
	communitySpace, err := h.spaceManager.GetCommunitySpace(ctx)
	if err != nil {
		writeJSON(w, http.StatusConflict, InviteResponse{
			Success: false,
			Error:   "community space not configured",
		})
		return
	}

	// Generate a fresh invite key via the ACL manager
	aclMgr := h.spaceManager.ACLManager()
	inviteKey, err := aclMgr.CreateOpenInvite(ctx, communitySpace.SpaceID, list.AclPermissionsWriter)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, InviteResponse{
			Success: false,
			Error:   fmt.Sprintf("failed to create invite: %v", err),
		})
		return
	}

	// Marshal invite private key to bytes and base64-encode
	inviteKeyBytes, err := inviteKey.Marshall()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, InviteResponse{
			Success: false,
			Error:   fmt.Sprintf("failed to marshal invite key: %v", err),
		})
		return
	}

	writeJSON(w, http.StatusOK, InviteResponse{
		Success:          true,
		CommunitySpaceID: communitySpace.SpaceID,
		InviteKey:        base64.StdEncoding.EncodeToString(inviteKeyBytes),
	})
}

// JoinCommunityRequest represents a request to join the community space
type JoinCommunityRequest struct {
	UserAID   string `json:"userAid"`
	InviteKey string `json:"inviteKey"` // base64-encoded invite private key
}

// JoinCommunityResponse represents the response for community join
type JoinCommunityResponse struct {
	Success bool   `json:"success"`
	SpaceID string `json:"spaceId,omitempty"`
	Error   string `json:"error,omitempty"`
}

// HandleJoinCommunity handles POST /api/v1/spaces/community/join
func (h *SpacesHandler) HandleJoinCommunity(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, JoinCommunityResponse{
			Success: false,
			Error:   "method not allowed",
		})
		return
	}

	var req JoinCommunityRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, JoinCommunityResponse{
			Success: false,
			Error:   fmt.Sprintf("invalid request: %v", err),
		})
		return
	}

	if req.UserAID == "" || req.InviteKey == "" {
		writeJSON(w, http.StatusBadRequest, JoinCommunityResponse{
			Success: false,
			Error:   "userAid and inviteKey are required",
		})
		return
	}

	ctx := r.Context()

	// Get community space ID
	communitySpace, err := h.spaceManager.GetCommunitySpace(ctx)
	if err != nil {
		writeJSON(w, http.StatusConflict, JoinCommunityResponse{
			Success: false,
			Error:   "community space not configured",
		})
		return
	}

	// Decode invite key from base64
	inviteKeyBytes, err := base64.StdEncoding.DecodeString(req.InviteKey)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, JoinCommunityResponse{
			Success: false,
			Error:   "invalid invite key encoding",
		})
		return
	}

	invitePrivKey, err := crypto.UnmarshalEd25519PrivateKeyProto(inviteKeyBytes)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, JoinCommunityResponse{
			Success: false,
			Error:   fmt.Sprintf("invalid invite key: %v", err),
		})
		return
	}

	// Load the user's stored peer key (persisted during private space creation)
	client := h.spaceManager.GetClient()
	if client == nil {
		writeJSON(w, http.StatusServiceUnavailable, JoinCommunityResponse{
			Success: false,
			Error:   "any-sync client not available",
		})
		return
	}

	dataDir := client.GetDataDir()
	_, err = anysync.LoadUserPeerKey(dataDir, req.UserAID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, JoinCommunityResponse{
			Success: false,
			Error:   "user peer key not found, private space must be created first",
		})
		return
	}

	// Create a temporary SDKClient with the user's stored peer key
	// so JoinWithInvite signs the join record with the USER's identity
	configPath := filepath.Join(dataDir, "..", "config", "client-host.yml")
	// Try common config locations
	for _, candidate := range []string{
		filepath.Join(dataDir, "..", "config", "client-host.yml"),
		"config/client-host.yml",
		"../infrastructure/any-sync/client-host-test.yml",
	} {
		if _, statErr := filepath.Abs(candidate); statErr == nil {
			configPath = candidate
			break
		}
	}

	tempClient, err := anysync.NewSDKClient(configPath, &anysync.ClientOptions{
		DataDir:     filepath.Join(dataDir, "users", req.UserAID, "join"),
		PeerKeyPath: filepath.Join(dataDir, "users", req.UserAID, "peer.key"),
	})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, JoinCommunityResponse{
			Success: false,
			Error:   fmt.Sprintf("failed to create temp client: %v", err),
		})
		return
	}
	defer tempClient.Close()

	// Wait for space to be available and join
	aclMgr := anysync.NewMatouACLManager(tempClient, nil)
	metadata := []byte(fmt.Sprintf(`{"aid":"%s","joinedAt":"%s"}`, req.UserAID, time.Now().UTC().Format(time.RFC3339)))

	if err := aclMgr.JoinWithInvite(ctx, communitySpace.SpaceID, invitePrivKey, metadata); err != nil {
		writeJSON(w, http.StatusInternalServerError, JoinCommunityResponse{
			Success: false,
			Error:   fmt.Sprintf("failed to join community: %v", err),
		})
		return
	}

	writeJSON(w, http.StatusOK, JoinCommunityResponse{
		Success: true,
		SpaceID: communitySpace.SpaceID,
	})
}

// VerifyAccessResponse represents the response for access verification
type VerifyAccessResponse struct {
	HasAccess bool   `json:"hasAccess"`
	SpaceID   string `json:"spaceId,omitempty"`
	CanRead   bool   `json:"canRead"`
	CanWrite  bool   `json:"canWrite"`
}

// HandleVerifyAccess handles GET /api/v1/spaces/community/verify-access?aid=<prefix>
func (h *SpacesHandler) HandleVerifyAccess(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	aid := r.URL.Query().Get("aid")
	if aid == "" {
		writeJSON(w, http.StatusBadRequest, VerifyAccessResponse{HasAccess: false})
		return
	}

	ctx := r.Context()

	// Get community space
	communitySpace, err := h.spaceManager.GetCommunitySpace(ctx)
	if err != nil {
		writeJSON(w, http.StatusOK, VerifyAccessResponse{HasAccess: false})
		return
	}

	client := h.spaceManager.GetClient()
	if client == nil {
		writeJSON(w, http.StatusOK, VerifyAccessResponse{HasAccess: false})
		return
	}
	dataDir := client.GetDataDir()
	aclMgr := h.spaceManager.ACLManager()

	// Step 1: Check via space signing key (space creator/owner).
	// The signing key is the identity recorded in the ACL root when the space
	// was created, so a non-zero permission proves ownership.
	if spaceKeys, loadErr := anysync.LoadSpaceKeySet(dataDir, communitySpace.SpaceID); loadErr == nil {
		perms, permErr := aclMgr.GetPermissions(ctx, communitySpace.SpaceID, spaceKeys.SigningKey.GetPublic())
		if permErr == nil && !perms.NoPermissions() {
			writeJSON(w, http.StatusOK, VerifyAccessResponse{
				HasAccess: true,
				SpaceID:   communitySpace.SpaceID,
				CanRead:   true,
				CanWrite:  perms.CanWrite(),
			})
			return
		}
	}

	// Step 2: Check via user peer key against ACL (joined member).
	userPeerKey, err := anysync.LoadUserPeerKey(dataDir, aid)
	if err != nil {
		writeJSON(w, http.StatusOK, VerifyAccessResponse{HasAccess: false})
		return
	}

	perms, err := aclMgr.GetPermissions(ctx, communitySpace.SpaceID, userPeerKey.GetPublic())
	if err != nil {
		writeJSON(w, http.StatusOK, VerifyAccessResponse{HasAccess: false})
		return
	}

	hasAccess := !perms.NoPermissions()
	writeJSON(w, http.StatusOK, VerifyAccessResponse{
		HasAccess: hasAccess,
		SpaceID:   communitySpace.SpaceID,
		CanRead:   hasAccess,
		CanWrite:  perms.CanWrite(),
	})
}

// handleVerifyAccessOrJoin routes /api/v1/spaces/community/verify-access
func (h *SpacesHandler) handleVerifyAccess(w http.ResponseWriter, r *http.Request) {
	h.HandleVerifyAccess(w, r)
}

// handleCommunitySpace routes community space requests
func (h *SpacesHandler) handleCommunitySpace(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		h.HandleCreateCommunity(w, r)
	case http.MethodGet:
		h.HandleGetCommunity(w, r)
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{
			"error": "method not allowed",
		})
	}
}

// RegisterRoutes registers space routes on the mux
func (h *SpacesHandler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/v1/spaces/community", h.handleCommunitySpace)
	mux.HandleFunc("/api/v1/spaces/community/invite", h.HandleInvite)
	mux.HandleFunc("/api/v1/spaces/community/join", h.HandleJoinCommunity)
	mux.HandleFunc("/api/v1/spaces/community/verify-access", h.handleVerifyAccess)
	mux.HandleFunc("/api/v1/spaces/private", h.HandleCreatePrivate)
	mux.HandleFunc("/api/v1/spaces/user", h.HandleGetUserSpaces)
}

// truncateAID returns the first 12 characters of an AID for display purposes
func truncateAID(aid string) string {
	if len(aid) > 12 {
		return aid[:12]
	}
	return aid
}
