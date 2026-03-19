// backend/internal/contributions/role_store.go
package contributions

import "encoding/json"

// ProfileRoleLookup implements RoleLookup by reading CommunityProfile and SharedProfile
// objects from the read-only space and mapping KERI role strings to contribution roles.
// It also supports a set of known admin AIDs that are always granted community_admin.
type ProfileRoleLookup struct {
	store     ObjectStore
	space     string            // community read-only space ID
	adminAIDs map[string]bool   // AIDs that always get community_admin role
}

func NewProfileRoleLookup(store ObjectStore, readOnlySpaceID string) *ProfileRoleLookup {
	return &ProfileRoleLookup{store: store, space: readOnlySpaceID, adminAIDs: make(map[string]bool)}
}

// SetAdminAIDs configures AIDs that are always treated as community admins.
func (l *ProfileRoleLookup) SetAdminAIDs(aids []string) {
	for _, aid := range aids {
		l.adminAIDs[aid] = true
	}
}

// GetUserRoles reads the user's profile and maps the KERI role to contribution roles.
func (l *ProfileRoleLookup) GetUserRoles(aid string) ([]Role, error) {
	// Check admin AID list first (from org config)
	if l.adminAIDs[aid] {
		return MapKERIRole("Founding Member"), nil
	}

	// Search both CommunityProfile and SharedProfile object types
	for _, profileType := range []string{"CommunityProfile", "SharedProfile"} {
		profiles, err := l.store.List(l.space, profileType)
		if err != nil {
			continue
		}
		for _, raw := range profiles {
			var profile struct {
				UserAID string `json:"userAID"`
				AID     string `json:"aid"`
				Role    string `json:"role"`
			}
			if err := json.Unmarshal(raw, &profile); err != nil {
				continue
			}
			profileAID := profile.UserAID
			if profileAID == "" {
				profileAID = profile.AID
			}
			if profileAID == aid && profile.Role != "" {
				return MapKERIRole(profile.Role), nil
			}
		}
	}
	// Any authenticated user with a valid AID defaults to member role
	return []Role{RoleMember}, nil
}
