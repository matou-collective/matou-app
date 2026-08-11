// Package anysync provides any-sync integration for MATOU.
// role_resolver.go implements the RoleResolver used by the peer-side write
// rules (write_rules.go). It maps an any-sync change author to their
// contribution-system roles using synced state:
//
//	author account (crypto.PubKey.Account())
//	  → member AID          (ACL join metadata, acl.go FindAccountPubKeyByAID's reverse)
//	  → KERI role string    (admin-written CommunityProfile.role)
//	  → []contributions.Role (contributions.MapKERIRole)
//
// Resolution is served entirely from an in-memory cache. The cache is populated
// off the state-reconstruction hot path (see cmd/server wiring), never by a
// synchronous read triggered from inside ValidateChange, because ValidateChange
// runs while an object tree lock is held and reading ACL/profile trees under
// that lock risks contention/deadlock (the same reason the tree listener's
// FreshTreeReader is used sparingly). A cache miss resolves to ok=false, and the
// validator fails open, so a not-yet-populated cache never rejects a legitimate
// change — it only defers enforcement until the refresher has run.
package anysync

import (
	"sync"

	"github.com/matou-dao/backend/internal/contributions"
)

// CachedRoleResolver is a concurrency-safe RoleResolver backed by a snapshot map
// from any-sync account string to contribution roles. The map is replaced
// atomically by a background refresher via Replace.
type CachedRoleResolver struct {
	mu        sync.RWMutex
	byAccount map[string][]contributions.Role
}

// NewCachedRoleResolver creates an empty resolver. Until Replace is called it
// resolves nothing (every author is unknown → validator fails open).
func NewCachedRoleResolver() *CachedRoleResolver {
	return &CachedRoleResolver{byAccount: make(map[string][]contributions.Role)}
}

// Replace atomically swaps in a fresh account→roles snapshot. The caller retains
// ownership of the passed map's contents; the resolver stores the reference.
func (r *CachedRoleResolver) Replace(byAccount map[string][]contributions.Role) {
	if byAccount == nil {
		byAccount = make(map[string][]contributions.Role)
	}
	r.mu.Lock()
	r.byAccount = byAccount
	r.mu.Unlock()
}

// RolesForAuthor implements RoleResolver.
func (r *CachedRoleResolver) RolesForAuthor(account string) ([]contributions.Role, bool) {
	if account == "" {
		return nil, false
	}
	r.mu.RLock()
	roles, ok := r.byAccount[account]
	r.mu.RUnlock()
	return roles, ok
}
