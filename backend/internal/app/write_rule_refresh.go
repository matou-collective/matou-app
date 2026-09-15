package app

import (
	"context"
	"log"

	"github.com/matou-dao/backend/internal/anysync"
	"github.com/matou-dao/backend/internal/auth"
)

// The source interfaces below are the narrow slices of the any-sync managers the
// write-rule refresher consumes. They are declared so the refresher can be
// unit-tested with fakes instead of a live any-sync client (*MatouACLManager and
// *ObjectTreeManager satisfy them in production).
type refreshACLSource interface {
	AccountAIDMap(ctx context.Context, spaceID string) (map[string]string, error)
}

type refreshTreeSource interface {
	CollectRoleHistories(ctx context.Context, spaceID string) (map[string][]anysync.RoleAt, error)
	CollectProjectAssignments(ctx context.Context, spaceID string) (map[string]anysync.ProjectAssignment, error)
}

type roleSnapshotSink interface {
	Replace(anysync.RoleSnapshot)
}

type projectAssignmentSink interface {
	Replace(map[string]anysync.ProjectAssignment)
}

type keySnapshotSink interface {
	Replace(map[string][]string)
	ReplaceHistory(map[string][]auth.EstablishmentKeyState)
}

// writeRuleRefresher rebuilds the write-rule role, project-assignment and (when
// proof enforcement is on) signing-key snapshots from synced state — ACL join
// records of the community space and one listing pass over the CommunityProfile
// trees of the read-only space — off the tree-processing hot path.
//
// The community and read-only space IDs are resolved live on every run, via
// communitySpaceID / readOnlySpaceID, rather than frozen at construction: the
// backend can boot before an identity (and its spaces) exists and receive it
// later through POST /api/v1/identity/set (every fresh install, every e2e
// BackendManager backend). A refresher that captured the boot-time empty IDs
// would return silently forever, leaving the signing-key snapshot empty — so
// with proof enforcement on, every proof-gated transition authored by another
// member (contribution sign-off, plan sign-off, reward, project completion)
// fails closed with "signer key state unavailable" until the process restarts
// (#522). This mirrors the live-resolver fix #174 applied to profileRoleLookup
// and the role-policy providers.
type writeRuleRefresher struct {
	communitySpaceID func() string
	readOnlySpaceID  func() string
	adminAIDs        func() map[string]bool

	acl   refreshACLSource
	trees refreshTreeSource

	roles    roleSnapshotSink
	projects projectAssignmentSink
	keys     keySnapshotSink

	keyStateResolver auth.KeyStateResolver
	enforceProofs    bool
}

// run performs one refresh pass. It is safe to call repeatedly (the periodic
// ticker does) and never panics out — a panic in a snapshot source is recovered
// and logged, leaving the previous snapshots in place.
func (r *writeRuleRefresher) run(ctx context.Context) {
	defer func() {
		if rec := recover(); rec != nil {
			log.Printf("[write-rules] role refresh panicked: %v", rec)
		}
	}()

	// Resolve the space IDs live: they are empty until an identity is set after
	// boot, and only once both are known can the refresher build a snapshot.
	communitySpaceID := r.communitySpaceID()
	readOnlySpaceID := r.readOnlySpaceID()
	if communitySpaceID == "" || readOnlySpaceID == "" {
		return
	}

	accountAID, err := r.acl.AccountAIDMap(ctx, communitySpaceID)
	if err != nil {
		log.Printf("[write-rules] account→AID refresh failed: %v", err)
		return
	}
	history, err := r.trees.CollectRoleHistories(ctx, readOnlySpaceID)
	if err != nil {
		log.Printf("[write-rules] role history refresh failed: %v", err)
		return
	}
	adminAIDs := r.adminAIDs()
	if adminAIDs == nil {
		adminAIDs = map[string]bool{}
	}
	r.roles.Replace(anysync.RoleSnapshot{AccountAID: accountAID, History: history, AdminAIDs: adminAIDs})

	// Project-scoped write rules (issue #166): refresh the per-project
	// assignment snapshot from the community space's Project + Contribution
	// objects. Best-effort — a failed pass leaves the previous snapshot in
	// place and the rules fall back to the community-role gate.
	if assignments, err := r.trees.CollectProjectAssignments(ctx, communitySpaceID); err != nil {
		log.Printf("[write-rules] project-assignment refresh failed: %v", err)
	} else {
		r.projects.Replace(assignments)
	}

	// GH#19 part 2: when proof enforcement is on, refresh the signing-key
	// snapshot the proof verifier reads. Resolve each known member/admin
	// AID's current KEL signing key off the hot path (a network fetch, so
	// never done under a tree lock). Best-effort: an AID that fails to
	// resolve is simply absent from the snapshot, and a proof from it then
	// fails closed. NEEDS LIVE VERIFICATION: requires a reachable KERIA
	// key-state endpoint (see the signed-auth wiring below); the e2e run is
	// the verification per the ticket's acceptance criteria.
	if r.enforceProofs {
		aids := make(map[string]bool, len(accountAID)+len(adminAIDs))
		for _, aid := range accountAID {
			if aid != "" {
				aids[aid] = true
			}
		}
		for aid := range adminAIDs {
			aids[aid] = true
		}
		keySnap := make(map[string][]string, len(aids))
		for aid := range aids {
			keys, err := r.keyStateResolver.CurrentKeys(ctx, aid)
			if err != nil {
				log.Printf("[write-rules] key-state refresh failed for %s: %v", aid, err)
				continue
			}
			keySnap[aid] = keys
		}
		r.keys.Replace(keySnap)

		// GH#19 part 3 (#112): when the resolver can serve full KEL history,
		// snapshot each AID's establishment key states so the proof verifier
		// can validate a proof against the signing key as of its KEL sn —
		// surviving a later legitimate rotation (AnchoredKeyProvider). Absent
		// history, SigningKeysAt falls back to current keys (fail-closed on
		// rotation), so this is a best-effort enrichment. NEEDS LIVE
		// VERIFICATION: exercised only against a reachable KERIA endpoint.
		if hr, ok := r.keyStateResolver.(auth.KeyHistoryResolver); ok {
			histSnap := make(map[string][]auth.EstablishmentKeyState, len(aids))
			for aid := range aids {
				hist, err := hr.KeyHistory(ctx, aid)
				if err != nil {
					log.Printf("[write-rules] key-history refresh failed for %s: %v", aid, err)
					continue
				}
				histSnap[aid] = hist
			}
			r.keys.ReplaceHistory(histSnap)
		}
		// Credential/TEL binding (#112) is available as a seam
		// (WriteRuleValidator.WithCredentialVerifier + SnapshotCredentialVerifier)
		// and exercised by fixture tests, but is not wired here: there is no
		// synced representation of credential TEL/revocation status in-repo
		// yet (revocation happens client-side via KERIA), so a live snapshot
		// cannot yet distinguish revoked from active credentials. Attaching an
		// empty/incomplete verifier would fail-closed on legitimate
		// transitions, so the check stays opt-in until the TEL snapshot source
		// lands (tracked in docs/RBAC.md).
	}
}
