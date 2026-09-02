package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/matou-dao/backend/internal/anysync"
	"github.com/matou-dao/backend/internal/contributions"
	"github.com/matou-dao/backend/internal/identity"
	"github.com/matou-dao/backend/internal/keri"
	"github.com/matou-dao/backend/internal/types"
)

// ProfilesHandler handles profile and type definition HTTP requests.
type ProfilesHandler struct {
	spaceManager *anysync.SpaceManager
	userIdentity *identity.UserIdentity
	registry     *types.Registry
	fileManager  *anysync.FileManager
	eventBroker  *EventBroker
	roleLookup   RoleLookup
}

// NewProfilesHandler creates a new profiles handler.
func NewProfilesHandler(
	spaceManager *anysync.SpaceManager,
	userIdentity *identity.UserIdentity,
	registry *types.Registry,
	fileManager *anysync.FileManager,
	eventBroker *EventBroker,
) *ProfilesHandler {
	return &ProfilesHandler{
		spaceManager: spaceManager,
		userIdentity: userIdentity,
		registry:     registry,
		fileManager:  fileManager,
		eventBroker:  eventBroker,
	}
}

// HandleListTypes handles GET /api/v1/types — list all type definitions.
func (h *ProfilesHandler) HandleListTypes(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method not allowed"})
		return
	}

	defs := h.registry.All()
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"types": defs,
		"count": len(defs),
	})
}

// HandleGetType handles GET /api/v1/types/{name} — get specific type definition.
func (h *ProfilesHandler) HandleGetType(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method not allowed"})
		return
	}

	name := strings.TrimPrefix(r.URL.Path, "/api/v1/types/")
	if name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "type name is required"})
		return
	}

	def, ok := h.registry.Get(name)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": fmt.Sprintf("type %q not found", name)})
		return
	}

	writeJSON(w, http.StatusOK, def)
}

// CreateProfileRequest represents a request to create or update a profile.
type CreateProfileRequest struct {
	Type    string          `json:"type"`    // e.g. "SharedProfile", "PrivateProfile"
	ID      string          `json:"id"`      // Object ID (auto-generated if empty)
	Data    json.RawMessage `json:"data"`    // Profile data
	SpaceID string          `json:"spaceId"` // Target space ID (optional, derived from type)
}

// HandleCreateProfile handles POST /api/v1/profiles — create or update a profile.
func (h *ProfilesHandler) HandleCreateProfile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method not allowed"})
		return
	}

	var req CreateProfileRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf("invalid request: %v", err),
		})
		return
	}

	if req.Type == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "type is required"})
		return
	}

	// Validate against type definition
	def, ok := h.registry.Get(req.Type)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf("unknown type: %s", req.Type),
		})
		return
	}

	if errs, err := h.registry.Validate(req.Type, req.Data); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	} else if len(errs) > 0 {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{
			"error":            "validation failed",
			"validationErrors": errs,
		})
		return
	}

	// Determine target space
	spaceID := req.SpaceID
	if spaceID == "" && h.spaceManager != nil {
		spaceID = h.resolveSpaceForType(def)
	}

	// Generate object ID if not provided
	objectID := req.ID
	if objectID == "" {
		aid := ""
		if h.userIdentity != nil {
			aid = h.userIdentity.GetAID()
		}
		objectID = fmt.Sprintf("%s-%s-%d", req.Type, aid, time.Now().UnixMilli())
	}

	// Read the existing object (if any) — needed both for the version bump and
	// for the write policy (role-change detection / ownership).
	ctx := r.Context()
	var existing *anysync.ObjectPayload
	if h.spaceManager != nil && spaceID != "" {
		if obj, err := h.spaceManager.ObjectTreeManager().ReadLatestByID(ctx, spaceID, objectID); err == nil {
			existing = obj
		}
	}

	// Resource-level authorization (RBAC active only). POST /profiles is the
	// same write path as PUT /members/{aid}/role for role-bearing
	// CommunityProfiles, so it applies the same rule; see profileWritePolicy.
	if h.roleLookup != nil {
		var existingData json.RawMessage
		if existing != nil {
			existingData = existing.Data
		}
		if reason := profileWritePolicy(GetUserAID(r), GetUserRoles(r), req.Type, objectID, req.Data, existingData); reason != "" {
			log.Printf("[Profiles] write of %s/%s denied for %s: %s", req.Type, objectID, GetUserAID(r), reason)
			writeJSON(w, http.StatusForbidden, map[string]string{"error": reason})
			return
		}
	}

	if spaceID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf("no space configured for type %s (space=%s)", req.Type, def.Space),
		})
		return
	}

	// Get signing key for the space
	client := h.spaceManager.GetClient()
	if client == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "any-sync client not available",
		})
		return
	}

	keys, err := anysync.LoadOrCreateSpaceKeySet(client.GetDataDir(), spaceID, client.GetSigningKey())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to load space keys: %v", err),
		})
		return
	}

	// Determine version (increment over the existing object)
	objMgr := h.spaceManager.ObjectTreeManager()
	version := 1
	if existing != nil {
		version = existing.Version + 1
	}

	// Build owner key
	ownerKey := ""
	if keys.SigningKey != nil {
		pubKeyBytes, err := keys.SigningKey.GetPublic().Marshall()
		if err == nil {
			ownerKey = fmt.Sprintf("%x", pubKeyBytes)
		}
	}

	payload := &anysync.ObjectPayload{
		ID:        objectID,
		Type:      req.Type,
		OwnerKey:  ownerKey,
		Data:      req.Data,
		Timestamp: time.Now().Unix(),
		Version:   version,
	}

	headID, err := objMgr.AddObject(ctx, spaceID, payload, keys.SigningKey)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to write profile: %v", err),
		})
		return
	}

	// Get tree ID for the response
	treeID := objMgr.GetTreeIDForObject(objectID)

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success":  true,
		"objectId": objectID,
		"headId":   headID,
		"treeId":   treeID,
		"version":  version,
		"spaceId":  spaceID,
	})
}

