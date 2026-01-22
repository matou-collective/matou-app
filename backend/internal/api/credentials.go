package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/matou-dao/backend/internal/anystore"
	"github.com/matou-dao/backend/internal/keri"
)

// CredentialsHandler handles credential-related HTTP requests.
// Note: Credential issuance is handled by the frontend via signify-ts.
// This handler provides storage, retrieval, and validation of credentials.
type CredentialsHandler struct {
	keriClient *keri.Client
	store      *anystore.LocalStore
}

// NewCredentialsHandler creates a new credentials handler
func NewCredentialsHandler(keriClient *keri.Client, store *anystore.LocalStore) *CredentialsHandler {
	return &CredentialsHandler{
		keriClient: keriClient,
		store:      store,
	}
}

// StoreRequest represents a credential storage request from frontend
type StoreRequest struct {
	Credential keri.Credential `json:"credential"`
}

// StoreResponse represents a credential storage response
type StoreResponse struct {
	Success bool   `json:"success"`
	SAID    string `json:"said,omitempty"`
	Error   string `json:"error,omitempty"`
}

// ValidateRequest represents a credential validation request
type ValidateRequest struct {
	Credential json.RawMessage `json:"credential"`
}

// ValidateResponse represents a credential validation response
type ValidateResponse struct {
	Valid     bool   `json:"valid"`
	OrgIssued bool   `json:"orgIssued"`
	Role      string `json:"role,omitempty"`
	Error     string `json:"error,omitempty"`
}

// CredentialResponse represents a single credential response
type CredentialResponse struct {
	Credential *keri.Credential `json:"credential,omitempty"`
	Error      string           `json:"error,omitempty"`
}

// ListResponse represents a list of credentials response
type ListResponse struct {
	Credentials []keri.Credential `json:"credentials"`
	Total       int               `json:"total"`
}

// RolesResponse lists available roles
type RolesResponse struct {
	Roles []RoleInfo `json:"roles"`
}

// RoleInfo describes a role and its permissions
type RoleInfo struct {
	Name        string   `json:"name"`
	Permissions []string `json:"permissions"`
}

// HandleStore handles POST /api/v1/credentials - Store a credential from frontend
func (h *CredentialsHandler) HandleStore(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, StoreResponse{
			Success: false,
			Error:   "method not allowed",
		})
		return
	}

	var req StoreRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, StoreResponse{
			Success: false,
			Error:   fmt.Sprintf("invalid request: %v", err),
		})
		return
	}

	// Validate credential structure
	if err := h.keriClient.ValidateCredential(&req.Credential); err != nil {
		writeJSON(w, http.StatusBadRequest, StoreResponse{
			Success: false,
			Error:   fmt.Sprintf("invalid credential: %v", err),
		})
		return
	}

	// Store in anystore
	ctx := context.Background()
	cachedCred := &anystore.CachedCredential{
		ID:         req.Credential.SAID,
		IssuerAID:  req.Credential.Issuer,
		SubjectAID: req.Credential.Recipient,
		SchemaID:   req.Credential.Schema,
		Data:       req.Credential.Data,
		CachedAt:   time.Now().UTC(),
		Verified:   h.keriClient.IsOrgIssued(&req.Credential),
	}

	if err := h.store.StoreCredential(ctx, cachedCred); err != nil {
		writeJSON(w, http.StatusInternalServerError, StoreResponse{
			Success: false,
			Error:   fmt.Sprintf("failed to store credential: %v", err),
		})
		return
	}

	writeJSON(w, http.StatusOK, StoreResponse{
		Success: true,
		SAID:    req.Credential.SAID,
	})
}

// HandleGet handles GET /api/v1/credentials/{said} - Get a specific credential
func (h *CredentialsHandler) HandleGet(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, CredentialResponse{
			Error: "method not allowed",
		})
		return
	}

	// Extract SAID from path
	path := r.URL.Path
	parts := strings.Split(path, "/")
	if len(parts) < 5 {
		writeJSON(w, http.StatusBadRequest, CredentialResponse{
			Error: "credential SAID required",
		})
		return
	}
	said := parts[4]

	ctx := context.Background()
	cached, err := h.store.GetCredential(ctx, said)
	if err != nil {
		writeJSON(w, http.StatusNotFound, CredentialResponse{
			Error: "credential not found",
		})
		return
	}

	// Convert back to Credential
	data, ok := cached.Data.(keri.CredentialData)
	if !ok {
		// Try to convert from map
		dataBytes, _ := json.Marshal(cached.Data)
		json.Unmarshal(dataBytes, &data)
	}

	cred := &keri.Credential{
		SAID:      cached.ID,
		Issuer:    cached.IssuerAID,
		Recipient: cached.SubjectAID,
		Schema:    cached.SchemaID,
		Data:      data,
	}

	writeJSON(w, http.StatusOK, CredentialResponse{
		Credential: cred,
	})
}

