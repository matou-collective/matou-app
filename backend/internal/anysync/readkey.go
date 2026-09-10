// Package anysync provides any-sync integration for MATOU.
// readkey.go reports whether the local account can currently read a space, used
// to surface a "space-access-pending" state for spaces adopted by a linked or
// recovered device before the ACL has delivered their read key.
package anysync

import (
	"context"

	"github.com/anyproto/any-sync/commonspace"
)

// Space-access states reported to callers.
const (
	SpaceAccessOK      = "ok"
	SpaceAccessPending = "pending"
)

// spaceReadKeyAvailable reports whether this account currently holds the read
// key for the current ACL read-key epoch, i.e. it can decrypt the space's
// trees. A linked/recovered device adopts a space before the ACL has delivered
// the read key; until then reads fail and access is "pending".
func spaceReadKeyAvailable(sp commonspace.Space) bool {
	if sp == nil {
		return false
	}
	acl := sp.Acl()
	if acl == nil {
		return false
	}
	acl.RLock()
	defer acl.RUnlock()
	st := acl.AclState()
	if st == nil {
		return false
	}
	_, err := st.CurrentReadKey()
	return err == nil
}

// SpaceReadKeyReady reports whether the local account can read spaceID right
// now. It returns false on any error (space not openable, ACL not yet synced,
// read key not yet delivered) — the caller treats false as "pending".
func (m *SpaceManager) SpaceReadKeyReady(ctx context.Context, spaceID string) bool {
	client := m.GetClient()
	if client == nil {
		return false
	}
	sp, err := client.GetSpace(ctx, spaceID)
	if err != nil {
		return false
	}
	return spaceReadKeyAvailable(sp)
}
