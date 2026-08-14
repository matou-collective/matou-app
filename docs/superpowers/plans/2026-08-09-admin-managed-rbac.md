# Admin-Managed RBAC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Community admins manage RBAC through the UI — edit per-role capability grants, create custom roles backed by KERI membership credentials — with one versioned `RolePolicy` object synced to every member's backend via the community-readonly space.

**Architecture:** A fixed capability registry in Go maps ~13 grouped capabilities to backend Action constants. A `RolePolicy` object (role registry + grants matrix) lives in the community-readonly any-sync space; a `PolicyProvider` with a short TTL cache feeds `CanPerformAction`, falling back to a built-in default policy exactly equivalent to today's hardcoded tables. New `GET/PUT /api/v1/role-policy` endpoints (PUT gated by the `manage_roles` meta-capability with an org-config-admin backstop) drive a new Roles & Permissions admin page.

**Tech Stack:** Go backend (net/http, any-sync object trees via `ObjectTreeManager`/`ObjectStoreAdapter`), Quasar/Vue 3 + Pinia frontend, Vitest for frontend unit tests, `go test` for backend.

**Spec:** `docs/superpowers/specs/2026-08-09-admin-managed-rbac-design.md`

## Global Constraints

- Hard prerequisite context: issue #6 (RBAC route wiring) is separate work. This plan must not change which routes are wired — it only changes *what the policy says* when a wired route checks `CanPerformAction`.
- Default behavior must be **exactly equivalent** to today's `actionPermissions` + `MapKERIRole` tables when no `RolePolicy` object exists (verified by an equivalence test in Task 2).
- Org-config admins must ALWAYS be able to edit the policy (code-enforced backstop; not expressible in the matrix).
- The 10 builtin roles cannot be deleted or renamed via the API.
- Custom role IDs: `^[a-z][a-z0-9_]{1,39}$`, must not collide with builtin role IDs or KERI role names.
- Backend module path is `github.com/matou-dao/backend`. Frontend imports use Quasar aliases (`stores/...`, `src/lib/...`).
- Run backend tests from `backend/`: `go test ./internal/... -run <Name> -v`. Run frontend unit tests from `frontend/`: `npm run test:script`.
- Commit after every task (each task ends with a commit step).

---

### Task 1: Capability registry

**Files:**
- Create: `backend/internal/contributions/capabilities.go`
- Create: `backend/internal/contributions/capabilities_test.go`
- Modify: `backend/internal/contributions/roles.go` (add 4 new Action constants)

**Interfaces:**
- Produces: `type Capability string`, capability constants (`CapContribute`, `CapManageProjects`, `CapAssignWork`, `CapReviewWork`, `CapSignOff`, `CapReward`, `CapSubmitCompletion`, `CapApproveCompletion`, `CapArchiveWork`, `CapManageMembers`, `CapManageGovernance`, `CapManageComms`, `CapManageRoles`), `CapabilityActions() map[Capability][]Action`, `ActionCapability(a Action) (Capability, bool)`, `AllCapabilities() []Capability`. New Action constants: `ActionInitMember`, `ActionChangeMemberRole`, `ActionRemoveMember`, `ActionManageRolePolicy`.

- [ ] **Step 1: Write the failing test**

```go
// backend/internal/contributions/capabilities_test.go
package contributions

import "testing"

// Every existing action must belong to exactly one capability.
func TestEveryActionHasExactlyOneCapability(t *testing.T) {
	allActions := []Action{
		ActionCreateContribution, ActionConfirmContribution, ActionAssignContribution,
		ActionApproveContribution, ActionSignOffContribution, ActionRewardContribution,
		ActionCreateProject, ActionEditProject, ActionDeleteProject,
		ActionCreateSubContrib, ActionRegisterInterest,
		ActionShareContribution, ActionOfferContribution, ActionAcceptOffer,
		ActionSubmitEvidence, ActionReviewContribution, ActionSignOffPlan,
		ActionApproveSubContrib,
		ActionSignOffProposal, ActionRejectProposal, ActionEditProposal, ActionWithdrawProposal,
		ActionArchiveProject, ActionArchiveMilestone, ActionArchiveContribution,
		ActionUnassignContribution, ActionEditMilestone,
		ActionSubmitProjectCompletion, ActionApproveProjectCompletion, ActionRejectProjectCompletion,
		ActionInitMember, ActionChangeMemberRole, ActionRemoveMember, ActionManageRolePolicy,
	}
	for _, a := range allActions {
		count := 0
		for _, actions := range CapabilityActions() {
			for _, ca := range actions {
				if ca == a {
					count++
				}
			}
		}
		if count != 1 {
			t.Errorf("action %q appears in %d capabilities, want exactly 1", a, count)
		}
	}
}

func TestActionCapabilityReverseLookup(t *testing.T) {
	cap, ok := ActionCapability(ActionSignOffContribution)
	if !ok || cap != CapSignOff {
		t.Errorf("ActionCapability(sign_off_contribution) = %q, %v; want %q, true", cap, ok, CapSignOff)
	}
	if _, ok := ActionCapability(Action("nonexistent")); ok {
		t.Error("ActionCapability(nonexistent) should return ok=false")
	}
}

func TestAllCapabilitiesStable(t *testing.T) {
	caps := AllCapabilities()
	if len(caps) != 13 {
		t.Errorf("AllCapabilities() returned %d capabilities, want 13", len(caps))
	}
	// manage_communications intentionally has no actions yet (routes unwired; see spec §2 note)
	if actions := CapabilityActions()[CapManageComms]; len(actions) != 0 {
		t.Errorf("manage_communications should map to no actions yet, got %v", actions)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/contributions/ -run 'TestEveryActionHasExactlyOneCapability|TestActionCapabilityReverseLookup|TestAllCapabilitiesStable' -v`
Expected: FAIL to compile — `undefined: ActionInitMember`, `undefined: CapabilityActions`, etc.

- [ ] **Step 3: Add the new Action constants to roles.go**

In `backend/internal/contributions/roles.go`, extend the `const` block that ends with `ActionRejectProjectCompletion` (after line 91):

```go
	// Membership management (route wiring lands with issue #6; constants
	// defined here so the capability registry is complete)
	ActionInitMember       Action = "init_member"
	ActionChangeMemberRole Action = "change_member_role"
	ActionRemoveMember     Action = "remove_member"

	// Role-policy management (the manage_roles meta-permission)
	ActionManageRolePolicy Action = "manage_role_policy"
```

Do NOT add these to `actionPermissions` — the legacy table stays untouched (it remains the reference for the Task 2 equivalence test).

- [ ] **Step 4: Write the capability registry**

```go
// backend/internal/contributions/capabilities.go
package contributions

// Capability is a human-sized group of Actions, the unit admins toggle in the
// Roles & Permissions UI. The registry below is fixed in code; the synced
// RolePolicy stores only which roles hold which capabilities.
type Capability string

const (
	CapContribute        Capability = "contribute"
	CapManageProjects    Capability = "manage_projects"
	CapAssignWork        Capability = "assign_work"
	CapReviewWork        Capability = "review_work"
	CapSignOff           Capability = "sign_off"
	CapReward            Capability = "reward"
	CapSubmitCompletion  Capability = "submit_completion"
	CapApproveCompletion Capability = "approve_completion"
	CapArchiveWork       Capability = "archive_work"
	CapManageMembers     Capability = "manage_members"
	CapManageGovernance  Capability = "manage_governance"
	CapManageComms       Capability = "manage_communications"
	CapManageRoles       Capability = "manage_roles"
)

// capabilityActions is the single place a backend Action gets classified.
// Composition mirrors the permission equivalence classes of the legacy
// actionPermissions table so the default policy (policy.go) reproduces
// today's behavior exactly.
var capabilityActions = map[Capability][]Action{
	CapContribute: {
		ActionCreateContribution, ActionCreateSubContrib, ActionRegisterInterest,
		ActionShareContribution, ActionOfferContribution, ActionAcceptOffer,
		ActionSubmitEvidence, ActionConfirmContribution,
	},
	CapManageProjects: {ActionCreateProject, ActionEditProject, ActionDeleteProject},
	CapAssignWork:     {ActionAssignContribution},
	CapReviewWork:     {ActionReviewContribution, ActionApproveContribution, ActionApproveSubContrib},
	CapSignOff:        {ActionSignOffContribution, ActionSignOffPlan},
	CapReward:         {ActionRewardContribution},
	CapSubmitCompletion:  {ActionSubmitProjectCompletion},
	CapApproveCompletion: {ActionApproveProjectCompletion, ActionRejectProjectCompletion},
	CapArchiveWork: {
		ActionArchiveProject, ActionArchiveMilestone, ActionArchiveContribution,
		ActionUnassignContribution, ActionEditMilestone,
	},
	CapManageMembers:    {ActionInitMember, ActionChangeMemberRole, ActionRemoveMember},
	CapManageGovernance: {ActionSignOffProposal, ActionRejectProposal, ActionEditProposal, ActionWithdrawProposal},
	// Notices/chat routes have no Action constants yet (follow-up to issue #6).
	// The capability exists so grants can be configured ahead of enforcement.
	CapManageComms: {},
	CapManageRoles: {ActionManageRolePolicy},
}

// actionToCapability is the reverse index, built once at init.
var actionToCapability = func() map[Action]Capability {
	m := make(map[Action]Capability)
	for cap, actions := range capabilityActions {
		for _, a := range actions {
			m[a] = cap
		}
	}
	return m
}()

// CapabilityActions returns the full capability → actions registry.
func CapabilityActions() map[Capability][]Action {
	return capabilityActions
}

// ActionCapability returns the capability an action belongs to.
func ActionCapability(a Action) (Capability, bool) {
	cap, ok := actionToCapability[a]
	return cap, ok
}

// AllCapabilities returns every capability in stable display order.
func AllCapabilities() []Capability {
	return []Capability{
		CapContribute, CapManageProjects, CapAssignWork, CapReviewWork,
		CapSignOff, CapReward, CapSubmitCompletion, CapApproveCompletion,
		CapArchiveWork, CapManageMembers, CapManageGovernance, CapManageComms,
		CapManageRoles,
	}
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && go test ./internal/contributions/ -run 'TestEveryActionHasExactlyOneCapability|TestActionCapabilityReverseLookup|TestAllCapabilitiesStable' -v`
Expected: PASS (3 tests)

- [ ] **Step 6: Run the full contributions package tests to check nothing broke**

Run: `cd backend && go test ./internal/contributions/ && go vet ./internal/contributions/`
Expected: ok, no vet errors

- [ ] **Step 7: Commit**

```bash
git add backend/internal/contributions/capabilities.go backend/internal/contributions/capabilities_test.go backend/internal/contributions/roles.go
git commit -m "feat(rbac): capability registry grouping actions into 13 admin-editable capabilities"
```

---

### Task 2: RolePolicy model + default policy + equivalence proof

**Files:**
- Create: `backend/internal/contributions/policy.go`
- Create: `backend/internal/contributions/policy_test.go`

