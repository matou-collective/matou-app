package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/anyproto/any-sync/util/crypto"

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
	schemaWriter SchemaWriter

	// schemaMu serialises schema PUTs from the registry read that backs the
	// optimistic-locking check through persist and Register. Without it two
	// PUTs claiming the same Version both pass the check and the last Register
	// wins silently, voiding the 409 guarantee. Persisting inside the lock is
	// fine for this admin-only path.
	schemaMu sync.Mutex
}

// SchemaWriter persists an updated type definition to the community space.
// The production implementation (spaceSchemaWriter) writes a type_definition
// object signed with the community space key set — the same way org setup
// seeds them (see spaces.go seedSpace); tests inject a fake.
type SchemaWriter interface {
	WriteTypeDefinition(ctx context.Context, def *types.TypeDefinition) error
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
		schemaWriter: &spaceSchemaWriter{spaceManager: spaceManager},
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

// HandleUpdateType handles PUT /api/v1/types/{name} — replace a type's
// definition with an admin-supplied one (#399, part of #396).
//
// The core-field invariant is enforced against the built-in (Bootstrap)
// definition: every field the built-in marks core:true must stay present and
// unchanged in name/type, and its remaining FieldDef (core/required/readOnly/
// validation/…) is re-asserted from the built-in before persisting; custom
// fields may be freely added, edited, or removed.
//
// PUT is update-only by design: an unknown type name is 404 and no definition
// is created. The endpoint edits the schema of types the backend already
// knows how to serve (registered at Bootstrap or loaded from the community
// space at boot); creating a brand-new type is a separate slice of #396 with
// its own storage/space/route questions, not something a PUT should do on the
// side. Structurally invalid or hostile definitions (core-field violation, bad
// field name/type, over the field cap, dangling variantField or layout entry,
// a changed space) are 400. A stale definition Version is 409 (optimistic
// locking, mirroring the role-policy PUT; the check-and-set is serialised by
// schemaMu); on success the version is bumped, the definition persisted to
// the community space, and the in-memory registry updated write-through.
// RBAC is applied by the route (ActionManageSchema →
// manage_community_settings).
func (h *ProfilesHandler) HandleUpdateType(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method not allowed"})
		return
	}

	name := strings.TrimPrefix(r.URL.Path, "/api/v1/types/")
	if name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "type name is required"})
		return
	}

	var incoming types.TypeDefinition
	if err := json.NewDecoder(r.Body).Decode(&incoming); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("invalid request: %v", err)})
		return
	}

	// The path is the source of truth for the name; an empty body name inherits
	// it, a mismatched one is rejected so a PUT can't rename or retarget a type.
	if incoming.Name == "" {
		incoming.Name = name
	}
	if incoming.Name != name {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf("type name %q in body does not match %q in path", incoming.Name, name),
		})
		return
	}

	// Everything from the registry read that backs the version check through
	// persist and Register is one critical section (the body is decoded above,
	// outside it, so a slow client cannot hold the lock).
	h.schemaMu.Lock()
	defer h.schemaMu.Unlock()

	current, ok := h.registry.Get(name)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": fmt.Sprintf("type %q not found", name)})
		return
	}

	// Optimistic locking: the client must have edited the version it last read.
	if incoming.Version != current.Version {
		writeJSON(w, http.StatusConflict, map[string]interface{}{
			"error":          "type definition was modified by someone else — reload and retry",
			"currentVersion": current.Version,
		})
		return
	}

	// The space a type lives in is not editable: resolveSpaceForType reads
	// def.Space to decide where objects of the type are written and listed, so
	// moving SharedProfile to "private" would re-route community profiles. An
	// empty space inherits the current one.
	if incoming.Space == "" {
		incoming.Space = current.Space
	}
	if incoming.Space != current.Space {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf("type space may not change (current %q, got %q)", current.Space, incoming.Space),
		})
		return
	}

	// Core-field invariant + structural validation against the built-in shape.
	builtin, _ := types.BuiltinDefinition(name)
	if msg := types.ValidateSchemaUpdate(builtin, &incoming); msg != "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": msg})
		return
	}

	// Bump the version for the persisted + registered copy, then write-through:
	// persist to the community space first so a storage failure surfaces as 500
	// and never leaves the registry ahead of the durable copy.
	updated := incoming
	updated.Version = current.Version + 1

	// The validator only pins a core field's name and type; its flags
	// (core/required/readOnly/validation) are re-asserted from the built-in
	// here — the same merge LoadFromSpace applies at boot — so what is served
	// now and what the next boot loads never disagree (notices.go reads f.Core
	// at runtime to tell custom fields apart).
	types.ReassertCoreFields(builtin, &updated)

	if h.schemaWriter != nil {
		if err := h.schemaWriter.WriteTypeDefinition(r.Context(), &updated); err != nil {
			log.Printf("[Types] failed to persist definition %q (version %d): %v", name, updated.Version, err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{
				"error": fmt.Sprintf("failed to store type definition: %v", err),
			})
			return
		}
	}
	h.registry.Register(&updated)

	// Version bumps on every PUT (optimistic lock); schemaChanged tells the
	// client whether the edit affects what data validates (#302) — an
	// advisory flag: existing profiles are grandfathered on read and re-stamped
	// on their next write either way.
	schemaChanged := types.SchemaChanged(current, &updated)
	log.Printf("[Types] updated definition %q to version %d (schemaChanged=%v) by %s", name, updated.Version, schemaChanged, GetUserAID(r))
	writeJSON(w, http.StatusOK, struct {
		*types.TypeDefinition
		SchemaChanged bool `json:"schemaChanged"`
	}{&updated, schemaChanged})
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

	// Resource-level authorization (RBAC active only), then migrate-on-write
	// stamping of the live schema version (#302). See
	// authorizeAndStampProfileWrite for why the order matters.
	var existingData json.RawMessage
	if existing != nil {
		existingData = existing.Data
	}
	stamped, reason, err := h.authorizeAndStampProfileWrite(r, req.Type, objectID, req.Data, existingData)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf("invalid request: %v", err),
		})
		return
	}
	if reason != "" {
		log.Printf("[Profiles] write of %s/%s denied for %s: %s", req.Type, objectID, GetUserAID(r), reason)
		writeJSON(w, http.StatusForbidden, map[string]string{"error": reason})
		return
	}
	req.Data = stamped

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
	FacebookURL         string          `json:"facebookUrl,omitempty"`
	LinkedinURL         string          `json:"linkedinUrl,omitempty"`
	TwitterURL          string          `json:"twitterUrl,omitempty"`
	InstagramURL        string          `json:"instagramUrl,omitempty"`
	GithubURL           string          `json:"githubUrl,omitempty"`
	GitlabURL           string          `json:"gitlabUrl,omitempty"`
	ProfileData         json.RawMessage `json:"profileData,omitempty"` // Opaque registration payload (canonical); typed fields above kept for one-release compat, merged under it — see mergedProfileData
}

