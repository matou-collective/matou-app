package api

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/matou-dao/backend/internal/anysync"
	"github.com/matou-dao/backend/internal/identity"
)

// IdentityHandler handles identity-related HTTP requests for per-user mode.
type IdentityHandler struct {
	userIdentity *identity.UserIdentity
	sdkClient    *anysync.SDKClient
	spaceManager *anysync.SpaceManager
	spaceStore   anysync.SpaceStore
}

// NewIdentityHandler creates a new identity handler.
func NewIdentityHandler(
	userIdentity *identity.UserIdentity,
	sdkClient *anysync.SDKClient,
	spaceManager *anysync.SpaceManager,
	spaceStore anysync.SpaceStore,
) *IdentityHandler {
	return &IdentityHandler{
		userIdentity: userIdentity,
		sdkClient:    sdkClient,
		spaceManager: spaceManager,
		spaceStore:   spaceStore,
	}
}

// SetIdentityRequest is the request body for POST /api/v1/identity/set.
type SetIdentityRequest struct {
	AID              string `json:"aid"`
	Mnemonic         string `json:"mnemonic"`
	OrgAID           string `json:"orgAid,omitempty"`
	CommunitySpaceID string `json:"communitySpaceId,omitempty"`
}

// SetIdentityResponse is the response for POST /api/v1/identity/set.
type SetIdentityResponse struct {
	Success        bool   `json:"success"`
	PeerID         string `json:"peerId,omitempty"`
	PrivateSpaceID string `json:"privateSpaceId,omitempty"`
	Error          string `json:"error,omitempty"`
}

// GetIdentityResponse is the response for GET /api/v1/identity.
type GetIdentityResponse struct {
	Configured       bool   `json:"configured"`
	AID              string `json:"aid,omitempty"`
	PeerID           string `json:"peerId,omitempty"`
	OrgAID           string `json:"orgAid,omitempty"`
	CommunitySpaceID string `json:"communitySpaceId,omitempty"`
	PrivateSpaceID   string `json:"privateSpaceId,omitempty"`
}

