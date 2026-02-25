package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/matou-dao/backend/internal/anysync"
	"github.com/matou-dao/backend/internal/anystore"
	"github.com/matou-dao/backend/internal/identity"
	"github.com/matou-dao/backend/internal/keri"
)

// SyncHandler handles sync-related HTTP requests.
// This handler receives credentials and KELs from the frontend (fetched from KERIA via signify-ts)
// and stores them in anystore (local cache) and routes them to any-sync spaces.
type SyncHandler struct {
	keriClient    *keri.Client
	store         *anystore.LocalStore
	spaceManager  *anysync.SpaceManager
	spaceStore    anysync.SpaceStore
	userIdentity  *identity.UserIdentity
}

// NewSyncHandler creates a new sync handler
func NewSyncHandler(
	keriClient *keri.Client,
	store *anystore.LocalStore,
	spaceManager *anysync.SpaceManager,
	spaceStore anysync.SpaceStore,
	userIdentity *identity.UserIdentity,
) *SyncHandler {
	return &SyncHandler{
		keriClient:   keriClient,
		store:        store,
		spaceManager: spaceManager,
		spaceStore:   spaceStore,
		userIdentity: userIdentity,
	}
}

// SyncCredentialsRequest represents a credential sync request from frontend.
// UserAID is optional in per-user mode (falls back to userIdentity).
type SyncCredentialsRequest struct {
	UserAID     string            `json:"userAid,omitempty"`
	Credentials []keri.Credential `json:"credentials"`
}

// SyncCredentialsResponse represents a credential sync response
type SyncCredentialsResponse struct {
	Success        bool     `json:"success"`
	Synced         int      `json:"synced"`
	Failed         int      `json:"failed"`
	PrivateSpace   string   `json:"privateSpace,omitempty"`
	CommunitySpace string   `json:"communitySpace,omitempty"`
	Spaces         []string `json:"spaces,omitempty"`
	Errors         []string `json:"errors,omitempty"`
}

// SyncKELRequest represents a KEL sync request from frontend.
// UserAID is optional in per-user mode (falls back to userIdentity).
type SyncKELRequest struct {
	UserAID string     `json:"userAid,omitempty"`
	KEL     []KELEvent `json:"kel"`
}

// KELEvent represents a single event in a Key Event Log
type KELEvent struct {
	Type      string `json:"type"`      // "icp", "rot", "ixn"
	Sequence  int    `json:"sequence"`  // Event sequence number
	Digest    string `json:"digest"`    // Event digest
	Data      any    `json:"data"`      // Event data
	Timestamp string `json:"timestamp"` // ISO 8601 timestamp
}

// SyncKELResponse represents a KEL sync response
type SyncKELResponse struct {
	Success      bool   `json:"success"`
	EventsStored int    `json:"eventsStored"`
	PrivateSpace string `json:"privateSpace,omitempty"`
	Error        string `json:"error,omitempty"`
}

// CommunityMember represents a member in the community
type CommunityMember struct {
	AID            string `json:"aid"`
	Alias          string `json:"alias,omitempty"`
	Role           string `json:"role"`
	JoinedAt       string `json:"joinedAt"`
	CredentialSAID string `json:"credentialSaid"`
}

// CommunityMembersResponse represents the community members list
type CommunityMembersResponse struct {
	Members []CommunityMember `json:"members"`
	Total   int               `json:"total"`
}

// CommunityCredentialsResponse represents community-visible credentials
type CommunityCredentialsResponse struct {
	Credentials []keri.Credential `json:"credentials"`
	Total       int               `json:"total"`
}

