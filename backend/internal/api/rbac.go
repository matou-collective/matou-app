package api

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"testing"

	"github.com/matou-dao/backend/internal/anystore"
	"github.com/matou-dao/backend/internal/contributions"
)

type contextKey string

const (
	ctxUserAID   contextKey = "user_aid"
	ctxUserRoles contextKey = "user_roles"
)

// RoleLookup resolves a user AID to their contribution-system roles.
// Implementation reads the "role" field from CommunityProfile in the readonly space,
// then maps it via contributions.MapKERIRole().
type RoleLookup interface {
	GetUserRoles(aid string) ([]contributions.Role, error)
}

// RBACMiddleware extracts the user AID from the X-User-AID header,
// resolves their roles, and stores both in the request context.
func RBACMiddleware(lookup RoleLookup, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		aid := r.Header.Get("X-User-AID")
		if aid == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "X-User-AID header required"})
			return
		}
		roles, err := lookup.GetUserRoles(aid)
		if err != nil {
			log.Printf("[RBAC] role lookup failed for %s: %v", aid, err)
			roles = []contributions.Role{} // default to no roles
		}

		ctx := context.WithValue(r.Context(), ctxUserAID, aid)
		ctx = context.WithValue(ctx, ctxUserRoles, roles)
		next(w, r.WithContext(ctx))
	}
}

// requireRoleLookup fails loud when a handler is wired without a RoleLookup
// outside of tests. Every handler's withRBAC treats a nil lookup as "skip
// auth" so unit tests can exercise handlers directly; in the real server a
// nil lookup would silently turn every guarded route fail-open, so the
// production wiring must never reach this with nil.
func requireRoleLookup(handler string, lookup RoleLookup) {
	if lookup == nil && !testing.Testing() {
		log.Fatalf("[RBAC] %s.RegisterRoutes called with nil RoleLookup: refusing to start with RBAC disabled", handler)
	}
}

// RequireAction wraps a handler and returns 403 if the caller lacks
// the required action permission.
func RequireAction(action contributions.Action, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		roles, _ := r.Context().Value(ctxUserRoles).([]contributions.Role)
		if !contributions.CanPerformAction(roles, action) {
			log.Printf("[RBAC] access denied: action=%s roles=%v", action, roles)
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "insufficient permissions"})
			return
		}
		next(w, r)
	}
}

// GetUserAID extracts the user AID from the request context.
func GetUserAID(r *http.Request) string {
	aid, _ := r.Context().Value(ctxUserAID).(string)
	return aid
}

// GetUserRoles extracts user roles from the request context.
func GetUserRoles(r *http.Request) []contributions.Role {
	roles, _ := r.Context().Value(ctxUserRoles).([]contributions.Role)
	return roles
}

// OptionalRBACMiddleware is like RBACMiddleware but does not reject requests
// that are missing the X-User-AID header. When the header is present, roles
// are resolved and stored in the context; when absent, the request passes
// through with no roles set.
func OptionalRBACMiddleware(lookup RoleLookup, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		aid := r.Header.Get("X-User-AID")
		if aid != "" && lookup != nil {
			roles, err := lookup.GetUserRoles(aid)
			if err != nil {
				log.Printf("[RBAC] role lookup failed for %s: %v", aid, err)
				roles = []contributions.Role{}
			}
			ctx := context.WithValue(r.Context(), ctxUserAID, aid)
			ctx = context.WithValue(ctx, ctxUserRoles, roles)
			r = r.WithContext(ctx)
		}
		next(w, r)
	}
}

// OrgConfigProvider provides access to the org config for role resolution.
type OrgConfigProvider interface {
	GetConfig() *OrgConfigData
}

// OrgConfigAdminLookup implements RoleLookup by checking if the AID
// appears in the org config admins list. This serves as a fallback when
// the primary ProfileRoleLookup cannot resolve roles (e.g. read-only
// space not configured).
type OrgConfigAdminLookup struct {
	provider OrgConfigProvider
}

// NewOrgConfigAdminLookup constructs an OrgConfigAdminLookup.
func NewOrgConfigAdminLookup(provider OrgConfigProvider) *OrgConfigAdminLookup {
	return &OrgConfigAdminLookup{provider: provider}
}

// GetUserRoles returns Founding Member for AIDs in the org config admins
// list, or an empty slice otherwise.
func (l *OrgConfigAdminLookup) GetUserRoles(aid string) ([]contributions.Role, error) {
	cfg := l.provider.GetConfig()
	if cfg == nil {
		return []contributions.Role{}, nil
	}
	for _, admin := range cfg.Admins {
		if admin.AID == aid {
			return contributions.MapKERIRole("Founding Member"), nil
		}
	}
	return []contributions.Role{}, nil
}

// CredentialRoleLookup implements RoleLookup by checking cached credentials
// in the anystore. If a credential's recipient matches the requesting AID
// and contains a role field, that role is mapped to contribution roles.
type CredentialRoleLookup struct {
	store *anystore.LocalStore
}

// NewCredentialRoleLookup constructs a CredentialRoleLookup.
func NewCredentialRoleLookup(store *anystore.LocalStore) *CredentialRoleLookup {
	return &CredentialRoleLookup{store: store}
}