// HandleSetIdentity handles POST /api/v1/identity/set.
// This endpoint:
//  1. Persists identity (AID + mnemonic) to disk
//  2. Derives peer key from mnemonic and reinitializes the SDK client
//  3. Updates org config (orgAID, communitySpaceID) if provided
//  4. Auto-creates the user's private space
//  5. Returns the new peer ID and private space ID
func (h *IdentityHandler) HandleSetIdentity(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, SetIdentityResponse{
			Error: "method not allowed",
		})
		return
	}

	var req SetIdentityRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, SetIdentityResponse{
			Error: fmt.Sprintf("invalid request: %v", err),
		})
		return
	}

	if req.AID == "" || req.Mnemonic == "" {
		writeJSON(w, http.StatusBadRequest, SetIdentityResponse{
			Error: "aid and mnemonic are required",
		})
		return
	}

	// Validate mnemonic
	if err := anysync.ValidateMnemonic(req.Mnemonic); err != nil {
		writeJSON(w, http.StatusBadRequest, SetIdentityResponse{
			Error: fmt.Sprintf("invalid mnemonic: %v", err),
		})
		return
	}

	// 1. Persist identity to disk
	if err := h.userIdentity.SetIdentity(req.AID, req.Mnemonic); err != nil {
		writeJSON(w, http.StatusInternalServerError, SetIdentityResponse{
			Error: fmt.Sprintf("failed to persist identity: %v", err),
		})
		return
	}

	// 2. Derive peer key from mnemonic and reinitialize SDK client
	if err := h.sdkClient.Reinitialize(req.Mnemonic); err != nil {
		writeJSON(w, http.StatusInternalServerError, SetIdentityResponse{
			Error: fmt.Sprintf("failed to reinitialize SDK: %v", err),
		})
		return
	}

	newPeerID := h.sdkClient.GetPeerID()
	if err := h.userIdentity.SetPeerID(newPeerID); err != nil {
		fmt.Printf("Warning: failed to persist peer ID: %v\n", err)
	}

	// 3. Update org config if provided
	if req.OrgAID != "" || req.CommunitySpaceID != "" {
		if err := h.userIdentity.SetOrgConfig(req.OrgAID, req.CommunitySpaceID); err != nil {
			fmt.Printf("Warning: failed to persist org config: %v\n", err)
		}
		// Update SpaceManager with runtime config
		if req.CommunitySpaceID != "" {
			h.spaceManager.SetCommunitySpaceID(req.CommunitySpaceID)
		}
		if req.OrgAID != "" {
			h.spaceManager.SetOrgAID(req.OrgAID)
		}
	}

	// 4. Also persist the user's peer key for future join operations
	peerKey := h.sdkClient.GetSigningKey()
	if peerKey != nil {
		if err := anysync.PersistUserPeerKey(h.sdkClient.GetDataDir(), req.AID, peerKey); err != nil {
			fmt.Printf("Warning: failed to persist user peer key: %v\n", err)
		}
	}

	// 5. Auto-create the user's private space with mnemonic-derived keys
	var privateSpaceID string
	ctx := r.Context()

	keys, err := anysync.DeriveSpaceKeySet(req.Mnemonic, 0)
	if err != nil {
		fmt.Printf("Warning: failed to derive space keys: %v\n", err)
	} else {
		result, err := h.sdkClient.CreateSpaceWithKeys(ctx, req.AID, anysync.SpaceTypePrivate, keys)
		if err != nil {
			fmt.Printf("Warning: failed to create private space: %v (may already exist)\n", err)
			// Try to find existing space
			if existing, existErr := h.spaceStore.GetUserSpace(ctx, req.AID); existErr == nil && existing != nil {
				privateSpaceID = existing.SpaceID
			}
		} else {
			privateSpaceID = result.SpaceID

			// Save space record to store
			space := &anysync.Space{
				SpaceID:   result.SpaceID,
				OwnerAID:  req.AID,
				SpaceType: anysync.SpaceTypePrivate,
				SpaceName: fmt.Sprintf("Private Space - %s", truncateAID(req.AID)),
				CreatedAt: result.CreatedAt,
				LastSync:  result.CreatedAt,
			}
			if err := h.spaceStore.SaveSpace(ctx, space); err != nil {
				fmt.Printf("Warning: failed to save private space record: %v\n", err)
			}
		}
	}

	if privateSpaceID != "" {
		if err := h.userIdentity.SetPrivateSpaceID(privateSpaceID); err != nil {
			fmt.Printf("Warning: failed to persist private space ID: %v\n", err)
		}
	}

	writeJSON(w, http.StatusOK, SetIdentityResponse{
		Success:        true,
		PeerID:         newPeerID,
		PrivateSpaceID: privateSpaceID,
	})
}

// HandleGetIdentity handles GET /api/v1/identity.
func (h *IdentityHandler) HandleGetIdentity(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{
			"error": "method not allowed",
		})
		return
	}

	writeJSON(w, http.StatusOK, GetIdentityResponse{
		Configured:       h.userIdentity.IsConfigured(),
		AID:              h.userIdentity.GetAID(),
		PeerID:           h.userIdentity.GetPeerID(),
		OrgAID:           h.userIdentity.GetOrgAID(),
		CommunitySpaceID: h.userIdentity.GetCommunitySpaceID(),
		PrivateSpaceID:   h.userIdentity.GetPrivateSpaceID(),
	})
}

// HandleDeleteIdentity handles DELETE /api/v1/identity.
func (h *IdentityHandler) HandleDeleteIdentity(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{
			"error": "method not allowed",
		})
		return
	}

	if err := h.userIdentity.Clear(); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to clear identity: %v", err),
		})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{
		"status": "identity cleared",
	})
}

// handleIdentity routes identity requests by method.
func (h *IdentityHandler) handleIdentity(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.HandleGetIdentity(w, r)
	case http.MethodDelete:
		h.HandleDeleteIdentity(w, r)
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{
			"error": "method not allowed",
		})
	}
}

// RegisterRoutes registers identity routes on the mux.
func (h *IdentityHandler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/v1/identity/set", h.HandleSetIdentity)
	mux.HandleFunc("/api/v1/identity", h.handleIdentity)
}