// UpdateMemberRoleRequest represents a request to update a member's role.
type UpdateMemberRoleRequest struct {
	Role string `json:"role"`
}

// profileTypeOrBuiltin returns the org's registered definition for a type,
// falling back to the built-in definition when the registry is absent or the
// type has not been loaded. The split-on-save follows whichever definition is
// effective, so org schema customisations drive field→space routing.
func (h *ProfilesHandler) profileTypeOrBuiltin(name string, builtin func() *types.TypeDefinition) *types.TypeDefinition {
	if h.registry != nil {
		if def, ok := h.registry.Get(name); ok && def != nil {
			return def
		}
	}
	return builtin()
}

// memberProfileReservedKeys are the fields HandleInitMemberProfiles manages
// itself (identity, membership, timestamps, schema version). They are stripped
// from the opaque registration map before routing so a client can never set
// them through profileData; the assembler pins them from the request instead.
var memberProfileReservedKeys = map[string]bool{
	"aid": true, "status": true, "lastActiveAt": true, "createdAt": true, "updatedAt": true, "typeVersion": true,
	"userAID": true, "credential": true, "role": true, "memberSince": true, "credentials": true,
}

// memberProfilePinnedDisplayKeys are SharedProfile core fields the frontend
// and handlers read structurally (member lists, avatars, SSE). They are always
// stored on the SharedProfile — and never on the CommunityProfile — whatever
// the org's schema says.
var memberProfilePinnedDisplayKeys = []string{"displayName", "avatar"}