**Interfaces:**
- Consumes: `Capability` constants, `ActionCapability` (Task 1).
- Produces: `type RoleDef struct { ID string; DisplayName string; Builtin bool }`, `type RolePolicy struct { Version int; UpdatedBy string; UpdatedAt string; Roles []RoleDef; Grants map[string][]Capability }`, `func DefaultRolePolicy() *RolePolicy`, methods `(*RolePolicy).RoleGrants(roleID string) []Capability`, `(*RolePolicy).HasCapability(roles []Role, cap Capability) bool`, `(*RolePolicy).HasCustomRole(roleID string) bool`, `func CanPerformActionWithPolicy(p *RolePolicy, userRoles []Role, action Action) bool`.

- [ ] **Step 1: Write the failing tests**

```go
// backend/internal/contributions/policy_test.go
package contributions

import "testing"

// keriRoles are the 10 KERI credential role strings (keri.ValidRoles()).
var keriRoles = []string{
	"Member", "Contributor", "Community Steward", "Operations Steward",
	"Founding Member", "Financial Steward", "Governance Steward",
	"Treasury Steward", "Technical Steward", "Cultural Steward",
}

// legacyActions: every action present in the legacy actionPermissions table.
var legacyActions = []Action{
	ActionCreateProject, ActionEditProject, ActionDeleteProject,
	ActionCreateContribution, ActionConfirmContribution, ActionAssignContribution,
	ActionApproveContribution, ActionSignOffContribution, ActionRewardContribution,
	ActionShareContribution, ActionOfferContribution, ActionAcceptOffer,
	ActionSubmitEvidence, ActionReviewContribution, ActionSignOffPlan,
	ActionCreateSubContrib, ActionApproveSubContrib, ActionRegisterInterest,
	ActionSignOffProposal, ActionRejectProposal, ActionEditProposal, ActionWithdrawProposal,
	ActionArchiveProject, ActionArchiveMilestone, ActionArchiveContribution,
	ActionUnassignContribution, ActionEditMilestone,
	ActionSubmitProjectCompletion, ActionApproveProjectCompletion, ActionRejectProjectCompletion,
}

// legacyCan checks directly against the legacy actionPermissions table.
// IMPORTANT: do NOT call CanPerformAction here — Task 3 rewires it to
// delegate to the policy, which would make this test compare the policy
// against itself. The raw table is the permanent reference.
func legacyCan(userRoles []Role, action Action) bool {
	allowed, ok := actionPermissions[action]
	if !ok {
		return false
	}
	for _, role := range userRoles {
		for _, a := range allowed {
			if role == a {
				return true
			}
		}
	}
	return false
}

// The default policy must reproduce the legacy table exactly, for every
// KERI role bundle and every legacy action.
func TestDefaultPolicyEquivalentToLegacyTable(t *testing.T) {
	p := DefaultRolePolicy()
	for _, kr := range keriRoles {
		bundle := MapKERIRole(kr)
		for _, action := range legacyActions {
			legacy := legacyCan(bundle, action)
			viaPolicy := CanPerformActionWithPolicy(p, bundle, action)
			if legacy != viaPolicy {
				t.Errorf("divergence: keriRole=%q action=%q legacy=%v policy=%v",
					kr, action, legacy, viaPolicy)
			}
		}
	}
}

func TestDefaultPolicyNewActions(t *testing.T) {
	p := DefaultRolePolicy()
	opsBundle := MapKERIRole("Operations Steward")
	memberBundle := MapKERIRole("Member")
	if !CanPerformActionWithPolicy(p, opsBundle, ActionManageRolePolicy) {
		t.Error("Operations Steward must hold manage_roles by default (spec decision 2)")
	}
	if !CanPerformActionWithPolicy(p, MapKERIRole("Founding Member"), ActionManageRolePolicy) {
		t.Error("Founding Member must hold manage_roles by default")
	}
	if CanPerformActionWithPolicy(p, memberBundle, ActionManageRolePolicy) {
		t.Error("Member must NOT hold manage_roles")
	}
	if !CanPerformActionWithPolicy(p, opsBundle, ActionChangeMemberRole) {
		t.Error("Operations Steward must hold manage_members by default")
	}
	if CanPerformActionWithPolicy(p, memberBundle, ActionChangeMemberRole) {
		t.Error("Member must NOT hold manage_members")
	}
}

func TestDefaultPolicyShape(t *testing.T) {
	p := DefaultRolePolicy()
	if p.Version != 0 {
		t.Errorf("default policy Version = %d, want 0 (0 = built-in, unsaved)", p.Version)
	}
	if len(p.Roles) != 10 {
		t.Errorf("default policy has %d roles, want the 10 builtins", len(p.Roles))
	}
	for _, r := range p.Roles {
		if !r.Builtin {
			t.Errorf("default role %q must be marked Builtin", r.ID)
		}
		if _, ok := p.Grants[r.ID]; !ok {
			t.Errorf("default role %q has no grants entry", r.ID)
		}
	}
	if p.HasCustomRole("member") {
		t.Error("builtin 'member' must not be reported as a custom role")
	}
	if p.HasCustomRole("kaitiaki") {
		t.Error("HasCustomRole must be false for unknown roles")
	}
}

func TestCustomRoleGrants(t *testing.T) {
	p := DefaultRolePolicy()
	p.Roles = append(p.Roles, RoleDef{ID: "kaitiaki", DisplayName: "Kaitiaki", Builtin: false})
	p.Grants["kaitiaki"] = []Capability{CapSignOff}
	if !p.HasCustomRole("kaitiaki") {
		t.Error("kaitiaki should be a custom role")
	}
	userRoles := []Role{RoleMember, Role("kaitiaki")}
	if !CanPerformActionWithPolicy(p, userRoles, ActionSignOffContribution) {
		t.Error("custom role with sign_off grant must be able to sign off contributions")
	}
	if CanPerformActionWithPolicy(p, userRoles, ActionRewardContribution) {
		t.Error("custom role without reward grant must not reward")
	}
}

func TestCanPerformActionWithPolicyUnknownAction(t *testing.T) {
	p := DefaultRolePolicy()
	if CanPerformActionWithPolicy(p, MapKERIRole("Founding Member"), Action("nonexistent")) {
		t.Error("unknown action must be denied even for founding member")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/contributions/ -run 'TestDefaultPolicy|TestCustomRoleGrants|TestCanPerformActionWithPolicy' -v`
Expected: FAIL to compile — `undefined: DefaultRolePolicy`, `undefined: RoleDef`, etc.

- [ ] **Step 3: Write the policy model**

```go
// backend/internal/contributions/policy.go
package contributions

// RoleDef is one entry in the RolePolicy role registry. Builtin roles are the
// 10 contribution-system roles that ship with the app and cannot be deleted
// or renamed; custom roles are admin-created. A RoleDef's ID doubles as the
// membership-credential role string for custom roles.
type RoleDef struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
	Builtin     bool   `json:"builtin"`
}

// RolePolicy is the community's editable RBAC policy: which roles exist and
// which capabilities each holds. One versioned object per community, synced
// via the community-readonly space (object type "RolePolicy", object ID
// "RolePolicy" — a singleton). Version 0 means "built-in default, never saved".
type RolePolicy struct {
	Version   int                     `json:"version"`
	UpdatedBy string                  `json:"updatedBy,omitempty"`
	UpdatedAt string                  `json:"updatedAt,omitempty"`
	Roles     []RoleDef               `json:"roles"`
	Grants    map[string][]Capability `json:"grants"`
}

// RoleGrants returns the capabilities granted to a role ID (nil if unknown).
func (p *RolePolicy) RoleGrants(roleID string) []Capability {
	return p.Grants[roleID]
}

// HasCapability reports whether any of userRoles holds cap under this policy.
func (p *RolePolicy) HasCapability(userRoles []Role, cap Capability) bool {
	for _, r := range userRoles {
		for _, c := range p.Grants[string(r)] {
			if c == cap {
				return true
			}
		}
	}
	return false
}

// HasCustomRole reports whether roleID is a non-builtin role in the registry.
func (p *RolePolicy) HasCustomRole(roleID string) bool {
	for _, r := range p.Roles {
		if r.ID == roleID && !r.Builtin {
			return true
		}
	}
	return false
}

// CanPerformActionWithPolicy is the pure policy check: action → capability →
// grants. Unknown actions are always denied.
func CanPerformActionWithPolicy(p *RolePolicy, userRoles []Role, action Action) bool {
	cap, ok := ActionCapability(action)
	if !ok {
		return false
	}
	return p.HasCapability(userRoles, cap)
}

// baseCaps are granted to every builtin role — they cover exactly the
// actions the legacy table marks allRoles.
var baseCaps = []Capability{CapContribute, CapManageProjects, CapAssignWork, CapReviewWork}

// DefaultRolePolicy returns the built-in policy, exactly equivalent to the
// legacy actionPermissions table (proven by TestDefaultPolicyEquivalentToLegacyTable).
// It is used whenever no RolePolicy object is synced, and as the base for a
// community's first edit.
func DefaultRolePolicy() *RolePolicy {
	roles := []RoleDef{
		{ID: string(RoleMember), DisplayName: "Member", Builtin: true},
		{ID: string(RoleContributor), DisplayName: "Contributor", Builtin: true},
		{ID: string(RoleProjectLead), DisplayName: "Project Lead", Builtin: true},
		{ID: string(RoleProjectSteward), DisplayName: "Project Steward", Builtin: true},
		{ID: string(RoleOperationsSteward), DisplayName: "Operations Steward", Builtin: true},
		{ID: string(RoleCommunitySteward), DisplayName: "Community Steward", Builtin: true},
		{ID: string(RoleTechSteward), DisplayName: "Technical Steward", Builtin: true},
		{ID: string(RoleTreasurySteward), DisplayName: "Treasury Steward", Builtin: true},
		{ID: string(RoleFoundingMember), DisplayName: "Founding Member", Builtin: true},
		{ID: string(RoleElderCouncil), DisplayName: "Elder Council", Builtin: true},
	}

	grants := map[string][]Capability{
		string(RoleMember):      append([]Capability{}, baseCaps...),
		string(RoleContributor): append([]Capability{}, baseCaps...),
		string(RoleProjectLead): append(append([]Capability{}, baseCaps...),
			CapSubmitCompletion, CapArchiveWork),
		string(RoleProjectSteward): append(append([]Capability{}, baseCaps...),
			CapSignOff, CapApproveCompletion, CapArchiveWork, CapManageGovernance),
		string(RoleOperationsSteward): append(append([]Capability{}, baseCaps...),
			CapSignOff, CapReward, CapSubmitCompletion, CapApproveCompletion,
			CapArchiveWork, CapManageMembers, CapManageGovernance, CapManageComms, CapManageRoles),
		string(RoleCommunitySteward): append(append([]Capability{}, baseCaps...),
			CapManageGovernance, CapManageComms),
		string(RoleTechSteward):     append([]Capability{}, baseCaps...),
		string(RoleTreasurySteward): append([]Capability{}, baseCaps...),
		string(RoleFoundingMember): append(append([]Capability{}, baseCaps...),
			CapSignOff, CapReward, CapSubmitCompletion, CapApproveCompletion,
			CapArchiveWork, CapManageMembers, CapManageGovernance, CapManageComms, CapManageRoles),
		string(RoleElderCouncil): append([]Capability{}, baseCaps...),
	}

	return &RolePolicy{Version: 0, Roles: roles, Grants: grants}
}
```

