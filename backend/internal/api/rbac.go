package api

import (
	"context"
	"log"
	"net/http"

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
