// backend/internal/contributions/role_store.go
package contributions

import (
	"encoding/json"
	"log"
)

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
	if l.space == "" {
		log.Printf("[RoleLookup] WARNING: read-only space ID is empty, cannot resolve roles for aid=%s", aid)
		return []Role{}, nil
	}
	// CommunityProfile objects use the convention "CommunityProfile-{AID}" as their ID
	profiles, err := l.store.List(l.space, "CommunityProfile")
	if err != nil {
		log.Printf("[RoleLookup] failed to list CommunityProfiles in space %s: %v", l.space, err)
		return []Role{}, nil
	}
	log.Printf("[RoleLookup] found %d CommunityProfile(s) in space %s, looking for aid=%s", len(profiles), l.space, aid)
	for _, raw := range profiles {
		var profile struct {
			UserAID string `json:"userAID"`
			Role    string `json:"role"`
		}
		if err := json.Unmarshal(raw, &profile); err != nil {
			log.Printf("[RoleLookup] failed to unmarshal profile: %v", err)
			continue
		}
		if profile.UserAID == aid {
			roles := MapKERIRole(profile.Role)
			log.Printf("[RoleLookup] matched aid=%s role=%q → %v", aid, profile.Role, roles)
			return roles, nil
		}
	}
	log.Printf("[RoleLookup] no CommunityProfile matched aid=%s", aid)
	return []Role{}, nil
}
