package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/anyproto/any-sync/commonspace/object/acl/list"
	"github.com/anyproto/any-sync/util/crypto"
	"github.com/matou-dao/backend/internal/anystore"
	"github.com/matou-dao/backend/internal/anysync"
	"github.com/matou-dao/backend/internal/identity"
	"github.com/matou-dao/backend/internal/types"
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
	OrgAID         string `json:"orgAid"`
	OrgName        string `json:"orgName"`
	AdminAID       string `json:"adminAid,omitempty"`
	AdminName      string `json:"adminName,omitempty"`
	AdminEmail     string `json:"adminEmail,omitempty"`
	AdminAvatar    string `json:"adminAvatar,omitempty"`
	CredentialSAID string `json:"credentialSaid,omitempty"`
}

// CreateCommunityResponse represents the response for community space creation
type CreateCommunityResponse struct {
	Success          bool            `json:"success"`
	CommunitySpaceID string          `json:"communitySpaceId,omitempty"`
	ReadOnlySpaceID  string          `json:"readOnlySpaceId,omitempty"`
	AdminSpaceID     string          `json:"adminSpaceId,omitempty"`
	Objects          []CreatedObject `json:"objects,omitempty"`
	Error            string          `json:"error,omitempty"`
	// Deprecated: use CommunitySpaceID instead
	SpaceID string `json:"spaceId,omitempty"`
}

// CreatedObject describes an object seeded into a space during creation.
type CreatedObject struct {
	SpaceID  string `json:"spaceId"`
	ObjectID string `json:"objectId"`
	HeadID   string `json:"headId"`
	Type     string `json:"type"` // "type_definition" or profile type name
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
	Success                bool   `json:"success"`
	CommunitySpaceID       string `json:"communitySpaceId,omitempty"`
	InviteKey              string `json:"inviteKey,omitempty"`              // base64-encoded community invite private key
	ReadOnlyInviteKey      string `json:"readOnlyInviteKey,omitempty"`      // base64-encoded community-readonly invite key
	ReadOnlySpaceID        string `json:"readOnlySpaceId,omitempty"`        // community-readonly space ID
	Error                  string `json:"error,omitempty"`
}