// buildMemberProfileData assembles the CommunityProfile and SharedProfile data
// maps for a new member from the merged opaque registration map (see
// mergedProfileData). Non-reserved fields are routed to whichever destination
// type's schema declares them (types.RouteFieldsBySchema), so which fields land
// in the community-readonly vs the community-writable profile follows the org's
// type definitions rather than a hardcoded list (issue #300). The core
// identity/membership fields each profile's handlers structurally depend on are
// pinned after routing and therefore cannot be moved to another space by a
// schema edit. Keys declared by neither schema are not stored; their names are
// returned in dropped (sorted) so the caller can log and report them.
func buildMemberProfileData(communityDef, sharedDef *types.TypeDefinition, req *InitMemberProfilesRequest, merged map[string]interface{}, now string) (community, shared map[string]interface{}, dropped []string) {
	inputs := make(map[string]interface{}, len(merged))
	for k, v := range merged {
		if !memberProfileReservedKeys[k] {
			inputs[k] = v
		}
	}
	routed := types.RouteFieldsBySchema(inputs, communityDef, sharedDef)

	// CommunityProfile: routed fields, then the pinned membership record.
	community = buildCommunityProfileData(req, now)
	for k, v := range routed[communityDef.Name] {
		if _, pinned := community[k]; !pinned {
			community[k] = v
		}
	}

	// SharedProfile: routed fields, then the pinned identity/system fields.
	shared = buildSharedProfileData(routed[sharedDef.Name], req.MemberAID, req.Status, now, sharedDef.Version)
	for _, k := range memberProfilePinnedDisplayKeys {
		if v, ok := merged[k]; ok {
			shared[k] = v
		}
		delete(community, k)
	}

	for k := range inputs {
		_, inCommunity := routed[communityDef.Name][k]
		_, inShared := routed[sharedDef.Name][k]
		if !inCommunity && !inShared {
			dropped = append(dropped, k)
		}
	}
	sort.Strings(dropped)
	return community, shared, dropped
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

	// Assemble the opaque registration profile (#299). The canonical payload is
	// the profileData map (keyed by schema field names); the legacy typed
	// request fields are still accepted for one release for backward
	// compatibility and form the base that profileData overlays.
	merged, err := req.mergedProfileData()
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	// Split the merged map into the CommunityProfile (community-readonly) and
	// SharedProfile (community) records. Which field lands where is read from
	// the org's type definitions (#300): a field routes to whichever schema
	// declares it, so an admin moving a field between the two schemas moves
	// where a new member's value is stored. The core membership/identity fields
	// each handler depends on are pinned by the assembler and cannot be moved
	// out by a schema edit. A key no schema declares is dropped (logged and
	// reported as droppedFields in the response) rather than persisted
	// unvalidated. This is deliberately not a 400: the answers were collected
	// under the kit as it stood at submit time, and refusing the write would
	// leave the registration un-approvable whenever the admin removed a
	// question between submit and approval.
	now := time.Now().UTC().Format(time.RFC3339)
	communityDef := h.profileTypeOrBuiltin("CommunityProfile", types.CommunityProfileType)
	sharedDef := h.profileTypeOrBuiltin("SharedProfile", types.SharedProfileType)
	communityProfileData, sharedProfileData, droppedFields := buildMemberProfileData(communityDef, sharedDef, &req, merged, now)
	if len(droppedFields) > 0 {
		log.Printf("[InitMemberProfiles] %s: dropped registration fields declared by neither profile schema: %v", req.MemberAID, droppedFields)
	}

	dataBytes, err := json.Marshal(communityProfileData)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to marshal profile data: %v", err),
		})
		return
	}

	// Validate the assembled profile against the org's schema before writing.
	// The same handler runs on the registration submit (status "pending") and
	// again when the profile is (re-)initialised, so a member is never persisted
	// with data that violates the current CommunityProfile schema (e.g. an
	// out-of-enum role). The approval status flip re-validates via POST
	// /profiles, catching a schema that changed between submit and approval.
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
	// error response. The SharedProfile carries the opaque profile map plus the
	// system-managed fields; the map is what makes a custom required field
	// enforceable at registration.
	communitySpaceID := h.spaceManager.GetCommunitySpaceID()
	var sharedDataBytes []byte
	if communitySpaceID != "" {
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
	if len(droppedFields) > 0 {
		result["droppedFields"] = droppedFields
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
			displayName, _ := merged["displayName"].(string)
			h.eventBroker.Broadcast(SSEEvent{
				Type: "profile:updated",
				Data: map[string]interface{}{
					"profileId":   sharedObjectID,
					"memberAid":   req.MemberAID,
					"displayName": displayName,
				},
			})
		}
	}

	writeJSON(w, http.StatusOK, result)
}

