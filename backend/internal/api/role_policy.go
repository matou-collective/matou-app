// backend/internal/api/role_policy.go
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"time"

	"github.com/matou-dao/backend/internal/anysync"
	"github.com/matou-dao/backend/internal/contributions"
)

// PolicyWriter persists a RolePolicy to the community-readonly space.
// Production implementation writes via space keys + ObjectTreeManager
// (see SpacePolicyWriter in main.go wiring); tests use a fake.
type PolicyWriter interface {
	WritePolicy(p *contributions.RolePolicy) error
}

// RolePolicyHandler serves GET/PUT /api/v1/role-policy.
type RolePolicyHandler struct {
	provider   *contributions.StorePolicyProvider
	writer     PolicyWriter
	store      contributions.ObjectStore // for custom-role-in-use checks
	roSpaceID  string
	isAdminAID func(string) bool // org-config admin backstop
}

func NewRolePolicyHandler(
	provider *contributions.StorePolicyProvider,
	writer PolicyWriter,
	store contributions.ObjectStore,
	roSpaceID string,
	isAdminAID func(string) bool,
) *RolePolicyHandler {
	return &RolePolicyHandler{
		provider: provider, writer: writer, store: store,
		roSpaceID: roSpaceID, isAdminAID: isAdminAID,
	}
}

// RegisterRoutes registers role-policy routes. GET is open (any member reads
// the policy to render UI); PUT requires the manage_roles capability or the
// org-admin backstop.
func (h *RolePolicyHandler) RegisterRoutes(mux *http.ServeMux, roleLookup RoleLookup) {
	mux.HandleFunc("/api/v1/role-policy", OptionalRBACMiddleware(roleLookup, func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			h.handleGet(w, r)
		case http.MethodPut:
			h.handlePut(w, r)
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method not allowed"})
		}
	}))
}

type rolePolicyResponse struct {
	Policy             *contributions.RolePolicy                           `json:"policy"`
	Source             string                                              `json:"source"`
	Capabilities       map[contributions.Capability][]contributions.Action `json:"capabilities"`
	CallerCapabilities []contributions.Capability                          `json:"callerCapabilities"`
}

func (h *RolePolicyHandler) effective() (*contributions.RolePolicy, string) {
	if p := h.provider.Policy(); p != nil {
		return p, "synced"
	}
	return contributions.DefaultRolePolicy(), "default"
}

// effectiveOrErr is like effective but fails closed: a store read error is
// surfaced instead of masked as "default policy". PUT must use this — the
// version check and the manage_roles invariant are meaningless if a read
// failure is silently mistaken for "policy was never saved", which would let
// a stale version:0 request overwrite a synced policy (privilege rollback).
func (h *RolePolicyHandler) effectiveOrErr() (*contributions.RolePolicy, string, error) {
	p, err := h.provider.PolicyOrErr()
	if err != nil {
		return nil, "", err
	}
	if p != nil {
		return p, "synced", nil
	}
	return contributions.DefaultRolePolicy(), "default", nil
}

func (h *RolePolicyHandler) handleGet(w http.ResponseWriter, r *http.Request) {
	policy, source := h.effective()
	resp := rolePolicyResponse{
		Policy:       policy,
		Source:       source,
		Capabilities: contributions.CapabilityActions(),
	}
	if roles := GetUserRoles(r); len(roles) > 0 {
		caller := []contributions.Capability{}
		for _, cap := range contributions.AllCapabilities() {
			if policy.HasCapability(roles, cap) {
				caller = append(caller, cap)
			}
		}
		resp.CallerCapabilities = caller
	}
	// Org-admin backstop is reflected in the response too, so the UI shows
	// the page to admins whose roles carry no grants.
	if aid := GetUserAID(r); aid != "" && h.isAdminAID(aid) {
		resp.CallerCapabilities = appendCapIfMissing(resp.CallerCapabilities, contributions.CapManageRoles)
	}
	writeJSON(w, http.StatusOK, resp)
}

func appendCapIfMissing(caps []contributions.Capability, c contributions.Capability) []contributions.Capability {
	for _, existing := range caps {
		if existing == c {
			return caps
		}
	}
	return append(caps, c)
}

type rolePolicyUpdate struct {
	Version int                                   `json:"version"`
	Roles   []contributions.RoleDef               `json:"roles"`
	Grants  map[string][]contributions.Capability `json:"grants"`
}

var roleIDPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{1,39}$`)

func (h *RolePolicyHandler) handlePut(w http.ResponseWriter, r *http.Request) {
	aid := GetUserAID(r)
	if aid == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "X-User-AID header required"})
		return
	}
	roles := GetUserRoles(r)
	if !contributions.CanPerformAction(roles, contributions.ActionManageRolePolicy) && !h.isAdminAID(aid) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "insufficient permissions"})
		return
	}

	var req rolePolicyUpdate
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("invalid request: %v", err)})
		return
	}

	current, _, err := h.effectiveOrErr()
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": fmt.Sprintf("could not verify current policy: %v", err)})
		return
	}
	if req.Version != current.Version {
		writeJSON(w, http.StatusConflict, map[string]interface{}{
			"error":          "policy was modified by someone else — reload and retry",
			"currentVersion": current.Version,
		})
		return
	}

	errMsg, err := h.validate(&req, current)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": fmt.Sprintf("could not verify role removal safety: %v", err)})
		return
	}
	if errMsg != "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": errMsg})
		return
	}

	updated := &contributions.RolePolicy{
		Version:   current.Version + 1,
		UpdatedBy: aid,
		UpdatedAt: time.Now().UTC().Format(time.RFC3339),
		Roles:     req.Roles,
		Grants:    req.Grants,
	}
	if err := h.writer.WritePolicy(updated); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("failed to store policy: %v", err)})
		return
	}
	h.provider.Invalidate()
	writeJSON(w, http.StatusOK, map[string]interface{}{"policy": updated})
}

// validate returns ("", nil) when the update is acceptable, an error message
// (caller responds 400) when the update itself is invalid, or a non-nil
// error (caller responds 503) when a dependency check couldn't be completed
// — e.g. the profile store failed to list, so custom-role-in-use safety
// can't be verified. A 503 here must never be treated as "no problem found":
// silently continuing would let a still-assigned custom role be deleted.
func (h *RolePolicyHandler) validate(req *rolePolicyUpdate, current *contributions.RolePolicy) (string, error) {
	// 1. All builtins present, unrenamed, still flagged builtin.
	builtinNames := map[string]string{} // id -> canonical displayName
	for _, r := range contributions.DefaultRolePolicy().Roles {
		builtinNames[r.ID] = r.DisplayName
	}
	builtinsSeen := map[string]bool{}
	seen := map[string]bool{}
	for _, r := range req.Roles {
		if seen[r.ID] {
			return fmt.Sprintf("duplicate role id %q", r.ID), nil
		}
		seen[r.ID] = true
		if canonicalName, isBuiltin := builtinNames[r.ID]; isBuiltin {
			if !r.Builtin {
				return fmt.Sprintf("builtin role %q cannot be made custom", r.ID), nil
			}
			if r.DisplayName != canonicalName {
				return fmt.Sprintf("builtin role %q cannot be renamed", r.ID), nil
			}
			builtinsSeen[r.ID] = true
			continue
		}
		if r.Builtin {
			return fmt.Sprintf("role %q cannot claim builtin status", r.ID), nil
		}
		if !roleIDPattern.MatchString(r.ID) {
			return fmt.Sprintf("invalid custom role id %q (want %s)", r.ID, roleIDPattern.String()), nil
		}
		if r.DisplayName == "" {
			return fmt.Sprintf("custom role %q needs a displayName", r.ID), nil
		}
	}
	for id := range builtinNames {
		if !builtinsSeen[id] {
			return fmt.Sprintf("builtin role %q cannot be removed", id), nil
		}
	}

	// 2. Grants only reference known roles and known capabilities.
	validCaps := map[contributions.Capability]bool{}
	for _, c := range contributions.AllCapabilities() {
		validCaps[c] = true
	}
	for roleID, caps := range req.Grants {
		if !seen[roleID] {
			return fmt.Sprintf("grants reference unknown role %q", roleID), nil
		}
		for _, c := range caps {
			if !validCaps[c] {
				return fmt.Sprintf("unknown capability %q for role %q", c, roleID), nil
			}
		}
	}

	// 3. At least one role must retain manage_roles (org admins are a code
	// backstop, but a policy nobody can edit via roles is almost certainly a
	// mistake — reject it).
	holderFound := false
	for _, caps := range req.Grants {
		for _, c := range caps {
			if c == contributions.CapManageRoles {
				holderFound = true
			}
		}
	}
	if !holderFound {
		return "at least one role must hold manage_roles", nil
	}

	// 4. Custom roles removed by this update must not be held by any member.
	removed := map[string]bool{}
	for _, r := range current.Roles {
		if !r.Builtin && !seen[r.ID] {
			removed[r.ID] = true
		}
	}
	if len(removed) > 0 && h.store != nil {
		for _, profileType := range []string{"CommunityProfile", "SharedProfile"} {
			raws, err := h.store.List(h.roSpaceID, profileType)
			if err != nil {
				return "", fmt.Errorf("checking custom-role usage in %s: %w", profileType, err)
			}
			for _, raw := range raws {
				var prof struct {
					Role string `json:"role"`
				}
				if json.Unmarshal(raw, &prof) == nil && removed[prof.Role] {
					return fmt.Sprintf("custom role %q is still assigned to a member — reassign before deleting", prof.Role), nil
				}
			}
		}
	}
	return "", nil
}

// SpacePolicyWriter writes the RolePolicy singleton into the community-
// readonly space using the space key set (same write path as profiles).
type SpacePolicyWriter struct {
	spaceManager *anysync.SpaceManager
	roSpaceID    string
}

func NewSpacePolicyWriter(sm *anysync.SpaceManager, roSpaceID string) *SpacePolicyWriter {
	return &SpacePolicyWriter{spaceManager: sm, roSpaceID: roSpaceID}
}

func (s *SpacePolicyWriter) WritePolicy(p *contributions.RolePolicy) error {
	if s.roSpaceID == "" {
		return fmt.Errorf("community-readonly space not configured")
	}
	client := s.spaceManager.GetClient()
	if client == nil {
		return fmt.Errorf("any-sync client not available")
	}
	keys, err := anysync.LoadOrCreateSpaceKeySet(client.GetDataDir(), s.roSpaceID, client.GetSigningKey())
	if err != nil {
		return fmt.Errorf("loading space keys: %w", err)
	}
	data, err := json.Marshal(p)
	if err != nil {
		return fmt.Errorf("marshaling policy: %w", err)
	}
	payload := &anysync.ObjectPayload{
		ID:        "RolePolicy",
		Type:      "RolePolicy",
		Data:      data,
		Timestamp: time.Now().Unix(),
		Version:   1,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	_, err = s.spaceManager.ObjectTreeManager().AddObject(ctx, s.roSpaceID, payload, keys.SigningKey)
	return err
}