// GetUserSpacesResponse represents the response for getting a user's spaces
type GetUserSpacesResponse struct {
	PrivateSpace           *SpaceInfo `json:"privateSpace,omitempty"`
	CommunitySpace         *SpaceInfo `json:"communitySpace,omitempty"`
	CommunityReadOnlySpace *SpaceInfo `json:"communityReadOnlySpace,omitempty"`
	AdminSpace             *SpaceInfo `json:"adminSpace,omitempty"`
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

	// Look up community read-only space
	if roSpaceID := h.spaceManager.GetCommunityReadOnlySpaceID(); roSpaceID != "" {
		info := &SpaceInfo{
			SpaceID:   roSpaceID,
			SpaceName: "Community Read-Only",
		}
		client := h.spaceManager.GetClient()
		if client != nil {
			if _, keyErr := anysync.LoadSpaceKeySet(client.GetDataDir(), roSpaceID); keyErr == nil {
				info.KeysAvailable = true
			}
		}
		resp.CommunityReadOnlySpace = info
	}

	// Look up admin space
	if adminSpaceID := h.spaceManager.GetAdminSpaceID(); adminSpaceID != "" {
		info := &SpaceInfo{
			SpaceID:   adminSpaceID,
			SpaceName: "Admin",
		}
		client := h.spaceManager.GetClient()
		if client != nil {
			if _, keyErr := anysync.LoadSpaceKeySet(client.GetDataDir(), adminSpaceID); keyErr == nil {
				info.KeysAvailable = true
			}
		}
		resp.AdminSpace = info
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
		// Verify the space still exists on the network (e.g. after any-sync restart).
		// MakeSpaceShareable talks to the coordinator — if it fails the space is gone.
		client := h.spaceManager.GetClient()
		spaceValid := false
		if client != nil {
			if verifyErr := client.MakeSpaceShareable(r.Context(), existingSpace.SpaceID); verifyErr == nil {
				spaceValid = true
			} else {
				fmt.Printf("[CreateCommunity] Cached space %s no longer valid: %v — will recreate\n", existingSpace.SpaceID, verifyErr)
			}
		}
		if spaceValid {
			writeJSON(w, http.StatusOK, CreateCommunityResponse{
				Success:          true,
				CommunitySpaceID: existingSpace.SpaceID,
				ReadOnlySpaceID:  h.spaceManager.GetCommunityReadOnlySpaceID(),
				AdminSpaceID:     h.spaceManager.GetAdminSpaceID(),
				SpaceID:          existingSpace.SpaceID, // backward compat
			})
			return
		}
		// Clear stale cached IDs so we fall through to recreation
		h.spaceManager.SetCommunitySpaceID("")
		h.spaceManager.SetCommunityReadOnlySpaceID("")
		h.spaceManager.SetAdminSpaceID("")
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

	// Use the peer key as the space signing key so the SDK client's account
	// identity (peer key) matches the ACL owner. This ensures ACL operations
	// like BuildInviteAnyone succeed when the admin creates invites later.
	keys.SigningKey = client.GetSigningKey()

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

	// Collect seeded objects across all spaces
	var allObjects []CreatedObject

	// Seed community space with type definition + admin SharedProfile
	if req.AdminAID != "" {
		communityObjects, seedErr := h.seedSpace(ctx, result.SpaceID, types.SharedProfileType(), map[string]interface{}{
			"aid":         req.AdminAID,
			"displayName": req.AdminName,
			"bio":         "",
			"publicEmail": req.AdminEmail,
			"avatar":      req.AdminAvatar,
			"lastActiveAt": time.Now().UTC().Format(time.RFC3339),
			"createdAt":    time.Now().UTC().Format(time.RFC3339),
			"updatedAt":    time.Now().UTC().Format(time.RFC3339),
			"typeVersion":  1,
		}, fmt.Sprintf("SharedProfile-%s", req.AdminAID))
		if seedErr != nil {
			fmt.Printf("Warning: failed to seed community space: %v\n", seedErr)
		} else {
			allObjects = append(allObjects, communityObjects...)
		}
	}

	// Create community read-only space (key derivation index 2)
	roKeys, err := anysync.DeriveSpaceKeySet(mnemonic, 2)
	if err != nil {
		fmt.Printf("Warning: failed to derive community-readonly space keys: %v\n", err)
	} else {
		roKeys.SigningKey = client.GetSigningKey()
		roResult, err := client.CreateSpaceWithKeys(ctx, req.OrgAID, anysync.SpaceTypeCommunityReadOnly, roKeys)
		if err != nil {
			fmt.Printf("Warning: failed to create community-readonly space: %v\n", err)
		} else {
			if err := client.MakeSpaceShareable(ctx, roResult.SpaceID); err != nil {
				fmt.Printf("Warning: failed to make community-readonly space shareable: %v\n", err)
			}
			roSpace := &anysync.Space{
				SpaceID:   roResult.SpaceID,
				OwnerAID:  req.OrgAID,
				SpaceType: anysync.SpaceTypeCommunityReadOnly,
				SpaceName: req.OrgName + " Community (Read-Only)",
				CreatedAt: roResult.CreatedAt,
				LastSync:  roResult.CreatedAt,
			}
			if err := h.spaceStore.SaveSpace(ctx, roSpace); err != nil {
				fmt.Printf("Warning: failed to save community-readonly space record: %v\n", err)
			}
			h.spaceManager.SetCommunityReadOnlySpaceID(roResult.SpaceID)
			if h.userIdentity != nil {
				if err := h.userIdentity.SetCommunityReadOnlySpaceID(roResult.SpaceID); err != nil {
					fmt.Printf("Warning: failed to persist community-readonly space ID: %v\n", err)
				}
			}

			// Seed readonly space with CommunityProfile type def + admin's CommunityProfile
			if req.AdminAID != "" {
				now := time.Now().UTC().Format(time.RFC3339)
				roObjects, seedErr := h.seedSpace(ctx, roResult.SpaceID, types.CommunityProfileType(), map[string]interface{}{
					"userAID":    req.AdminAID,
					"credential": req.CredentialSAID,
					"role":       "Operations Steward",
					"memberSince": now,
					"lastActiveAt": now,
					"credentials":  []string{req.CredentialSAID},
					"permissions":  []string{"participate", "vote", "propose"},
				}, fmt.Sprintf("CommunityProfile-%s", req.AdminAID))
				if seedErr != nil {
					fmt.Printf("Warning: failed to seed community-readonly space: %v\n", seedErr)
				} else {
					allObjects = append(allObjects, roObjects...)
				}

				// Seed readonly space with OrgProfile type def + Matou OrgProfile
				orgProfileObjects, orgSeedErr := h.seedSpace(ctx, roResult.SpaceID, types.OrgProfileType(), map[string]interface{}{
					"communityName": req.OrgName,
					"contactEmail":  req.AdminEmail,
					"logo":          req.AdminAvatar,
					"createdAt":     now,
				}, fmt.Sprintf("OrgProfile-%s", req.OrgAID))
				if orgSeedErr != nil {
					fmt.Printf("Warning: failed to seed OrgProfile: %v\n", orgSeedErr)
				} else {
					allObjects = append(allObjects, orgProfileObjects...)
				}
			}
		}
	}

	// Create admin space (key derivation index 3)
	adminKeys, err := anysync.DeriveSpaceKeySet(mnemonic, 3)
	if err != nil {
		fmt.Printf("Warning: failed to derive admin space keys: %v\n", err)
	} else {
		adminKeys.SigningKey = client.GetSigningKey()
		adminResult, err := client.CreateSpaceWithKeys(ctx, req.OrgAID, anysync.SpaceTypeAdmin, adminKeys)
		if err != nil {
			fmt.Printf("Warning: failed to create admin space: %v\n", err)
		} else {
			if err := client.MakeSpaceShareable(ctx, adminResult.SpaceID); err != nil {
				fmt.Printf("Warning: failed to make admin space shareable: %v\n", err)
			}
			adminSpace := &anysync.Space{
				SpaceID:   adminResult.SpaceID,
				OwnerAID:  req.OrgAID,
				SpaceType: anysync.SpaceTypeAdmin,
				SpaceName: req.OrgName + " Admin",
				CreatedAt: adminResult.CreatedAt,
				LastSync:  adminResult.CreatedAt,
			}
			if err := h.spaceStore.SaveSpace(ctx, adminSpace); err != nil {
				fmt.Printf("Warning: failed to save admin space record: %v\n", err)
			}
			h.spaceManager.SetAdminSpaceID(adminResult.SpaceID)
			if h.userIdentity != nil {
				if err := h.userIdentity.SetAdminSpaceID(adminResult.SpaceID); err != nil {
					fmt.Printf("Warning: failed to persist admin space ID: %v\n", err)
				}
			}
		}
	}

	writeJSON(w, http.StatusOK, CreateCommunityResponse{
		Success:          true,
		CommunitySpaceID: result.SpaceID,
		ReadOnlySpaceID:  h.spaceManager.GetCommunityReadOnlySpaceID(),
		AdminSpaceID:     h.spaceManager.GetAdminSpaceID(),
		Objects:          allObjects,
		SpaceID:          result.SpaceID, // backward compat
	})
}

// seedSpace writes a type definition and an initial profile object into a space's ObjectTree.
func (h *SpacesHandler) seedSpace(ctx context.Context, spaceID string, typeDef *types.TypeDefinition, profileData map[string]interface{}, profileObjectID string) ([]CreatedObject, error) {
	client := h.spaceManager.GetClient()
	if client == nil {
		return nil, fmt.Errorf("any-sync client not available")
	}

	keys, err := anysync.LoadSpaceKeySet(client.GetDataDir(), spaceID)
	if err != nil {
		return nil, fmt.Errorf("failed to load space keys for %s: %w", spaceID, err)
	}

	objMgr := h.spaceManager.ObjectTreeManager()
	var objects []CreatedObject

	// 1. Write type definition
	typeDefBytes, err := json.Marshal(typeDef)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal type definition: %w", err)
	}
	typeDefID := fmt.Sprintf("typedef-%s-%d", typeDef.Name, time.Now().UnixMilli())
	typePayload := &anysync.ObjectPayload{
		ID:        typeDefID,
		Type:      "type_definition",
		Data:      typeDefBytes,
		Timestamp: time.Now().Unix(),
		Version:   1,
	}
	headID, err := objMgr.AddObject(ctx, spaceID, typePayload, keys.SigningKey)
	if err != nil {
		fmt.Printf("Warning: failed to write type definition %s to space %s: %v\n", typeDef.Name, spaceID, err)
	} else {
		objects = append(objects, CreatedObject{SpaceID: spaceID, ObjectID: typeDefID, HeadID: headID, Type: "type_definition"})
	}

	// 2. Write profile object
	profileBytes, err := json.Marshal(profileData)
	if err != nil {
		return objects, fmt.Errorf("failed to marshal profile data: %w", err)
	}
	profilePayload := &anysync.ObjectPayload{
		ID:        profileObjectID,
		Type:      typeDef.Name,
		Data:      profileBytes,
		Timestamp: time.Now().Unix(),
		Version:   1,
	}
	headID2, err := objMgr.AddObject(ctx, spaceID, profilePayload, keys.SigningKey)
	if err != nil {
		fmt.Printf("Warning: failed to write %s to space %s: %v\n", typeDef.Name, spaceID, err)
	} else {
		objects = append(objects, CreatedObject{SpaceID: spaceID, ObjectID: profileObjectID, HeadID: headID2, Type: typeDef.Name})
	}

	return objects, nil
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

	// Ensure the space is shareable on the coordinator (idempotent; needed
	// after SDK reinit because the new client connection doesn't carry the
	// previous registration).
	client := h.spaceManager.GetClient()
	if client != nil {
		if err := client.MakeSpaceShareable(ctx, communitySpace.SpaceID); err != nil {
			fmt.Printf("[Invite] Warning: MakeSpaceShareable: %v\n", err)
		}
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

	resp := InviteResponse{
		Success:          true,
		CommunitySpaceID: communitySpace.SpaceID,
		InviteKey:        base64.StdEncoding.EncodeToString(inviteKeyBytes),
	}

	// Also generate a community-readonly invite key (Reader permissions)
	roSpaceID := h.spaceManager.GetCommunityReadOnlySpaceID()
	if roSpaceID != "" {
		roInviteKey, roErr := aclMgr.CreateOpenInvite(ctx, roSpaceID, list.AclPermissionsReader)
		if roErr != nil {
			fmt.Printf("Warning: failed to create community-readonly invite: %v\n", roErr)
		} else {
			roKeyBytes, roMarshalErr := roInviteKey.Marshall()
			if roMarshalErr == nil {
				resp.ReadOnlyInviteKey = base64.StdEncoding.EncodeToString(roKeyBytes)
				resp.ReadOnlySpaceID = roSpaceID
			}
		}
	}

	writeJSON(w, http.StatusOK, resp)
}

// JoinCommunityRequest represents a request to join the community space
type JoinCommunityRequest struct {
	UserAID            string `json:"userAid"`
	InviteKey          string `json:"inviteKey"`                    // base64-encoded invite private key
	SpaceID            string `json:"spaceId,omitempty"`            // community space ID (fallback if not configured locally)
	ReadOnlyInviteKey  string `json:"readOnlyInviteKey,omitempty"`  // base64-encoded community-readonly invite key
	ReadOnlySpaceID    string `json:"readOnlySpaceId,omitempty"`    // community-readonly space ID
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
	if err != nil && req.SpaceID != "" {
		// Space not configured locally — use the provided ID from the invite
		h.spaceManager.SetCommunitySpaceID(req.SpaceID)
		communitySpace, err = h.spaceManager.GetCommunitySpace(ctx)
	}
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

	// In per-user mode the SDK client already has the user's peer key
	// (set via HandleSetIdentity → Reinitialize), so we use it directly.
	client := h.spaceManager.GetClient()
	if client == nil {
		writeJSON(w, http.StatusServiceUnavailable, JoinCommunityResponse{
			Success: false,
			Error:   "any-sync client not available",
		})
		return
	}

	// Ensure the space is shareable on the coordinator (required before join)
	if err := client.MakeSpaceShareable(ctx, communitySpace.SpaceID); err != nil {
		fmt.Printf("[JoinCommunity] Warning: MakeSpaceShareable: %v\n", err)
	}

	aclMgr := h.spaceManager.ACLManager()
	metadata := []byte(fmt.Sprintf(`{"aid":"%s","joinedAt":"%s"}`, req.UserAID, time.Now().UTC().Format(time.RFC3339)))

	if err := aclMgr.JoinWithInvite(ctx, communitySpace.SpaceID, invitePrivKey, metadata); err != nil {
		writeJSON(w, http.StatusInternalServerError, JoinCommunityResponse{
			Success: false,
			Error:   fmt.Sprintf("failed to join community: %v", err),
		})
		return
	}

	// Wait for initial sync to complete so member sees existing data
	if treeMgr := h.spaceManager.TreeManager(); treeMgr != nil {
		if err := treeMgr.WaitForSync(ctx, communitySpace.SpaceID, 1, 30*time.Second); err != nil {
			fmt.Printf("[JoinCommunity] WaitForSync warning for space %s: %v\n", communitySpace.SpaceID, err)
			// Don't fail — data will arrive via next HeadSync cycle
		}
	}

	// Generate and persist space keys so this backend can write objects
	// (e.g. SharedProfile) to the community space. Each member gets their
	// own signing key; the ACL authorizes writes based on peer identity.
	dataDir := client.GetDataDir()
	communityKeys, err := anysync.GenerateSpaceKeySet()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, JoinCommunityResponse{
			Success: false,
			Error:   fmt.Sprintf("failed to generate community space keys: %v", err),
		})
		return
	}
	// Use the peer key as the signing key so ObjectTree writes are authorized
	// by the ACL (which registered the peer key during JoinWithInvite).
	communityKeys.SigningKey = client.GetSigningKey()
	if err := anysync.PersistSpaceKeySet(dataDir, communitySpace.SpaceID, communityKeys); err != nil {
		writeJSON(w, http.StatusInternalServerError, JoinCommunityResponse{
			Success: false,
			Error:   fmt.Sprintf("failed to persist community space keys: %v", err),
		})
		return
	}
	fmt.Printf("[JoinCommunity] Generated and persisted space keys for community space %s\n", communitySpace.SpaceID)

	// Also join community-readonly space if invite key is provided
	log.Printf("[JoinCommunity] readOnly check: key=%v spaceID=%q", req.ReadOnlyInviteKey != "", req.ReadOnlySpaceID)
	if req.ReadOnlyInviteKey != "" && req.ReadOnlySpaceID != "" {
		roKeyBytes, roErr := base64.StdEncoding.DecodeString(req.ReadOnlyInviteKey)
		if roErr != nil {
			log.Printf("[JoinCommunity] readOnly base64 decode error: %v", roErr)
		} else {
			roPrivKey, roUnmarshalErr := crypto.UnmarshalEd25519PrivateKeyProto(roKeyBytes)
			if roUnmarshalErr != nil {
				log.Printf("[JoinCommunity] readOnly key unmarshal error: %v", roUnmarshalErr)
			} else {
				if joinErr := aclMgr.JoinWithInvite(ctx, req.ReadOnlySpaceID, roPrivKey, metadata); joinErr != nil {
					log.Printf("[JoinCommunity] WARNING: failed to join community-readonly space: %v", joinErr)
				} else {
					h.spaceManager.SetCommunityReadOnlySpaceID(req.ReadOnlySpaceID)
					log.Printf("[JoinCommunity] User %s joined community-readonly space %s", req.UserAID, req.ReadOnlySpaceID)

					// Wait for initial sync of readonly space (same as community space above)
					if treeMgr := h.spaceManager.TreeManager(); treeMgr != nil {
						log.Printf("[JoinCommunity] calling WaitForSync for readonly space %s", req.ReadOnlySpaceID)
						if waitErr := treeMgr.WaitForSync(ctx, req.ReadOnlySpaceID, 1, 30*time.Second); waitErr != nil {
							log.Printf("[JoinCommunity] WaitForSync warning for readonly space %s: %v", req.ReadOnlySpaceID, waitErr)
						} else {
							log.Printf("[JoinCommunity] WaitForSync OK for readonly space %s", req.ReadOnlySpaceID)
						}
					} else {
						log.Printf("[JoinCommunity] TreeManager is nil — skipping WaitForSync for readonly space")
					}

					// Persist keys for the readonly space too
					roKeys, roKeyGenErr := anysync.GenerateSpaceKeySet()
					if roKeyGenErr == nil {
						roKeys.SigningKey = client.GetSigningKey()
						if roPersistErr := anysync.PersistSpaceKeySet(dataDir, req.ReadOnlySpaceID, roKeys); roPersistErr != nil {
							log.Printf("[JoinCommunity] Warning: failed to persist readonly space keys: %v", roPersistErr)
						} else {
							log.Printf("[JoinCommunity] Generated and persisted space keys for readonly space %s", req.ReadOnlySpaceID)
						}
					}
				}
			}
		}
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

// HandleCommunityReadOnlyInvite handles POST /api/v1/spaces/community-readonly/invite
// Generates a Reader invite key for the community-readonly space.
func (h *SpacesHandler) HandleCommunityReadOnlyInvite(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, InviteResponse{
			Success: false,
			Error:   "method not allowed",
		})
		return
	}

	ctx := r.Context()
	roSpaceID := h.spaceManager.GetCommunityReadOnlySpaceID()
	if roSpaceID == "" {
		writeJSON(w, http.StatusConflict, InviteResponse{
			Success: false,
			Error:   "community-readonly space not configured",
		})
		return
	}

	aclMgr := h.spaceManager.ACLManager()
	inviteKey, err := aclMgr.CreateOpenInvite(ctx, roSpaceID, list.AclPermissionsReader)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, InviteResponse{
			Success: false,
			Error:   fmt.Sprintf("failed to create readonly invite: %v", err),
		})
		return
	}

	inviteKeyBytes, err := inviteKey.Marshall()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, InviteResponse{
			Success: false,
			Error:   fmt.Sprintf("failed to marshal invite key: %v", err),
		})
		return
	}

	writeJSON(w, http.StatusOK, InviteResponse{
		Success:         true,
		ReadOnlySpaceID: roSpaceID,
		ReadOnlyInviteKey: base64.StdEncoding.EncodeToString(inviteKeyBytes),
	})
}