// HandleListProfiles handles GET /api/v1/profiles/{type} — list profiles of a type.
func (h *ProfilesHandler) HandleListProfiles(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method not allowed"})
		return
	}

	typeName := strings.TrimPrefix(r.URL.Path, "/api/v1/profiles/")
	if typeName == "" || typeName == "me" {
		h.HandleMyProfiles(w, r)
		return
	}

	// Check for /:type/:id pattern
	parts := strings.SplitN(typeName, "/", 2)
	if len(parts) == 2 {
		h.handleGetProfile(w, r, parts[0], parts[1])
		return
	}

	def, ok := h.registry.Get(typeName)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{
			"error": fmt.Sprintf("unknown type: %s", typeName),
		})
		return
	}

	spaceID := h.resolveSpaceForType(def)
	log.Printf("[Profiles] HandleListProfiles type=%s space=%q defSpace=%s", typeName, spaceID, def.Space)
	if spaceID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf("no space configured for type %s", typeName),
		})
		return
	}

	ctx := r.Context()
	objMgr := h.spaceManager.ObjectTreeManager()

	objects, err := objMgr.ReadObjectsByType(ctx, spaceID, typeName)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to read profiles: %v", err),
		})
		return
	}

	// Deduplicate: keep only latest version per ID
	latest := deduplicateObjects(objects)

	// Apply schema-driven filters. The set of accepted filter parameters comes
	// from the type's schema (fields whose uiHints mark them filterable), not a
	// hardcoded list, so an org controls which fields are searchable via its
	// schema. A query parameter naming a non-filterable field is rejected.
	filters, badParam := collectFilters(def, r.URL.Query())
	if badParam != "" {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{
			"error":            fmt.Sprintf("field %q is not filterable", badParam),
			"filterableFields": def.FilterableFieldNames(),
		})
		return
	}
	if len(filters) > 0 {
		latest = filterProfiles(def, latest, filters)
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"profiles": latest,
		"count":    len(latest),
		"type":     typeName,
	})
}

// collectFilters turns request query parameters into a field→value filter map,
// keeping only fields the schema marks filterable. It returns the name of the
// first query parameter that names a known-but-non-filterable field so the
// caller can reject the request; reserved pagination-style params are ignored.
func collectFilters(def *types.TypeDefinition, query map[string][]string) (map[string]string, string) {
	filters := make(map[string]string)
	for key, vals := range query {
		if len(vals) == 0 || vals[0] == "" {
			continue
		}
		field, known := def.Field(key)
		if !known {
			// Unknown key: ignore rather than reject so pagination/sort params
			// added later don't break existing clients.
			continue
		}
		if field.UIHints == nil || !field.UIHints.Filterable {
			return nil, key
		}
		filters[key] = vals[0]
	}
	return filters, ""
}

// filterProfiles keeps only the objects whose data satisfies every filter.
func filterProfiles(def *types.TypeDefinition, objects []*anysync.ObjectPayload, filters map[string]string) []*anysync.ObjectPayload {
	result := make([]*anysync.ObjectPayload, 0, len(objects))
	for _, obj := range objects {
		var data map[string]interface{}
		if err := json.Unmarshal(obj.Data, &data); err != nil {
			continue
		}
		if types.MatchesFilters(def, data, filters) {
			result = append(result, obj)
		}
	}
	return result
}

// handleGetProfile handles GET /api/v1/profiles/{type}/{id}.
func (h *ProfilesHandler) handleGetProfile(w http.ResponseWriter, r *http.Request, typeName, objectID string) {
	def, ok := h.registry.Get(typeName)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{
			"error": fmt.Sprintf("unknown type: %s", typeName),
		})
		return
	}

	spaceID := h.resolveSpaceForType(def)
	if spaceID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf("no space configured for type %s", typeName),
		})
		return
	}

	ctx := r.Context()
	objMgr := h.spaceManager.ObjectTreeManager()

	obj, err := objMgr.ReadLatestByID(ctx, spaceID, objectID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{
			"error": fmt.Sprintf("profile not found: %v", err),
		})
		return
	}

	writeJSON(w, http.StatusOK, obj)
}