// HandleSyncCredentials handles POST /api/v1/sync/credentials
// Receives credentials from frontend (fetched from KERIA) and syncs to spaces
func (h *SyncHandler) HandleSyncCredentials(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, SyncCredentialsResponse{
			Success: false,
			Errors:  []string{"Method not allowed"},
		})
		return
	}

	var req SyncCredentialsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, SyncCredentialsResponse{
			Success: false,
			Errors:  []string{fmt.Sprintf("invalid request: %v", err)},
		})
		return
	}

	// In per-user mode, use local identity. Fall back to request body for backward compat.
	userAID := req.UserAID
	if userAID == "" && h.userIdentity != nil {
		userAID = h.userIdentity.GetAID()
	}
	if userAID == "" {
		writeJSON(w, http.StatusConflict, SyncCredentialsResponse{
			Success: false,
			Errors:  []string{"identity not configured — call POST /api/v1/identity/set first"},
		})
		return
	}

	ctx := context.Background()
	var errors []string
	synced := 0
	failed := 0
	spaceSet := make(map[string]bool)

	// Get or create user's private space
	privateSpace, err := h.spaceManager.GetOrCreatePrivateSpace(ctx, userAID, h.spaceStore)
	if err != nil {
		errors = append(errors, fmt.Sprintf("failed to get/create private space: %v", err))
	}

	// Get community space
	communitySpace, _ := h.spaceManager.GetCommunitySpace(ctx)

	// Process each credential
	for _, cred := range req.Credentials {
		// Validate credential structure
		if err := h.keriClient.ValidateCredential(&cred); err != nil {
			errors = append(errors, fmt.Sprintf("invalid credential %s: %v", cred.SAID, err))
			failed++
			continue
		}

		// Store in anystore (local cache)
		cachedCred := &anystore.CachedCredential{
			ID:         cred.SAID,
			IssuerAID:  cred.Issuer,
			SubjectAID: cred.Recipient,
			SchemaID:   cred.Schema,
			Data:       cred.Data,
			CachedAt:   time.Now().UTC(),
			Verified:   h.keriClient.IsOrgIssued(&cred),
		}

		if err := h.store.StoreCredential(ctx, cachedCred); err != nil {
			errors = append(errors, fmt.Sprintf("failed to cache credential %s: %v", cred.SAID, err))
			failed++
			continue
		}

		// Route credential to appropriate spaces
		anysyncCred := &anysync.Credential{
			SAID:      cred.SAID,
			Issuer:    cred.Issuer,
			Recipient: cred.Recipient,
			Schema:    cred.Schema,
			Data:      cred.Data,
		}

		routedSpaces, routeErr := h.spaceManager.RouteCredential(ctx, anysyncCred, h.spaceStore)
		if routeErr != nil {
			errors = append(errors, fmt.Sprintf("failed to route credential %s: %v", cred.SAID, routeErr))
			// Don't fail - credential is cached even if routing fails
		}
		for _, sid := range routedSpaces {
			spaceSet[sid] = true
		}

		synced++
	}

	// Collect unique space IDs
	var spaces []string
	for sid := range spaceSet {
		spaces = append(spaces, sid)
	}

	// Build response
	resp := SyncCredentialsResponse{
		Success: failed == 0,
		Synced:  synced,
		Failed:  failed,
		Spaces:  spaces,
		Errors:  errors,
	}

	if privateSpace != nil {
		resp.PrivateSpace = privateSpace.SpaceID
	}
	if communitySpace != nil {
		resp.CommunitySpace = communitySpace.SpaceID
	}

	status := http.StatusOK
	if failed > 0 && synced == 0 {
		status = http.StatusBadRequest
	}

	writeJSON(w, status, resp)
}