Legacy-table fidelity notes (why these grants):
- allRoles actions → `baseCaps` on every role.
- `sign_off_contribution`/`sign_off_plan` = {project_steward, operations_steward, founding_member} → `CapSignOff` on exactly those three.
- `reward_contribution` = {operations_steward, founding_member} → `CapReward`.
- proposal actions = {project_steward, community_steward, operations_steward, founding_member} → `CapManageGovernance`.
- archive/unassign/edit-milestone (leadStewardScope) = {project_lead, project_steward, operations_steward, founding_member} → `CapArchiveWork`.
- `submit_project_completion` = {project_lead, operations_steward, founding_member} → `CapSubmitCompletion` (note: NOT project_steward — this is why it's a separate capability from `CapApproveCompletion`).
- approve/reject completion (stewardScope) = {project_steward, operations_steward, founding_member} → `CapApproveCompletion`.
- Note the KERI expansion makes some cells reachable indirectly (e.g. KERI "Technical Steward" → contribution `project_lead` → CapArchiveWork). The equivalence test iterates KERI bundles so this is verified, not assumed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./internal/contributions/ -run 'TestDefaultPolicy|TestCustomRoleGrants|TestCanPerformActionWithPolicy' -v`
Expected: PASS (5 tests). If `TestDefaultPolicyEquivalentToLegacyTable` fails, the divergence message names the exact KERI role + action — fix the grants map, not the test.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/contributions/policy.go backend/internal/contributions/policy_test.go
git commit -m "feat(rbac): RolePolicy model with default policy equivalent to legacy table"
```

---

### Task 3: PolicyProvider — store-backed policy with fallback, wired into CanPerformAction and MapKERIRole

**Files:**
- Create: `backend/internal/contributions/policy_provider.go`
- Create: `backend/internal/contributions/policy_provider_test.go`
- Modify: `backend/internal/contributions/roles.go` (CanPerformAction + MapKERIRole delegate to the current policy)

**Interfaces:**
- Consumes: `RolePolicy`, `DefaultRolePolicy()`, `CanPerformActionWithPolicy` (Task 2); `ObjectStore` (`service.go:120` — `Save/Get/List/Delete`).
- Produces: `type PolicyProvider interface { Policy() *RolePolicy }`, `func SetPolicyProvider(p PolicyProvider)`, `func CurrentPolicy() *RolePolicy`, `type StorePolicyProvider struct{...}` with `func NewStorePolicyProvider(store ObjectStore, spaceID string, ttl time.Duration) *StorePolicyProvider` and `(*StorePolicyProvider).Invalidate()`. Changed semantics: `CanPerformAction` and `MapKERIRole` become policy-aware (signatures unchanged).

- [ ] **Step 1: Write the failing tests**

```go
// backend/internal/contributions/policy_provider_test.go
package contributions

import (
	"testing"
	"time"
)

// resetProvider restores the default provider after each test so tests
// don't leak state into each other.
func resetProvider() { SetPolicyProvider(nil) }

func TestCurrentPolicyDefaultsWhenNoProvider(t *testing.T) {
	defer resetProvider()
	SetPolicyProvider(nil)
	p := CurrentPolicy()
	if p == nil || p.Version != 0 {
		t.Fatal("CurrentPolicy must fall back to DefaultRolePolicy when no provider is set")
	}
}

func TestStoreProviderReadsPolicyObject(t *testing.T) {
	defer resetProvider()
	store := NewMockStore()
	custom := DefaultRolePolicy()
	custom.Version = 3
	custom.Roles = append(custom.Roles, RoleDef{ID: "kaitiaki", DisplayName: "Kaitiaki"})
	custom.Grants["kaitiaki"] = []Capability{CapSignOff}
	if err := store.Save("ro-space", "RolePolicy", "RolePolicy", custom); err != nil {
		t.Fatal(err)
	}

	prov := NewStorePolicyProvider(store, "ro-space", time.Millisecond)
	got := prov.Policy()
	if got == nil || got.Version != 3 {
		t.Fatalf("provider returned %+v, want synced policy version 3", got)
	}
	if !got.HasCustomRole("kaitiaki") {
		t.Error("synced policy must include the custom role")
	}
}

func TestStoreProviderFallsBackWhenEmpty(t *testing.T) {
	defer resetProvider()
	prov := NewStorePolicyProvider(NewMockStore(), "ro-space", time.Millisecond)
	if got := prov.Policy(); got != nil {
		t.Errorf("provider with no stored policy must return nil (caller falls back), got %+v", got)
	}
	// Empty space ID → always nil, never a lookup.
	prov2 := NewStorePolicyProvider(NewMockStore(), "", time.Millisecond)
	if got := prov2.Policy(); got != nil {
		t.Error("provider with empty space ID must return nil")
	}
}

func TestStoreProviderCachesWithinTTL(t *testing.T) {
	defer resetProvider()
	store := NewMockStore()
	p := DefaultRolePolicy()
	p.Version = 1
	_ = store.Save("ro-space", "RolePolicy", "RolePolicy", p)
	prov := NewStorePolicyProvider(store, "ro-space", time.Hour)

	if got := prov.Policy(); got == nil || got.Version != 1 {
		t.Fatal("first read should hit the store")
	}
	// Update store; cached value should still be served within TTL.
	p2 := DefaultRolePolicy()
	p2.Version = 2
	_ = store.Save("ro-space", "RolePolicy", "RolePolicy", p2)
	if got := prov.Policy(); got.Version != 1 {
		t.Error("within TTL the cached policy must be served")
	}
	prov.Invalidate()
	if got := prov.Policy(); got.Version != 2 {
		t.Error("after Invalidate the provider must re-read the store")
	}
}

func TestCanPerformActionUsesProvider(t *testing.T) {
	defer resetProvider()
	store := NewMockStore()
	p := DefaultRolePolicy()
	p.Version = 1
	// Take sign_off away from project_steward.
	grants := p.Grants[string(RoleProjectSteward)]
	filtered := grants[:0]
	for _, c := range grants {
		if c != CapSignOff {
			filtered = append(filtered, c)
		}
	}
	p.Grants[string(RoleProjectSteward)] = filtered
	_ = store.Save("ro-space", "RolePolicy", "RolePolicy", p)
	SetPolicyProvider(NewStorePolicyProvider(store, "ro-space", time.Millisecond))

	if CanPerformAction([]Role{RoleProjectSteward}, ActionSignOffContribution) {
		t.Error("edited policy must revoke sign_off from project_steward")
	}
	if !CanPerformAction([]Role{RoleOperationsSteward}, ActionSignOffContribution) {
		t.Error("operations_steward must still sign off")
	}
}

func TestMapKERIRoleResolvesCustomRoles(t *testing.T) {
	defer resetProvider()
	store := NewMockStore()
	p := DefaultRolePolicy()
	p.Version = 1
	p.Roles = append(p.Roles, RoleDef{ID: "kaitiaki", DisplayName: "Kaitiaki"})
	p.Grants["kaitiaki"] = []Capability{CapSignOff}
	_ = store.Save("ro-space", "RolePolicy", "RolePolicy", p)
	SetPolicyProvider(NewStorePolicyProvider(store, "ro-space", time.Millisecond))

	roles := MapKERIRole("kaitiaki")
	want := map[Role]bool{RoleMember: true, Role("kaitiaki"): true}
	if len(roles) != 2 || !want[roles[0]] || !want[roles[1]] {
		t.Errorf("MapKERIRole(kaitiaki) = %v, want [member kaitiaki]", roles)
	}
	// Unknown strings still default to member only.
	if got := MapKERIRole("nonsense"); len(got) != 1 || got[0] != RoleMember {
		t.Errorf("MapKERIRole(nonsense) = %v, want [member]", got)
	}
	// Builtin KERI roles unaffected.
	if got := MapKERIRole("Operations Steward"); len(got) != 5 {
		t.Errorf("MapKERIRole(Operations Steward) = %v, want the 5-role bundle", got)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/contributions/ -run 'TestCurrentPolicy|TestStoreProvider|TestCanPerformActionUsesProvider|TestMapKERIRoleResolvesCustomRoles' -v`
Expected: FAIL to compile — `undefined: SetPolicyProvider`, etc.

- [ ] **Step 3: Write the provider**

```go
// backend/internal/contributions/policy_provider.go
package contributions

import (
	"encoding/json"
	"log"
	"sync"
	"time"
)

// PolicyProvider supplies the community's current RolePolicy. Policy() may
// return nil, meaning "no synced policy" — callers fall back to
// DefaultRolePolicy() via CurrentPolicy().
type PolicyProvider interface {
	Policy() *RolePolicy
}

var (
	providerMu      sync.RWMutex
	currentProvider PolicyProvider
)

// SetPolicyProvider installs the process-wide policy provider (nil to reset
// to built-in defaults). Called once from main after the any-sync store is up.
func SetPolicyProvider(p PolicyProvider) {
	providerMu.Lock()
	defer providerMu.Unlock()
	currentProvider = p
}

// CurrentPolicy returns the synced policy if a provider is set and has one,
// otherwise the built-in default. Never returns nil.
func CurrentPolicy() *RolePolicy {
	providerMu.RLock()
	p := currentProvider
	providerMu.RUnlock()
	if p != nil {
		if policy := p.Policy(); policy != nil {
			return policy
		}
	}
	return DefaultRolePolicy()
}

// StorePolicyProvider reads the singleton RolePolicy object from the
// community-readonly space via ObjectStore, with a short TTL cache.
// Read-through matches how ProfileRoleLookup reads profiles; the TTL keeps
// per-request overhead low without tree-listener wiring.
type StorePolicyProvider struct {
	store   ObjectStore
	spaceID string
	ttl     time.Duration

	mu        sync.Mutex
	cached    *RolePolicy
	fetchedAt time.Time
}

func NewStorePolicyProvider(store ObjectStore, spaceID string, ttl time.Duration) *StorePolicyProvider {
	return &StorePolicyProvider{store: store, spaceID: spaceID, ttl: ttl}
}

// Policy returns the synced policy, or nil when none exists / space not
// configured / read fails (callers fall back to defaults via CurrentPolicy).
func (s *StorePolicyProvider) Policy() *RolePolicy {
	if s.store == nil || s.spaceID == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cached != nil && time.Since(s.fetchedAt) < s.ttl {
		return s.cached
	}
	raws, err := s.store.List(s.spaceID, "RolePolicy")
	if err != nil {
		log.Printf("[RolePolicy] list failed (falling back to %s): %v",
			map[bool]string{true: "cached", false: "default"}[s.cached != nil], err)
		return s.cached // possibly nil → default
	}
	var latest *RolePolicy
	for _, raw := range raws {
		var p RolePolicy
		if err := json.Unmarshal(raw, &p); err != nil {
			log.Printf("[RolePolicy] skipping corrupt policy object: %v", err)
			continue
		}
		if latest == nil || p.Version > latest.Version {
			latest = &p
		}
	}
	s.cached = latest
	s.fetchedAt = time.Now()
	return s.cached
}

// Invalidate drops the cache so the next Policy() call re-reads the store.
// Called by the PUT handler after a successful write.
func (s *StorePolicyProvider) Invalidate() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cached = nil
	s.fetchedAt = time.Time{}
}
```

- [ ] **Step 4: Make CanPerformAction and MapKERIRole policy-aware**

In `backend/internal/contributions/roles.go`:

Replace the body of `CanPerformAction` (lines 157-171):

```go
// CanPerformAction checks if any of the user's roles allows the given action
// under the community's current RolePolicy (synced, or built-in default).
// The legacy actionPermissions table above is retained as the permanent
// reference the default policy is proven equivalent to (policy_test.go
// legacyCan) — do not delete it.
func CanPerformAction(userRoles []Role, action Action) bool {
	return CanPerformActionWithPolicy(CurrentPolicy(), userRoles, action)
}
```

Replace the `default` case of `MapKERIRole` (lines 45-46):

```go
	default:
		// Custom roles: a credential role string matching a custom role in
		// the current policy grants [member, <custom-role>].
		if p := CurrentPolicy(); p.HasCustomRole(keriRole) {
			return []Role{RoleMember, Role(keriRole)}
		}
		return []Role{RoleMember}
	}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && go test ./internal/contributions/ -v`
Expected: PASS — including the Task 2 equivalence test (which now exercises the provider path with no provider set → default policy → still equivalent) and all pre-existing package tests.

- [ ] **Step 6: Run the full backend test suite**

Run: `cd backend && make test`
Expected: PASS. `CanPerformAction` behavior is unchanged for every existing caller (default policy ≡ legacy table), so `rbac_test.go`, `proposals_test.go`, and handler tests must all pass untouched. If any fail, the default policy has a fidelity bug — fix `DefaultRolePolicy`, never the failing test.

- [ ] **Step 7: Commit**

```bash
git add backend/internal/contributions/policy_provider.go backend/internal/contributions/policy_provider_test.go backend/internal/contributions/roles.go
git commit -m "feat(rbac): PolicyProvider with store-backed read-through and default fallback"
```

---

### Task 4: role-policy API endpoints + server wiring

**Files:**
- Create: `backend/internal/api/role_policy.go`
- Create: `backend/internal/api/role_policy_test.go`
- Modify: `backend/internal/contributions/role_store.go` (add `IsAdminAID`)
- Modify: `backend/cmd/server/main.go` (wire provider + handler; near lines 511-546 and the mux registrations)

**Interfaces:**
- Consumes: `CurrentPolicy`, `StorePolicyProvider.Invalidate`, `CanPerformAction`, `ActionManageRolePolicy`, `CapabilityActions`, `AllCapabilities`, `RolePolicy`/`RoleDef` (Tasks 1-3); `RBACMiddleware`/`OptionalRBACMiddleware`/`GetUserAID`/`GetUserRoles` (`rbac.go`); write path per `profiles.go:530-556` (`anysync.LoadOrCreateSpaceKeySet` + `ObjectTreeManager.AddObject`); `contributions.ObjectStore.List` for custom-role-in-use checks.
- Produces: `GET /api/v1/role-policy` → `{ policy, source: "synced"|"default", capabilities: {cap: [actions]}, callerCapabilities: [cap] }`; `PUT /api/v1/role-policy` (body `{version, roles, grants}`) → 200 `{policy}` | 400 | 401 | 403 | 409. `ProfileRoleLookup.IsAdminAID(aid string) bool`.

- [ ] **Step 1: Add IsAdminAID to ProfileRoleLookup**

In `backend/internal/contributions/role_store.go`, after `SetAdminAIDs` (line 27):

```go
// IsAdminAID reports whether the AID is in the org-config admin list.
// Used as the un-lockout backstop: org admins can always edit the role
// policy regardless of what the policy's grants say.
func (l *ProfileRoleLookup) IsAdminAID(aid string) bool {
	return l.adminAIDs[aid]
}
```

- [ ] **Step 2: Write the failing handler tests**

The handler takes small interfaces so tests need no any-sync spaces. Note the writer abstraction: production wires it to the space-key + `AddObject` path; tests use a fake.

```go
// backend/internal/api/role_policy_test.go
package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/matou-dao/backend/internal/contributions"
)

// fakePolicyWriter records writes and mirrors them into the mock store the
// provider reads from, emulating the synced round trip.
type fakePolicyWriter struct {
	store *contributions.MockObjectStore
	space string
	fail  bool
}

func (f *fakePolicyWriter) WritePolicy(p *contributions.RolePolicy) error {
	if f.fail {
		return http.ErrHandlerTimeout
	}
	return f.store.Save(f.space, "RolePolicy", "RolePolicy", p)
}

type staticRoles map[string][]contributions.Role

func (s staticRoles) GetUserRoles(aid string) ([]contributions.Role, error) { return s[aid], nil }

func newTestPolicyHandler(t *testing.T) (*RolePolicyHandler, *contributions.MockObjectStore, *contributions.StorePolicyProvider) {
	t.Helper()
	store := contributions.NewMockStore()
	provider := contributions.NewStorePolicyProvider(store, "ro-space", time.Millisecond)
	contributions.SetPolicyProvider(provider)
	t.Cleanup(func() { contributions.SetPolicyProvider(nil) })
	writer := &fakePolicyWriter{store: store, space: "ro-space"}
	h := NewRolePolicyHandler(provider, writer, store, "ro-space",
		func(aid string) bool { return aid == "EAdminAID" })
	return h, store, provider
}

func lookupForTests() RoleLookup {
	return staticRoles{
		"EOpsAID":    contributions.MapKERIRole("Operations Steward"),
		"EMemberAID": contributions.MapKERIRole("Member"),
		"EAdminAID":  {}, // org admin with NO policy grants — backstop must let them through
	}
}

func TestGetRolePolicyDefault(t *testing.T) {
	h, _, _ := newTestPolicyHandler(t)
	mux := http.NewServeMux()
	h.RegisterRoutes(mux, lookupForTests())

	req := httptest.NewRequest(http.MethodGet, "/api/v1/role-policy", nil)
	req.Header.Set("X-User-AID", "EOpsAID")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("GET = %d, want 200; body: %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Source             string                     `json:"source"`
		Policy             contributions.RolePolicy   `json:"policy"`
		Capabilities       map[string][]string        `json:"capabilities"`
		CallerCapabilities []contributions.Capability `json:"callerCapabilities"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Source != "default" {
		t.Errorf("source = %q, want default", resp.Source)
	}
	if len(resp.Policy.Roles) != 10 {
		t.Errorf("default policy roles = %d, want 10", len(resp.Policy.Roles))
	}
	if len(resp.Capabilities) != 13 {
		t.Errorf("capabilities = %d entries, want 13", len(resp.Capabilities))
	}
	found := false
	for _, c := range resp.CallerCapabilities {
		if c == contributions.CapManageRoles {
			found = true
		}
	}
	if !found {
		t.Error("ops steward's callerCapabilities must include manage_roles")
	}
}