// HandleMyProfiles handles GET /api/v1/profiles/me — get current user's profiles.
func (h *ProfilesHandler) HandleMyProfiles(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method not allowed"})
		return
	}

	aid := ""
	if h.userIdentity != nil {
		aid = h.userIdentity.GetAID()
	}
	if aid == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "Identity not configured",
		})
		return
	}

	ctx := r.Context()
	objMgr := h.spaceManager.ObjectTreeManager()
	result := make(map[string]interface{})

	// Read profiles from each space type
	profileTypes := []struct {
		typeName string
		spaceID  string
	}{
		{"PrivateProfile", h.userIdentity.GetPrivateSpaceID()},
		{"SharedProfile", h.spaceManager.GetCommunitySpaceID()},
		{"CommunityProfile", h.spaceManager.GetCommunityReadOnlySpaceID()},
	}

	for _, pt := range profileTypes {
		if pt.spaceID == "" {
			continue
		}
		objects, err := objMgr.ReadObjectsByType(ctx, pt.spaceID, pt.typeName)
		if err != nil {
			continue
		}
		latest := deduplicateObjects(objects)
		// Private space is already per-user; shared spaces need AID filtering
		if pt.typeName != "PrivateProfile" {
			latest = filterObjectsByAID(latest, aid)
		}
		if len(latest) > 0 {
			result[pt.typeName] = latest
		}
	}

	writeJSON(w, http.StatusOK, result)
}

// InitMemberProfilesRequest represents a request to initialize profiles for a new member.
type InitMemberProfilesRequest struct {
	MemberAID           string          `json:"memberAid"`
	CredentialSAID      string          `json:"credentialSaid"`
	Role                string          `json:"role"`
	Status              string          `json:"status,omitempty"` // SharedProfile status; defaults to "approved"
	DisplayName         string          `json:"displayName"`
	Email               string          `json:"email,omitempty"`
	Avatar              string          `json:"avatar,omitempty"`
	AvatarData          string          `json:"avatarData,omitempty"`     // Base64-encoded avatar fallback
	AvatarMimeType      string          `json:"avatarMimeType,omitempty"` // MIME type for base64 avatar
	Bio                 string          `json:"bio,omitempty"`
	Interests           []string        `json:"interests,omitempty"`
	CustomInterests     string          `json:"customInterests,omitempty"`
	Location            string          `json:"location,omitempty"`
	IndigenousCommunity string          `json:"indigenousCommunity,omitempty"`
	JoinReason          string          `json:"joinReason,omitempty"`
	FacebookUrl         string          `json:"facebookUrl,omitempty"`
	LinkedinUrl         string          `json:"linkedinUrl,omitempty"`
	TwitterUrl          string          `json:"twitterUrl,omitempty"`
	InstagramUrl        string          `json:"instagramUrl,omitempty"`
	GithubUrl           string          `json:"githubUrl,omitempty"`
	GitlabUrl           string          `json:"gitlabUrl,omitempty"`
	ProfileData         json.RawMessage `json:"profileData,omitempty"` // Optional registration data
}

// UpdateMemberRoleRequest represents a request to update a member's role.
type UpdateMemberRoleRequest struct {
	Role string `json:"role"`
}

