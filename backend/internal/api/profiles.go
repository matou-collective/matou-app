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
	"github.com/matou-dao/backend/internal/identity"
	"github.com/matou-dao/backend/internal/types"
)

// ProfilesHandler handles profile and type definition HTTP requests.
type ProfilesHandler struct {
	spaceManager *anysync.SpaceManager
	userIdentity *identity.UserIdentity
	registry     *types.Registry
	fileManager  *anysync.FileManager
}

// NewProfilesHandler creates a new profiles handler.
func NewProfilesHandler(
	spaceManager *anysync.SpaceManager,
	userIdentity *identity.UserIdentity,
	registry *types.Registry,
	fileManager *anysync.FileManager,
) *ProfilesHandler {
	return &ProfilesHandler{
		spaceManager: spaceManager,
		userIdentity: userIdentity,
		registry:     registry,
		fileManager:  fileManager,
	}
}

// HandleListTypes handles GET /api/v1/types — list all type definitions.
func (h *ProfilesHandler) HandleListTypes(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
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
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
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
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
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
	if spaceID == "" {
		spaceID = h.resolveSpaceForType(def)
	}
	if spaceID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf("no space configured for type %s (space=%s)", req.Type, def.Space),
		})
		return
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

	// Get signing key for the space
	client := h.spaceManager.GetClient()
	if client == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "any-sync client not available",
		})
		return
	}

	keys, err := anysync.LoadSpaceKeySet(client.GetDataDir(), spaceID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to load space keys: %v", err),
		})
		return
	}

	// Determine version (read existing to increment)
	ctx := r.Context()
	objMgr := h.spaceManager.ObjectTreeManager()
	version := 1
	if existing, err := objMgr.ReadLatestByID(ctx, spaceID, objectID); err == nil {
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
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
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

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"profiles": latest,
		"count":    len(latest),
		"type":     typeName,
	})
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
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	aid := ""
	if h.userIdentity != nil {
		aid = h.userIdentity.GetAID()
	}
	if aid == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "identity not configured",
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
	MemberAID            string          `json:"memberAid"`
	CredentialSAID       string          `json:"credentialSaid"`
	Role                 string          `json:"role"`
	DisplayName          string          `json:"displayName"`
	Email                string          `json:"email,omitempty"`
	Avatar               string          `json:"avatar,omitempty"`
	AvatarData           string          `json:"avatarData,omitempty"`     // Base64-encoded avatar fallback
	AvatarMimeType       string          `json:"avatarMimeType,omitempty"` // MIME type for base64 avatar
	Bio                  string          `json:"bio,omitempty"`
	Interests            []string        `json:"interests,omitempty"`
	CustomInterests      string          `json:"customInterests,omitempty"`
	Location             string          `json:"location,omitempty"`
	IndigenousCommunity  string          `json:"indigenousCommunity,omitempty"`
	JoinReason           string          `json:"joinReason,omitempty"`
	FacebookUrl          string          `json:"facebookUrl,omitempty"`
	LinkedinUrl          string          `json:"linkedinUrl,omitempty"`
	TwitterUrl           string          `json:"twitterUrl,omitempty"`
	InstagramUrl         string          `json:"instagramUrl,omitempty"`
	GithubUrl            string          `json:"githubUrl,omitempty"`
	GitlabUrl            string          `json:"gitlabUrl,omitempty"`
	ProfileData          json.RawMessage `json:"profileData,omitempty"` // Optional registration data
}

// HandleInitMemberProfiles handles POST /api/v1/profiles/init-member.
// Called by admin after credential issuance + space invite to create the
// member's CommunityProfile in the read-only space.
func (h *ProfilesHandler) HandleInitMemberProfiles(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
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
		"permissions":  []string{"participate", "vote", "propose"},
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

	// Get signing key for readonly space
	client := h.spaceManager.GetClient()
	if client == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "any-sync client not available",
		})
		return
	}

	keys, err := anysync.LoadSpaceKeySet(client.GetDataDir(), roSpaceID)
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

	ctx := r.Context()
	objMgr := h.spaceManager.ObjectTreeManager()

	headID, err := objMgr.AddObject(ctx, roSpaceID, payload, keys.SigningKey)
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
	communitySpaceID := h.spaceManager.GetCommunitySpaceID()
	if communitySpaceID != "" {
		now2 := time.Now().UTC().Format(time.RFC3339)
		sharedProfileData := map[string]interface{}{
			"aid":                    req.MemberAID,
			"displayName":            req.DisplayName,
			"bio":                    req.Bio,
			"avatar":                 req.Avatar,
			"publicEmail":            req.Email,
			"location":              req.Location,
			"indigenousCommunity":   req.IndigenousCommunity,
			"joinReason":            req.JoinReason,
			"facebookUrl":           req.FacebookUrl,
			"linkedinUrl":           req.LinkedinUrl,
			"twitterUrl":            req.TwitterUrl,
			"instagramUrl":          req.InstagramUrl,
			"githubUrl":             req.GithubUrl,
			"gitlabUrl":             req.GitlabUrl,
			"participationInterests": req.Interests,
			"customInterests":       req.CustomInterests,
			"lastActiveAt":           now2,
			"createdAt":              now2,
			"updatedAt":              now2,
			"typeVersion":            1,
		}

		sharedDataBytes, err := json.Marshal(sharedProfileData)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{
				"error": fmt.Sprintf("failed to marshal SharedProfile data: %v", err),
			})
			return
		}

		communityKeys, err := anysync.LoadSpaceKeySet(client.GetDataDir(), communitySpaceID)
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

		sharedHeadID, err := objMgr.AddObject(ctx, communitySpaceID, sharedPayload, communityKeys.SigningKey)
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
		fmt.Printf("[Profiles] Created SharedProfile %s in community space %s\n", sharedObjectID, communitySpaceID)
	}

	writeJSON(w, http.StatusOK, result)
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

// RegisterRoutes registers profile and type routes on the mux.
func (h *ProfilesHandler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/v1/types", h.handleTypes)
	mux.HandleFunc("/api/v1/types/", h.HandleGetType)
	mux.HandleFunc("/api/v1/profiles", h.handleProfiles)
	mux.HandleFunc("/api/v1/profiles/", h.HandleListProfiles)
	mux.HandleFunc("/api/v1/profiles/me", h.HandleMyProfiles)
	mux.HandleFunc("/api/v1/profiles/init-member", h.HandleInitMemberProfiles)
}

// handleTypes routes /api/v1/types requests.
func (h *ProfilesHandler) handleTypes(w http.ResponseWriter, r *http.Request) {
	h.HandleListTypes(w, r)
}

// handleProfiles routes /api/v1/profiles requests.
func (h *ProfilesHandler) handleProfiles(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		h.HandleCreateProfile(w, r)
	case http.MethodGet:
		h.HandleMyProfiles(w, r)
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}
