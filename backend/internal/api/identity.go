package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/matou-dao/backend/internal/anysync"
	"github.com/matou-dao/backend/internal/contributions"
	"github.com/matou-dao/backend/internal/identity"
	"github.com/matou-dao/backend/internal/types"
)

// IdentityHandler handles identity-related HTTP requests for per-user mode.
type IdentityHandler struct {
	userIdentity *identity.UserIdentity
	sdkClient    *anysync.SDKClient
	spaceManager *anysync.SpaceManager
	spaceStore   anysync.SpaceStore
	roleLookup   RoleLookup // nil = RBAC disabled (tests only)
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
	// Retryable marks a failure the caller should wait out and retry rather
	// than treat as terminal. Set on link-mode 503s (space not yet reachable).
	Retryable bool `json:"retryable,omitempty"`
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
			Error: "Method not allowed",
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

	// Clear cached tree instances — old trees hold stale peer keys and ACL state
	// from the previous SDK session.
	h.spaceManager.TreeManager().ClearTreeCache()

	newPeerID := h.sdkClient.GetPeerID()
	if err := h.userIdentity.SetPeerID(newPeerID); err != nil {
		log.Printf("Warning: failed to persist peer ID: %v\n", err)
	}

	log.Printf("[Identity] Set identity: aid=%s, orgAid=%s, communitySpace=%s, readOnlySpace=%s, adminSpace=%s",
		req.AID[:min(16, len(req.AID))], req.OrgAID, req.CommunitySpaceID, req.ReadOnlySpaceID, req.AdminSpaceID)

	// 3. Update org config if provided
	if req.OrgAID != "" || req.CommunitySpaceID != "" {
		if err := h.userIdentity.SetOrgConfig(req.OrgAID, req.CommunitySpaceID); err != nil {
			log.Printf("Warning: failed to persist org config: %v\n", err)
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
			log.Printf("Warning: failed to persist read-only space ID: %v\n", err)
		}
		h.spaceManager.SetCommunityReadOnlySpaceID(req.ReadOnlySpaceID)
	}

	// 3c. Persist admin space ID if provided
	if req.AdminSpaceID != "" {
		if err := h.userIdentity.SetAdminSpaceID(req.AdminSpaceID); err != nil {
			log.Printf("Warning: failed to persist admin space ID: %v\n", err)
		}
		h.spaceManager.SetAdminSpaceID(req.AdminSpaceID)
	}

	// 4. Also persist the user's sign key (ACL identity) for future join operations
	signKey := h.sdkClient.GetSigningKey()
	if signKey != nil {
		if err := anysync.PersistUserSignKey(h.sdkClient.GetDataDir(), req.AID, signKey); err != nil {
			log.Printf("Warning: failed to persist user sign key: %v\n", err)
		}
	}

	// 5. Recover, adopt (link) or create the user's private space with
	// mnemonic-derived keys.
	var privateSpaceID string
	ctx := r.Context()
	client := h.sdkClient
	isClaim := req.Mode == modeClaim
	isLink := req.Mode == modeLink

	keys, err := anysync.DeriveSpaceKeySet(req.Mnemonic, 0)
	if err != nil {
		log.Printf("[Identity] Failed to derive private space keys: %v", err)
	} else {
		outcome, resolveErr := resolvePrivateSpace(ctx, client, req.AID, keys, req.Mode)
		if resolveErr != nil {
			writeJSON(w, http.StatusInternalServerError, SetIdentityResponse{
				Error: fmt.Sprintf("failed to resolve private space: %v", resolveErr),
			})
			return
		}
		if outcome.unreachable {
			// Link mode only: never create a forked private space. Persist
			// nothing for this space and tell the caller to wait and retry.
			log.Printf("[Identity] Link: private space not reachable, adopting nothing")
			writeJSON(w, http.StatusServiceUnavailable, SetIdentityResponse{
				Error:     "private space not reachable",
				Retryable: true,
			})
			return
		}
		// actualID is the coordinator-assigned ID for claim/recovery-create, or
		// the deterministic ID for an adopted (recovered/linked) space.
		actualID := outcome.spaceID
		// Persist keys and space record using the actual space ID. A successful
		// link run writes exactly the same files here as a recovery run.
		_ = anysync.PersistSpaceKeySet(client.GetDataDir(), actualID, keys)
		_ = h.spaceStore.SaveSpace(ctx, &anysync.Space{
			SpaceID:   actualID,
			OwnerAID:  req.AID,
			SpaceType: anysync.SpaceTypePrivate,
		})
		_ = h.userIdentity.SetPrivateSpaceID(actualID)
		privateSpaceID = actualID
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
			log.Printf("[Identity] Warning: failed to seed private space: %v\n", seedErr)
		}
	}

	// 6-8. Adopt the shared spaces (community / read-only / admin) — skip in
	// claim mode. In link mode an unreachable shared space 503s (retryable) and
	// persists nothing, never creating; in recovery mode it re-derives keys and
	// tolerates a sync miss (unchanged behaviour).
	if !isClaim {
		for _, s := range sharedSpacesToAdopt(req.CommunitySpaceID, req.ReadOnlySpaceID, h.spaceManager.GetAdminSpaceID()) {
			if s.id == "" {
				continue
			}
			unreachable, notInACL := h.recoverSharedSpace(ctx, s.id, req.Mnemonic, s.mnemonicIx, s.label, isLink)
			if notInACL {
				// The identity is definitively absent from this shared space's ACL,
				// so it holds no read key and can never derive a working one (#290).
				// No key set was persisted. For the community space that is fatal:
				// fail loudly rather than hand back an identity that 500s on every
				// profile read. For the read-only and admin spaces it is the normal
				// state of a member (only stewards/admins are in the admin ACL), so
				// just skip adoption and carry on.
				if !s.required {
					log.Printf("[Identity] %s space %s: identity is not in its ACL, skipping adoption\n", s.label, s.id)
					continue
				}
				writeJSON(w, http.StatusConflict, SetIdentityResponse{
					Error: fmt.Sprintf("cannot recover %s space %s: identity is not in its ACL (no read key)", s.label, s.id),
				})
				return
			}
			if unreachable {
				log.Printf("[Identity] Link: %s space %s not reachable, adopting nothing", s.label, s.id)
				writeJSON(w, http.StatusServiceUnavailable, SetIdentityResponse{
					Error:     fmt.Sprintf("%s space not reachable", s.label),
					Retryable: true,
				})
				return
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
		log.Printf("[Identity] Warning: failed to marshal PrivateProfile data: %v\n", err)
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
		log.Printf("[Identity] Warning: failed to seed PrivateProfile: %v\n", err)
	}
	return nil
}

// HandleGetIdentity handles GET /api/v1/identity.
func (h *IdentityHandler) HandleGetIdentity(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{
			"error": "Method not allowed",
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
			"error": "Method not allowed",
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

// HandleTestReset handles POST /api/v1/test/reset — a TEST-ONLY endpoint that
// wipes the backend identity and forgets the community / read-only / admin
// space IDs, so an e2e `org-setup` RETRY starts from a genuinely clean backend
// instead of inheriting the previous attempt's community space (issue #502).
//
// Without this, a retried org-setup creates a fresh admin AID but the backend
// keeps attempt 1's identity — the new admin's DELETE/POST /api/v1/identity is
// denied ("not the identity owner"), so no new community space is ever created
// and every SharedProfile write into the inherited space fails with "missing
// current read key", poisoning the whole run's registration-member project.
//
// It bypasses the identity-owner/RBAC gate on the normal identity routes BY
// DESIGN: the point is that the retry's new admin is not the previous owner.
// That is safe only because this route is registered ONLY when MATOU_ENV=test
// (see RegisterTestResetRoute / app.go); it does not exist in dev, bundled or
// production, so there is no way to reach it there.
func (h *IdentityHandler) HandleTestReset(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method not allowed"})
		return
	}

	if err := h.userIdentity.Clear(); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to clear identity: %v", err),
		})
		return
	}

	// Forget the shared-space IDs the previous attempt's admin seeded so the
	// next org-setup creates brand-new ones. UserIdentity.Clear() already reset
	// the persisted copies; this resets the in-memory SpaceManager runtime
	// config that survives independently. The orphaned space data left in the
	// any-sync store is harmless — no identity references it any more.
	if h.spaceManager != nil {
		h.spaceManager.SetCommunitySpaceID("")
		h.spaceManager.SetCommunityReadOnlySpaceID("")
		h.spaceManager.SetAdminSpaceID("")
		h.spaceManager.SetOrgAID("")
	}

	log.Println("[Identity] TEST reset: cleared identity and forgot community/read-only/admin spaces")
	writeJSON(w, http.StatusOK, map[string]string{"status": "reset"})
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
			"error": "Method not allowed",
		})
	}
}

