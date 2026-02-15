package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/matou-dao/backend/internal/anysync"
	"github.com/matou-dao/backend/internal/identity"
	"github.com/matou-dao/backend/internal/types"
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
	ReadOnlySpaceID  string `json:"readOnlySpaceId,omitempty"`
	AdminSpaceID     string `json:"adminSpaceId,omitempty"`
	CredentialSAID   string `json:"credentialSaid,omitempty"`
	Mode             string `json:"mode,omitempty"`
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
	Configured               bool   `json:"configured"`
	AID                      string `json:"aid,omitempty"`
	PeerID                   string `json:"peerId,omitempty"`
	OrgAID                   string `json:"orgAid,omitempty"`
	CommunitySpaceID         string `json:"communitySpaceId,omitempty"`
	CommunityReadOnlySpaceID string `json:"communityReadOnlySpaceId,omitempty"`
	AdminSpaceID             string `json:"adminSpaceId,omitempty"`
	PrivateSpaceID           string `json:"privateSpaceId,omitempty"`
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

	// Refresh the FileManager's pool/nodeconf references — the old pool died
	// when Reinitialize closed the previous app.
	h.spaceManager.RefreshFileManager()

	newPeerID := h.sdkClient.GetPeerID()
	if err := h.userIdentity.SetPeerID(newPeerID); err != nil {
		fmt.Printf("Warning: failed to persist peer ID: %v\n", err)
	}

	log.Printf("[Identity] Set identity: aid=%s, orgAid=%s, communitySpace=%s, readOnlySpace=%s, adminSpace=%s",
		req.AID[:min(16, len(req.AID))], req.OrgAID, req.CommunitySpaceID, req.ReadOnlySpaceID, req.AdminSpaceID)

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

	// 3b. Persist read-only space ID if provided
	if req.ReadOnlySpaceID != "" {
		if err := h.userIdentity.SetCommunityReadOnlySpaceID(req.ReadOnlySpaceID); err != nil {
			fmt.Printf("Warning: failed to persist read-only space ID: %v\n", err)
		}
		h.spaceManager.SetCommunityReadOnlySpaceID(req.ReadOnlySpaceID)
	}

	// 3c. Persist admin space ID if provided
	if req.AdminSpaceID != "" {
		if err := h.userIdentity.SetAdminSpaceID(req.AdminSpaceID); err != nil {
			fmt.Printf("Warning: failed to persist admin space ID: %v\n", err)
		}
		h.spaceManager.SetAdminSpaceID(req.AdminSpaceID)
	}

	// 4. Also persist the user's peer key for future join operations
	peerKey := h.sdkClient.GetSigningKey()
	if peerKey != nil {
		if err := anysync.PersistUserPeerKey(h.sdkClient.GetDataDir(), req.AID, peerKey); err != nil {
			fmt.Printf("Warning: failed to persist user peer key: %v\n", err)
		}
	}

	// 5. Recover or create the user's private space with mnemonic-derived keys
	var privateSpaceID string
	ctx := r.Context()
	client := h.sdkClient
	isClaim := req.Mode == "claim"

	keys, err := anysync.DeriveSpaceKeySet(req.Mnemonic, 0)
	if err != nil {
		log.Printf("[Identity] Failed to derive private space keys: %v", err)
	} else {
		// Derive deterministic space ID from keys (used for recovery lookups)
		derivedID, err := client.DeriveSpaceIDWithKeys(ctx, req.AID, anysync.SpaceTypePrivate, keys)
		if err != nil {
			log.Printf("[Identity] Failed to derive private space ID: %v", err)
		} else {
			// actualID tracks the space ID to use for all downstream operations.
			// After CreateSpaceWithKeys we use its result (the coordinator-assigned
			// ID) instead of derivedID, matching the pattern used by community
			// space creation.
			actualID := derivedID

			if isClaim {
				// Claim mode: create directly, treat failure as hard error
				log.Printf("[Identity] Claim mode: creating private space directly")
				result, createErr := client.CreateSpaceWithKeys(ctx, req.AID, anysync.SpaceTypePrivate, keys)
				if createErr != nil {
					writeJSON(w, http.StatusInternalServerError, SetIdentityResponse{
						Error: fmt.Sprintf("failed to create private space: %v", createErr),
					})
					return
				}
				actualID = result.SpaceID
				if actualID != derivedID {
					fmt.Printf("[Identity] Warning: derived ID %s != created ID %s, using created ID\n", derivedID, actualID)
				}
			} else {
				// Recovery mode: try to recover existing space, fall back to create.
				// Use a short timeout so a slow/unreachable network doesn't block the response.
				recoverCtx, recoverCancel := context.WithTimeout(ctx, 10*time.Second)
				_, getErr := client.GetSpace(recoverCtx, derivedID)
				recoverCancel()
				if getErr != nil {
					log.Printf("[Identity] Private space not on network, creating new: %v", getErr)
					result, createErr := client.CreateSpaceWithKeys(ctx, req.AID, anysync.SpaceTypePrivate, keys)
					if createErr != nil {
						writeJSON(w, http.StatusInternalServerError, SetIdentityResponse{
							Error: fmt.Sprintf("failed to create private space: %v", createErr),
						})
						return
					}
					actualID = result.SpaceID
				} else {
					log.Printf("[Identity] Recovered private space from network: %s", derivedID)
				}
			}
			// Persist keys and space record using the actual space ID
			anysync.PersistSpaceKeySet(client.GetDataDir(), actualID, keys)
			h.spaceStore.SaveSpace(ctx, &anysync.Space{
				SpaceID:   actualID,
				OwnerAID:  req.AID,
				SpaceType: anysync.SpaceTypePrivate,
			})
			h.userIdentity.SetPrivateSpaceID(actualID)
			privateSpaceID = actualID
		}
	}

	if privateSpaceID != "" {
		// Seed private space with PrivateProfile type definition + initial profile
		if seedErr := h.seedPrivateSpace(ctx, privateSpaceID, req.AID, req.CredentialSAID); seedErr != nil {
			if isClaim {
				writeJSON(w, http.StatusInternalServerError, SetIdentityResponse{
					Error: fmt.Sprintf("failed to seed private space: %v", seedErr),
				})
				return
			}
			fmt.Printf("[Identity] Warning: failed to seed private space: %v\n", seedErr)
		}
	}

	// 6. Recover community space (if configured) — skip in claim mode.
	// Only open the space if we have persisted keys (meaning we previously
	// joined or created it). Opening a space we haven't joined triggers
	// HeadSync and consensus connections that fail with "forbidden" because
	// our peer isn't in the ACL yet.
	const spaceRecoverTimeout = 10 * time.Second
	if req.CommunitySpaceID != "" && !isClaim {
		if _, keyErr := anysync.LoadSpaceKeySet(client.GetDataDir(), req.CommunitySpaceID); keyErr != nil {
			fmt.Printf("[Identity] Skipping community space %s recovery (no keys — not yet joined)\n", req.CommunitySpaceID)
		} else {
			communityCtx, communityCancel := context.WithTimeout(ctx, spaceRecoverTimeout)
			_, err := client.GetSpace(communityCtx, req.CommunitySpaceID)
			communityCancel()
			if err != nil {
				fmt.Printf("[Identity] Failed to sync community space %s: %v\n", req.CommunitySpaceID, err)
			} else {
				fmt.Printf("[Identity] Recovered community space: %s\n", req.CommunitySpaceID)
			}
		}
	}

	// 7. Recover read-only space (if configured) — skip in claim mode
	if req.ReadOnlySpaceID != "" && !isClaim {
		if _, keyErr := anysync.LoadSpaceKeySet(client.GetDataDir(), req.ReadOnlySpaceID); keyErr != nil {
			fmt.Printf("[Identity] Skipping readonly space %s recovery (no keys — not yet joined)\n", req.ReadOnlySpaceID)
		} else {
			roCtx, roCancel := context.WithTimeout(ctx, spaceRecoverTimeout)
			_, err := client.GetSpace(roCtx, req.ReadOnlySpaceID)
			roCancel()
			if err != nil {
				fmt.Printf("[Identity] Failed to sync readonly space %s: %v\n", req.ReadOnlySpaceID, err)
			} else {
				fmt.Printf("[Identity] Recovered readonly space: %s\n", req.ReadOnlySpaceID)
			}
		}
	}

	// 8. Recover admin space (if configured) — skip in claim mode
	if adminSpaceID := h.spaceManager.GetAdminSpaceID(); adminSpaceID != "" && !isClaim {
		if _, keyErr := anysync.LoadSpaceKeySet(client.GetDataDir(), adminSpaceID); keyErr != nil {
			fmt.Printf("[Identity] Skipping admin space %s recovery (no keys — not yet joined)\n", adminSpaceID)
		} else {
			adminCtx, adminCancel := context.WithTimeout(ctx, spaceRecoverTimeout)
			_, err := client.GetSpace(adminCtx, adminSpaceID)
			adminCancel()
			if err != nil {
				fmt.Printf("[Identity] Failed to sync admin space %s: %v\n", adminSpaceID, err)
			} else {
				fmt.Printf("[Identity] Recovered admin space: %s\n", adminSpaceID)
			}
		}
	}

	writeJSON(w, http.StatusOK, SetIdentityResponse{
		Success:        true,
		PeerID:         newPeerID,
		PrivateSpaceID: privateSpaceID,
	})
}