// SyncStatusResponse reports sync readiness for the user's spaces.
type SyncStatusResponse struct {
	Community SpaceSyncStatus `json:"community"`
	ReadOnly  SpaceSyncStatus `json:"readOnly"`
	Ready     bool            `json:"ready"`
}

// SyncMetrics reports P2P sync activity for a space.
type SyncMetrics struct {
	TreesChanged  int `json:"treesChanged"`  // number of locally changed trees
	HeadsReceived int `json:"headsReceived"` // total head receive events from peers
	HeadsApplied  int `json:"headsApplied"`  // total head apply events (successful merges)
}

// SpaceSyncStatus describes the sync state of a single space.
type SpaceSyncStatus struct {
	SpaceID       string       `json:"spaceId,omitempty"`
	HasObjectTree bool         `json:"hasObjectTree"`
	ObjectCount   int          `json:"objectCount"`
	ProfileCount  int          `json:"profileCount"`
	Sync          *SyncMetrics `json:"sync,omitempty"`
}

// HandleSyncStatus handles GET /api/v1/spaces/sync-status.
// Returns sync readiness for community and readonly spaces by checking
// whether ObjectTrees have been synced and how many objects exist.
func (h *SpacesHandler) HandleSyncStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	ctx := r.Context()
	objMgr := h.spaceManager.ObjectTreeManager()
	treeMgr := h.spaceManager.TreeManager()
	resp := SyncStatusResponse{}

	// Re-scan space indexes to pick up trees that arrived via sync since last poll.
	// BuildSpaceIndex is idempotent — it skips already-indexed trees.
	if treeMgr != nil {
		ctx := r.Context()
		if cid := h.spaceManager.GetCommunitySpaceID(); cid != "" {
			_ = treeMgr.BuildSpaceIndex(ctx, cid)
		}
		if rid := h.spaceManager.GetCommunityReadOnlySpaceID(); rid != "" {
			_ = treeMgr.BuildSpaceIndex(ctx, rid)
		}
	}

	// Check community (writable) space
	communitySpaceID := h.spaceManager.GetCommunitySpaceID()
	if communitySpaceID != "" {
		resp.Community.SpaceID = communitySpaceID
		if treeMgr != nil {
			// Re-scan storage for newly arrived trees (from sync workers)
			_ = treeMgr.BuildSpaceIndex(ctx, communitySpaceID)
			entries := treeMgr.GetTreesForSpace(communitySpaceID)
			resp.Community.HasObjectTree = len(entries) > 0
			resp.Community.ObjectCount = len(entries)
			for _, entry := range entries {
				if entry.ObjectType == "SharedProfile" || entry.ObjectType == "CommunityProfile" {
					resp.Community.ProfileCount++
				}
			}
			if ss := treeMgr.GetSyncStatus(communitySpaceID); ss != nil {
				changed, received, applied := ss.GetStatus()
				resp.Community.Sync = &SyncMetrics{
					TreesChanged:  changed,
					HeadsReceived: received,
					HeadsApplied:  applied,
				}
			}
		} else {
			resp.Community.HasObjectTree = objMgr.HasObjectTree(ctx, communitySpaceID)
			if resp.Community.HasObjectTree {
				if objects, err := objMgr.ReadObjects(ctx, communitySpaceID); err == nil {
					resp.Community.ObjectCount = len(objects)
					for _, obj := range objects {
						if obj.Type == "SharedProfile" || obj.Type == "CommunityProfile" {
							resp.Community.ProfileCount++
						}
					}
				}
			}
		}
	}

	// Check community read-only space
	roSpaceID := h.spaceManager.GetCommunityReadOnlySpaceID()
	if roSpaceID != "" {
		resp.ReadOnly.SpaceID = roSpaceID
		if treeMgr != nil {
			// Re-scan storage for newly arrived trees (from sync workers)
			_ = treeMgr.BuildSpaceIndex(ctx, roSpaceID)
			entries := treeMgr.GetTreesForSpace(roSpaceID)
			resp.ReadOnly.HasObjectTree = len(entries) > 0
			resp.ReadOnly.ObjectCount = len(entries)
			for _, entry := range entries {
				if entry.ObjectType == "CommunityProfile" || entry.ObjectType == "OrgProfile" {
					resp.ReadOnly.ProfileCount++
				}
			}
			if ss := treeMgr.GetSyncStatus(roSpaceID); ss != nil {
				changed, received, applied := ss.GetStatus()
				resp.ReadOnly.Sync = &SyncMetrics{
					TreesChanged:  changed,
					HeadsReceived: received,
					HeadsApplied:  applied,
				}
			}
		} else {
			resp.ReadOnly.HasObjectTree = objMgr.HasObjectTree(ctx, roSpaceID)
			if resp.ReadOnly.HasObjectTree {
				if objects, err := objMgr.ReadObjects(ctx, roSpaceID); err == nil {
					resp.ReadOnly.ObjectCount = len(objects)
					for _, obj := range objects {
						if obj.Type == "CommunityProfile" || obj.Type == "OrgProfile" {
							resp.ReadOnly.ProfileCount++
						}
					}
				}
			}
		}
	}

	resp.Ready = resp.Community.HasObjectTree && resp.ReadOnly.HasObjectTree

	// Log detailed entry info for debugging
	if communitySpaceID != "" && treeMgr != nil {
		entries := treeMgr.GetTreesForSpace(communitySpaceID)
		for i, e := range entries {
			log.Printf("[SyncStatus] community entry[%d]: treeId=%s objectId=%s objectType=%s changeType=%s",
				i, e.TreeID, e.ObjectID, e.ObjectType, e.ChangeType)
		}
	}
	if roSpaceID != "" && treeMgr != nil {
		roEntries := treeMgr.GetTreesForSpace(roSpaceID)
		for i, e := range roEntries {
			log.Printf("[SyncStatus] readOnly entry[%d]: treeId=%s objectId=%s objectType=%s changeType=%s",
				i, e.TreeID, e.ObjectID, e.ObjectType, e.ChangeType)
		}
	}
	log.Printf("[SyncStatus] community={has=%v obj=%d prof=%d} readOnly={has=%v obj=%d prof=%d} ready=%v",
		resp.Community.HasObjectTree, resp.Community.ObjectCount, resp.Community.ProfileCount,
		resp.ReadOnly.HasObjectTree, resp.ReadOnly.ObjectCount, resp.ReadOnly.ProfileCount,
		resp.Ready)

	writeJSON(w, http.StatusOK, resp)
}

// RegisterRoutes registers space routes on the mux
func (h *SpacesHandler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/v1/spaces/community", h.handleCommunitySpace)
	mux.HandleFunc("/api/v1/spaces/community/invite", h.HandleInvite)
	mux.HandleFunc("/api/v1/spaces/community/join", h.HandleJoinCommunity)
	mux.HandleFunc("/api/v1/spaces/community/verify-access", h.handleVerifyAccess)
	mux.HandleFunc("/api/v1/spaces/community-readonly/invite", h.HandleCommunityReadOnlyInvite)
	mux.HandleFunc("/api/v1/spaces/private", h.HandleCreatePrivate)
	mux.HandleFunc("/api/v1/spaces/user", h.HandleGetUserSpaces)
	mux.HandleFunc("/api/v1/spaces/sync-status", h.HandleSyncStatus)
}

// truncateAID returns the first 12 characters of an AID for display purposes
func truncateAID(aid string) string {
	if len(aid) > 12 {
		return aid[:12]
	}
	return aid
}
