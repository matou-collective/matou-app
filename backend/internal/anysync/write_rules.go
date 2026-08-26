// Package anysync provides any-sync integration for MATOU.
// write_rules.go implements peer-side validation of synced object changes
// (GH#19, part 1). Any-sync ACL permissions are strictly space-scoped — a space
// Writer may write any change to any object in that space — so the SDK cannot
// express "only a steward may set a contribution to signed_off". A modified
// peer with legitimate Writer permission on the community space can therefore
// forge a high-stakes transition (sign-off, reward, project completion, role
// change) and every peer's SDK will accept the change into the tree.
//
// This file adds an application-layer check that runs while state is
// reconstructed from a tree (state.go BuildStateValidated). Each change that
// sets a guarded field to a high-stakes value is validated against the
// author's synced role; changes that fail are excluded from the computed state
// (as if they were never authored) and recorded for observability.
//
// Determinism (GH#19 AC-2): a verdict depends only on data every peer syncs —
// the change's author identity and timestamp, the ACL join records (account →
// AID, first-bound wins in ACL record order, see acl.go AccountAIDMap) and the
// CommunityProfile role history (role as-of the change's timestamp, see
// role_resolver.go). It never consults wall-clock time or "current" roles, so
// two honest peers with the same synced trees reach the same verdict, and
// demoting a steward later does not retroactively reject their past sign-offs.
//
// Legitimacy source — KNOWN GAP (GH#19 AC-1 is NOT met by this part): the
// account → AID binding comes from ACL join metadata that the *joining* peer
// writes (api/spaces.go HandleJoinCommunity interpolates the client-supplied
// UserAID). A modified client can therefore join claiming a steward's AID. The
// first-bound-wins dedupe in AccountAIDMap stops a *second* account from
// hijacking an AID that is already bound, but it cannot stop a fresh claim of
// an AID that has not joined yet. Closing that hole requires KERI-backed
// proofs of the AID ↔ any-sync-account binding (GH#20). When those land, the
// RoleResolver must be replaced by one that also verifies the proof; the
// fail-open branch below (unresolved author → allow) must then become
// fail-closed per the decided design (per-action digest verification), which
// is an engine change, not a drop-in swap.
package anysync

import (
	"encoding/json"
	"log"
	"sync"

	"github.com/matou-dao/backend/internal/contributions"
)

// ChangeValidator decides whether a decoded change may contribute to derived
// state. It is consulted per change during state reconstruction.
type ChangeValidator interface {
	// ValidateChange reports whether the change identified by changeID,
	// authored by the any-sync account `author` (crypto.PubKey.Account()) at
	// unix time `timestamp` (the change's own Timestamp field, part of the
	// synced tree data), may apply `ops` to an object of the given type.
	// `current` is the object's field state immediately before this change is
	// applied, used to tell a genuine high-stakes transition apart from a
	// no-op re-assertion (e.g. a snapshot that merely carries a value forward).
	//
	// Returning false excludes the change from state computation and is
	// expected to record it for observability. Implementations must be
	// deterministic: the same inputs yield the same verdict on every peer.
	ValidateChange(objectType, objectID, changeID, author string, timestamp int64, ops []ChangeOp, current map[string]json.RawMessage) bool
}

// RoleResolver maps an any-sync change author (the account string returned by
// crypto.PubKey.Account()) to the contribution-system roles that author held
// at a given point in time, derived purely from synced state. It must be
// deterministic so every honest peer with the same synced state resolves the
// same roles.
type RoleResolver interface {
	// RolesForAuthorAt returns the roles the account held as of unix time
	// `at` (a change timestamp). ok is false when the author cannot be
	// resolved from currently-synced state (unknown account, or profile not
	// yet replicated). Callers fail open on !ok, because absence of evidence
	// is not proof of a violation — see the package comment for why this is
	// a known gap.
	RolesForAuthorAt(account string, at int64) (roles []contributions.Role, ok bool)
}

// RejectedChange describes a change excluded from state by a write rule.
type RejectedChange struct {
	ObjectType string `json:"objectType"`
	ObjectID   string `json:"objectId"`
	ChangeID   string `json:"changeId"`
	Author     string `json:"author"`
	Field      string `json:"field"`
	Value      string `json:"value"`
	Reason     string `json:"reason"`
}

