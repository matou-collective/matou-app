// backend/internal/api/role_policy_integration_test.go
package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

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