// GetUserRoles returns the union of roles mapped from every cached credential
// whose recipient matches aid, or an empty slice if none is found. A member
// can hold several role credentials at once (e.g. the baseline Member
// credential plus an Operations Steward credential received later). Returning
// the first match would let the baseline Member credential mask the steward
// one depending on store iteration order (#739), so every matching credential
// contributes its mapped roles.
func (l *CredentialRoleLookup) GetUserRoles(aid string) ([]contributions.Role, error) {
	if l.store == nil {
		return []contributions.Role{}, nil
	}
	creds, err := l.store.GetAllCredentials(context.Background())
	if err != nil {
		return []contributions.Role{}, nil
	}
	var roles []contributions.Role
	for _, cred := range creds {
		if cred.SubjectAID != aid {
			continue
		}
		// Extract role from credential data
		dataBytes, err := json.Marshal(cred.Data)
		if err != nil {
			continue
		}
		var data struct {
			Role string `json:"role"`
		}
		if err := json.Unmarshal(dataBytes, &data); err != nil || data.Role == "" {
			continue
		}
		mapped := contributions.MapKERIRole(data.Role)
		if len(mapped) > 0 {
			log.Printf("[RoleLookup] credential match: aid=%s role=%q → %v", aid, data.Role, mapped)
			roles = append(roles, mapped...)
		}
	}
	return dedupeRoles(roles), nil
}

// IdentityAIDProvider returns the current identity AID. This allows
// IdentityRoleLookup to always use the live AID, even if it was set
// after server startup (e.g. during onboarding).
type IdentityAIDProvider interface {
	GetAID() string
}

// IdentityRoleLookup implements RoleLookup by checking if the requesting
// AID matches the backend's own identity AID. In the per-user architecture,
// the backend owner is always an admin (Founding Member).
type IdentityRoleLookup struct {
	provider IdentityAIDProvider
}

// NewIdentityRoleLookup constructs an IdentityRoleLookup.
func NewIdentityRoleLookup(provider IdentityAIDProvider) *IdentityRoleLookup {
	return &IdentityRoleLookup{provider: provider}
}

// GetUserRoles returns Founding Member when aid matches the backend's own
// identity AID, or an empty slice otherwise.
func (l *IdentityRoleLookup) GetUserRoles(aid string) ([]contributions.Role, error) {
	identityAID := l.provider.GetAID()
	if identityAID != "" && aid == identityAID {
		return contributions.MapKERIRole("Founding Member"), nil
	}
	return []contributions.Role{}, nil
}

// CompositeRoleLookup chains multiple RoleLookup implementations.
// It tries each in order and returns the first non-empty result.
type CompositeRoleLookup struct {
	lookups []RoleLookup
}

// NewCompositeRoleLookup constructs a CompositeRoleLookup from lookups.
func NewCompositeRoleLookup(lookups ...RoleLookup) *CompositeRoleLookup {
	return &CompositeRoleLookup{lookups: lookups}
}

// GetUserRoles returns the first non-empty role set produced by the chained
// lookups, trying each in order.
func (c *CompositeRoleLookup) GetUserRoles(aid string) ([]contributions.Role, error) {
	for _, l := range c.lookups {
		roles, err := l.GetUserRoles(aid)
		if err != nil {
			continue
		}
		if len(roles) > 0 {
			return roles, nil
		}
	}
	return []contributions.Role{}, nil
}

// UnionRoleLookup combines several RoleLookup implementations and returns the
// union (superset) of every role they resolve, rather than the first
// non-empty result. Use it where a role credential a member holds must be able
// to *upgrade* the role recorded on their synced CommunityProfile: the profile
// role is a cached mirror written by the approving steward, while the held
// credential is the admin-signed source of truth the frontend already treats
// as authoritative (identity store isSteward/canManageMembers). Combining them
// is strictly additive — a credential can grant extra roles but never strip a
// role the profile grants — so it cannot be used to self-downgrade or lock out
// an admin. See #739: a received Operations Steward credential now takes effect
// on the holder's own backend without waiting for a separate profile patch.
type UnionRoleLookup struct {
	lookups []RoleLookup
}

// NewUnionRoleLookup constructs a UnionRoleLookup from lookups.
func NewUnionRoleLookup(lookups ...RoleLookup) *UnionRoleLookup {
	return &UnionRoleLookup{lookups: lookups}
}

// GetUserRoles returns the de-duplicated union of every lookup's roles.
func (u *UnionRoleLookup) GetUserRoles(aid string) ([]contributions.Role, error) {
	var roles []contributions.Role
	for _, l := range u.lookups {
		r, err := l.GetUserRoles(aid)
		if err != nil {
			continue
		}
		roles = append(roles, r...)
	}
	return dedupeRoles(roles), nil
}

// dedupeRoles returns roles with duplicates removed, preserving first-seen
// order. It returns a nil slice (not a shared empty literal) when given no
// roles so callers treat "no roles" as empty.
func dedupeRoles(roles []contributions.Role) []contributions.Role {
	if len(roles) == 0 {
		return nil
	}
	seen := make(map[contributions.Role]bool, len(roles))
	out := make([]contributions.Role, 0, len(roles))
	for _, r := range roles {
		if seen[r] {
			continue
		}
		seen[r] = true
		out = append(out, r)
	}
	return out
}