// RejectionRecorder receives changes rejected by the write rules so they can be
// surfaced for observability rather than silently dropped.
type RejectionRecorder interface {
	RecordRejection(rc RejectedChange)
}

// LoggingRejectionRecorder logs every rejection and keeps a bounded in-memory
// ring of the most recent ones so they remain inspectable at runtime. State is
// rebuilt on every read, so the same forged change is re-rejected on every
// read; the recorder dedupes by change ID so each forgery is logged and
// retained once.
type LoggingRejectionRecorder struct {
	mu     sync.Mutex
	recent []RejectedChange
	seen   map[string]struct{}
	max    int
}

// NewLoggingRejectionRecorder creates a recorder that retains up to max recent
// distinct rejections (max <= 0 defaults to 100).
func NewLoggingRejectionRecorder(max int) *LoggingRejectionRecorder {
	if max <= 0 {
		max = 100
	}
	return &LoggingRejectionRecorder{max: max, seen: make(map[string]struct{})}
}

// RecordRejection logs the rejection and appends it to the bounded ring,
// unless a rejection for the same change ID has already been recorded.
func (r *LoggingRejectionRecorder) RecordRejection(rc RejectedChange) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, dup := r.seen[rc.ChangeID]; dup {
		return
	}

	log.Printf("[write-rules] REJECTED %s change %s on %s/%s by %q: %s (%s=%s)",
		rc.ObjectType, rc.ChangeID, rc.ObjectType, rc.ObjectID, rc.Author, rc.Reason, rc.Field, rc.Value)

	r.seen[rc.ChangeID] = struct{}{}
	r.recent = append(r.recent, rc)
	if len(r.recent) > r.max {
		evicted := r.recent[:len(r.recent)-r.max]
		for _, e := range evicted {
			delete(r.seen, e.ChangeID)
		}
		r.recent = r.recent[len(r.recent)-r.max:]
	}
}

// Recent returns a copy of the retained rejections, oldest first.
func (r *LoggingRejectionRecorder) Recent() []RejectedChange {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]RejectedChange, len(r.recent))
	copy(out, r.recent)
	return out
}

// rolePredicate reports whether an author holding the given roles is permitted
// to make the guarded transition.
type rolePredicate func(roles []contributions.Role) bool

// allowAction permits a transition when the author's roles satisfy an existing
// contributions policy action. Reusing the policy table keeps peer-side rules
// in sync with the HTTP-layer RBAC (contributions.CanPerformAction).
func allowAction(a contributions.Action) rolePredicate {
	return func(roles []contributions.Role) bool {
		return contributions.CanPerformAction(roles, a)
	}
}

// allowRoles permits a transition when the author holds one of the listed roles.
// Used for high-stakes transitions that have no dedicated policy action yet.
func allowRoles(allowed ...contributions.Role) rolePredicate {
	return func(roles []contributions.Role) bool {
		for _, r := range roles {
			for _, a := range allowed {
				if r == a {
					return true
				}
			}
		}
		return false
	}
}

// objectRule declares the guarded field of one object type and which values of
// that field are high-stakes.
type objectRule struct {
	field string
	// byValue gates specific values of the field (e.g. status transitions).
	byValue map[string]rolePredicate
	// anyValue, when non-nil, treats any change of the field as high-stakes
	// (e.g. CommunityProfile.role).
	anyValue rolePredicate
}

// permitFor returns the predicate guarding a proposed value and whether that
// value is high-stakes at all.
func (r objectRule) permitFor(value string) (rolePredicate, bool) {
	if r.anyValue != nil {
		return r.anyValue, true
	}
	p, ok := r.byValue[value]
	return p, ok
}