// HandleInitMemberProfiles handles POST /api/v1/profiles/init-member.
// Called by admin after credential issuance + space invite to create the
// member's CommunityProfile in the read-only space.
func (h *ProfilesHandler) HandleInitMemberProfiles(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method not allowed"})
		return
	}

	var req InitMemberProfilesRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf("invalid request: %v", err),
		})
		return
	}

	if req.MemberAID == "" || req.CredentialSAID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "memberAid and credentialSaid are required",
		})
		return
	}

	if req.Role == "" {
		req.Role = "Member"
	}

	// The approve flow passes "pending" here and flips to "approved" only
	// after credential issuance succeeds, so a failed approval keeps the
	// member visible in the dashboard's pending list for retry.
	if req.Status == "" {
		req.Status = "approved"
	}

	roSpaceID := h.spaceManager.GetCommunityReadOnlySpaceID()
	if roSpaceID == "" {
		writeJSON(w, http.StatusConflict, map[string]string{
			"error": "community-readonly space not configured",
		})
		return
	}

	// If no pre-uploaded avatar fileRef but base64 data is available, upload now.
	// Use a separate context so the retry loop doesn't consume the request timeout.
	if req.Avatar == "" && req.AvatarData != "" {
		communitySpaceID := h.spaceManager.GetCommunitySpaceID()
		if communitySpaceID != "" {
			client := h.spaceManager.GetClient()
			if client != nil {
				avatarCtx, avatarCancel := context.WithTimeout(context.Background(), 12*time.Second)
				if fileRef, uploadErr := uploadBase64Avatar(avatarCtx, h.fileManager, communitySpaceID, client.GetSigningKey(), req.AvatarData, req.AvatarMimeType); uploadErr != nil {
					fmt.Printf("Warning: failed to upload base64 member avatar: %v\n", uploadErr)
				} else {
					req.Avatar = fileRef
					fmt.Printf("[InitMemberProfiles] Uploaded base64 avatar for %s, fileRef: %s\n", req.MemberAID, fileRef)
				}
				avatarCancel()
			}
		}
	}

	// Build CommunityProfile data
	now := time.Now().UTC().Format(time.RFC3339)
	communityProfileData := map[string]interface{}{
		"userAID":      req.MemberAID,
		"credential":   req.CredentialSAID,
		"role":         req.Role,
		"memberSince":  now,
		"lastActiveAt": now,
		"credentials":  []string{req.CredentialSAID},
	}
	if req.DisplayName != "" {
		communityProfileData["displayName"] = req.DisplayName
	}
	if req.Email != "" {
		communityProfileData["email"] = req.Email
	}
	if req.Avatar != "" {
		communityProfileData["avatar"] = req.Avatar
	}
	if req.Bio != "" {
		communityProfileData["bio"] = req.Bio
	}
	if len(req.Interests) > 0 {
		communityProfileData["participationInterests"] = req.Interests
	}
	if req.CustomInterests != "" {
		communityProfileData["customInterests"] = req.CustomInterests
	}
	if req.Location != "" {
		communityProfileData["location"] = req.Location
	}
	if req.IndigenousCommunity != "" {
		communityProfileData["indigenousCommunity"] = req.IndigenousCommunity
	}
	if req.JoinReason != "" {
		communityProfileData["joinReason"] = req.JoinReason
	}
	if req.FacebookUrl != "" {
		communityProfileData["facebookUrl"] = req.FacebookUrl
	}
	if req.LinkedinUrl != "" {
		communityProfileData["linkedinUrl"] = req.LinkedinUrl
	}
	if req.TwitterUrl != "" {
		communityProfileData["twitterUrl"] = req.TwitterUrl
	}
	if req.InstagramUrl != "" {
		communityProfileData["instagramUrl"] = req.InstagramUrl
	}
	if req.GithubUrl != "" {
		communityProfileData["githubUrl"] = req.GithubUrl
	}
	if req.GitlabUrl != "" {
		communityProfileData["gitlabUrl"] = req.GitlabUrl
	}

	dataBytes, err := json.Marshal(communityProfileData)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to marshal profile data: %v", err),
		})
		return
	}

	// Validate the assembled profile against the org's schema before writing.
	// This runs on both the registration submit and the approval re-issue path
	// (both go through this handler), so a member is never persisted with data
	// that violates the current CommunityProfile schema (e.g. a custom required
	// field left empty, or an out-of-enum role).
	if errs := h.validateProfile("CommunityProfile", dataBytes); len(errs) > 0 {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{
			"error":            "CommunityProfile validation failed",
			"validationErrors": errs,
		})
		return
	}

	// Assemble and validate the SharedProfile BEFORE the CommunityProfile write.
	// Both payloads must pass validation before anything is committed — a 400
	// returned after the first AddObject would leave state mutated behind an
	// error response.
	communitySpaceID := h.spaceManager.GetCommunitySpaceID()
	var sharedDataBytes []byte
	if communitySpaceID != "" {
		now2 := time.Now().UTC().Format(time.RFC3339)
		sharedProfileData := map[string]interface{}{
			"aid":                    req.MemberAID,
			"status":                 req.Status,
			"displayName":            req.DisplayName,
			"bio":                    req.Bio,
			"avatar":                 req.Avatar,
			"publicEmail":            req.Email,
			"location":               req.Location,
			"indigenousCommunity":    req.IndigenousCommunity,
			"joinReason":             req.JoinReason,
			"facebookUrl":            req.FacebookUrl,
			"linkedinUrl":            req.LinkedinUrl,
			"twitterUrl":             req.TwitterUrl,
			"instagramUrl":           req.InstagramUrl,
			"githubUrl":              req.GithubUrl,
			"gitlabUrl":              req.GitlabUrl,
			"participationInterests": req.Interests,
			"customInterests":        req.CustomInterests,
			"lastActiveAt":           now2,
			"createdAt":              now2,
			"updatedAt":              now2,
			"typeVersion":            1,
		}
		sharedDataBytes, err = json.Marshal(sharedProfileData)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{
				"error": fmt.Sprintf("failed to marshal SharedProfile data: %v", err),
			})
			return
		}
		if errs := h.validateProfile("SharedProfile", sharedDataBytes); len(errs) > 0 {
			writeJSON(w, http.StatusBadRequest, map[string]interface{}{
				"error":            "SharedProfile validation failed",
				"validationErrors": errs,
			})
			return
		}
	}

	// Get signing key for readonly space
	client := h.spaceManager.GetClient()
	if client == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "any-sync client not available",
		})
		return
	}

	keys, err := anysync.LoadOrCreateSpaceKeySet(client.GetDataDir(), roSpaceID, client.GetSigningKey())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to load space keys: %v", err),
		})
		return
	}

	objectID := fmt.Sprintf("CommunityProfile-%s", req.MemberAID)
	ownerKey := ""
	if keys.SigningKey != nil {
		pubKeyBytes, _ := keys.SigningKey.GetPublic().Marshall()
		if pubKeyBytes != nil {
			ownerKey = fmt.Sprintf("%x", pubKeyBytes)
		}
	}

	payload := &anysync.ObjectPayload{
		ID:        objectID,
		Type:      "CommunityProfile",
		OwnerKey:  ownerKey,
		Data:      dataBytes,
		Timestamp: time.Now().Unix(),
		Version:   1,
	}

	// Use a 60s timeout for each AddObject call so we surface hangs as errors
	// rather than blocking the HTTP handler indefinitely.
	baseCtx := r.Context()
	objMgr := h.spaceManager.ObjectTreeManager()

	addCtx, addCancel := context.WithTimeout(baseCtx, 60*time.Second)
	headID, err := objMgr.AddObject(addCtx, roSpaceID, payload, keys.SigningKey)
	addCancel()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to write CommunityProfile: %v", err),
		})
		return
	}

	result := map[string]interface{}{
		"success":  true,
		"objectId": objectID,
		"headId":   headID,
		"treeId":   objMgr.GetTreeIDForObject(objectID),
		"spaceId":  roSpaceID,
	}

	// Also create SharedProfile in community writable space.
	// This is BLOCKING — WelcomeOverlay waits for this profile to appear
	// before allowing the member to continue. If it fails, the frontend
	// can retry initMemberProfiles (CommunityProfile update is idempotent).
	// Its payload was assembled and validated above, before the
	// CommunityProfile write.
	if communitySpaceID != "" {
		communityKeys, err := anysync.LoadOrCreateSpaceKeySet(client.GetDataDir(), communitySpaceID, client.GetSigningKey())
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{
				"error": fmt.Sprintf("failed to load community space keys for SharedProfile: %v", err),
			})
			return
		}

		sharedOwnerKey := ""
		if communityKeys.SigningKey != nil {
			if pub, pubErr := communityKeys.SigningKey.GetPublic().Marshall(); pubErr == nil {
				sharedOwnerKey = fmt.Sprintf("%x", pub)
			}
		}

		sharedObjectID := fmt.Sprintf("SharedProfile-%s", req.MemberAID)
		sharedPayload := &anysync.ObjectPayload{
			ID:        sharedObjectID,
			Type:      "SharedProfile",
			OwnerKey:  sharedOwnerKey,
			Data:      sharedDataBytes,
			Timestamp: time.Now().Unix(),
			Version:   1,
		}

		sharedCtx, sharedCancel := context.WithTimeout(baseCtx, 60*time.Second)
		sharedHeadID, err := objMgr.AddObject(sharedCtx, communitySpaceID, sharedPayload, communityKeys.SigningKey)
		sharedCancel()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{
				"error": fmt.Sprintf("failed to write SharedProfile to community space: %v", err),
			})
			return
		}

		result["sharedProfileObjectId"] = sharedObjectID
		result["sharedProfileHeadId"] = sharedHeadID
		result["sharedProfileTreeId"] = objMgr.GetTreeIDForObject(sharedObjectID)
		result["sharedProfileSpaceId"] = communitySpaceID

		if h.eventBroker != nil {
			h.eventBroker.Broadcast(SSEEvent{
				Type: "profile:updated",
				Data: map[string]interface{}{
					"profileId":   sharedObjectID,
					"memberAid":   req.MemberAID,
					"displayName": req.DisplayName,
				},
			})
		}
	}

	writeJSON(w, http.StatusOK, result)
}

