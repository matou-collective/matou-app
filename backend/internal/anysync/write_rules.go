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
// Legitimacy source (GH#19 part 2): high-stakes proof-backed transitions
// (contribution sign-off/reward, project completion, plan sign-off) are now
// gated by verifying a KERI action proof — see proof_verifier.go. The signer
// AID is authenticated cryptographically (the change must carry a signature
// over the object's own action/subject/space/value/dt), so the interim,
// attacker-controlled ACL-join-metadata binding is no longer trusted for these
// transitions and AC-1 is met: a writer-permission forger cannot mint a valid
// signature. The signer's role is then resolved BY AID
// (RoleResolver.RolesForAIDAt) from the synced CommunityProfile role history.
//
// A residual set of transitions the frontend does not yet sign a proof for
// (submit-completion, proposal sign-off, and CommunityProfile role changes —
// the last ACL-enforced by living in the admin-only space) stay on the interim
// account → AID → role path from part 1, which remains fail-open on an
// unresolved author. See docs/RBAC.md for the full matrix.
//
// Part 3 (#112) hardens the proof path further: the proof verifier can resolve
// the signing key as of the proof's KEL sn (survives rotation, see
// proof_verifier.go / AnchoredKeyProvider) and, when a CredentialVerifier is
// wired, the transition additionally requires an unrevoked org credential for a
// permitted role (see credential_verifier.go).
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
	// ValidateChange reports whether the change identified by changeID, in
	// any-sync space `spaceID`, authored by the account `author`
	// (crypto.PubKey.Account()) at unix time `timestamp` (the change's own
	// Timestamp field, part of the synced tree data), may apply `ops` to an
	// object of the given type. `spaceID` binds a proof-backed transition to the
	// space it lives in (anti-cross-space-replay); it may be "" on a read path
	// that cannot determine the space, in which case the space check is skipped.
	// `current` is the object's field state immediately before this change is
	// applied, used to tell a genuine high-stakes transition apart from a
	// no-op re-assertion (e.g. a snapshot that merely carries a value forward).
	//
	// Returning false excludes the change from state computation and is
	// expected to record it for observability. Implementations must be
	// deterministic: the same inputs yield the same verdict on every peer.
	ValidateChange(spaceID, objectType, objectID, changeID, author string, timestamp int64, ops []ChangeOp, current map[string]json.RawMessage) bool
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
	// a known gap. Used only for the interim role-based (non-proof) rules.
	RolesForAuthorAt(account string, at int64) (roles []contributions.Role, ok bool)

	// RolesForAIDAt returns the roles the member AID held as of unix time `at`,
	// keyed directly by the KERI AID rather than by an any-sync account. It is
	// used by the proof-backed rules, where the AID has already been
	// cryptographically authenticated by verifying the action proof, so the
	// attacker-controlled account → AID binding is bypassed entirely. ok is
	// false when the AID has no known role in currently-synced state.
	RolesForAIDAt(aid string, at int64) (roles []contributions.Role, ok bool)
}

// AuthorAIDResolver optionally exposes the member AID bound to a change author
// account, so the role-only project-scoped rules can compare the author against
// a project's assigned lead/steward. HistoryRoleResolver implements it; a
// resolver that does not is simply treated as "author AID unknown", and
// project-scoped role-only transitions then fall back to the community-role
// gate.
type AuthorAIDResolver interface {
	AIDForAuthor(account string) (aid string, ok bool)
}