// seedPrivateSpace writes the PrivateProfile type definition and an initial
// PrivateProfile into the user's private space. Returns an error if the type
// definition write fails (the initial profile is best-effort).
func (h *IdentityHandler) seedPrivateSpace(ctx context.Context, spaceID, userAID, credentialSAID string) error {
	client := h.sdkClient
	if client == nil {
		return fmt.Errorf("SDK client not available")
	}

	privateKeys, err := anysync.LoadSpaceKeySet(client.GetDataDir(), spaceID)
	if err != nil {
		return fmt.Errorf("loading private space keys: %w", err)
	}

	objMgr := h.spaceManager.ObjectTreeManager()

	// 1. Write type definition — required for profile writes to succeed
	typeDef := types.PrivateProfileType()
	typeDefBytes, err := json.Marshal(typeDef)
	if err != nil {
		return fmt.Errorf("marshaling PrivateProfile type def: %w", err)
	}
	typeDefID := fmt.Sprintf("typedef-PrivateProfile-%d", time.Now().UnixMilli())
	typePayload := &anysync.ObjectPayload{
		ID:        typeDefID,
		Type:      "type_definition",
		Data:      typeDefBytes,
		Timestamp: time.Now().Unix(),
		Version:   1,
	}
	if _, err := objMgr.AddObject(ctx, spaceID, typePayload, privateKeys.SigningKey); err != nil {
		return fmt.Errorf("writing PrivateProfile type def: %w", err)
	}

	// 2. Write initial PrivateProfile (best-effort — credential SAID may not be available yet)
	if credentialSAID == "" {
		return nil
	}
	profileData := map[string]interface{}{
		"membershipCredentialSAID": credentialSAID,
		"privacySettings":          map[string]interface{}{"allowEndorsements": true, "allowDirectMessages": true},
		"appPreferences":           map[string]interface{}{"mode": "light", "language": "es"},
	}
	profileBytes, err := json.Marshal(profileData)
	if err != nil {
		fmt.Printf("[Identity] Warning: failed to marshal PrivateProfile data: %v\n", err)
		return nil
	}
	profilePayload := &anysync.ObjectPayload{
		ID:        fmt.Sprintf("PrivateProfile-%s", userAID),
		Type:      "PrivateProfile",
		Data:      profileBytes,
		Timestamp: time.Now().Unix(),
		Version:   1,
	}
	if _, err := objMgr.AddObject(ctx, spaceID, profilePayload, privateKeys.SigningKey); err != nil {
		fmt.Printf("[Identity] Warning: failed to seed PrivateProfile: %v\n", err)
	}
	return nil
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
		Configured:               h.userIdentity.IsConfigured(),
		AID:                      h.userIdentity.GetAID(),
		PeerID:                   h.userIdentity.GetPeerID(),
		OrgAID:                   h.userIdentity.GetOrgAID(),
		CommunitySpaceID:         h.userIdentity.GetCommunitySpaceID(),
		CommunityReadOnlySpaceID: h.userIdentity.GetCommunityReadOnlySpaceID(),
		AdminSpaceID:             h.userIdentity.GetAdminSpaceID(),
		PrivateSpaceID:           h.userIdentity.GetPrivateSpaceID(),
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