// mergedProfileData assembles the registration profile as an opaque map. The
// legacy typed request fields form the base (kept for one release so older
// admin clients that POST the named field list keep working); the opaque
// profileData map, keyed by SharedProfile schema field names, is overlaid on
// top and wins on conflict. An org-added custom field can only travel through
// the opaque map, which is why registration must carry it verbatim rather than
// copying a fixed set of named fields.
func (req *InitMemberProfilesRequest) mergedProfileData() (map[string]interface{}, error) {
	merged := map[string]interface{}{}

	set := func(key, val string) {
		if val != "" {
			merged[key] = val
		}
	}
	set("displayName", req.DisplayName)
	set("publicEmail", req.Email)
	set("avatar", req.Avatar)
	set("bio", req.Bio)
	if len(req.Interests) > 0 {
		merged["participationInterests"] = req.Interests
	}
	set("customInterests", req.CustomInterests)
	set("location", req.Location)
	set("indigenousCommunity", req.IndigenousCommunity)
	set("joinReason", req.JoinReason)
	set("facebookUrl", req.FacebookURL)
	set("linkedinUrl", req.LinkedinURL)
	set("twitterUrl", req.TwitterURL)
	set("instagramUrl", req.InstagramURL)
	set("githubUrl", req.GithubURL)
	set("gitlabUrl", req.GitlabURL)

	if len(req.ProfileData) > 0 {
		var overlay map[string]interface{}
		if err := json.Unmarshal(req.ProfileData, &overlay); err != nil {
			return nil, fmt.Errorf("profileData is not a valid JSON object: %w", err)
		}
		for k, v := range overlay {
			merged[k] = v
		}
	}
	return merged, nil
}

// buildCommunityProfileData composes the CommunityProfile payload: the
// admin-managed membership record for the community-readonly space. It carries
// only the fields the CommunityProfile schema declares — none of the
// registration display/social answers, which live on the SharedProfile.
func buildCommunityProfileData(req *InitMemberProfilesRequest, now string) map[string]interface{} {
	return map[string]interface{}{
		"userAID":      req.MemberAID,
		"credential":   req.CredentialSAID,
		"role":         req.Role,
		"memberSince":  now,
		"lastActiveAt": now,
		"credentials":  []string{req.CredentialSAID},
	}
}