// ProjectAssignmentResolver resolves the per-project roles an AID holds on a
// project (project_lead / project_steward from assign-role, contributor from
// contribution assignment), from synced state, deterministically. It lets the
// project-scoped write rules gate a Contribution/Plan transition on the signer's
// role on the object's OWNING project. Mirrors contributions.Service.ProjectRoles
// on the HTTP side. When nil the project-scoped rules fall back to the
// community-role gate for those object types.
//
// known is false when the project itself is not yet in synced state on this
// peer (replication lag): the caller then falls back to the community-role gate
// rather than rejecting, so a legitimate steward's sign-off is not dropped while
// the project object catches up.
type ProjectAssignmentResolver interface {
	ProjectRolesForAID(projectID, aid string) (roles []contributions.Role, known bool)
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

// guardedValue declares how one high-stakes transition is authorised.
//
// A transition is either PROOF-BACKED or ROLE-ONLY:
//
//   - Proof-backed (proofAction != ""): the change MUST carry a valid KERI
//     action proof (see proof_verifier.go). The signer AID is authenticated
//     cryptographically and its role is then resolved by AID. This is the
//     GH#19 part-2 legitimacy source and meets AC-1: a forger cannot produce a
//     valid signature. proofField is the object field carrying the Proof
//     envelope; proofValue is the value bound in the signed message (which can
//     differ from the field's literal value — e.g. a bool "true" is signed as
//     "signed_off").
//
//   - Role-only (proofAction == ""): the frontend does not (yet) sign a proof
//     for this transition, so it stays on the interim role-based path from part
//     1 — the author is resolved via the ACL account → AID binding and gated by
//     role. Weaker (fail-open on unknown author), retained as defence-in-depth
//     for transitions without proof coverage (e.g. CommunityProfile role
//     changes, which are ACL-enforced by living in the admin-only space, and
//     submit-completion / proposal sign-off, which have no proof action).
type guardedValue struct {
	permit      rolePredicate
	proofAction string
	proofField  string
	proofValue  string

	// action is the contributions.Action this transition maps to. It is set
	// alongside permit (which is allowAction(action)) so the project-scoped
	// path can re-evaluate the action against the signer's role ON THE OBJECT'S
	// PROJECT rather than community-globally.
	action contributions.Action

	// projectScoped marks a transition whose authorisation depends on the
	// signer's role on the object's OWNING project (issue #166): a
	// project_steward may sign off only their own project's contributions, a
	// project_lead may submit only their own project's completion. When the
	// signer's project role can be resolved (the Project object carries its
	// lead/steward AID in `current`; a Contribution/Plan resolves its project
	// via a ProjectAssignmentResolver), the check becomes
	// contributions.CanPerformProjectAction(roles, projectRoles, action) — which
	// strips credential-derived project roles so a community "lead" is not lead
	// of every project. When the project assignment cannot be resolved (no
	// assignments recorded yet, or no resolver wired — dev/test), it falls back
	// to the community-role gate (permit), so no legitimate transition is newly
	// rejected. Community-scope grants (Operations Steward / Founding Member)
	// pass on every project either way.
	projectScoped bool
}

// objectRule declares the guarded field of one object type and which values of
// that field are high-stakes.
type objectRule struct {
	field string
	// byValue gates specific values of the field (e.g. status transitions).
	byValue map[string]guardedValue
	// anyValue, when non-nil, treats any change of the field as high-stakes
	// (e.g. CommunityProfile.role).
	anyValue *guardedValue
}

// permitFor returns the guarded transition for a proposed value and whether
// that value is high-stakes at all.
func (r objectRule) permitFor(value string) (guardedValue, bool) {
	if r.anyValue != nil {
		return *r.anyValue, true
	}
	gv, ok := r.byValue[value]
	return gv, ok
}

// communityWriteRules is the per-object-type write policy for high-stakes
// community-space objects: contribution sign-off/reward, project completion,
// implementation-plan and proposal sign-off, and profile role changes. Every
// honest peer evaluates this identical table, so verdicts agree.
var communityWriteRules = map[string]objectRule{
	TypeContribution: {
		field: "status",
		byValue: map[string]guardedValue{
			// Proof-backed: the frontend signs contribution_signoff /
			// contribution_reward with the acting steward's AID.
			string(contributions.ContribSignedOff): {
				permit:        allowAction(contributions.ActionSignOffContribution),
				action:        contributions.ActionSignOffContribution,
				projectScoped: true,
				proofAction:   "contribution_signoff",
				proofField:    "sign_off_proof",
				proofValue:    string(contributions.ContribSignedOff),
			},
			string(contributions.ContribRewarded): {
				permit:      allowAction(contributions.ActionRewardContribution),
				proofAction: "contribution_reward",
				proofField:  "reward_proof",
				proofValue:  string(contributions.ContribRewarded),
			},
		},
	},
	TypeProject: {
		field: "status",
		byValue: map[string]guardedValue{
			// Proof-backed: the frontend signs project_completion for the
			// completion approval.
			string(contributions.ProjectCompleted): {
				permit:        allowAction(contributions.ActionApproveProjectCompletion),
				action:        contributions.ActionApproveProjectCompletion,
				projectScoped: true,
				proofAction:   "project_completion",
				proofField:    "proof",
				proofValue:    string(contributions.ProjectCompleted),
			},
			// Role-only: submit-completion has no signed proof; keep the interim
			// role gate (defence-in-depth, weaker binding). Project-scoped: the
			// project's assigned lead (project_lead_id in `current`) submits it.
			string(contributions.ProjectPendingCompletion): {
				permit:        allowAction(contributions.ActionSubmitProjectCompletion),
				action:        contributions.ActionSubmitProjectCompletion,
				projectScoped: true,
			},
		},
	},
	// ImplementationPlan.signed_off is a bool; only the transition to true is
	// high-stakes (invalidation back to false happens on any milestone edit).
	// Proof-backed: the frontend signs plan_signoff (value "signed_off") for the
	// sign-off, even though the object field is a bool "true".
	TypeImplementationPlan: {
		field: "signed_off",
		byValue: map[string]guardedValue{
			"true": {
				permit:        allowAction(contributions.ActionSignOffPlan),
				action:        contributions.ActionSignOffPlan,
				projectScoped: true,
				proofAction:   "plan_signoff",
				proofField:    "proof",
				proofValue:    "signed_off",
			},
		},
	},
	// DecisionPlan.status → signed_off is proof-backed: the frontend signs
	// plan_signoff for decision-plan sign-off.
	TypeDecisionPlan: {
		field: "status",
		byValue: map[string]guardedValue{
			string(contributions.DecisionPlanSignedOff): {
				permit:      allowAction(contributions.ActionSignOffPlan),
				proofAction: "plan_signoff",
				proofField:  "proof",
				proofValue:  "signed_off",
			},
		},
	},
	// Role-only: proposal sign-off has no dedicated proof action in the frontend
	// yet, so it stays on the interim role gate.
	TypeProposal: {
		field: "status",
		byValue: map[string]guardedValue{
			string(contributions.ProposalSignedOff): {
				permit: allowAction(contributions.ActionSignOffProposal),
			},
		},
	},
	// CommunityProfile carries the member role and lives in the admin-only
	// community-readonly space, so the SDK ACL already blocks non-admin writers.
	// Role changes are credential-backed (ACDC revoke/re-issue), not signed via
	// the action-proof path, so this stays a role-only gate: defence-in-depth
	// for that space and a ready hook for the day role state moves to a
	// member-writable space. Reserved to operations stewards and founding
	// members (mirrors the 2026-02-22 design).
	"CommunityProfile": {
		field:    "role",
		anyValue: &guardedValue{permit: allowRoles(contributions.RoleOperationsSteward, contributions.RoleFoundingMember)},
	},
}

// IsGuardedObjectType reports whether objectType has a peer-side write rule.
func IsGuardedObjectType(objectType string) bool {
	_, ok := communityWriteRules[objectType]
	return ok
}

// WriteRuleValidator implements ChangeValidator using communityWriteRules.
//
// Proof-backed transitions are gated by verifying a KERI action proof against a
// KeyProvider (GH#19 part 2) and then resolving the crypto-verified signer AID's
// role. Role-only transitions fall back to the interim account → role
// resolution (part 1). An optional RejectionRecorder surfaces every exclusion.
type WriteRuleValidator struct {
	resolver      RoleResolver
	keys          KeyProvider
	creds         CredentialVerifier
	recorder      RejectionRecorder
	enforceProofs bool
	projects      ProjectAssignmentResolver
}

// NewWriteRuleValidator creates a validator. resolver must be non-nil; keys may
// be nil (only used when proof enforcement is on); recorder may be nil
// (rejections are dropped without a trace, which callers should avoid).
//
// enforceProofs selects the legitimacy source for proof-backed transitions:
//
//   - false (default, dev/test without the KERI crypto stack): proof-backed
//     transitions use the interim role-based path from part 1 (author → AID via
//     ACL metadata, fail-open on unknown). No proof is required, so a legit
//     sign-off made without a signify keystore is not rejected. This preserves
//     part-1 behaviour exactly and keeps environments without live KERIA
//     working.
//   - true (production / e2e with live KERIA, gated by MATOU_REQUIRE_SIGNED_AUTH
//     — the same signal that makes X-User-AID trustworthy): proof-backed
//     transitions are gated on cryptographic proof verification (fail-closed),
//     meeting GH#19 AC-1.
func NewWriteRuleValidator(resolver RoleResolver, keys KeyProvider, recorder RejectionRecorder, enforceProofs bool) *WriteRuleValidator {
	return &WriteRuleValidator{resolver: resolver, keys: keys, recorder: recorder, enforceProofs: enforceProofs}
}

// WithCredentialVerifier binds proof-backed transitions to org-credential / TEL
// status (GH#19 part 3 / #112): once set, a proof-backed transition additionally
// requires the crypto-verified signer AID to hold a valid, unrevoked org
// credential granting a role the transition permits — so a revoked credential is
// rejected even when the synced profile role history lags. When nil (the
// default) the credential check is skipped and only the profile-role check
// applies, preserving part-2 behaviour. Returns the validator for chaining.
func (v *WriteRuleValidator) WithCredentialVerifier(creds CredentialVerifier) *WriteRuleValidator {
	v.creds = creds
	return v
}

// WithProjectAssignments wires the resolver that supplies per-project role
// assignments for project-scoped write rules on Contribution/Plan objects
// (issue #166). When nil (the default), project-scoped rules for those objects
// fall back to the community-role gate — no legitimate transition is newly
// rejected, but cross-project over-grants are only caught for Project objects
// (whose lead/steward AID travels in the object's own state). Returns the
// validator for chaining.
func (v *WriteRuleValidator) WithProjectAssignments(projects ProjectAssignmentResolver) *WriteRuleValidator {
	v.projects = projects
	return v
}

// ValidateChange implements ChangeValidator.
func (v *WriteRuleValidator) ValidateChange(spaceID, objectType, objectID, changeID, author string, timestamp int64, ops []ChangeOp, current map[string]json.RawMessage) bool {
	rule, guarded := communityWriteRules[objectType]
	if !guarded || v.resolver == nil {
		return true
	}

	for _, op := range ops {
		if op.Op != "set" || op.Field != rule.field {
			continue
		}
		value := jsonStringValue(op.Value)
		gv, highStakes := rule.permitFor(value)
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

		reject := func(reason, ruleField string) bool {
			if v.recorder != nil {
				v.recorder.RecordRejection(RejectedChange{
					ObjectType: objectType,
					ObjectID:   objectID,
					ChangeID:   changeID,
					Author:     author,
					Field:      ruleField,
					Value:      value,
					Reason:     reason,
				})
			}
			return false
		}

		if gv.proofAction != "" && v.enforceProofs {
			// Proof-backed with enforcement on: the crypto proof is the
			// legitimacy source (AC-1). A forger cannot mint a valid signature.
			proof := extractProof(gv.proofField, ops)
			aid, ok, reason := verifyActionProof(v.keys, gv.proofAction, objectID, spaceID, gv.proofValue, proof)
			if !ok {
				return reject(reason, gv.proofField)
			}
			roles, resolved := v.resolver.RolesForAIDAt(aid, timestamp)
			if !resolved {
				return reject("signer AID has no known role", op.Field)
			}
			if !v.authorize(gv, objectType, objectID, aid, roles, current) {
				return reject("signer role not permitted to set this value", op.Field)
			}
			// Credential/TEL binding (#112): when a credential verifier is wired,
			// the signer must ALSO hold a valid, unrevoked org credential
			// granting a role the transition permits. This rejects a revoked
			// credential even when the profile role history still records the
			// role (a lagging profile cannot rescue a revoked credential).
			if v.creds != nil {
				credRoles, credOK, credReason := v.creds.UnrevokedRoles(aid, timestamp)
				if !credOK {
					reason := "signer credential state unavailable"
					if credReason != "" {
						reason = reason + ": " + credReason
					}
					return reject(reason, gv.proofField)
				}
				if !v.authorize(gv, objectType, objectID, aid, credRoles, current) {
					reason := "signer holds no unrevoked credential for a permitted role"
					if credReason != "" {
						reason = credReason
					}
					return reject(reason, gv.proofField)
				}
			}
			continue
		}

		// Role-only path: either a transition with no proof action, or a
		// proof-backed transition with enforcement off (interim part-1
		// behaviour). Resolve the author via the account → AID binding and gate
		// by role. Fail-open on an unresolved author.
		roles, resolved := v.resolver.RolesForAuthorAt(author, timestamp)
		if !resolved {
			continue
		}
		authorAID := ""
		if ar, ok := v.resolver.(AuthorAIDResolver); ok {
			authorAID, _ = ar.AIDForAuthor(author)
		}
		if !v.authorize(gv, objectType, objectID, authorAID, roles, current) {
			return reject("author not permitted to set this value", op.Field)
		}
	}
	return true
}

// authorize applies a guarded transition's role check. For a project-scoped
// transition whose owning project can be resolved, it evaluates the action
// against the signer's role ON THAT PROJECT (community roles with credential-
// derived project roles stripped, unioned with the signer's actual assignment
// roles) — so a project lead/steward is authorised only on their own project,
// while community-scope grants (Operations Steward / Founding Member) still pass
// everywhere. When the transition is not project-scoped, or the project role
// cannot be resolved (signer AID unknown, no assignments recorded, or no
// resolver wired), it falls back to the community-role gate so no legitimate
// transition is newly rejected.
func (v *WriteRuleValidator) authorize(gv guardedValue, objectType, objectID, signerAID string, roles []contributions.Role, current map[string]json.RawMessage) bool {
	if gv.projectScoped && gv.action != "" && signerAID != "" {
		if projectRoles, known := v.signerProjectRoles(objectType, objectID, current, signerAID); known {
			return contributions.CanPerformProjectAction(roles, projectRoles, gv.action)
		}
	}
	return gv.permit(roles)
}

// signerProjectRoles resolves the per-project roles signerAID holds on the
// object's owning project, deterministically from synced state. For a Project
// object the lead/steward AID travels in the object's own `current` state; for a
// Contribution/Plan it is resolved via the ProjectAssignmentResolver keyed by
// the object's project_id. Returns ok=false when the project (and thus the
// signer's role on it) cannot be determined, so the caller falls back to the
// community-role gate.
func (v *WriteRuleValidator) signerProjectRoles(objectType, objectID string, current map[string]json.RawMessage, signerAID string) ([]contributions.Role, bool) {
	switch objectType {
	case TypeProject:
		lead := fieldString(current, "project_lead_id")
		steward := fieldString(current, "project_steward_id")
		if lead == "" && steward == "" {
			return nil, false
		}
		var roles []contributions.Role
		if signerAID != "" && signerAID == lead {
			roles = append(roles, contributions.RoleProjectLead)
		}
		if signerAID != "" && signerAID == steward {
			roles = append(roles, contributions.RoleProjectSteward)
		}
		return roles, true
	case TypeContribution, TypeImplementationPlan:
		if v.projects == nil {
			return nil, false
		}
		projectID := fieldString(current, "project_id")
		if projectID == "" {
			return nil, false
		}
		return v.projects.ProjectRolesForAID(projectID, signerAID)
	default:
		return nil, false
	}
}

// fieldString reads a string-valued field from an object's current field state,
// returning "" when absent.
func fieldString(current map[string]json.RawMessage, field string) string {
	if current == nil {
		return ""
	}
	raw, ok := current[field]
	if !ok {
		return ""
	}
	return jsonStringValue(raw)
}

// extractProof pulls the Proof envelope for a proof-backed transition from the
// change's OWN ops only. A genuine transition always writes the proof in the
// same change as the guarded field (the service layer sets status and proof in
// one save). The object's persisted proof field is deliberately NOT consulted:
// a proof that already sits on the object binds the same action/subject/space/
// value by construction, so falling back to it would let any writer re-assert
// the high-stakes value (e.g. after a permitted revert) without a signature of
// their own — a replay of the original signer's authority. Returns nil when the
// change carries no proof, which verifyActionProof treats as a missing proof.
func extractProof(field string, ops []ChangeOp) *contributions.Proof {
	for _, op := range ops {
		if op.Op == "set" && op.Field == field {
			return decodeProof(op.Value)
		}
	}
	return nil
}

func decodeProof(raw json.RawMessage) *contributions.Proof {
	if len(raw) == 0 {
		return nil
	}
	var p contributions.Proof
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil
	}
	return &p
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