// RegisterRoutes registers identity routes on the mux.
// roleLookup gates POST /api/v1/identity/set and DELETE /api/v1/identity once
// an identity exists; pass nil to skip auth (tests only).
func (h *IdentityHandler) RegisterRoutes(mux *http.ServeMux, roleLookup RoleLookup) {
	requireRoleLookup("IdentityHandler", roleLookup)
	h.roleLookup = roleLookup
	mux.HandleFunc("/api/v1/identity/set", h.withBootstrapRBAC(h.HandleSetIdentity))
	mux.HandleFunc("/api/v1/identity", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			h.withBootstrapRBAC(h.HandleDeleteIdentity)(w, r)
			return
		}
		h.handleIdentity(w, r)
	})
}

// RegisterTestResetRoute registers the TEST-ONLY POST /api/v1/test/reset route.
// The caller MUST guard this with a test-mode check (opts.IsTest()); it is never
// registered in dev, bundled or production, so the un-authenticated reset is
// unreachable outside e2e. See HandleTestReset for why it bypasses RBAC.
func (h *IdentityHandler) RegisterTestResetRoute(mux *http.ServeMux) {
	mux.HandleFunc("/api/v1/test/reset", h.HandleTestReset)
}

// withBootstrapRBAC applies the bootstrap rule for identity writes:
//
//   - No identity configured yet (first run / after DELETE): allowed without
//     X-User-AID. This is the onboarding path — the backend has no owner and
//     no roles to check.
//   - Identity configured: the caller must authenticate and either be the
//     current owner (X-User-AID == the configured AID; the app re-sets its
//     own identity on boot and in the welcome checks, and a plain Member must
//     be able to do that on their own backend) or hold ActionSetIdentity
//     (Operations Steward / Founding Member). Anyone else re-pointing the
//     backend at a different AID is refused with 403.
func (h *IdentityHandler) withBootstrapRBAC(handler http.HandlerFunc) http.HandlerFunc {
	if h.roleLookup == nil {
		return handler
	}
	return func(w http.ResponseWriter, r *http.Request) {
		if h.userIdentity == nil || !h.userIdentity.IsConfigured() {
			log.Printf("[Identity] bootstrap: accepting %s %s without RBAC (no identity configured yet)", r.Method, r.URL.Path)
			handler(w, r)
			return
		}
		RBACMiddleware(h.roleLookup, func(w http.ResponseWriter, r *http.Request) {
			caller := GetUserAID(r)
			if caller == h.userIdentity.GetAID() || contributions.CanPerformAction(GetUserRoles(r), contributions.ActionSetIdentity) {
				handler(w, r)
				return
			}
			log.Printf("[Identity] %s %s denied for %s: not the identity owner and lacks %s", r.Method, r.URL.Path, caller, contributions.ActionSetIdentity)
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "insufficient permissions"})
		})(w, r)
	}
}