// communityWriteRules is the per-object-type write policy for high-stakes
// community-space objects: contribution sign-off/reward, project completion,
// implementation-plan and proposal sign-off, and profile role changes. Every
// honest peer evaluates this identical table, so verdicts agree.
var communityWriteRules = map[string]objectRule{
	TypeContribution: {
		field: "status",
		byValue: map[string]rolePredicate{
			string(contributions.ContribSignedOff): allowAction(contributions.ActionSignOffContribution),
			string(contributions.ContribRewarded):  allowAction(contributions.ActionRewardContribution),
		},
	},
	TypeProject: {
		field: "status",
		byValue: map[string]rolePredicate{
			string(contributions.ProjectCompleted):         allowAction(contributions.ActionApproveProjectCompletion),
			string(contributions.ProjectPendingCompletion): allowAction(contributions.ActionSubmitProjectCompletion),
		},
	},
	// ImplementationPlan.signed_off is a bool; only the transition to true is
	// high-stakes (invalidation back to false happens on any milestone edit).
	TypeImplementationPlan: {
		field: "signed_off",
		byValue: map[string]rolePredicate{
			"true": allowAction(contributions.ActionSignOffPlan),
		},
	},
	TypeProposal: {
		field: "status",
		byValue: map[string]rolePredicate{
			string(contributions.ProposalSignedOff): allowAction(contributions.ActionSignOffProposal),
		},
	},
	// CommunityProfile carries the member role and lives in the admin-only
	// community-readonly space, so the SDK ACL already blocks non-admin writers.
	// This entry is defense-in-depth for that space and a ready hook for the day
	// role state moves to a member-writable space. Role changes are reserved to
	// operations stewards and founding members (mirrors the 2026-02-22 design).
	"CommunityProfile": {
		field:    "role",
		anyValue: allowRoles(contributions.RoleOperationsSteward, contributions.RoleFoundingMember),
	},
}

// IsGuardedObjectType reports whether objectType has a peer-side write rule.
func IsGuardedObjectType(objectType string) bool {
	_, ok := communityWriteRules[objectType]
	return ok
}

// WriteRuleValidator implements ChangeValidator using communityWriteRules, a
// RoleResolver for authorship, and an optional RejectionRecorder.
type WriteRuleValidator struct {
	resolver RoleResolver
	recorder RejectionRecorder
}

// NewWriteRuleValidator creates a validator. resolver must be non-nil; recorder
// may be nil (rejections are then dropped without a trace, which callers should
// avoid).
func NewWriteRuleValidator(resolver RoleResolver, recorder RejectionRecorder) *WriteRuleValidator {
	return &WriteRuleValidator{resolver: resolver, recorder: recorder}
}

// ValidateChange implements ChangeValidator.
func (v *WriteRuleValidator) ValidateChange(objectType, objectID, changeID, author string, timestamp int64, ops []ChangeOp, current map[string]json.RawMessage) bool {
	rule, guarded := communityWriteRules[objectType]
	if !guarded || v.resolver == nil {
		return true
	}

	for _, op := range ops {
		if op.Op != "set" || op.Field != rule.field {
			continue
		}
		value := jsonStringValue(op.Value)
		permit, highStakes := rule.permitFor(value)
		if !highStakes {
			continue
		}
		// Only a genuine transition to the high-stakes value is gated. A change
		// (typically a snapshot) that re-asserts the value already in state is
		// not a new privileged action and must be allowed, or legitimate state
		// authored by a steward would be dropped when carried forward by a
		// non-steward's snapshot.
		if cur, ok := current[op.Field]; ok && jsonStringValue(cur) == value {
			continue
		}
		roles, resolved := v.resolver.RolesForAuthorAt(author, timestamp)
		if !resolved {
			// FAIL-OPEN (by design for part 1, see package comment): the author
			// cannot be resolved from currently-synced state. Deterministic
			// across peers sharing the same synced state, but not a security
			// guarantee — GH#20 proofs turn this into fail-closed.
			continue
		}
		if !permit(roles) {
			if v.recorder != nil {
				v.recorder.RecordRejection(RejectedChange{
					ObjectType: objectType,
					ObjectID:   objectID,
					ChangeID:   changeID,
					Author:     author,
					Field:      op.Field,
					Value:      value,
					Reason:     "author not permitted to set this value",
				})
			}
			return false
		}
	}
	return true
}

// jsonStringValue decodes a JSON string value (e.g. `"signed_off"`) to its
// underlying text, falling back to the raw bytes for non-string values (so a
// JSON `true` compares as "true").
func jsonStringValue(raw json.RawMessage) string {
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	return string(raw)
}