func putPolicy(t *testing.T, mux *http.ServeMux, aid string, body interface{}) *httptest.ResponseRecorder {
	t.Helper()
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPut, "/api/v1/role-policy", bytes.NewReader(b))
	if aid != "" {
		req.Header.Set("X-User-AID", aid)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func validUpdate() map[string]interface{} {
	p := contributions.DefaultRolePolicy()
	return map[string]interface{}{
		"version": 0, // based on the unsaved default
		"roles": append(p.Roles, contributions.RoleDef{
			ID: "kaitiaki", DisplayName: "Kaitiaki", Builtin: false,
		}),
		"grants": func() map[string][]contributions.Capability {
			g := p.Grants
			g["kaitiaki"] = []contributions.Capability{contributions.CapSignOff}
			return g
		}(),
	}
}

func TestPutRolePolicyRBAC(t *testing.T) {
	h, _, _ := newTestPolicyHandler(t)
	mux := http.NewServeMux()
	h.RegisterRoutes(mux, lookupForTests())

	if rec := putPolicy(t, mux, "", validUpdate()); rec.Code != http.StatusUnauthorized {
		t.Errorf("no AID: %d, want 401", rec.Code)
	}
	if rec := putPolicy(t, mux, "EMemberAID", validUpdate()); rec.Code != http.StatusForbidden {
		t.Errorf("member: %d, want 403", rec.Code)
	}
	if rec := putPolicy(t, mux, "EOpsAID", validUpdate()); rec.Code != http.StatusOK {
		t.Errorf("ops steward: %d, want 200; body %s", rec.Code, rec.Body.String())
	}
}

func TestPutRolePolicyAdminBackstop(t *testing.T) {
	h, _, _ := newTestPolicyHandler(t)
	mux := http.NewServeMux()
	h.RegisterRoutes(mux, lookupForTests())
	// EAdminAID resolves to zero roles → no manage_roles grant, but IsAdminAID
	// returns true → must be allowed (spec §6 lockout prevention).
	if rec := putPolicy(t, mux, "EAdminAID", validUpdate()); rec.Code != http.StatusOK {
		t.Errorf("org admin backstop: %d, want 200; body %s", rec.Code, rec.Body.String())
	}
}

func TestPutRolePolicyVersionConflict(t *testing.T) {
	h, _, _ := newTestPolicyHandler(t)
	mux := http.NewServeMux()
	h.RegisterRoutes(mux, lookupForTests())

	if rec := putPolicy(t, mux, "EOpsAID", validUpdate()); rec.Code != http.StatusOK {
		t.Fatalf("first PUT: %d", rec.Code)
	}
	// Same base version again → conflict (current is now 1).
	if rec := putPolicy(t, mux, "EOpsAID", validUpdate()); rec.Code != http.StatusConflict {
		t.Errorf("stale PUT: %d, want 409", rec.Code)
	}
}

func TestPutRolePolicyValidation(t *testing.T) {
	h, _, _ := newTestPolicyHandler(t)
	mux := http.NewServeMux()
	h.RegisterRoutes(mux, lookupForTests())

	// Missing a builtin role → 400
	bad := validUpdate()
	roles := bad["roles"].([]contributions.RoleDef)
	bad["roles"] = roles[1:] // drop "member"
	if rec := putPolicy(t, mux, "EOpsAID", bad); rec.Code != http.StatusBadRequest {
		t.Errorf("dropped builtin: %d, want 400", rec.Code)
	}

	// Bad custom role id → 400
	bad2 := validUpdate()
	bad2["roles"] = append(bad2["roles"].([]contributions.RoleDef),
		contributions.RoleDef{ID: "Bad-ID!", DisplayName: "X"})
	if rec := putPolicy(t, mux, "EOpsAID", bad2); rec.Code != http.StatusBadRequest {
		t.Errorf("bad role id: %d, want 400", rec.Code)
	}

	// No role holds manage_roles → 400
	bad3 := validUpdate()
	grants := bad3["grants"].(map[string][]contributions.Capability)
	for id, caps := range grants {
		out := caps[:0]
		for _, c := range caps {
			if c != contributions.CapManageRoles {
				out = append(out, c)
			}
		}
		grants[id] = out
	}
	if rec := putPolicy(t, mux, "EOpsAID", bad3); rec.Code != http.StatusBadRequest {
		t.Errorf("no manage_roles holder: %d, want 400", rec.Code)
	}

	// Grants referencing unknown role → 400
	bad4 := validUpdate()
	bad4["grants"].(map[string][]contributions.Capability)["ghost"] = []contributions.Capability{contributions.CapReward}
	if rec := putPolicy(t, mux, "EOpsAID", bad4); rec.Code != http.StatusBadRequest {
		t.Errorf("unknown role in grants: %d, want 400", rec.Code)
	}
}

func TestDeleteCustomRoleInUse(t *testing.T) {
	h, store, _ := newTestPolicyHandler(t)
	mux := http.NewServeMux()
	h.RegisterRoutes(mux, lookupForTests())

	// Save policy with kaitiaki, then a member profile holding it.
	if rec := putPolicy(t, mux, "EOpsAID", validUpdate()); rec.Code != http.StatusOK {
		t.Fatalf("setup PUT: %d", rec.Code)
	}
	_ = store.Save("ro-space", "CommunityProfile-EUser", "CommunityProfile",
		map[string]string{"userAID": "EUser", "role": "kaitiaki"})

	// Now attempt an update (version 1) that removes kaitiaki → 400.
	p := contributions.DefaultRolePolicy()
	update := map[string]interface{}{"version": 1, "roles": p.Roles, "grants": p.Grants}
	rec := putPolicy(t, mux, "EOpsAID", update)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("removing in-use custom role: %d, want 400; body %s", rec.Code, rec.Body.String())
	}
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd backend && go test ./internal/api/ -run 'TestGetRolePolicy|TestPutRolePolicy|TestDeleteCustomRoleInUse' -v`
Expected: FAIL to compile — `undefined: NewRolePolicyHandler`, `RolePolicyHandler`.

- [ ] **Step 4: Write the handler**

```go
// backend/internal/api/role_policy.go
package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"time"

	"github.com/matou-dao/backend/internal/contributions"
)