// HandleSyncKEL handles POST /api/v1/sync/kel
// Receives KEL from frontend (fetched from KERIA) and syncs to private space
func (h *SyncHandler) HandleSyncKEL(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, SyncKELResponse{
			Success: false,
			Error:   "Method not allowed",
		})
		return
	}

	var req SyncKELRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, SyncKELResponse{
			Success: false,
			Error:   fmt.Sprintf("invalid request: %v", err),
		})
		return
	}

	// In per-user mode, use local identity. Fall back to request body for backward compat.
	kelUserAID := req.UserAID
	if kelUserAID == "" && h.userIdentity != nil {
		kelUserAID = h.userIdentity.GetAID()
	}
	if kelUserAID == "" {
		writeJSON(w, http.StatusConflict, SyncKELResponse{
			Success: false,
			Error:   "identity not configured — call POST /api/v1/identity/set first",
		})
		return
	}

	if len(req.KEL) == 0 {
		writeJSON(w, http.StatusBadRequest, SyncKELResponse{
			Success: false,
			Error:   "kel events are required",
		})
		return
	}

	ctx := context.Background()

	// Get or create user's private space
	privateSpace, err := h.spaceManager.GetOrCreatePrivateSpace(ctx, kelUserAID, h.spaceStore)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, SyncKELResponse{
			Success: false,
			Error:   fmt.Sprintf("failed to get/create private space: %v", err),
		})
		return
	}

	// Store KEL events in anystore
	kelCollection, err := h.store.KELCache(ctx)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, SyncKELResponse{
			Success: false,
			Error:   fmt.Sprintf("failed to get KEL collection: %v", err),
		})
		return
	}

	eventsStored := 0
	for _, event := range req.KEL {
		// Create KEL record
		record := map[string]interface{}{
			"id":        fmt.Sprintf("%s-%d", kelUserAID, event.Sequence),
			"userAid":   kelUserAID,
			"type":      event.Type,
			"sequence":  event.Sequence,
			"digest":    event.Digest,
			"data":      event.Data,
			"timestamp": event.Timestamp,
			"cachedAt":  time.Now().UTC().Format(time.RFC3339),
		}

		recordJSON, err := json.Marshal(record)
		if err != nil {
			continue
		}

		doc := anystore.MustParseJSON(string(recordJSON))
		if err := kelCollection.UpsertOne(ctx, doc); err != nil {
			continue
		}
		eventsStored++
	}

	writeJSON(w, http.StatusOK, SyncKELResponse{
		Success:      true,
		EventsStored: eventsStored,
		PrivateSpace: privateSpace.SpaceID,
	})
}

// HandleGetCommunityMembers handles GET /api/v1/community/members
// Returns all members with community-visible membership credentials.
// Tries AnySync community space ObjectTree first (P2P synced data),
// falls back to anystore cache if tree is not available.
func (h *SyncHandler) HandleGetCommunityMembers(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{
			"error": "Method not allowed",
		})
		return
	}

	ctx := context.Background()
	members := []CommunityMember{}

	// Try reading from AnySync community space ObjectTree first
	communitySpaceID := h.spaceManager.GetCommunitySpaceID()
	if communitySpaceID != "" {
		treeMgr := h.spaceManager.CredentialTreeManager()
		if treeMgr != nil {
			creds, err := treeMgr.ReadCredentials(ctx, communitySpaceID)
			if err == nil && len(creds) > 0 {
				for _, cred := range creds {
					if cred.Schema != "EMatouMembershipSchemaV1" {
						continue
					}
					var data keri.CredentialData
					if cred.Data != nil {
						json.Unmarshal(cred.Data, &data)
					}
					members = append(members, CommunityMember{
						AID:            cred.Recipient,
						Role:           data.Role,
						JoinedAt:       data.JoinedAt,
						CredentialSAID: cred.SAID,
					})
				}
				writeJSON(w, http.StatusOK, CommunityMembersResponse{
					Members: members,
					Total:   len(members),
				})
				return
			}
		}
	}

	// Fallback: query anystore cache
	credCollection, err := h.store.CredentialsCache(ctx)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to get credentials collection: %v", err),
		})
		return
	}

	query := anystore.MustParseJSON(`{"schemaID": "EMatouMembershipSchemaV1"}`)
	iter, err := credCollection.Find(query).Iter(ctx)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to query credentials: %v", err),
		})
		return
	}
	defer iter.Close()

	for iter.Next() {
		doc, err := iter.Doc()
		if err != nil {
			continue
		}

		var cached anystore.CachedCredential
		if err := json.Unmarshal([]byte(doc.Value().String()), &cached); err != nil {
			continue
		}

		var data keri.CredentialData
		dataBytes, _ := json.Marshal(cached.Data)
		json.Unmarshal(dataBytes, &data)

		members = append(members, CommunityMember{
			AID:            cached.SubjectAID,
			Role:           data.Role,
			JoinedAt:       data.JoinedAt,
			CredentialSAID: cached.ID,
		})
	}

	writeJSON(w, http.StatusOK, CommunityMembersResponse{
		Members: members,
		Total:   len(members),
	})
}