// HandleUpdateMemberRole handles PUT /api/v1/members/{aid}/role.
// Updates the member's CommunityProfile role in the read-only space.
func (h *ProfilesHandler) HandleUpdateMemberRole(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method not allowed"})
		return
	}

	// Extract member AID from URL path: /api/v1/members/{aid}/role
	path := r.URL.Path
	parts := strings.Split(strings.TrimPrefix(path, "/api/v1/members/"), "/")
	if len(parts) < 2 || parts[1] != "role" || parts[0] == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid path, expected /api/v1/members/{aid}/role"})
		return
	}
	memberAID := parts[0]

	var req UpdateMemberRoleRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf("invalid request: %v", err),
		})
		return
	}

	if !isAssignableRole(req.Role) {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "invalid role: not a builtin role or defined custom role",
		})
		return
	}

	// Promotion to Founding Member — the org's highest-privilege role — may only
	// be performed by an existing Founding Member. All other role changes follow
	// the standard RBAC table (ActionChangeMemberRole: ops steward / founding).
	// Only enforced when RBAC is active (roleLookup configured).
	if h.roleLookup != nil && req.Role == "Founding Member" &&
		!contributions.HasRole(GetUserRoles(r), contributions.RoleFoundingMember) {
		writeJSON(w, http.StatusForbidden, map[string]string{
			"error": "only a Founding Member may promote a member to Founding Member",
		})
		return
	}

	roSpaceID := h.spaceManager.GetCommunityReadOnlySpaceID()
	if roSpaceID == "" {
		writeJSON(w, http.StatusConflict, map[string]string{
			"error": "community-readonly space not configured",
		})
		return
	}

	client := h.spaceManager.GetClient()
	if client == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "any-sync client not available",
		})
		return
	}

	ctx := r.Context()
	objMgr := h.spaceManager.ObjectTreeManager()

	objects, err := objMgr.ReadObjectsByType(ctx, roSpaceID, "CommunityProfile")
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to read profiles: %v", err),
		})
		return
	}

	var targetObj *anysync.ObjectPayload
	expectedID := "CommunityProfile-" + memberAID
	for _, obj := range objects {
		// Match by userAID field in data
		var data map[string]interface{}
		if err := json.Unmarshal(obj.Data, &data); err == nil {
			if aid, ok := data["userAID"].(string); ok && aid == memberAID {
				targetObj = obj
				break
			}
		}
		// Fallback: match by object ID convention
		if obj.ID == expectedID {
			targetObj = obj
			break
		}
	}

	if targetObj == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{
			"error": fmt.Sprintf("no CommunityProfile found for AID %s", memberAID),
		})
		return
	}

	nowStr := time.Now().UTC().Format(time.RFC3339)
	roleBytes, _ := json.Marshal(req.Role)
	nowBytes, _ := json.Marshal(nowStr)
	newFields := map[string]json.RawMessage{
		"role":         roleBytes,
		"lastActiveAt": nowBytes,
	}

	keys, err := anysync.LoadOrCreateSpaceKeySet(client.GetDataDir(), roSpaceID, client.GetSigningKey())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to load space keys: %v", err),
		})
		return
	}

	if _, err := objMgr.UpsertFields(ctx, roSpaceID, targetObj.ID, newFields, keys.SigningKey); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to update profile: %v", err),
		})
		return
	}

	log.Printf("[UpdateMemberRole] Updated role for %s to %s", memberAID, req.Role)
	writeJSON(w, http.StatusOK, map[string]string{
		"success": "true",
		"role":    req.Role,
	})
}

