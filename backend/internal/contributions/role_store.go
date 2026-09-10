package contributions

import (
	"encoding/json"
	"log"
	"sync"
)

// ProfileRoleLookup implements RoleLookup by reading CommunityProfile and SharedProfile
// objects from the read-only space and mapping KERI role strings to contribution roles.
// It also supports a set of known admin AIDs that are always granted community_admin.
type ProfileRoleLookup struct {
	store         ObjectStore
	space         string        // community read-only space ID captured at construction
	spaceResolver func() string // live read-only space ID resolver (preferred over the captured value)

	mu        sync.RWMutex
	adminAIDs map[string]bool // AIDs that always get community_admin role
}

// NewProfileRoleLookup creates a ProfileRoleLookup that reads profiles from
// store in the community read-only space readOnlySpaceID.
func NewProfileRoleLookup(store ObjectStore, readOnlySpaceID string) *ProfileRoleLookup {
	return &ProfileRoleLookup{store: store, space: readOnlySpaceID, adminAIDs: make(map[string]bool)}
}

// SetAdminAIDs configures AIDs that are always treated as community admins.
// Called concurrently with GetUserRoles/IsAdminAID from the org-config
// update callback, so adminAIDs is guarded by mu.
func (l *ProfileRoleLookup) SetAdminAIDs(aids []string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, aid := range aids {
		l.adminAIDs[aid] = true
	}
}

// SetSpaceIDResolver installs a live resolver for the community read-only space ID.
// The backend boots before an identity (and its read-only space) exists, so the ID
// captured in NewProfileRoleLookup is empty until a restart. Consulting a resolver on
// every lookup lets roles resolve from the current read-only space without a restart —
// mirroring the resolver pattern used elsewhere for role resolution (#157).
func (l *ProfileRoleLookup) SetSpaceIDResolver(resolver func() string) {
	l.spaceResolver = resolver
}

// spaceID returns the live read-only space ID from the resolver when available,
// falling back to the value captured at construction.
func (l *ProfileRoleLookup) spaceID() string {
	if l.spaceResolver != nil {
		if s := l.spaceResolver(); s != "" {
			return s
		}
	}
	return l.space
}

// IsAdminAID reports whether the AID is in the org-config admin list.
// Used as the un-lockout backstop: org admins can always edit the role
// policy regardless of what the policy's grants say.
func (l *ProfileRoleLookup) IsAdminAID(aid string) bool {
	l.mu.RLock()
	defer l.mu.RUnlock()
	return l.adminAIDs[aid]
}

// GetUserRoles reads the user's profile and maps the KERI role to contribution roles.
func (l *ProfileRoleLookup) GetUserRoles(aid string) ([]Role, error) {
	// Check admin AID list first (from org config)
	l.mu.RLock()
	isAdmin := l.adminAIDs[aid]
	l.mu.RUnlock()
	if isAdmin {
		return MapKERIRole("Founding Member"), nil
	}

	space := l.spaceID()
	if space == "" {
		log.Printf("[RoleLookup] WARNING: read-only space ID is empty, cannot resolve roles for aid=%s", aid)
		return []Role{RoleMember}, nil
	}

	// Search both CommunityProfile and SharedProfile object types
	for _, profileType := range []string{"CommunityProfile", "SharedProfile"} {
		profiles, err := l.store.List(space, profileType)
		if err != nil {
			log.Printf("[RoleLookup] failed to list %s in space %s: %v", profileType, space, err)
			continue
		}
		log.Printf("[RoleLookup] found %d %s(s) in space %s, looking for aid=%s", len(profiles), profileType, space, aid)
		for _, raw := range profiles {
			var profile struct {
				UserAID string `json:"userAID"`
				AID     string `json:"aid"`
				Role    string `json:"role"`
			}
			if err := json.Unmarshal(raw, &profile); err != nil {
				log.Printf("[RoleLookup] failed to unmarshal profile: %v", err)
				continue
			}
			profileAID := profile.UserAID
			if profileAID == "" {
				profileAID = profile.AID
			}
			if profileAID == aid && profile.Role != "" {
				roles := MapKERIRole(profile.Role)
				log.Printf("[RoleLookup] matched aid=%s role=%q → %v", aid, profile.Role, roles)
				return roles, nil
			}
		}
	}
	log.Printf("[RoleLookup] no profile matched aid=%s, defaulting to member", aid)
	// Any authenticated user with a valid AID defaults to member role
	return []Role{RoleMember}, nil
}
