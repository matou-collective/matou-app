// backend/internal/contributions/role_store.go
package contributions

import "encoding/json"

// ProfileRoleLookup implements RoleLookup by reading CommunityProfile objects
// from the read-only space and mapping KERI role strings to contribution roles.
type ProfileRoleLookup struct {
	store ObjectStore
	space string // community read-only space ID
}

func NewProfileRoleLookup(store ObjectStore, readOnlySpaceID string) *ProfileRoleLookup {
	return &ProfileRoleLookup{store: store, space: readOnlySpaceID}
}

// GetUserRoles reads the user's CommunityProfile and maps the KERI role to contribution roles.
func (l *ProfileRoleLookup) GetUserRoles(aid string) ([]Role, error) {
	// CommunityProfile objects use the convention "CommunityProfile-{AID}" as their ID
	profiles, err := l.store.List(l.space, "CommunityProfile")
	if err != nil {
		return []Role{}, nil
	}
	for _, raw := range profiles {
		var profile struct {
			UserAID string `json:"userAID"`
			Role    string `json:"role"`
		}
		if err := json.Unmarshal(raw, &profile); err != nil {
			continue
		}
		if profile.UserAID == aid {
			return MapKERIRole(profile.Role), nil
		}
	}
	return []Role{}, nil
}