// RemoveMemberRequest represents a request to remove a member from the community.
type RemoveMemberRequest struct {
	Reason string `json:"reason,omitempty"`
}

// HandleRemoveMember handles DELETE /api/v1/members/{aid}.
// Marks the member's CommunityProfile and SharedProfile as removed.
func (h *ProfilesHandler) HandleRemoveMember(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method not allowed"})
		return
	}

	// Extract member AID from URL path: /api/v1/members/{aid}
	memberAID := strings.TrimPrefix(r.URL.Path, "/api/v1/members/")
	if memberAID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid path, expected /api/v1/members/{aid}"})
		return
	}

	var req RemoveMemberRequest
	// Body is optional for DELETE; ignore decode errors
	_ = json.NewDecoder(r.Body).Decode(&req)

	adminAID := ""
	if h.userIdentity != nil {
		adminAID = h.userIdentity.GetAID()
	}

	roSpaceID := h.spaceManager.GetCommunityReadOnlySpaceID()
	if roSpaceID == "" {
		writeJSON(w, http.StatusConflict, map[string]string{
			"error": "community-readonly space not configured",
		})
		return
	}

	communitySpaceID := h.spaceManager.GetCommunitySpaceID()
	if communitySpaceID == "" {
		writeJSON(w, http.StatusConflict, map[string]string{
			"error": "community space not configured",
		})
		return
	}

	client := h.spaceManager.GetClient()
	if client == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "any-sync client not available",
		})
		return
	}

	ctx := r.Context()
	objMgr := h.spaceManager.ObjectTreeManager()
	nowStr := time.Now().UTC().Format(time.RFC3339)

	// Update CommunityProfile in the read-only space
	statusBytes, _ := json.Marshal("removed")
	nowBytes, _ := json.Marshal(nowStr)
	adminAIDBytes, _ := json.Marshal(adminAID)

	roFields := map[string]json.RawMessage{
		"status":    statusBytes,
		"removedAt": nowBytes,
		"removedBy": adminAIDBytes,
	}
	if req.Reason != "" {
		reasonBytes, _ := json.Marshal(req.Reason)
		roFields["removalReason"] = reasonBytes
	}

	roKeys, err := anysync.LoadOrCreateSpaceKeySet(client.GetDataDir(), roSpaceID, client.GetSigningKey())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to load read-only space keys: %v", err),
		})
		return
	}

	communityProfileID := fmt.Sprintf("CommunityProfile-%s", memberAID)
	if _, err := objMgr.UpsertFields(ctx, roSpaceID, communityProfileID, roFields, roKeys.SigningKey); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to update CommunityProfile: %v", err),
		})
		return
	}

	// Update SharedProfile in the community space
	communityFields := map[string]json.RawMessage{
		"status":    statusBytes,
		"removedAt": nowBytes,
	}

	communityKeys, err := anysync.LoadOrCreateSpaceKeySet(client.GetDataDir(), communitySpaceID, client.GetSigningKey())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to load community space keys: %v", err),
		})
		return
	}

	sharedProfileID := fmt.Sprintf("SharedProfile-%s", memberAID)
	if _, err := objMgr.UpsertFields(ctx, communitySpaceID, sharedProfileID, communityFields, communityKeys.SigningKey); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to update SharedProfile: %v", err),
		})
		return
	}

	log.Printf("[RemoveMember] Removed member %s by admin %s", memberAID, adminAID)

	if h.eventBroker != nil {
		h.eventBroker.Broadcast(SSEEvent{
			Type: "member:removed",
			Data: map[string]interface{}{
				"memberAid": memberAID,
				"removedBy": adminAID,
				"removedAt": nowStr,
			},
		})
	}

	writeJSON(w, http.StatusOK, map[string]string{
		"success":   "true",
		"memberAid": memberAID,
	})
}

