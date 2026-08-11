// Package anysync provides any-sync integration for MATOU.
// write_rules.go implements peer-side validation of synced object changes
// (GH#19). Any-sync ACL permissions are strictly space-scoped — a space Writer
// may write any change to any object in that space — so the SDK cannot express
// "only a steward may set a contribution to signed_off". A modified peer with
// legitimate Writer permission on the community space can therefore forge a
// high-stakes transition (sign-off, reward, project completion, role change)
// and every peer's SDK will accept the change into the tree.
//
// This file adds an application-layer check that runs while state is
// reconstructed from a tree (state.go BuildState). Each change that sets a
// guarded field to a high-stakes value is validated against the author's
// synced role; changes that fail are excluded from the computed state (as if
// they were never authored) and recorded for observability. The check is
// deterministic — it depends only on synced ACL/profile state and the tree's
// own change order — so every honest peer converges on the same view.
//
// Legitimacy source (see GH#19 item 4): until KERI-signed proofs land (GH#20),
// authorship binds to the any-sync identity ↔ AID mapping carried in ACL join
// metadata plus the admin-written CommunityProfile role. That binding is weaker
// than a KERI proof (a member controls the AID they claim at join time) but the
// structure is in place and swapping in a proof-backed RoleResolver later needs
// no change to the rule engine or the state path.
package anysync

import (
	"encoding/json"
	"log"
	"sync"

	"github.com/matou-dao/backend/internal/contributions"
)

// ChangeValidator decides whether a decoded change may contribute to derived
// state. It is consulted per change during state reconstruction (BuildState).
type ChangeValidator interface {
	// ValidateChange reports whether the change identified by changeID and
	// authored by the any-sync account `author` (crypto.PubKey.Account()) may
	// apply `ops` to an object of the given type. `current` is the object's
	// field state immediately before this change is applied, used to tell a
	// genuine high-stakes transition apart from a no-op re-assertion (e.g. a
	// snapshot that merely carries a value forward).
	//
	// Returning false excludes the change from state computation and is
	// expected to record it for observability. Implementations must be
	// deterministic: the same inputs yield the same verdict on every peer.
	ValidateChange(objectType, objectID, changeID, author string, ops []ChangeOp, current map[string]json.RawMessage) bool
}

// RoleResolver maps an any-sync change author (the account string returned by
// crypto.PubKey.Account()) to the contribution-system roles that author holds,
// derived purely from synced state. It must be deterministic so every honest
// peer with the same synced state resolves the same roles.
type RoleResolver interface {
	// RolesForAuthor returns the roles for the given account. ok is false when
	// the author cannot be resolved from currently-synced state (unknown
	// account, or role not yet replicated). Callers fail open on !ok, because
	// absence of evidence is not proof of a violation.
	RolesForAuthor(account string) (roles []contributions.Role, ok bool)
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
// ring of the most recent ones so they remain inspectable at runtime.
type LoggingRejectionRecorder struct {
	mu     sync.Mutex
	recent []RejectedChange
	max    int
}

// NewLoggingRejectionRecorder creates a recorder that retains up to max recent
// rejections (max <= 0 defaults to 100).
func NewLoggingRejectionRecorder(max int) *LoggingRejectionRecorder {
	if max <= 0 {
		max = 100
	}
	return &LoggingRejectionRecorder{max: max}
}

// RecordRejection logs the rejection and appends it to the bounded ring.
func (r *LoggingRejectionRecorder) RecordRejection(rc RejectedChange) {
	log.Printf("[write-rules] REJECTED %s change %s on %s/%s by %q: %s (%s=%s)",
		rc.ObjectType, rc.ChangeID, rc.ObjectType, rc.ObjectID, rc.Author, rc.Reason, rc.Field, rc.Value)

	r.mu.Lock()
	defer r.mu.Unlock()
	r.recent = append(r.recent, rc)
	if len(r.recent) > r.max {
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
// community-space objects. It intentionally starts with the set called out in
// GH#19: contribution sign-off/reward, project completion, and profile role
// changes. Every honest peer evaluates this identical table, so verdicts agree.
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
func (v *WriteRuleValidator) ValidateChange(objectType, objectID, changeID, author string, ops []ChangeOp, current map[string]json.RawMessage) bool {
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
		roles, resolved := v.resolver.RolesForAuthor(author)
		if !resolved {
			// Cannot prove a violation from currently-synced state — fail open.
			// Deterministic: peers sharing the same synced state resolve alike.
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
// underlying text, falling back to the raw bytes for non-string values.
func jsonStringValue(raw json.RawMessage) string {
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	return string(raw)
}
