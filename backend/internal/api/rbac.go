package api

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

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

func NewOrgConfigAdminLookup(provider OrgConfigProvider) *OrgConfigAdminLookup {
	return &OrgConfigAdminLookup{provider: provider}
}

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

func NewCredentialRoleLookup(store *anystore.LocalStore) *CredentialRoleLookup {
	return &CredentialRoleLookup{store: store}
}

func (l *CredentialRoleLookup) GetUserRoles(aid string) ([]contributions.Role, error) {
	if l.store == nil {
		return []contributions.Role{}, nil
	}
	creds, err := l.store.GetAllCredentials(context.Background())
	if err != nil {
		return []contributions.Role{}, nil
	}
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
		roles := contributions.MapKERIRole(data.Role)
		if len(roles) > 0 {
			log.Printf("[RoleLookup] credential match: aid=%s role=%q → %v", aid, data.Role, roles)
			return roles, nil
		}
	}
	return []contributions.Role{}, nil
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

func NewIdentityRoleLookup(provider IdentityAIDProvider) *IdentityRoleLookup {
	return &IdentityRoleLookup{provider: provider}
}

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

func NewCompositeRoleLookup(lookups ...RoleLookup) *CompositeRoleLookup {
	return &CompositeRoleLookup{lookups: lookups}
}

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
