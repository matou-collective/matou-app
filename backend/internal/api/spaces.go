package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/matou-dao/backend/internal/anystore"
	"github.com/matou-dao/backend/internal/anysync"
)

// SpacesHandler handles space-related HTTP requests
type SpacesHandler struct {
	spaceManager *anysync.SpaceManager
	store        *anystore.LocalStore
	spaceStore   anysync.SpaceStore
}

// NewSpacesHandler creates a new spaces handler
func NewSpacesHandler(spaceManager *anysync.SpaceManager, store *anystore.LocalStore) *SpacesHandler {
	return &SpacesHandler{
		spaceManager: spaceManager,
		store:        store,
		spaceStore:   anystore.NewSpaceStoreAdapter(store),
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
	PrivateSpaceID   string `json:"privateSpaceId,omitempty"`
	CommunitySpaceID string `json:"communitySpaceId,omitempty"`
	Error            string `json:"error,omitempty"`
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

	// Create new community space via any-sync client using full key set
	ctx := r.Context()
	client := h.spaceManager.GetClient()
	if client == nil {
		writeJSON(w, http.StatusServiceUnavailable, CreateCommunityResponse{
			Success: false,
			Error:   "any-sync client not available",
		})
		return
	}

	keys, err := anysync.GenerateSpaceKeySet()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, CreateCommunityResponse{
			Success: false,
			Error:   fmt.Sprintf("failed to generate space keys: %v", err),
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

	if req.UserAID == "" {
		writeJSON(w, http.StatusBadRequest, CreatePrivateResponse{
			Success: false,
			Error:   "userAid is required",
		})
		return
	}

	ctx := r.Context()

	// Check if space already exists
	existingSpace, err := h.spaceStore.GetUserSpace(ctx, req.UserAID)
	if err == nil && existingSpace != nil {
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

	// Get or create the user's private space
	privateSpace, err := h.spaceManager.GetOrCreatePrivateSpace(ctx, req.RecipientAID, h.spaceStore)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, InviteResponse{
			Success: false,
			Error:   fmt.Sprintf("failed to get/create private space: %v", err),
		})
		return
	}

	// Add user to community space ACL
	// Note: This requires the user's peer ID, which would be derived from their AID
	client := h.spaceManager.GetClient()
	if client != nil {
		peerID := anysync.GeneratePeerIDFromAID(req.RecipientAID)
		if err := client.AddToACL(ctx, communitySpace.SpaceID, peerID, []string{"read", "write"}); err != nil {
			fmt.Printf("Warning: failed to add user to community ACL: %v\n", err)
		}
	}

	// Route the credential to both spaces
	cred := &anysync.Credential{
		SAID:      req.CredentialSAID,
		Recipient: req.RecipientAID,
		Schema:    req.Schema,
	}

	if _, err := h.spaceManager.RouteCredential(ctx, cred, h.spaceStore); err != nil {
		fmt.Printf("Warning: failed to route credential: %v\n", err)
	}

	writeJSON(w, http.StatusOK, InviteResponse{
		Success:          true,
		PrivateSpaceID:   privateSpace.SpaceID,
		CommunitySpaceID: communitySpace.SpaceID,
	})
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
	mux.HandleFunc("/api/v1/spaces/private", h.HandleCreatePrivate)
}

// truncateAID returns the first 12 characters of an AID for display purposes
func truncateAID(aid string) string {
	if len(aid) > 12 {
		return aid[:12]
	}
	return aid
}