// validateProfile validates raw profile data against the named type in the
// registry. It returns the list of validation errors (empty when valid). A nil
// registry (environments without schema wiring) skips validation; any error
// from the registry — including an unregistered type — is surfaced as a
// validation error rather than swallowed, so a registry that failed to load a
// type cannot silently disable the very validation this path exists for.
func (h *ProfilesHandler) validateProfile(typeName string, data json.RawMessage) []string {
	if h.registry == nil {
		return nil
	}
	errs, err := h.registry.Validate(typeName, data)
	if err != nil {
		return []string{err.Error()}
	}
	return errs
}

// resolveSpaceForType returns the space ID for a given type definition.
func (h *ProfilesHandler) resolveSpaceForType(def *types.TypeDefinition) string {
	switch def.Space {
	case "private":
		if h.userIdentity != nil {
			return h.userIdentity.GetPrivateSpaceID()
		}
	case "community":
		return h.spaceManager.GetCommunitySpaceID()
	case "community-readonly":
		return h.spaceManager.GetCommunityReadOnlySpaceID()
	case "admin":
		return h.spaceManager.GetAdminSpaceID()
	}
	return ""
}

// filterObjectsByAID returns only objects whose data contains an "aid" or "userAID"
// field matching the given AID, or whose object ID contains the AID.
func filterObjectsByAID(objects []*anysync.ObjectPayload, aid string) []*anysync.ObjectPayload {
	if aid == "" {
		return objects
	}
	var filtered []*anysync.ObjectPayload
	for _, obj := range objects {
		// Check object ID pattern (e.g. "SharedProfile-EAbcd..." or "CommunityProfile-EAbcd...")
		if strings.Contains(obj.ID, aid) {
			filtered = append(filtered, obj)
			continue
		}
		// Check data fields: SharedProfile uses "aid", CommunityProfile uses "userAID"
		var data map[string]interface{}
		if err := json.Unmarshal(obj.Data, &data); err == nil {
			if profileAID, ok := data["aid"].(string); ok && profileAID == aid {
				filtered = append(filtered, obj)
			} else if profileAID, ok := data["userAID"].(string); ok && profileAID == aid {
				filtered = append(filtered, obj)
			}
		}
	}
	return filtered
}

// deduplicateObjects keeps only the latest version of each object by ID.
func deduplicateObjects(objects []*anysync.ObjectPayload) []*anysync.ObjectPayload {
	byID := make(map[string]*anysync.ObjectPayload)
	for _, obj := range objects {
		if existing, ok := byID[obj.ID]; !ok || obj.Version > existing.Version {
			byID[obj.ID] = obj
		}
	}
	result := make([]*anysync.ObjectPayload, 0, len(byID))
	for _, obj := range byID {
		result = append(result, obj)
	}
	return result
}

// profileWritePolicy decides whether caller may write the given profile via
// POST /api/v1/profiles. It returns "" to allow, or a denial reason.
//
// Rules (in order):
//
//  1. A CommunityProfile write that changes the role (new profile with a role
//     other than "Member", or an existing profile whose role differs) is a
//     role change and must satisfy exactly what PUT /members/{aid}/role
//     requires: ActionChangeMemberRole, and Founding Member may only be
//     granted by a Founding Member. This closes the escalation the review
//     found — ProfileRoleLookup resolves roles from this very object.
//  2. Steward scope (project/operations steward, founding member) may write
//     any profile whose role is unchanged (registration approval, decline,
//     attendance, pending-profile creation all run as a steward).
//  3. The profile's subject may write their own profile (PrivateProfile,
//     SharedProfile edits). Subject = data.userAID / data.aid, or the object
//     id "<Type>-<aid>[-suffix]".
//  4. Any authenticated member may append endorsements to another member's
//     SharedProfile — the only field that write may touch is "endorsements"
//     and it may only grow.
//
// Everything else is denied.
func profileWritePolicy(caller string, roles []contributions.Role, typeName, objectID string, newData, existingData json.RawMessage) string {
	newFields := decodeProfileFields(newData)
	existingFields := decodeProfileFields(existingData)

	if typeName == "CommunityProfile" {
		newRole, _ := newFields["role"].(string)
		if newRole != "" {
			roleChanged := newRole != "Member"
			if existingData != nil {
				existingRole, _ := existingFields["role"].(string)
				roleChanged = newRole != existingRole
			}
			if roleChanged {
				if !contributions.CanPerformAction(roles, contributions.ActionChangeMemberRole) {
					return "changing a member's role requires the change_member_role permission"
				}
				if newRole == "Founding Member" && !contributions.HasRole(roles, contributions.RoleFoundingMember) {
					return "only a Founding Member may promote a member to Founding Member"
				}
				return ""
			}
		}
	}

	if contributions.IsStewardScope(roles) {
		return ""
	}
	if isProfileOwner(caller, typeName, objectID, newFields, existingFields) {
		return ""
	}
	if typeName == "SharedProfile" && existingData != nil && isEndorsementAppend(existingFields, newFields) {
		return ""
	}
	return "you may only write your own profile"
}