// HandleValidate handles POST /api/v1/credentials/validate - Validate credential structure
func (h *CredentialsHandler) HandleValidate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, ValidateResponse{
			Valid: false,
			Error: "method not allowed",
		})
		return
	}

	var req ValidateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, ValidateResponse{
			Valid: false,
			Error: fmt.Sprintf("invalid request: %v", err),
		})
		return
	}

	if len(req.Credential) == 0 {
		writeJSON(w, http.StatusBadRequest, ValidateResponse{
			Valid: false,
			Error: "credential is required",
		})
		return
	}

	// Validate credential structure
	cred, err := h.keriClient.ValidateCredentialJSON(string(req.Credential))
	if err != nil {
		writeJSON(w, http.StatusOK, ValidateResponse{
			Valid: false,
			Error: err.Error(),
		})
		return
	}

	writeJSON(w, http.StatusOK, ValidateResponse{
		Valid:     true,
		OrgIssued: h.keriClient.IsOrgIssued(cred),
		Role:      cred.Data.Role,
	})
}

// HandleRoles handles GET /api/v1/credentials/roles - List available roles
func (h *CredentialsHandler) HandleRoles(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{
			"error": "method not allowed",
		})
		return
	}

	roles := make([]RoleInfo, 0, len(keri.ValidRoles()))
	for _, role := range keri.ValidRoles() {
		roles = append(roles, RoleInfo{
			Name:        role,
			Permissions: keri.GetPermissionsForRole(role),
		})
	}

	writeJSON(w, http.StatusOK, RolesResponse{Roles: roles})
}

// HandleOrg handles GET /api/v1/org - Get organization info for frontend
func (h *CredentialsHandler) HandleOrg(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{
			"error": "method not allowed",
		})
		return
	}

	writeJSON(w, http.StatusOK, h.keriClient.GetOrgInfo())
}

// RegisterRoutes registers credential routes on the mux
func (h *CredentialsHandler) RegisterRoutes(mux *http.ServeMux) {
	// Organization info
	mux.HandleFunc("/api/v1/org", h.HandleOrg)

	// Credential operations
	mux.HandleFunc("/api/v1/credentials", h.handleCredentials)
	mux.HandleFunc("/api/v1/credentials/", h.handleCredentialByID)
	mux.HandleFunc("/api/v1/credentials/validate", h.HandleValidate)
	mux.HandleFunc("/api/v1/credentials/roles", h.HandleRoles)
}

// handleCredentials routes to Store (POST) or List (GET)
func (h *CredentialsHandler) handleCredentials(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		h.HandleStore(w, r)
	case http.MethodGet:
		h.handleList(w, r)
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{
			"error": "method not allowed",
		})
	}
}

// handleCredentialByID routes to Get by SAID
func (h *CredentialsHandler) handleCredentialByID(w http.ResponseWriter, r *http.Request) {
	// Check if it's a sub-route like /validate or /roles
	path := r.URL.Path
	if strings.HasSuffix(path, "/validate") || strings.HasSuffix(path, "/roles") {
		return // Let specific handlers handle these
	}
	h.HandleGet(w, r)
}

// handleList handles GET /api/v1/credentials - List all credentials
func (h *CredentialsHandler) handleList(w http.ResponseWriter, r *http.Request) {
	ctx := context.Background()

	// Query all credentials from anystore cache
	cachedCreds, err := h.store.GetAllCredentials(ctx)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to query credentials: %v", err),
		})
		return
	}

	// Convert cached credentials to keri.Credential format
	credentials := make([]keri.Credential, 0, len(cachedCreds))
	for _, cached := range cachedCreds {
		// Try to convert data to CredentialData
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

	writeJSON(w, http.StatusOK, ListResponse{
		Credentials: credentials,
		Total:       len(credentials),
	})
}

// writeJSON writes a JSON response
func writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}
