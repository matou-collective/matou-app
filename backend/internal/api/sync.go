package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/matou-dao/backend/internal/anysync"
	"github.com/matou-dao/backend/internal/anystore"
	"github.com/matou-dao/backend/internal/keri"
)

// SyncHandler handles sync-related HTTP requests.
// This handler receives credentials and KELs from the frontend (fetched from KERIA via signify-ts)
// and stores them in anystore (local cache) and routes them to any-sync spaces.
type SyncHandler struct {
	keriClient   *keri.Client
	store        *anystore.LocalStore
	spaceManager *anysync.SpaceManager
	spaceStore   anysync.SpaceStore
}

// NewSyncHandler creates a new sync handler
func NewSyncHandler(
	keriClient *keri.Client,
	store *anystore.LocalStore,
	spaceManager *anysync.SpaceManager,
	spaceStore anysync.SpaceStore,
) *SyncHandler {
	return &SyncHandler{
		keriClient:   keriClient,
		store:        store,
		spaceManager: spaceManager,
		spaceStore:   spaceStore,
	}
}

// SyncCredentialsRequest represents a credential sync request from frontend
type SyncCredentialsRequest struct {
	UserAID     string            `json:"userAid"`
	Credentials []keri.Credential `json:"credentials"`
}

// SyncCredentialsResponse represents a credential sync response
type SyncCredentialsResponse struct {
	Success        bool     `json:"success"`
	Synced         int      `json:"synced"`
	Failed         int      `json:"failed"`
	PrivateSpace   string   `json:"privateSpace,omitempty"`
	CommunitySpace string   `json:"communitySpace,omitempty"`
	Errors         []string `json:"errors,omitempty"`
}

// SyncKELRequest represents a KEL sync request from frontend
type SyncKELRequest struct {
	UserAID string     `json:"userAid"`
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
	AID                string   `json:"aid"`
	Alias              string   `json:"alias,omitempty"`
	Role               string   `json:"role"`
	VerificationStatus string   `json:"verificationStatus"`
	Permissions        []string `json:"permissions"`
	JoinedAt           string   `json:"joinedAt"`
	CredentialSAID     string   `json:"credentialSaid"`
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
			Errors:  []string{"method not allowed"},
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

	if req.UserAID == "" {
		writeJSON(w, http.StatusBadRequest, SyncCredentialsResponse{
			Success: false,
			Errors:  []string{"userAid is required"},
		})
		return
	}

	ctx := context.Background()
	var errors []string
	synced := 0
	failed := 0

	// Get or create user's private space
	privateSpace, err := h.spaceManager.GetOrCreatePrivateSpace(ctx, req.UserAID, h.spaceStore)
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

		_, routeErr := h.spaceManager.RouteCredential(ctx, anysyncCred, h.spaceStore)
		if routeErr != nil {
			errors = append(errors, fmt.Sprintf("failed to route credential %s: %v", cred.SAID, routeErr))
			// Don't fail - credential is cached even if routing fails
		}

		synced++
	}

	// Build response
	resp := SyncCredentialsResponse{
		Success: failed == 0,
		Synced:  synced,
		Failed:  failed,
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
			Error:   "method not allowed",
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

	if req.UserAID == "" {
		writeJSON(w, http.StatusBadRequest, SyncKELResponse{
			Success: false,
			Error:   "userAid is required",
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
	privateSpace, err := h.spaceManager.GetOrCreatePrivateSpace(ctx, req.UserAID, h.spaceStore)
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
			"id":        fmt.Sprintf("%s-%d", req.UserAID, event.Sequence),
			"userAid":   req.UserAID,
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
// Returns all members with community-visible membership credentials
func (h *SyncHandler) HandleGetCommunityMembers(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{
			"error": "method not allowed",
		})
		return
	}

	ctx := context.Background()

	// Query all credentials with membership schema
	credCollection, err := h.store.CredentialsCache(ctx)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to get credentials collection: %v", err),
		})
		return
	}

	// Find all membership credentials
	query := anystore.MustParseJSON(`{"schemaID": "EMatouMembershipSchemaV1"}`)
	iter, err := credCollection.Find(query).Iter(ctx)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to query credentials: %v", err),
		})
		return
	}
	defer iter.Close()

	members := []CommunityMember{}
	for iter.Next() {
		doc, err := iter.Doc()
		if err != nil {
			continue
		}

		var cached anystore.CachedCredential
		if err := json.Unmarshal([]byte(doc.Value().String()), &cached); err != nil {
			continue
		}

		// Extract credential data
		var data keri.CredentialData
		dataBytes, _ := json.Marshal(cached.Data)
		json.Unmarshal(dataBytes, &data)

		member := CommunityMember{
			AID:                cached.SubjectAID,
			Role:               data.Role,
			VerificationStatus: data.VerificationStatus,
			Permissions:        data.Permissions,
			JoinedAt:           data.JoinedAt,
			CredentialSAID:     cached.ID,
		}

		members = append(members, member)
	}

	writeJSON(w, http.StatusOK, CommunityMembersResponse{
		Members: members,
		Total:   len(members),
	})
}

// HandleGetCommunityCredentials handles GET /api/v1/community/credentials
// Returns all community-visible credentials (memberships, roles)
func (h *SyncHandler) HandleGetCommunityCredentials(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{
			"error": "method not allowed",
		})
		return
	}

	ctx := context.Background()

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

	credentials := []keri.Credential{}
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

		cred := keri.Credential{
			SAID:      cached.ID,
			Issuer:    cached.IssuerAID,
			Recipient: cached.SubjectAID,
			Schema:    cached.SchemaID,
			Data:      data,
		}

		credentials = append(credentials, cred)
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