// PolicyWriter persists a RolePolicy to the community-readonly space.
// Production implementation writes via space keys + ObjectTreeManager
// (see SpacePolicyWriter in main.go wiring); tests use a fake.
type PolicyWriter interface {
	WritePolicy(p *contributions.RolePolicy) error
}

// RolePolicyHandler serves GET/PUT /api/v1/role-policy.
type RolePolicyHandler struct {
	provider   *contributions.StorePolicyProvider
	writer     PolicyWriter
	store      contributions.ObjectStore // for custom-role-in-use checks
	roSpaceID  string
	isAdminAID func(string) bool // org-config admin backstop
}

func NewRolePolicyHandler(
	provider *contributions.StorePolicyProvider,
	writer PolicyWriter,
	store contributions.ObjectStore,
	roSpaceID string,
	isAdminAID func(string) bool,
) *RolePolicyHandler {
	return &RolePolicyHandler{
		provider: provider, writer: writer, store: store,
		roSpaceID: roSpaceID, isAdminAID: isAdminAID,
	}
}

// RegisterRoutes registers role-policy routes. GET is open (any member reads
// the policy to render UI); PUT requires the manage_roles capability or the
// org-admin backstop.
func (h *RolePolicyHandler) RegisterRoutes(mux *http.ServeMux, roleLookup RoleLookup) {
	mux.HandleFunc("/api/v1/role-policy", OptionalRBACMiddleware(roleLookup, func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			h.handleGet(w, r)
		case http.MethodPut:
			h.handlePut(w, r)
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method not allowed"})
		}
	}))
}

type rolePolicyResponse struct {
	Policy             *contributions.RolePolicy                 `json:"policy"`
	Source             string                                    `json:"source"`
	Capabilities       map[contributions.Capability][]contributions.Action `json:"capabilities"`
	CallerCapabilities []contributions.Capability                `json:"callerCapabilities"`
}

func (h *RolePolicyHandler) effective() (*contributions.RolePolicy, string) {
	if p := h.provider.Policy(); p != nil {
		return p, "synced"
	}
	return contributions.DefaultRolePolicy(), "default"
}

func (h *RolePolicyHandler) handleGet(w http.ResponseWriter, r *http.Request) {
	policy, source := h.effective()
	resp := rolePolicyResponse{
		Policy:       policy,
		Source:       source,
		Capabilities: contributions.CapabilityActions(),
	}
	if roles := GetUserRoles(r); len(roles) > 0 {
		caller := []contributions.Capability{}
		for _, cap := range contributions.AllCapabilities() {
			if policy.HasCapability(roles, cap) {
				caller = append(caller, cap)
			}
		}
		resp.CallerCapabilities = caller
	}
	// Org-admin backstop is reflected in the response too, so the UI shows
	// the page to admins whose roles carry no grants.
	if aid := GetUserAID(r); aid != "" && h.isAdminAID(aid) {
		resp.CallerCapabilities = appendCapIfMissing(resp.CallerCapabilities, contributions.CapManageRoles)
	}
	writeJSON(w, http.StatusOK, resp)
}

func appendCapIfMissing(caps []contributions.Capability, c contributions.Capability) []contributions.Capability {
	for _, existing := range caps {
		if existing == c {
			return caps
		}
	}
	return append(caps, c)
}

type rolePolicyUpdate struct {
	Version int                                          `json:"version"`
	Roles   []contributions.RoleDef                      `json:"roles"`
	Grants  map[string][]contributions.Capability        `json:"grants"`
}

var roleIDPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{1,39}$`)

func (h *RolePolicyHandler) handlePut(w http.ResponseWriter, r *http.Request) {
	aid := GetUserAID(r)
	if aid == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "X-User-AID header required"})
		return
	}
	roles := GetUserRoles(r)
	if !contributions.CanPerformAction(roles, contributions.ActionManageRolePolicy) && !h.isAdminAID(aid) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "insufficient permissions"})
		return
	}

	var req rolePolicyUpdate
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("invalid request: %v", err)})
		return
	}

	current, _ := h.effective()
	if req.Version != current.Version {
		writeJSON(w, http.StatusConflict, map[string]interface{}{
			"error":          "policy was modified by someone else — reload and retry",
			"currentVersion": current.Version,
		})
		return
	}

	if errMsg := h.validate(&req, current); errMsg != "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": errMsg})
		return
	}

	updated := &contributions.RolePolicy{
		Version:   current.Version + 1,
		UpdatedBy: aid,
		UpdatedAt: time.Now().UTC().Format(time.RFC3339),
		Roles:     req.Roles,
		Grants:    req.Grants,
	}
	if err := h.writer.WritePolicy(updated); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("failed to store policy: %v", err)})
		return
	}
	h.provider.Invalidate()
	writeJSON(w, http.StatusOK, map[string]interface{}{"policy": updated})
}

// validate returns "" when the update is acceptable, else an error message.
func (h *RolePolicyHandler) validate(req *rolePolicyUpdate, current *contributions.RolePolicy) string {
	// 1. All builtins present, unrenamed, still flagged builtin.
	builtins := map[string]bool{}
	for _, r := range contributions.DefaultRolePolicy().Roles {
		builtins[r.ID] = false
	}
	seen := map[string]bool{}
	for _, r := range req.Roles {
		if seen[r.ID] {
			return fmt.Sprintf("duplicate role id %q", r.ID)
		}
		seen[r.ID] = true
		if _, isBuiltin := builtins[r.ID]; isBuiltin {
			if !r.Builtin {
				return fmt.Sprintf("builtin role %q cannot be made custom", r.ID)
			}
			builtins[r.ID] = true
			continue
		}
		if r.Builtin {
			return fmt.Sprintf("role %q cannot claim builtin status", r.ID)
		}
		if !roleIDPattern.MatchString(r.ID) {
			return fmt.Sprintf("invalid custom role id %q (want %s)", r.ID, roleIDPattern.String())
		}
		if r.DisplayName == "" {
			return fmt.Sprintf("custom role %q needs a displayName", r.ID)
		}
	}
	for id, present := range builtins {
		if !present {
			return fmt.Sprintf("builtin role %q cannot be removed", id)
		}
	}

	// 2. Grants only reference known roles and known capabilities.
	validCaps := map[contributions.Capability]bool{}
	for _, c := range contributions.AllCapabilities() {
		validCaps[c] = true
	}
	for roleID, caps := range req.Grants {
		if !seen[roleID] {
			return fmt.Sprintf("grants reference unknown role %q", roleID)
		}
		for _, c := range caps {
			if !validCaps[c] {
				return fmt.Sprintf("unknown capability %q for role %q", c, roleID)
			}
		}
	}

	// 3. At least one role must retain manage_roles (org admins are a code
	// backstop, but a policy nobody can edit via roles is almost certainly a
	// mistake — reject it).
	holderFound := false
	for _, caps := range req.Grants {
		for _, c := range caps {
			if c == contributions.CapManageRoles {
				holderFound = true
			}
		}
	}
	if !holderFound {
		return "at least one role must hold manage_roles"
	}

	// 4. Custom roles removed by this update must not be held by any member.
	removed := map[string]bool{}
	for _, r := range current.Roles {
		if !r.Builtin && !seen[r.ID] {
			removed[r.ID] = true
		}
	}
	if len(removed) > 0 && h.store != nil {
		for _, profileType := range []string{"CommunityProfile", "SharedProfile"} {
			raws, err := h.store.List(h.roSpaceID, profileType)
			if err != nil {
				continue
			}
			for _, raw := range raws {
				var prof struct {
					Role string `json:"role"`
				}
				if json.Unmarshal(raw, &prof) == nil && removed[prof.Role] {
					return fmt.Sprintf("custom role %q is still assigned to a member — reassign before deleting", prof.Role)
				}
			}
		}
	}
	return ""
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && go test ./internal/api/ -run 'TestGetRolePolicy|TestPutRolePolicy|TestDeleteCustomRoleInUse' -v`
Expected: PASS (6 tests)

- [ ] **Step 6: Wire into main.go**

In `backend/cmd/server/main.go`:

(a) After `profileRoleLookup := contributions.NewProfileRoleLookup(...)` (line 517) and before the composite lookup, add:

```go
	rolePolicyProvider := contributions.NewStorePolicyProvider(contribStoreAdapter, communityReadOnlySpaceID, 5*time.Second)
	contributions.SetPolicyProvider(rolePolicyProvider)
```

(b) Next to the other handler constructions (lines 541-546), add:

```go
	rolePolicyHandler := api.NewRolePolicyHandler(
		rolePolicyProvider,
		api.NewSpacePolicyWriter(spaceManager, communityReadOnlySpaceID),
		contribStoreAdapter,
		communityReadOnlySpaceID,
		profileRoleLookup.IsAdminAID,
	)
```

(c) Where the other handlers register on the mux (find the block of `RegisterRoutes(mux, ...)` calls below), add:

```go
	rolePolicyHandler.RegisterRoutes(mux, roleLookup)
```

(d) Add the production `PolicyWriter` at the bottom of `backend/internal/api/role_policy.go` — it follows the exact write pattern of `HandleInitMemberProfiles` (`profiles.go:530-556`):

