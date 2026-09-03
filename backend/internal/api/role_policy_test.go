// backend/internal/api/role_policy_test.go
package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
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

// failingListStore wraps a MockObjectStore and fails List for a given
// objectType, letting tests simulate a store/read error independently of
// what's actually stored (see contributions/change_log_test.go's
// failingSaveStore for the write-side sibling of this pattern). failType can
// be changed between calls within a test to target a specific read.
type failingListStore struct {
	*contributions.MockObjectStore
	failType string
}

func (f *failingListStore) List(spaceID, objectType string) ([]json.RawMessage, error) {
	if f.failType != "" && objectType == f.failType {
		return nil, fmt.Errorf("simulated store failure for %s", objectType)
	}
	return f.MockObjectStore.List(spaceID, objectType)
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
		Source              string                         `json:"source"`
		Policy              contributions.RolePolicy       `json:"policy"`
		Capabilities        map[string][]string            `json:"capabilities"`
		CapabilityOrder     []contributions.Capability     `json:"capabilityOrder"`
		ProjectCapabilities []contributions.Capability     `json:"projectCapabilities"`
		CallerCapabilities  []contributions.Capability     `json:"callerCapabilities"`
		CapabilityMeta      []contributions.CapabilityMeta `json:"capabilityMeta"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Source != "default" {
		t.Errorf("source = %q, want default", resp.Source)
	}
	if len(resp.Policy.Roles) != 7 {
		t.Errorf("default policy roles = %d, want 7", len(resp.Policy.Roles))
	}
	// 13 original − 2 retired + 11 new = 22 toggleable capabilities.
	if len(resp.Capabilities) != 22 {
		t.Errorf("capabilities = %d entries, want 22", len(resp.Capabilities))
	}
	if len(resp.CapabilityOrder) != 22 {
		t.Errorf("capabilityOrder = %d entries, want 22 (all in AllCapabilities order)", len(resp.CapabilityOrder))
	}
	if len(resp.ProjectCapabilities) != 10 {
		t.Errorf("projectCapabilities = %d entries, want 10", len(resp.ProjectCapabilities))
	}
	if len(resp.CapabilityMeta) != 22 {
		t.Errorf("capabilityMeta = %d entries, want 22 (one per capability, with group/scope)", len(resp.CapabilityMeta))
	}
	// Every role carries a non-empty scope so the UI can split the tables.
	for _, r := range resp.Policy.Roles {
		if r.Scope != contributions.ScopeCommunity && r.Scope != contributions.ScopeProject {
			t.Errorf("role %q has scope %q, want community or project", r.ID, r.Scope)
		}
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

// A PUT that tries to store a retired capability ID is rejected with a clear,
// successor-naming message (#313). The generic "unknown capability" path would
// otherwise swallow it in a less helpful error.
func TestPutRolePolicyRejectsRetiredCapability(t *testing.T) {
	h, _, _ := newTestPolicyHandler(t)
	mux := http.NewServeMux()
	h.RegisterRoutes(mux, lookupForTests())

	bad := validUpdate()
	grants := bad["grants"].(map[string][]contributions.Capability)
	grants[string(contributions.RoleOperationsSteward)] = append(
		grants[string(contributions.RoleOperationsSteward)], contributions.CapAssignWork)
	rec := putPolicy(t, mux, "EOpsAID", bad)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("retired capability in PUT: %d, want 400; body %s", rec.Code, rec.Body.String())
	}
	if body := rec.Body.String(); !strings.Contains(body, "retired") ||
		!strings.Contains(body, string(contributions.CapAssignProjectSteward)) {
		t.Errorf("error message should name the retirement and its successor, got %s", body)
	}
}

// A legacy policy saved before the #312 capabilities existed (CapModel 0, using
// the retired assign_work / manage_communications IDs) is served UPGRADED via
// GET: retired IDs mapped to successors, new-capability defaults merged, no
// retired ID left in the response.
func TestGetRolePolicyUpgradesLegacyStoredPolicy(t *testing.T) {
	h, store, provider := newTestPolicyHandler(t)
	mux := http.NewServeMux()
	h.RegisterRoutes(mux, lookupForTests())

	legacy := &contributions.RolePolicy{
		Version:  4,
		CapModel: 0,
		Roles:    contributions.DefaultRolePolicy().Roles,
		Grants: map[string][]contributions.Capability{
			string(contributions.RoleMember): {contributions.CapContribute},
			string(contributions.RoleFoundingMember): {
				contributions.CapAssignWork, contributions.CapManageComms, contributions.CapManageRoles,
			},
		},
	}
	if err := store.Save("ro-space", "RolePolicy", "RolePolicy", legacy); err != nil {
		t.Fatal(err)
	}
	provider.Invalidate()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/role-policy", nil)
	req.Header.Set("X-User-AID", "EOpsAID")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET = %d, want 200; body %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Source string                   `json:"source"`
		Policy contributions.RolePolicy `json:"policy"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Source != "synced" {
		t.Errorf("source = %q, want synced", resp.Source)
	}
	has := func(roleID string, c contributions.Capability) bool {
		for _, g := range resp.Policy.Grants[roleID] {
			if g == c {
				return true
			}
		}
		return false
	}
	fm := string(contributions.RoleFoundingMember)
	if has(fm, contributions.CapAssignWork) || has(fm, contributions.CapManageComms) {
		t.Error("upgraded policy still exposes a retired capability")
	}
	if !has(fm, contributions.CapAssignProjectSteward) || !has(fm, contributions.CapAssignProjectLead) {
		t.Error("founding_member should inherit the assign capabilities from assign_work")
	}
	if !has(fm, contributions.CapManageChannels) || !has(fm, contributions.CapModerateMessages) {
		t.Error("founding_member should inherit the chat caps from manage_communications")
	}
	// A new default reaches a builtin role even though the saved policy predates it.
	if !has(string(contributions.RoleMember), contributions.CapCreateProposals) {
		t.Error("member should gain merged default create_proposals via the upgrade path")
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

	// Builtin role renamed → 400
	bad5 := validUpdate()
	roles5 := append([]contributions.RoleDef{}, bad5["roles"].([]contributions.RoleDef)...)
	for i, r := range roles5 {
		if r.ID == "member" {
			roles5[i].DisplayName = "Renamed Member"
		}
	}
	bad5["roles"] = roles5
	if rec := putPolicy(t, mux, "EOpsAID", bad5); rec.Code != http.StatusBadRequest {
		t.Errorf("renamed builtin: %d, want 400; body %s", rec.Code, rec.Body.String())
	}
}

// A project-scoped role may not hold a community-only capability: the PUT is
// rejected with 400 (issue #165). Covers both a builtin project role
// (project_lead) and a custom project role.
func TestPutRolePolicyProjectRoleCommunityCapRejected(t *testing.T) {
	h, _, _ := newTestPolicyHandler(t)
	mux := http.NewServeMux()
	h.RegisterRoutes(mux, lookupForTests())

	// Builtin project role project_lead granted manage_governance → 400.
	bad := validUpdate()
	grants := bad["grants"].(map[string][]contributions.Capability)
	grants["project_lead"] = append(grants["project_lead"], contributions.CapManageGovernance)
	if rec := putPolicy(t, mux, "EOpsAID", bad); rec.Code != http.StatusBadRequest {
		t.Errorf("project_lead + manage_governance: %d, want 400; body %s", rec.Code, rec.Body.String())
	}

	// A custom project-scoped role granted manage_roles → 400.
	bad2 := validUpdate()
	bad2["roles"] = append(bad2["roles"].([]contributions.RoleDef),
		contributions.RoleDef{ID: "kaimahi", DisplayName: "Kaimahi", Scope: contributions.ScopeProject})
	bad2["grants"].(map[string][]contributions.Capability)["kaimahi"] =
		[]contributions.Capability{contributions.CapManageRoles}
	if rec := putPolicy(t, mux, "EOpsAID", bad2); rec.Code != http.StatusBadRequest {
		t.Errorf("custom project role + manage_roles: %d, want 400; body %s", rec.Code, rec.Body.String())
	}

	// A custom project-scoped role granted only project caps → 200.
	ok := validUpdate()
	ok["roles"] = append(ok["roles"].([]contributions.RoleDef),
		contributions.RoleDef{ID: "kaimahi", DisplayName: "Kaimahi", Scope: contributions.ScopeProject})
	ok["grants"].(map[string][]contributions.Capability)["kaimahi"] =
		[]contributions.Capability{contributions.CapSignOff, contributions.CapReviewWork}
	if rec := putPolicy(t, mux, "EOpsAID", ok); rec.Code != http.StatusOK {
		t.Errorf("custom project role + project caps: %d, want 200; body %s", rec.Code, rec.Body.String())
	}
}

// A builtin's scope cannot be flipped: even if the request labels a community
// builtin as project-scoped, it is normalized back and may still hold its
// community capabilities (no 400).
func TestPutRolePolicyBuiltinScopeNotFlippable(t *testing.T) {
	h, _, _ := newTestPolicyHandler(t)
	mux := http.NewServeMux()
	h.RegisterRoutes(mux, lookupForTests())

	upd := validUpdate()
	roles := append([]contributions.RoleDef{}, upd["roles"].([]contributions.RoleDef)...)
	for i, r := range roles {
		if r.ID == "operations_steward" {
			roles[i].Scope = contributions.ScopeProject // try to demote it
		}
	}
	upd["roles"] = roles
	// operations_steward keeps manage_roles/manage_members etc.; if the flip
	// were honored this would 400, but the builtin scope is forced to community.
	if rec := putPolicy(t, mux, "EOpsAID", upd); rec.Code != http.StatusOK {
		t.Errorf("builtin scope flip attempt: %d, want 200 (scope normalized); body %s", rec.Code, rec.Body.String())
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

// newFailingTestPolicyHandler is like newTestPolicyHandler but the returned
// store's List can be made to fail for a chosen objectType mid-test, so a
// single test can exercise "store read fails" for the version check or the
// custom-role-in-use check independently. Writes always go through the
// underlying (non-failing) base store, mirroring fakePolicyWriter's real
// round trip.
func newFailingTestPolicyHandler(t *testing.T) (*RolePolicyHandler, *contributions.MockObjectStore, *failingListStore) {
	t.Helper()
	base := contributions.NewMockStore()
	failing := &failingListStore{MockObjectStore: base}
	provider := contributions.NewStorePolicyProvider(failing, "ro-space", time.Millisecond)
	contributions.SetPolicyProvider(provider)
	t.Cleanup(func() { contributions.SetPolicyProvider(nil) })
	writer := &fakePolicyWriter{store: base, space: "ro-space"}
	h := NewRolePolicyHandler(provider, writer, failing, "ro-space",
		func(aid string) bool { return aid == "EAdminAID" })
	return h, base, failing
}

func TestPutRolePolicyVersionCheckStoreFailure(t *testing.T) {
	h, base, failing := newFailingTestPolicyHandler(t)
	mux := http.NewServeMux()
	h.RegisterRoutes(mux, lookupForTests())

	// First PUT succeeds normally and invalidates the provider cache.
	if rec := putPolicy(t, mux, "EOpsAID", validUpdate()); rec.Code != http.StatusOK {
		t.Fatalf("setup PUT: %d; body %s", rec.Code, rec.Body.String())
	}

	// The store now fails to list "RolePolicy" objects, so the version check
	// can no longer distinguish "never saved" (version 0, default) from
	// "read failed" — it must refuse rather than fail open to the default.
	failing.failType = "RolePolicy"
	update := validUpdate()
	update["version"] = 1 // the correct current version, but unverifiable
	rec := putPolicy(t, mux, "EOpsAID", update)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("store read failure during version check: %d, want 503; body %s", rec.Code, rec.Body.String())
	}

	// Nothing was written by the failed attempt: still version 1 from setup.
	failing.failType = ""
	var stored contributions.RolePolicy
	if err := base.Get("ro-space", "RolePolicy", &stored); err != nil {
		t.Fatalf("Get: %v", err)
	}
	if stored.Version != 1 {
		t.Errorf("stored policy version = %d, want 1 (unchanged)", stored.Version)
	}
}

func TestPutRolePolicyCustomRoleCheckStoreFailure(t *testing.T) {
	h, base, failing := newFailingTestPolicyHandler(t)
	mux := http.NewServeMux()
	h.RegisterRoutes(mux, lookupForTests())

	// Save policy with kaitiaki (setup PUT, version 0 -> 1).
	if rec := putPolicy(t, mux, "EOpsAID", validUpdate()); rec.Code != http.StatusOK {
		t.Fatalf("setup PUT: %d; body %s", rec.Code, rec.Body.String())
	}

	// An update (version 1) that removes kaitiaki, but the profile store
	// can't be listed — the in-use check can't be verified, so it must
	// refuse rather than silently allow the deletion through.
	failing.failType = "CommunityProfile"
	p := contributions.DefaultRolePolicy()
	update := map[string]interface{}{"version": 1, "roles": p.Roles, "grants": p.Grants}
	rec := putPolicy(t, mux, "EOpsAID", update)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("profile store failure during custom-role check: %d, want 503; body %s", rec.Code, rec.Body.String())
	}

	// Nothing was written: still version 1 (kaitiaki still present).
	failing.failType = ""
	var stored contributions.RolePolicy
	if err := base.Get("ro-space", "RolePolicy", &stored); err != nil {
		t.Fatalf("Get: %v", err)
	}
	if stored.Version != 1 {
		t.Errorf("stored policy version = %d, want 1 (unchanged)", stored.Version)
	}
}

// Grandfathering (#165→#166 handoff): project_steward's manage_governance is a
// community-only capability on a project role that the DEFAULT policy grants.
// It must survive an echo of the current policy, be removable — and once
// removed, not be re-addable (and never extendable to another project role).
func TestPutRolePolicyGrandfatheredCommunityCap(t *testing.T) {
	h, _, _ := newTestPolicyHandler(t)
	mux := http.NewServeMux()
	h.RegisterRoutes(mux, lookupForTests())

	// 1. Echoing the default policy — which still grants project_steward
	// manage_governance — is accepted (a bare echo must never brick the page).
	if rec := putPolicy(t, mux, "EOpsAID", validUpdate()); rec.Code != http.StatusOK {
		t.Fatalf("echo of default policy: %d, want 200; body %s", rec.Code, rec.Body.String())
	}

	// 2. Removing the grandfathered grant is accepted.
	removed := validUpdate()
	removed["version"] = 1
	grants := removed["grants"].(map[string][]contributions.Capability)
	var kept []contributions.Capability
	for _, c := range grants[string(contributions.RoleProjectSteward)] {
		if c != contributions.CapManageGovernance {
			kept = append(kept, c)
		}
	}
	grants[string(contributions.RoleProjectSteward)] = kept
	if rec := putPolicy(t, mux, "EOpsAID", removed); rec.Code != http.StatusOK {
		t.Fatalf("removing grandfathered grant: %d, want 200; body %s", rec.Code, rec.Body.String())
	}

	// 3. Re-adding it after removal is rejected — the grandfather is a one-way
	// door: current policy no longer holds the grant, so it counts as new.
	readd := validUpdate()
	readd["version"] = 2
	if rec := putPolicy(t, mux, "EOpsAID", readd); rec.Code != http.StatusBadRequest {
		t.Fatalf("re-adding after removal: %d, want 400; body %s", rec.Code, rec.Body.String())
	}
}