func decodeProfileFields(raw json.RawMessage) map[string]interface{} {
	fields := map[string]interface{}{}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &fields)
	}
	return fields
}

// isProfileOwner reports whether caller is the AID a profile object is about.
// The existing object's identifiers (userAID / aid) win over the incoming
// payload so a caller cannot re-label someone else's profile as their own;
// when neither carries an identifier the object id convention
// "<Type>-<aid>" or "<Type>-<aid>-<suffix>" is used.
func isProfileOwner(caller, typeName, objectID string, newFields, existingFields map[string]interface{}) bool {
	if caller == "" {
		return false
	}
	for _, fields := range []map[string]interface{}{existingFields, newFields} {
		for _, key := range []string{"userAID", "aid"} {
			if v, ok := fields[key].(string); ok && v != "" {
				return v == caller
			}
		}
	}
	rest := strings.TrimPrefix(objectID, typeName+"-")
	if rest == objectID {
		return false
	}
	return rest == caller || strings.HasPrefix(rest, caller+"-")
}

// isEndorsementAppend reports whether newFields equals existingFields except
// for an "endorsements" array that only gained entries.
func isEndorsementAppend(existingFields, newFields map[string]interface{}) bool {
	if len(newFields) != len(existingFields) && !(len(newFields) == len(existingFields)+1 && existingFields["endorsements"] == nil) {
		return false
	}
	for k, v := range newFields {
		if k == "endorsements" {
			continue
		}
		ev, ok := existingFields[k]
		if !ok {
			return false
		}
		a, _ := json.Marshal(v)
		b, _ := json.Marshal(ev)
		if string(a) != string(b) {
			return false
		}
	}
	newEnd, ok := newFields["endorsements"].([]interface{})
	if !ok {
		return false
	}
	oldEnd, _ := existingFields["endorsements"].([]interface{})
	if len(newEnd) <= len(oldEnd) {
		return false
	}
	for i, e := range oldEnd {
		a, _ := json.Marshal(e)
		b, _ := json.Marshal(newEnd[i])
		if string(a) != string(b) {
			return false
		}
	}
	return true
}

// isAssignableRole reports whether a role string may be written to a member
// profile / issued in a membership credential: either one of the 10 builtin
// KERI roles, or a custom role defined in the community's RolePolicy.
func isAssignableRole(role string) bool {
	return keri.IsValidRole(role) || contributions.CurrentPolicy().HasCustomRole(role)
}

// RegisterRoutes registers profile and type routes on the mux.
// roleLookup is used to apply RBAC to mutating endpoints; pass nil to skip auth (tests only).
func (h *ProfilesHandler) RegisterRoutes(mux *http.ServeMux, roleLookup RoleLookup) {
	requireRoleLookup("ProfilesHandler", roleLookup)
	h.roleLookup = roleLookup
	mux.HandleFunc("/api/v1/types", h.handleTypes)
	mux.HandleFunc("/api/v1/types/", h.HandleGetType)
	mux.HandleFunc("/api/v1/profiles", h.handleProfiles)
	mux.HandleFunc("/api/v1/profiles/", h.HandleListProfiles)
	mux.HandleFunc("/api/v1/profiles/me", h.HandleMyProfiles)
	mux.HandleFunc("/api/v1/profiles/init-member", h.withRBAC(contributions.ActionInitMemberProfile, h.HandleInitMemberProfiles))
	mux.HandleFunc("/api/v1/members/", h.handleMembers)
}

// withRBAC applies RBAC middleware when a roleLookup is configured.
// When roleLookup is nil (tests), the handler is invoked directly.
func (h *ProfilesHandler) withRBAC(action contributions.Action, handler http.HandlerFunc) http.HandlerFunc {
	if h.roleLookup == nil {
		return handler
	}
	return RBACMiddleware(h.roleLookup, RequireAction(action, handler))
}

// handleMembers routes /api/v1/members/* requests through RBAC.
func (h *ProfilesHandler) handleMembers(w http.ResponseWriter, r *http.Request) {
	if strings.HasSuffix(r.URL.Path, "/role") && r.Method == http.MethodPut {
		h.withRBAC(contributions.ActionChangeMemberRole, h.HandleUpdateMemberRole)(w, r)
		return
	}
	if r.Method == http.MethodDelete {
		h.withRBAC(contributions.ActionRemoveMember, h.HandleRemoveMember)(w, r)
		return
	}
	writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
}

// handleTypes routes /api/v1/types requests.
func (h *ProfilesHandler) handleTypes(w http.ResponseWriter, r *http.Request) {
	h.HandleListTypes(w, r)
}

// handleProfiles routes /api/v1/profiles requests.
func (h *ProfilesHandler) handleProfiles(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		h.withRBAC(contributions.ActionWriteProfile, h.HandleCreateProfile)(w, r)
	case http.MethodGet:
		h.HandleMyProfiles(w, r)
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method not allowed"})
	}
}