```go
// SpacePolicyWriter writes the RolePolicy singleton into the community-
// readonly space using the space key set (same write path as profiles).
type SpacePolicyWriter struct {
	spaceManager *anysync.SpaceManager
	roSpaceID    string
}

func NewSpacePolicyWriter(sm *anysync.SpaceManager, roSpaceID string) *SpacePolicyWriter {
	return &SpacePolicyWriter{spaceManager: sm, roSpaceID: roSpaceID}
}

func (s *SpacePolicyWriter) WritePolicy(p *contributions.RolePolicy) error {
	if s.roSpaceID == "" {
		return fmt.Errorf("community-readonly space not configured")
	}
	client := s.spaceManager.GetClient()
	if client == nil {
		return fmt.Errorf("any-sync client not available")
	}
	keys, err := anysync.LoadOrCreateSpaceKeySet(client.GetDataDir(), s.roSpaceID, client.GetSigningKey())
	if err != nil {
		return fmt.Errorf("loading space keys: %w", err)
	}
	data, err := json.Marshal(p)
	if err != nil {
		return fmt.Errorf("marshaling policy: %w", err)
	}
	payload := &anysync.ObjectPayload{
		ID:        "RolePolicy",
		Type:      "RolePolicy",
		Data:      data,
		Timestamp: time.Now().Unix(),
		Version:   1,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	_, err = s.spaceManager.ObjectTreeManager().AddObject(ctx, s.roSpaceID, payload, keys.SigningKey)
	return err
}
```

Add the needed imports to role_policy.go: `"context"`, `"github.com/matou-dao/backend/internal/anysync"`.

- [ ] **Step 7: Build and run full backend tests**

Run: `cd backend && go build ./... && make test`
Expected: builds clean, all tests pass.

- [ ] **Step 8: Commit**

```bash
git add backend/internal/api/role_policy.go backend/internal/api/role_policy_test.go backend/internal/contributions/role_store.go backend/cmd/server/main.go
git commit -m "feat(rbac): GET/PUT /api/v1/role-policy with manage_roles gate and org-admin backstop"
```

---

### Task 5: Policy-aware credential-role validation (custom roles assignable)

**Files:**
- Modify: `backend/internal/api/profiles.go` (role validation call sites: `HandleUpdateMemberRole` around line 691, and the keri role check used by init-member if present — grep `keri.IsValidRole` in the file)
- Modify: `backend/internal/keri/client.go` (document that IsValidRole covers builtins only)
- Create: `backend/internal/api/profiles_role_validation_test.go`

**Interfaces:**
- Consumes: `contributions.CurrentPolicy().HasCustomRole` (Task 3), `keri.IsValidRole` (`keri/client.go:184-191`).
- Produces: `func isAssignableRole(role string) bool` in package `api` — the one place role-string validity is decided for profile writes.

- [ ] **Step 1: Write the failing test**

```go
// backend/internal/api/profiles_role_validation_test.go
package api

import (
	"testing"
	"time"

	"github.com/matou-dao/backend/internal/contributions"
)

func TestIsAssignableRole(t *testing.T) {
	contributions.SetPolicyProvider(nil)
	t.Cleanup(func() { contributions.SetPolicyProvider(nil) })

	// Builtin KERI roles always assignable.
	if !isAssignableRole("Member") || !isAssignableRole("Operations Steward") {
		t.Error("builtin KERI roles must be assignable")
	}
	// Unknown role: not assignable under default policy.
	if isAssignableRole("kaitiaki") {
		t.Error("unknown role must not be assignable without a policy entry")
	}

	// With a synced policy containing the custom role, it becomes assignable.
	store := contributions.NewMockStore()
	p := contributions.DefaultRolePolicy()
	p.Version = 1
	p.Roles = append(p.Roles, contributions.RoleDef{ID: "kaitiaki", DisplayName: "Kaitiaki"})
	p.Grants["kaitiaki"] = []contributions.Capability{contributions.CapSignOff}
	_ = store.Save("ro-space", "RolePolicy", "RolePolicy", p)
	contributions.SetPolicyProvider(contributions.NewStorePolicyProvider(store, "ro-space", time.Millisecond))

	if !isAssignableRole("kaitiaki") {
		t.Error("custom role in policy must be assignable")
	}
	if isAssignableRole("still_unknown") {
		t.Error("roles absent from policy must stay unassignable")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/api/ -run TestIsAssignableRole -v`
Expected: FAIL to compile — `undefined: isAssignableRole`.

- [ ] **Step 3: Implement and swap call sites**

Add to `backend/internal/api/profiles.go` (near the top-level helpers):

```go
// isAssignableRole reports whether a role string may be written to a member
// profile / issued in a membership credential: either one of the 10 builtin
// KERI roles, or a custom role defined in the community's RolePolicy.
func isAssignableRole(role string) bool {
	return keri.IsValidRole(role) || contributions.CurrentPolicy().HasCustomRole(role)
}
```

Then grep the file for `keri.IsValidRole(` — there is one call in `HandleUpdateMemberRole` (~line 691) validating `req.Role`; replace it with `isAssignableRole(req.Role)` and update its error message to `"invalid role: not a builtin role or defined custom role"`. If `HandleInitMemberProfiles` also validates the role string, swap it identically (as of the audit it does not validate — leave its defaulting behavior alone). Confirm `contributions` is already imported in profiles.go; add if missing.

In `backend/internal/keri/client.go`, update the doc comment on `IsValidRole` (line 183):

```go
// IsValidRole checks if a role is one of the 10 builtin membership roles.
// Custom roles defined in the community RolePolicy are validated separately
// (api.isAssignableRole) — this function intentionally knows nothing of them.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./internal/api/ -run TestIsAssignableRole -v && go build ./...`
Expected: PASS, clean build.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/api/profiles.go backend/internal/api/profiles_role_validation_test.go backend/internal/keri/client.go
git commit -m "feat(rbac): custom roles from RolePolicy accepted in member role validation"
```

---

### Task 6: Frontend role-policy API client + Pinia store

**Files:**
- Create: `frontend/src/lib/api/rolePolicy.ts`
- Create: `frontend/src/stores/rolePolicy.ts`
- Create: `frontend/test/vitest/__tests__/rolePolicy.store.test.ts` (match the repo's existing vitest test location — check `frontend/package.json` `test:script` config; if unit tests live elsewhere, put the file beside them)

**Interfaces:**
- Consumes: `BACKEND_URL`, `authHeaders()` from `src/lib/api/client.ts`; backend endpoints from Task 4.
- Produces: types `RoleDef`, `RolePolicy`, `RolePolicyResponse`; functions `fetchRolePolicy(): Promise<RolePolicyResponse>`, `updateRolePolicy(update: RolePolicyUpdate): Promise<RolePolicy>` (throws `RolePolicyConflictError` on 409); store `useRolePolicyStore` with state `{ policy, source, capabilities, callerCapabilities, loading, error }`, getters `canManageRoles`, `can(cap)`, `roleOptions`, actions `load()`, `save(update)`.

- [ ] **Step 1: Write the API client**

```ts
// frontend/src/lib/api/rolePolicy.ts
import { BACKEND_URL, authHeaders } from './client';

export interface RoleDef {
  id: string;
  displayName: string;
  builtin: boolean;
}

export interface RolePolicy {
  version: number;
  updatedBy?: string;
  updatedAt?: string;
  roles: RoleDef[];
  grants: Record<string, string[]>;
}

export interface RolePolicyResponse {
  policy: RolePolicy;
  source: 'synced' | 'default';
  capabilities: Record<string, string[]>;
  callerCapabilities?: string[];
}

export interface RolePolicyUpdate {
  version: number;
  roles: RoleDef[];
  grants: Record<string, string[]>;
}

export class RolePolicyConflictError extends Error {
  currentVersion: number;
  constructor(currentVersion: number) {
    super('Role policy was modified by someone else');
    this.name = 'RolePolicyConflictError';
    this.currentVersion = currentVersion;
  }
}

export async function fetchRolePolicy(): Promise<RolePolicyResponse> {
  const response = await fetch(`${BACKEND_URL}/api/v1/role-policy`, {
    headers: authHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Failed to load role policy: ${response.status}`);
  }
  return (await response.json()) as RolePolicyResponse;
}

export async function updateRolePolicy(update: RolePolicyUpdate): Promise<RolePolicy> {
  const response = await fetch(`${BACKEND_URL}/api/v1/role-policy`, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify(update),
  });
  if (response.status === 409) {
    const body = (await response.json()) as { currentVersion?: number };
    throw new RolePolicyConflictError(body.currentVersion ?? -1);
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to save role policy: ${response.status}`);
  }
  const body = (await response.json()) as { policy: RolePolicy };
  return body.policy;
}
```

- [ ] **Step 2: Write the store**

```ts
// frontend/src/stores/rolePolicy.ts
import { defineStore } from 'pinia';
import {
  fetchRolePolicy,
  updateRolePolicy,
  RolePolicyConflictError,
  type RolePolicy,
  type RolePolicyUpdate,
} from 'src/lib/api/rolePolicy';

interface RolePolicyState {
  policy: RolePolicy | null;
  source: 'synced' | 'default' | null;
  capabilities: Record<string, string[]>;
  callerCapabilities: string[];
  loading: boolean;
  error: string | null;
}

export const useRolePolicyStore = defineStore('rolePolicy', {
  state: (): RolePolicyState => ({
    policy: null,
    source: null,
    capabilities: {},
    callerCapabilities: [],
    loading: false,
    error: null,
  }),

  getters: {
    canManageRoles(state): boolean {
      return state.callerCapabilities.includes('manage_roles');
    },
    can(state): (cap: string) => boolean {
      return (cap: string) => state.callerCapabilities.includes(cap);
    },
    // Role options for member role assignment (ChangeRoleModal): the
    // policy registry, builtins first, preserving server order.
    roleOptions(state): { id: string; displayName: string; builtin: boolean }[] {
      return state.policy?.roles ?? [];
    },
  },

  actions: {
    async load() {
      this.loading = true;
      this.error = null;
      try {
        const resp = await fetchRolePolicy();
        this.policy = resp.policy;
        this.source = resp.source;
        this.capabilities = resp.capabilities;
        this.callerCapabilities = resp.callerCapabilities ?? [];
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
      } finally {
        this.loading = false;
      }
    },

    // Returns true on success; on version conflict reloads the latest
    // policy and returns false so the UI can tell the admin to re-apply.
    async save(update: RolePolicyUpdate): Promise<boolean> {
      this.error = null;
      try {
        this.policy = await updateRolePolicy(update);
        this.source = 'synced';
        return true;
      } catch (e) {
        if (e instanceof RolePolicyConflictError) {
          await this.load();
          this.error = 'Someone else changed the policy — review the latest version and retry.';
          return false;
        }
        this.error = e instanceof Error ? e.message : String(e);
        return false;
      }
    },
  },
});
```

- [ ] **Step 3: Write the store unit test**

First check where vitest unit tests live: `grep -n '"test:script"' frontend/package.json` and look at an existing test file for the setup pattern (e.g. how existing store tests mock `fetch` and install Pinia). Follow that pattern exactly. The test content:

```ts
// frontend/test/vitest/__tests__/rolePolicy.store.test.ts (adjust path to repo convention)
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useRolePolicyStore } from 'src/stores/rolePolicy';

const policyResponse = {
  policy: {
    version: 2,
    roles: [
      { id: 'member', displayName: 'Member', builtin: true },
      { id: 'kaitiaki', displayName: 'Kaitiaki', builtin: false },
    ],
    grants: { member: ['contribute'], kaitiaki: ['sign_off'] },
  },
  source: 'synced',
  capabilities: { contribute: ['create_contribution'], sign_off: ['sign_off_contribution'] },
  callerCapabilities: ['contribute', 'manage_roles'],
};