// HandleGetCommunityCredentials handles GET /api/v1/community/credentials
// Returns all community-visible credentials (memberships, roles).
// Tries AnySync community space ObjectTree first (P2P synced data),
// falls back to anystore cache if tree is not available.
func (h *SyncHandler) HandleGetCommunityCredentials(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{
			"error": "Method not allowed",
		})
		return
	}

	ctx := context.Background()
	credentials := []keri.Credential{}

	// Try reading from AnySync community space ObjectTree first
	communitySpaceID := h.spaceManager.GetCommunitySpaceID()
	if communitySpaceID != "" {
		treeMgr := h.spaceManager.CredentialTreeManager()
		if treeMgr != nil {
			creds, err := treeMgr.ReadCredentials(ctx, communitySpaceID)
			if err == nil && len(creds) > 0 {
				for _, cred := range creds {
					anysyncCred := &anysync.Credential{Schema: cred.Schema}
					if !anysync.IsCommunityVisible(anysyncCred) {
						continue
					}
					var data keri.CredentialData
					if cred.Data != nil {
						json.Unmarshal(cred.Data, &data)
					}
					credentials = append(credentials, keri.Credential{
						SAID:      cred.SAID,
						Issuer:    cred.Issuer,
						Recipient: cred.Recipient,
						Schema:    cred.Schema,
						Data:      data,
					})
				}
				writeJSON(w, http.StatusOK, CommunityCredentialsResponse{
					Credentials: credentials,
					Total:       len(credentials),
				})
				return
			}
		}
	}

	// Fallback: query anystore cache
	credCollection, err := h.store.CredentialsCache(ctx)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to get credentials collection: %v", err),
		})
		return
	}

	// Get all credentials and filter for community-visible ones
	iter, err := credCollection.Find(nil).Iter(ctx)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to query credentials: %v", err),
		})
		return
	}
	defer iter.Close()

	for iter.Next() {
		doc, err := iter.Doc()
		if err != nil {
			continue
		}

		var cached anystore.CachedCredential
		if err := json.Unmarshal([]byte(doc.Value().String()), &cached); err != nil {
			continue
		}

		// Check if credential is community-visible
		anysyncCred := &anysync.Credential{Schema: cached.SchemaID}
		if !anysync.IsCommunityVisible(anysyncCred) {
			continue
		}

		// Convert to keri.Credential
		var data keri.CredentialData
		dataBytes, _ := json.Marshal(cached.Data)
		json.Unmarshal(dataBytes, &data)

		credentials = append(credentials, keri.Credential{
			SAID:      cached.ID,
			Issuer:    cached.IssuerAID,
			Recipient: cached.SubjectAID,
			Schema:    cached.SchemaID,
			Data:      data,
		})
	}

	writeJSON(w, http.StatusOK, CommunityCredentialsResponse{
		Credentials: credentials,
		Total:       len(credentials),
	})
}

// RegisterRoutes registers sync routes on the mux
func (h *SyncHandler) RegisterRoutes(mux *http.ServeMux) {
	// Sync endpoints
	mux.HandleFunc("/api/v1/sync/credentials", h.HandleSyncCredentials)
	mux.HandleFunc("/api/v1/sync/kel", h.HandleSyncKEL)

	// Community endpoints
	mux.HandleFunc("/api/v1/community/members", h.HandleGetCommunityMembers)
	mux.HandleFunc("/api/v1/community/credentials", h.HandleGetCommunityCredentials)
}
