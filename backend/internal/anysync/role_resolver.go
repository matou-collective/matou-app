// Package anysync provides any-sync integration for MATOU.
// role_resolver.go implements the RoleResolver used by the peer-side write
// rules (write_rules.go). It maps an any-sync change author to the
// contribution-system roles they held *at the time of the change*, using only
// synced state:
//
//	author account (crypto.PubKey.Account())
//	  → member AID          (ACL join metadata, acl.go AccountAIDMap — first-bound wins)
//	  → role history        (CommunityProfile tree: every "role" set-op with its change timestamp)
//	  → role as-of change   (latest history entry whose timestamp <= the change's timestamp)
//	  → []contributions.Role (contributions.MapKERIRole)
//
// Why as-of instead of current (GH#19 AC-2): a verdict computed from *current*
// roles changes over time — demoting a steward would retroactively reject every
// sign-off they ever authored, and two peers refreshing at different moments
// would disagree. Change timestamps and profile-change timestamps are both part
// of the synced tree data, so "role at the change's timestamp" is identical on
// every peer. Timestamps are author-set, so an author can backdate a change,
// but that only lets them claim a role they genuinely held earlier (bounded by
// their own history); it cannot manufacture a role they never had.
//
// Resolution is served entirely from an in-memory snapshot. The snapshot is
// rebuilt off the state-reconstruction hot path (internal/app refresher),
// never by a synchronous read triggered from inside ValidateChange, because
// ValidateChange runs while an object tree lock is held and reading ACL/profile
// trees under that lock risks contention/deadlock. An unknown account resolves
// to ok=false and the validator fails open (see write_rules.go for why that is
// a documented gap, not a guarantee).
package anysync

import (
	"encoding/json"
	"sort"
	"sync"

	"github.com/anyproto/any-sync/commonspace/object/tree/objecttree"

	"github.com/matou-dao/backend/internal/contributions"
)

// RoleAt is one entry of a member's role history: the KERI role string that
// took effect at unix time Since (the timestamp of the CommunityProfile change
// that set it).
type RoleAt struct {
	Since int64
	Role  string
}

// RoleSnapshot is the immutable input to a HistoryRoleResolver: the ACL
// account → AID binding and each AID's role history (sorted by Since asc).
type RoleSnapshot struct {
	AccountAID map[string]string
	History    map[string][]RoleAt
	// AdminAIDs are org-config admins, treated as Founding Member at all
	// times. Org config is not tree data, so this is the one non-synced
	// input; it is the same static override ProfileRoleLookup applies for
	// the HTTP layer and is documented in docs/RBAC.md.
	AdminAIDs map[string]bool
}

// HistoryRoleResolver is a concurrency-safe RoleResolver backed by a
// RoleSnapshot that is replaced atomically by a background refresher.
type HistoryRoleResolver struct {
	mu   sync.RWMutex
	snap RoleSnapshot
}

// NewHistoryRoleResolver creates an empty resolver. Until Replace is called it
// resolves nothing (every author is unknown → validator fails open).
func NewHistoryRoleResolver() *HistoryRoleResolver {
	return &HistoryRoleResolver{snap: RoleSnapshot{
		AccountAID: map[string]string{},
		History:    map[string][]RoleAt{},
		AdminAIDs:  map[string]bool{},
	}}
}

// Replace atomically swaps in a fresh snapshot. Histories are sorted by Since
// (stable) so lookups are deterministic regardless of collection order.
func (r *HistoryRoleResolver) Replace(snap RoleSnapshot) {
	if snap.AccountAID == nil {
		snap.AccountAID = map[string]string{}
	}
	if snap.History == nil {
		snap.History = map[string][]RoleAt{}
	}
	if snap.AdminAIDs == nil {
		snap.AdminAIDs = map[string]bool{}
	}
	for aid, h := range snap.History {
		sort.SliceStable(h, func(i, j int) bool { return h[i].Since < h[j].Since })
		snap.History[aid] = h
	}
	r.mu.Lock()
	r.snap = snap
	r.mu.Unlock()
}

// RolesForAuthorAt implements RoleResolver. An account that is bound to an AID
// resolves ok=true even without profile history: every bound member is at
// least `member` (mirrors contributions.ProfileRoleLookup). A change dated
// before the AID's first recorded role likewise resolves to `member`, so an
// author cannot escape the rules by backdating a change to before their own
// profile existed.
func (r *HistoryRoleResolver) RolesForAuthorAt(account string, at int64) ([]contributions.Role, bool) {
	if account == "" {
		return nil, false
	}
	r.mu.RLock()
	snap := r.snap
	r.mu.RUnlock()

	aid, bound := snap.AccountAID[account]
	if !bound {
		return nil, false
	}
	if snap.AdminAIDs[aid] {
		return contributions.MapKERIRole("Founding Member"), true
	}
	role := ""
	for _, h := range snap.History[aid] {
		if h.Since > at {
			break
		}
		role = h.Role
	}
	if role == "" {
		return []contributions.Role{contributions.RoleMember}, true
	}
	return contributions.MapKERIRole(role), true
}

// RoleHistoryFromTree walks one CommunityProfile tree in a single pass and
// returns the profile's AID plus every role transition with the timestamp of
// the change that made it. Consecutive re-assertions of the same role (e.g.
// snapshots carrying the value forward) are collapsed. The caller must hold
// the tree lock. An empty aid means the tree carried no profile AID.
func RoleHistoryFromTree(tree objecttree.ReadableObjectTree) (aid string, history []RoleAt) {
	_ = tree.IterateRoot(
		func(change *objecttree.Change, decrypted []byte) (any, error) {
			if len(decrypted) == 0 {
				return nil, nil
			}
			var oc ObjectChange
			if err := json.Unmarshal(decrypted, &oc); err != nil || len(oc.Ops) == 0 {
				return nil, nil
			}
			return &oc, nil
		},
		func(change *objecttree.Change) bool {
			oc, ok := change.Model.(*ObjectChange)
			if !ok || oc == nil {
				return true
			}
			for _, op := range oc.Ops {
				if op.Op != "set" {
					continue
				}
				switch op.Field {
				case "userAID", "aid":
					if aid == "" {
						aid = jsonStringValue(op.Value)
					}
				case "role":
					role := jsonStringValue(op.Value)
					if role == "" {
						continue
					}
					if n := len(history); n > 0 && history[n-1].Role == role {
						continue
					}
					history = append(history, RoleAt{Since: change.Timestamp, Role: role})
				}
			}
			return true
		},
	)
	return aid, history
}