describe('rolePolicy store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  it('load populates policy and caller capabilities', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify(policyResponse), { status: 200 }),
    ));
    const store = useRolePolicyStore();
    await store.load();
    expect(store.policy?.version).toBe(2);
    expect(store.canManageRoles).toBe(true);
    expect(store.can('sign_off')).toBe(false);
    expect(store.roleOptions.map((r) => r.id)).toEqual(['member', 'kaitiaki']);
  });

  it('save handles 409 by reloading and reporting conflict', async () => {
    const fetchMock = vi
      .fn()
      // PUT → 409
      .mockResolvedValueOnce(new Response(JSON.stringify({ currentVersion: 3 }), { status: 409 }))
      // reload GET → 200
      .mockResolvedValueOnce(new Response(JSON.stringify(policyResponse), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const store = useRolePolicyStore();
    const ok = await store.save({ version: 1, roles: [], grants: {} });
    expect(ok).toBe(false);
    expect(store.error).toContain('Someone else changed the policy');
    expect(store.policy?.version).toBe(2); // reloaded
  });
});
```

- [ ] **Step 4: Run the test**

Run: `cd frontend && npm run test:script -- rolePolicy`
Expected: PASS (2 tests). If the runner can't resolve `src/` aliases in the chosen directory, move the test to wherever existing store tests live and match their import style.

- [ ] **Step 5: Lint and commit**

```bash
cd frontend && npm run lint
git add frontend/src/lib/api/rolePolicy.ts frontend/src/stores/rolePolicy.ts frontend/test
git commit -m "feat(rbac): role-policy API client and Pinia store"
```

---

### Task 7: Roles & Permissions admin page

**Files:**
- Create: `frontend/src/pages/Dashboard/RolesPermissionsPage.vue`
- Modify: `frontend/src/router/routes.ts` (add child route under `/dashboard`, after the `activity` entry)
- Modify: `frontend/src/layouts/DashboardLayout.vue` (nav button, after the `activity` nav-item at line 33-37)

**Interfaces:**
- Consumes: `useRolePolicyStore` (Task 6), Quasar components (`q-toggle`, `q-btn`, `q-dialog`, `q-input`, `q-select`, `q-banner`), `useQuasar().notify`.
- Produces: route `{ path: 'roles', name: 'roles-permissions' }`.

- [ ] **Step 1: Add the route**

In `frontend/src/router/routes.ts`, inside the `/dashboard` children array after the `activity` entry (line ~44):

```ts
      {
        path: 'roles',
        name: 'roles-permissions',
        component: () => import('pages/Dashboard/RolesPermissionsPage.vue'),
      },
```

- [ ] **Step 2: Write the page**

```vue
<!-- frontend/src/pages/Dashboard/RolesPermissionsPage.vue -->
<template>
  <q-page padding>
    <div class="row items-center q-mb-md">
      <h1 class="text-h5 q-my-none">Roles &amp; Permissions</h1>
      <q-space />
      <q-btn
        outline
        label="New role"
        icon="add"
        :disable="!store.canManageRoles"
        @click="newRoleDialog = true"
      />
      <q-btn
        class="q-ml-sm"
        color="primary"
        label="Save changes"
        :loading="saving"
        :disable="!dirty || !store.canManageRoles"
        @click="save"
      />
    </div>

    <q-banner v-if="!store.canManageRoles && !store.loading" class="bg-warning text-dark q-mb-md">
      You don't have permission to manage roles. This page is read-only for you.
    </q-banner>
    <q-banner v-if="store.error" class="bg-negative text-white q-mb-md">
      {{ store.error }}
    </q-banner>
    <q-banner v-if="store.source === 'default'" class="bg-info text-white q-mb-md">
      Showing the built-in default policy — it has never been customized. Saving creates the
      community's first policy version.
    </q-banner>

    <q-markup-table v-if="editableGrants" flat bordered dense class="roles-matrix">
      <thead>
        <tr>
          <th class="text-left">Role</th>
          <th v-for="cap in capabilityIds" :key="cap" class="text-center">
            {{ capabilityLabel(cap) }}
            <q-tooltip>{{ capabilityTooltip(cap) }}</q-tooltip>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="role in roles" :key="role.id">
          <td class="text-left">
            {{ role.displayName }}
            <q-badge v-if="!role.builtin" color="secondary" class="q-ml-xs">custom</q-badge>
          </td>
          <td v-for="cap in capabilityIds" :key="cap" class="text-center">
            <q-toggle
              :model-value="hasGrant(role.id, cap)"
              :disable="!store.canManageRoles || isLockedCell(role.id, cap)"
              dense
              @update:model-value="(v: boolean) => setGrant(role.id, cap, v)"
            >
              <q-tooltip v-if="isLockedCell(role.id, cap)">
                At least one role must keep “Manage roles”.
              </q-tooltip>
            </q-toggle>
          </td>
        </tr>
      </tbody>
    </q-markup-table>

    <q-dialog v-model="newRoleDialog">
      <q-card style="min-width: 360px">
        <q-card-section class="text-h6">New custom role</q-card-section>
        <q-card-section>
          <q-input
            v-model="newRoleName"
            label="Role name"
            hint="e.g. Kaitiaki — the ID becomes lowercase with underscores"
            :error="newRoleName.length > 0 && !newRoleIdValid"
            error-message="Letters, numbers and underscores only; must start with a letter"
          />
          <q-select
            v-model="copyFromRole"
            :options="roleSelectOptions"
            label="Copy permissions from (optional)"
            clearable
            emit-value
            map-options
            class="q-mt-sm"
          />
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="Cancel" v-close-popup />
          <q-btn
            color="primary"
            label="Add role"
            :disable="!newRoleIdValid"
            @click="addRole"
            v-close-popup
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </q-page>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useQuasar } from 'quasar';
import { useRolePolicyStore } from 'src/stores/rolePolicy';
import type { RoleDef } from 'src/lib/api/rolePolicy';

const $q = useQuasar();
const store = useRolePolicyStore();

const roles = ref<RoleDef[]>([]);
const editableGrants = ref<Record<string, string[]> | null>(null);
const saving = ref(false);
const newRoleDialog = ref(false);
const newRoleName = ref('');
const copyFromRole = ref<string | null>(null);

const capabilityIds = computed(() => Object.keys(store.capabilities));

const CAPABILITY_LABELS: Record<string, string> = {
  contribute: 'Contribute',
  manage_projects: 'Manage projects',
  assign_work: 'Assign work',
  review_work: 'Review work',
  sign_off: 'Sign off',
  reward: 'Reward',
  submit_completion: 'Submit completion',
  approve_completion: 'Approve completion',
  archive_work: 'Archive',
  manage_members: 'Manage members',
  manage_governance: 'Governance',
  manage_communications: 'Communications',
  manage_roles: 'Manage roles',
};

function capabilityLabel(cap: string): string {
  return CAPABILITY_LABELS[cap] ?? cap;
}

function capabilityTooltip(cap: string): string {
  const actions = store.capabilities[cap] ?? [];
  return actions.length ? `Actions: ${actions.join(', ')}` : 'No enforced actions yet';
}

function resetFromStore() {
  roles.value = (store.policy?.roles ?? []).map((r) => ({ ...r }));
  editableGrants.value = Object.fromEntries(
    Object.entries(store.policy?.grants ?? {}).map(([k, v]) => [k, [...v]]),
  );
}

onMounted(async () => {
  await store.load();
  resetFromStore();
});
watch(() => store.policy?.version, resetFromStore);

const dirty = computed(() => {
  if (!store.policy || !editableGrants.value) return false;
  return (
    JSON.stringify({ r: roles.value, g: editableGrants.value }) !==
    JSON.stringify({ r: store.policy.roles, g: store.policy.grants })
  );
});

function hasGrant(roleId: string, cap: string): boolean {
  return editableGrants.value?.[roleId]?.includes(cap) ?? false;
}

// The last remaining manage_roles toggle is locked ON (spec §6).
function isLockedCell(roleId: string, cap: string): boolean {
  if (cap !== 'manage_roles' || !hasGrant(roleId, cap)) return false;
  const holders = Object.entries(editableGrants.value ?? {}).filter(([, caps]) =>
    caps.includes('manage_roles'),
  );
  return holders.length === 1 && holders[0]?.[0] === roleId;
}

function setGrant(roleId: string, cap: string, value: boolean) {
  if (!editableGrants.value) return;
  const caps = editableGrants.value[roleId] ?? [];
  if (value && !caps.includes(cap)) {
    editableGrants.value[roleId] = [...caps, cap];
  } else if (!value) {
    editableGrants.value[roleId] = caps.filter((c) => c !== cap);
  }
}

const newRoleId = computed(() =>
  newRoleName.value.trim().toLowerCase().replace(/\s+/g, '_'),
);
const newRoleIdValid = computed(
  () =>
    /^[a-z][a-z0-9_]{1,39}$/.test(newRoleId.value) &&
    !roles.value.some((r) => r.id === newRoleId.value),
);
const roleSelectOptions = computed(() =>
  roles.value.map((r) => ({ label: r.displayName, value: r.id })),
);

function addRole() {
  if (!editableGrants.value) return;
  roles.value.push({ id: newRoleId.value, displayName: newRoleName.value.trim(), builtin: false });
  editableGrants.value[newRoleId.value] = copyFromRole.value
    ? [...(editableGrants.value[copyFromRole.value] ?? [])]
    : [];
  newRoleName.value = '';
  copyFromRole.value = null;
}

async function save() {
  if (!store.policy || !editableGrants.value) return;
  saving.value = true;
  const ok = await store.save({
    version: store.policy.version,
    roles: roles.value,
    grants: editableGrants.value,
  });
  saving.value = false;
  if (ok) {
    resetFromStore();
    $q.notify({ type: 'positive', message: 'Role policy saved' });
  } else if (store.error) {
    $q.notify({ type: 'negative', message: store.error });
    resetFromStore();
  }
}
</script>

<style scoped>
.roles-matrix th {
  white-space: nowrap;
}
</style>
```

- [ ] **Step 3: Add the nav entry**

In `frontend/src/layouts/DashboardLayout.vue`, after the `activity` nav button (lines 33-37), following the existing `nav-item` pattern exactly:

```html
        <button
          v-if="rolePolicyStore.canManageRoles"
          class="nav-item"
          :class="{ active: route.name === 'roles-permissions' }"
          @click="router.push({ name: 'roles-permissions' })"
        >
          Roles
        </button>
```

In the layout's `<script setup>`, add:

```ts
import { useRolePolicyStore } from 'src/stores/rolePolicy';
const rolePolicyStore = useRolePolicyStore();
onMounted(() => {
  void rolePolicyStore.load();
});
```

(If the layout already has an `onMounted`, add the `load()` call inside it instead of a second `onMounted`. Match the icon/label markup of sibling nav items — if they contain `<q-icon>`/`<span>` wrappers, mirror that structure.)

- [ ] **Step 4: Verify in dev**

Run: `cd frontend && npm run lint && npx vue-tsc --noEmit 2>/dev/null || npm run lint`
Expected: lint clean; if the repo has no standalone type-check script rely on lint + dev build.

Then manually: `npm run dev`, log in as an admin, confirm the Roles nav item appears, the matrix renders 13 columns, toggling + Save round-trips, and a second save with a stale version (edit from another window) surfaces the conflict banner.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Dashboard/RolesPermissionsPage.vue frontend/src/router/routes.ts frontend/src/layouts/DashboardLayout.vue
git commit -m "feat(rbac): Roles & Permissions admin page with editable capability matrix"
```