// buildSharedProfileData composes the SharedProfile payload from the opaque
// profile map plus the system-managed fields. The system fields are applied
// last so a caller can never override aid/status/timestamps through the map.
// typeVersion is the live SharedProfile schema version (#302): a freshly
// seeded profile is stamped at the current version so it is never born stale.
func buildSharedProfileData(merged map[string]interface{}, aid, status, now string, typeVersion int) map[string]interface{} {
	shared := make(map[string]interface{}, len(merged)+6)
	for k, v := range merged {
		shared[k] = v
	}
	shared["aid"] = aid
	shared["status"] = status
	shared["lastActiveAt"] = now
	shared["createdAt"] = now
	shared["updatedAt"] = now
	shared["typeVersion"] = typeVersion
	return shared
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

// authorizeAndStampProfileWrite applies the resource-level write policy (RBAC
// active only; POST /profiles is the same write path as PUT /members/{aid}/role
// for role-bearing CommunityProfiles — see profileWritePolicy) and, only if
// the write is allowed, stamps the live schema version into the data
// (migrate-on-write, #302). The policy must see the data exactly as the client
// sent it: stamping first would make an endorsement append onto a profile
// written under an older schema version differ from the existing object in
// typeVersion, so isEndorsementAppend would refuse it after any schema bump.
// Returns the stamped data, or a non-empty denial reason, or an error when the
// data cannot be stamped (not a JSON object).
func (h *ProfilesHandler) authorizeAndStampProfileWrite(r *http.Request, typeName, objectID string, data, existingData json.RawMessage) (json.RawMessage, string, error) {
	if h.roleLookup != nil {
		if reason := profileWritePolicy(GetUserAID(r), GetUserRoles(r), typeName, objectID, data, existingData); reason != "" {
			return nil, reason, nil
		}
	}
	stamped, err := h.registry.StampVersion(typeName, data)
	if err != nil {
		return nil, "", err
	}
	return stamped, "", nil
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
	if len(newFields) != len(existingFields) && (len(newFields) != len(existingFields)+1 || existingFields["endorsements"] != nil) {
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
	mux.HandleFunc("/api/v1/types/", h.handleTypeByName)
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

// handleTypeByName routes /api/v1/types/{name} requests: GET reads a definition
// (open), PUT edits it behind the manage_community_settings capability (#399).
func (h *ProfilesHandler) handleTypeByName(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.HandleGetType(w, r)
	case http.MethodPut:
		h.withRBAC(contributions.ActionManageSchema, h.HandleUpdateType)(w, r)
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method not allowed"})
	}
}

// schemaObjectStore is the slice of anysync.ObjectTreeManager the schema
// writer needs: enumerate the type_definition objects already in a space and
// create-or-update one by ID. Tests inject an in-memory fake.
type schemaObjectStore interface {
	ReadObjectsByType(ctx context.Context, spaceID, typeName string) ([]*anysync.ObjectPayload, error)
	AddObject(ctx context.Context, spaceID string, payload *anysync.ObjectPayload, signingKey crypto.PrivKey) (string, error)
}

// spaceSchemaWriter persists a type definition into the community space,
// signed with that space's key set — the same object shape org setup seeds
// (type "type_definition"; see spaces.go seedSpace).
//
// Object identity: AddObject decides create-vs-update by exact object ID, and
// seedSpace stored the seeded definitions under `typedef-<name>-<unixmilli>`,
// so the writer cannot assume a fixed ID. It looks the existing object up by
// the definition's Name among the space's type_definition objects and updates
// that one; only when none exists does it create `typedef-<name>`. That keeps
// exactly one stored definition per name — the property
// Registry.LoadFromSpace's highest-version tie-break only masks.
type spaceSchemaWriter struct {
	spaceManager *anysync.SpaceManager

	// Test seams. When store is set the space manager is not consulted and
	// spaceID / signingKey / ownerKey are used as given.
	store      schemaObjectStore
	spaceID    string
	signingKey crypto.PrivKey
	ownerKey   string
}

// target resolves the store, space and signing material for a write — from the
// test seams when set, otherwise from the space manager's community space.
func (s *spaceSchemaWriter) target() (schemaObjectStore, string, crypto.PrivKey, string, error) {
	if s.store != nil {
		return s.store, s.spaceID, s.signingKey, s.ownerKey, nil
	}
	if s.spaceManager == nil {
		return nil, "", nil, "", fmt.Errorf("space manager not available")
	}
	spaceID := s.spaceManager.GetCommunitySpaceID()
	if spaceID == "" {
		return nil, "", nil, "", fmt.Errorf("community space not configured")
	}
	client := s.spaceManager.GetClient()
	if client == nil {
		return nil, "", nil, "", fmt.Errorf("any-sync client not available")
	}
	keys, err := anysync.LoadOrCreateSpaceKeySet(client.GetDataDir(), spaceID, client.GetSigningKey())
	if err != nil {
		return nil, "", nil, "", fmt.Errorf("loading space keys: %w", err)
	}
	ownerKey := ""
	if keys.SigningKey != nil {
		if pub, err := keys.SigningKey.GetPublic().Marshall(); err == nil {
			ownerKey = fmt.Sprintf("%x", pub)
		}
	}
	return s.spaceManager.ObjectTreeManager(), spaceID, keys.SigningKey, ownerKey, nil
}

func (s *spaceSchemaWriter) WriteTypeDefinition(ctx context.Context, def *types.TypeDefinition) error {
	store, spaceID, signingKey, ownerKey, err := s.target()
	if err != nil {
		return err
	}
	data, err := json.Marshal(def)
	if err != nil {
		return fmt.Errorf("marshaling type definition: %w", err)
	}

	writeCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()

	objectID, err := existingTypeDefinitionID(writeCtx, store, spaceID, def.Name)
	if err != nil {
		return fmt.Errorf("looking up stored definition %q: %w", def.Name, err)
	}
	if objectID == "" {
		objectID = fmt.Sprintf("typedef-%s", def.Name)
	}

	payload := &anysync.ObjectPayload{
		ID:        objectID,
		Type:      "type_definition",
		OwnerKey:  ownerKey,
		Data:      data,
		Timestamp: time.Now().Unix(),
		Version:   def.Version,
	}
	_, err = store.AddObject(writeCtx, spaceID, payload, signingKey)
	return err
}

// existingTypeDefinitionID returns the object ID of the type_definition stored
// for name in spaceID, or "" when there is none. Should the space hold several
// (a pre-fix write path could leave stale copies), the one with the highest
// data.version wins and ties keep the first enumerated — the same tie-break
// Registry.LoadFromSpace applies at boot, so the copy updated here is the copy
// the next boot loads. Entries whose data does not parse are ignored.
func existingTypeDefinitionID(ctx context.Context, store schemaObjectStore, spaceID, name string) (string, error) {
	objects, err := store.ReadObjectsByType(ctx, spaceID, "type_definition")
	if err != nil {
		return "", err
	}
	bestID, bestVersion := "", -1
	for _, o := range objects {
		if o == nil {
			continue
		}
		var head struct {
			Name    string `json:"name"`
			Version int    `json:"version"`
		}
		if err := json.Unmarshal(o.Data, &head); err != nil || head.Name != name {
			continue
		}
		if head.Version > bestVersion {
			bestID, bestVersion = o.ID, head.Version
		}
	}
	return bestID, nil
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