---

### Task 8: Policy-driven role assignment UI

**Files:**
- Modify: `frontend/src/components/dashboard/ChangeRoleModal.vue` (lines 140-152: hardcoded `roles` array and `STEWARD_ROLES`)
- Modify: `frontend/src/composables/useAdminAccess.ts` (expose `canManageRoles`)

**Interfaces:**
- Consumes: `useRolePolicyStore.roleOptions` (Task 6).
- Produces: ChangeRoleModal lists builtin + custom roles from the policy registry; `useAdminAccess().canManageRoles`.

- [ ] **Step 1: Swap the hardcoded role list**

In `frontend/src/components/dashboard/ChangeRoleModal.vue`, replace the hardcoded array (lines 142-152):

```ts
import { useRolePolicyStore } from 'src/stores/rolePolicy';

const rolePolicyStore = useRolePolicyStore();

// Builtin roles use their KERI display names (which equal their credential
// role strings); custom roles use their policy IDs. Both are valid
// credential role values (backend isAssignableRole).
const roles = computed<string[]>(() => {
  const opts = rolePolicyStore.roleOptions;
  if (opts.length === 0) {
    // Policy not loaded yet — builtin fallback, identical to the old list.
    return [
      'Member', 'Contributor', 'Community Steward', 'Operations Steward',
      'Founding Member', 'Financial Steward', 'Governance Steward',
      'Treasury Steward', 'Technical Steward', 'Cultural Steward',
    ];
  }
  return opts.map((r) => (r.builtin ? keriNameForBuiltin(r.id) : r.id));
});

// Map builtin contribution-role IDs back to KERI credential role strings.
const BUILTIN_KERI_NAMES: Record<string, string> = {
  member: 'Member',
  contributor: 'Contributor',
  community_steward: 'Community Steward',
  operations_steward: 'Operations Steward',
  founding_member: 'Founding Member',
  treasury_steward: 'Treasury Steward',
  tech_steward: 'Technical Steward',
  project_lead: '',    // not directly assignable as a credential role
  project_steward: '', // not directly assignable as a credential role
  elder_council: '',   // ungrantable builtin — hidden from assignment
};
function keriNameForBuiltin(id: string): string {
  return BUILTIN_KERI_NAMES[id] ?? '';
}
```

Then filter empty entries where `roles` is consumed (the `v-for="role in roles"` at line 22): change the computed's final line to `.filter((r) => r !== '')`. Note the old hardcoded list also contained "Financial Steward", "Governance Steward", "Cultural Steward" — these are KERI roles with no distinct builtin contribution role (they collapse to community_steward/treasury_steward). Keep them assignable by appending them in the computed after the mapped list:

```ts
  const mapped = opts.map((r) => (r.builtin ? keriNameForBuiltin(r.id) : r.id)).filter((r) => r !== '');
  for (const extra of ['Financial Steward', 'Governance Steward', 'Cultural Steward']) {
    if (!mapped.includes(extra)) mapped.push(extra);
  }
  return mapped;
```

Add `void rolePolicyStore.load();` in the modal's setup (or rely on the layout's load from Task 7 — calling `load()` twice is harmless; keep the explicit call so the modal works standalone). `STEWARD_ROLES` (line 140) stays unchanged — custom roles never trigger the steward multisig upgrade path.

- [ ] **Step 2: Extend useAdminAccess**

In `frontend/src/composables/useAdminAccess.ts`, add to the returned object (after `canManageMembers`, line 27):

```ts
    canManageRoles: computed(() => useRolePolicyStore().canManageRoles),
```

with the import at the top: `import { useRolePolicyStore } from 'stores/rolePolicy';`

- [ ] **Step 3: Verify**

Run: `cd frontend && npm run lint`
Expected: clean. Manually in `npm run dev`: open the Change Role modal — the list shows the same roles as before plus any custom roles; assigning a custom role to a test member succeeds (backend Task 5 accepts it).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/dashboard/ChangeRoleModal.vue frontend/src/composables/useAdminAccess.ts
git commit -m "feat(rbac): role assignment lists policy-defined roles incl. custom roles"
```

---

### Task 9: Backend integration test — edit policy, enforcement changes

**Files:**
- Create: `backend/internal/api/role_policy_integration_test.go`

**Interfaces:**
- Consumes: everything above. Pure in-process test (mock store, no any-sync network) proving the full loop: PUT policy → RequireAction outcome changes; custom role end-to-end.

- [ ] **Step 1: Write the test**

```go
// backend/internal/api/role_policy_integration_test.go
package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/matou-dao/backend/internal/contributions"
)

// Full loop: a wired RequireAction route flips from allowed → denied after
// an admin edits the policy, and a custom role gains access end-to-end.
func TestPolicyEditChangesEnforcement(t *testing.T) {
	store := contributions.NewMockStore()
	provider := contributions.NewStorePolicyProvider(store, "ro-space", 0) // TTL 0 → always fresh
	contributions.SetPolicyProvider(provider)
	t.Cleanup(func() { contributions.SetPolicyProvider(nil) })

	lookup := staticRoles{
		"EOpsAID":     contributions.MapKERIRole("Operations Steward"),
		"EStewardAID": contributions.MapKERIRole("Community Steward"),
	}

	// A representative protected route, wired exactly like production
	// (RBACMiddleware + RequireAction, cf. contributions_handler withRBAC).
	protected := RBACMiddleware(lookup, RequireAction(contributions.ActionSignOffProposal,
		func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) }))

	call := func(aid string) int {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/proposals/x/sign-off", nil)
		req.Header.Set("X-User-AID", aid)
		rec := httptest.NewRecorder()
		protected(rec, req)
		return rec.Code
	}

	// Default policy: community steward CAN sign off proposals (manage_governance).
	if got := call("EStewardAID"); got != http.StatusOK {
		t.Fatalf("baseline: community steward sign-off = %d, want 200", got)
	}

	// Admin edits policy: remove manage_governance from community_steward
	// (both roles in the KERI bundle: community_steward AND project_steward
	// don't apply here — Community Steward KERI bundle includes project_steward,
	// so remove manage_governance from that too for the test to bite).
	mux := http.NewServeMux()
	writer := &fakePolicyWriter{store: store, space: "ro-space"}
	h := NewRolePolicyHandler(provider, writer, store, "ro-space", func(string) bool { return false })
	h.RegisterRoutes(mux, lookup)

	p := contributions.DefaultRolePolicy()
	for _, roleID := range []string{"community_steward", "project_steward"} {
		caps := p.Grants[roleID]
		out := caps[:0]
		for _, c := range caps {
			if c != contributions.CapManageGovernance {
				out = append(out, c)
			}
		}
		p.Grants[roleID] = out
	}
	rec := putPolicy(t, mux, "EOpsAID", map[string]interface{}{
		"version": 0, "roles": p.Roles, "grants": p.Grants,
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("policy edit: %d, body %s", rec.Code, rec.Body.String())
	}

	// Same request now denied.
	if got := call("EStewardAID"); got != http.StatusForbidden {
		t.Errorf("after edit: community steward sign-off = %d, want 403", got)
	}
	// Ops steward unaffected.
	if got := call("EOpsAID"); got != http.StatusOK {
		t.Errorf("after edit: ops steward sign-off = %d, want 200", got)
	}
}

func TestCustomRoleEndToEnd(t *testing.T) {
	store := contributions.NewMockStore()
	provider := contributions.NewStorePolicyProvider(store, "ro-space", 0)
	contributions.SetPolicyProvider(provider)
	t.Cleanup(func() { contributions.SetPolicyProvider(nil) })

	// 1. Admin creates custom role kaitiaki with sign_off.
	p := contributions.DefaultRolePolicy()
	p.Roles = append(p.Roles, contributions.RoleDef{ID: "kaitiaki", DisplayName: "Kaitiaki"})
	p.Grants["kaitiaki"] = []contributions.Capability{contributions.CapSignOff}
	mux := http.NewServeMux()
	h := NewRolePolicyHandler(provider, &fakePolicyWriter{store: store, space: "ro-space"},
		store, "ro-space", func(aid string) bool { return aid == "EAdminAID" })
	h.RegisterRoutes(mux, staticRoles{"EAdminAID": {}})
	rec := putPolicy(t, mux, "EAdminAID", map[string]interface{}{
		"version": 0, "roles": p.Roles, "grants": p.Grants,
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("create custom role: %d, body %s", rec.Code, rec.Body.String())
	}

	// 2. The role string is now assignable (profile validation, Task 5).
	if !isAssignableRole("kaitiaki") {
		t.Fatal("kaitiaki must be assignable after policy save")
	}

	// 3. A member whose profile carries role=kaitiaki resolves the custom
	//    bundle via ProfileRoleLookup and passes a sign_off RequireAction.
	_ = store.Save("ro-space", "CommunityProfile-EKaitiakiUser", "CommunityProfile",
		map[string]string{"userAID": "EKaitiakiUser", "role": "kaitiaki"})
	profileLookup := contributions.NewProfileRoleLookup(store, "ro-space")

	protected := RBACMiddleware(profileLookup, RequireAction(contributions.ActionSignOffContribution,
		func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) }))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/contributions/x/sign-off", nil)
	req.Header.Set("X-User-AID", "EKaitiakiUser")
	recorder := httptest.NewRecorder()
	protected(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Errorf("kaitiaki member sign-off = %d, want 200", recorder.Code)
	}

	// 4. A plain member still cannot.
	_ = store.Save("ro-space", "CommunityProfile-EPlainUser", "CommunityProfile",
		map[string]string{"userAID": "EPlainUser", "role": "Member"})
	req2 := httptest.NewRequest(http.MethodPost, "/api/v1/contributions/x/sign-off", nil)
	req2.Header.Set("X-User-AID", "EPlainUser")
	rec2 := httptest.NewRecorder()
	protected(rec2, req2)
	if rec2.Code != http.StatusForbidden {
		t.Errorf("plain member sign-off = %d, want 403", rec2.Code)
	}
}
```

- [ ] **Step 2: Run the tests**

Run: `cd backend && go test ./internal/api/ -run 'TestPolicyEditChangesEnforcement|TestCustomRoleEndToEnd' -v`
Expected: PASS (2 tests). Note `NewStorePolicyProvider(..., 0)` relies on `time.Since(fetchedAt) < ttl` being false for ttl 0 — always re-reads; if that flakes, use `time.Nanosecond`.

- [ ] **Step 3: Run everything**

Run: `cd backend && make test && cd ../frontend && npm run lint && npm run test:script`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add backend/internal/api/role_policy_integration_test.go
git commit -m "test(rbac): integration proof that policy edits change enforcement; custom role end-to-end"
```

---

## Out of scope (tracked elsewhere)

- Wiring unwired routes through `RequireAction` — issue #6 (prerequisite for the policy to bite on those routes; this plan works with whatever is wired).
- Peer-side validation of the RolePolicy object / KERI-signed policy edits — issues #8/#9.
- Playwright E2E for the admin matrix (add to the e2e suite once #6's auth-header changes settle; the backend integration test in Task 9 covers the enforcement loop).
- Migrating every frontend `isAdmin`/`isSteward` gate to capabilities — v1 migrates none beyond the new page and nav; incremental follow-ups.
