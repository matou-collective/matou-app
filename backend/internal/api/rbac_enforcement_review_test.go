package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/matou-dao/backend/internal/contributions"
	"github.com/matou-dao/backend/internal/identity"
	"github.com/matou-dao/backend/internal/keri"
	"github.com/matou-dao/backend/internal/types"
)

// Tests for the PR #28 review follow-ups: POST /profiles guard, archived via
// /transition, and RBAC on the role-granting routes (org config, identity/set,
// grant-steward-admin) plus sync/credentials.

var (
	memberRoles = []contributions.Role{contributions.RoleMember, contributions.RoleContributor}
	opsRoles    = contributions.MapKERIRole("Operations Steward")
	fmRoles     = contributions.MapKERIRole("Founding Member")
	csRoles     = contributions.MapKERIRole("Community Steward")
)

func reviewLookup() *mockRoleLookup {
	return &mockRoleLookup{roles: map[string][]contributions.Role{
		"EMember": memberRoles,
		"EOther":  memberRoles,
		"EOps":    opsRoles,
		"EFM":     fmRoles,
		"ECS":     csRoles,
	}}
}

func do(mux *http.ServeMux, method, path, aid, body string) *httptest.ResponseRecorder {
	var rdr *strings.Reader
	if body != "" {
		rdr = strings.NewReader(body)
	} else {
		rdr = strings.NewReader("")
	}
	req := httptest.NewRequest(method, path, rdr)
	req.Header.Set("Content-Type", "application/json")
	if aid != "" {
		req.Header.Set("X-User-AID", aid)
	}
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	return w
}

// ---------------------------------------------------------------------------
// POST /api/v1/profiles
// ---------------------------------------------------------------------------

func profilesMuxWithRegistry(lookup RoleLookup) *http.ServeMux {
	reg := types.NewRegistry()
	reg.Bootstrap()
	h := &ProfilesHandler{registry: reg}
	mux := http.NewServeMux()
	h.RegisterRoutes(mux, lookup)
	return mux
}

const fmProfileBody = `{"type":"CommunityProfile","id":"CommunityProfile-EMember","data":{"userAID":"EMember","credential":"ESAID","role":"Founding Member"}}`

func TestCreateProfile_MissingAIDRejected(t *testing.T) {
	mux := profilesMuxWithRegistry(reviewLookup())
	if w := do(mux, http.MethodPost, "/api/v1/profiles", "", fmProfileBody); w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without X-User-AID, got %d: %s", w.Code, w.Body.String())
	}
}

func TestCreateProfile_MemberCannotSelfPromoteViaProfiles(t *testing.T) {
	// The escalation from the review: a plain member writes a CommunityProfile
	// carrying role "Founding Member" for their own AID.
	mux := profilesMuxWithRegistry(reviewLookup())
	if w := do(mux, http.MethodPost, "/api/v1/profiles", "EMember", fmProfileBody); w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for member self-promotion via POST /profiles, got %d: %s", w.Code, w.Body.String())
	}
}

func TestCreateProfile_OpsStewardCannotGrantFoundingMember(t *testing.T) {
	// Same rule as PUT /members/{aid}/role: FM may only be granted by an FM.
	mux := profilesMuxWithRegistry(reviewLookup())
	if w := do(mux, http.MethodPost, "/api/v1/profiles", "EOps", fmProfileBody); w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for ops steward granting FM via POST /profiles, got %d: %s", w.Code, w.Body.String())
	}
}

func TestCreateProfile_FoundingMemberPassesRoleGate(t *testing.T) {
	// The FM passes the policy; the request then fails downstream (no space
	// configured in this test handler) with a non-403 status.
	mux := profilesMuxWithRegistry(reviewLookup())
	if w := do(mux, http.MethodPost, "/api/v1/profiles", "EFM", fmProfileBody); w.Code == http.StatusForbidden || w.Code == http.StatusUnauthorized {
		t.Fatalf("FM should pass the role gate, got %d: %s", w.Code, w.Body.String())
	}
}

func TestCreateProfile_MemberCannotWriteOthersSharedProfile(t *testing.T) {
	mux := profilesMuxWithRegistry(reviewLookup())
	body := `{"type":"SharedProfile","id":"SharedProfile-EOther","data":{"aid":"EOther","displayName":"Someone","status":"approved"}}`
	if w := do(mux, http.MethodPost, "/api/v1/profiles", "EMember", body); w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 writing another member's SharedProfile, got %d: %s", w.Code, w.Body.String())
	}
}

func TestCreateProfile_MemberMayWriteOwnSharedProfile(t *testing.T) {
	mux := profilesMuxWithRegistry(reviewLookup())
	body := `{"type":"SharedProfile","id":"SharedProfile-EMember","data":{"aid":"EMember","displayName":"Me","status":"approved"}}`
	if w := do(mux, http.MethodPost, "/api/v1/profiles", "EMember", body); w.Code == http.StatusForbidden || w.Code == http.StatusUnauthorized {
		t.Fatalf("member should pass the ownership gate for their own profile, got %d: %s", w.Code, w.Body.String())
	}
}

func TestProfileWritePolicy_Matrix(t *testing.T) {
	existingMember := json.RawMessage(`{"userAID":"EOther","credential":"pending","role":"Member","displayName":"O"}`)
	existingSteward := json.RawMessage(`{"userAID":"EOther","credential":"c","role":"Community Steward"}`)
	sharedExisting := json.RawMessage(`{"aid":"EOther","displayName":"O","endorsements":[{"by":"EA"}]}`)

	cases := []struct {
		name       string
		caller     string
		roles      []contributions.Role
		typ, id    string
		data       string
		existing   json.RawMessage
		wantDenied bool
	}{
		// role changes go through ActionChangeMemberRole
		{"member self-promote, no existing", "EMember", memberRoles, "CommunityProfile", "CommunityProfile-EMember", `{"userAID":"EMember","credential":"c","role":"Operations Steward"}`, nil, true},
		{"member self-promote over existing Member", "EMember", memberRoles, "CommunityProfile", "CommunityProfile-EMember", `{"userAID":"EMember","credential":"c","role":"Founding Member"}`, json.RawMessage(`{"userAID":"EMember","credential":"c","role":"Member"}`), true},
		{"community steward changes a role", "ECS", csRoles, "CommunityProfile", "CommunityProfile-EOther", `{"userAID":"EOther","credential":"c","role":"Contributor"}`, existingMember, true},
		{"ops steward changes a role", "EOps", opsRoles, "CommunityProfile", "CommunityProfile-EOther", `{"userAID":"EOther","credential":"c","role":"Contributor"}`, existingMember, false},
		{"ops steward grants FM", "EOps", opsRoles, "CommunityProfile", "CommunityProfile-EOther", `{"userAID":"EOther","credential":"c","role":"Founding Member"}`, existingMember, true},
		{"FM grants FM", "EFM", fmRoles, "CommunityProfile", "CommunityProfile-EOther", `{"userAID":"EOther","credential":"c","role":"Founding Member"}`, existingMember, false},
		{"member demotes a steward", "EMember", memberRoles, "CommunityProfile", "CommunityProfile-EOther", `{"userAID":"EOther","credential":"c","role":"Member"}`, existingSteward, true},
		// unchanged role: steward scope (registration approval by a Community Steward)
		{"community steward approves (role unchanged)", "ECS", csRoles, "CommunityProfile", "CommunityProfile-EOther", `{"userAID":"EOther","credential":"ESAID","role":"Member","displayName":"O"}`, existingMember, false},
		{"community steward creates new Member profile", "ECS", csRoles, "CommunityProfile", "CommunityProfile-EOther", `{"userAID":"EOther","credential":"pending","role":"Member"}`, nil, false},
		{"member creates a Member profile for someone else", "EMember", memberRoles, "CommunityProfile", "CommunityProfile-EOther", `{"userAID":"EOther","credential":"pending","role":"Member"}`, nil, true},
		// ownership
		{"member writes own PrivateProfile (generated id)", "EMember", memberRoles, "PrivateProfile", "PrivateProfile-EMember-1234", `{"membershipCredentialSAID":"x"}`, nil, false},
		{"member writes own SharedProfile", "EMember", memberRoles, "SharedProfile", "SharedProfile-EMember", `{"aid":"EMember","displayName":"Me"}`, nil, false},
		{"member relabels someone else's profile as their own", "EMember", memberRoles, "SharedProfile", "SharedProfile-EOther", `{"aid":"EMember","displayName":"Me"}`, sharedExisting, true},
		{"steward writes another SharedProfile", "ECS", csRoles, "SharedProfile", "SharedProfile-EOther", `{"aid":"EOther","displayName":"O","status":"declined"}`, sharedExisting, false},
		// endorsements
		{"member appends an endorsement", "EMember", memberRoles, "SharedProfile", "SharedProfile-EOther", `{"aid":"EOther","displayName":"O","endorsements":[{"by":"EA"},{"by":"EMember"}]}`, sharedExisting, false},
		{"member adds first endorsement", "EMember", memberRoles, "SharedProfile", "SharedProfile-EOther", `{"aid":"EOther","displayName":"O","endorsements":[{"by":"EMember"}]}`, json.RawMessage(`{"aid":"EOther","displayName":"O"}`), false},
		{"member 'endorses' while changing other fields", "EMember", memberRoles, "SharedProfile", "SharedProfile-EOther", `{"aid":"EOther","displayName":"Hacked","endorsements":[{"by":"EA"},{"by":"EMember"}]}`, sharedExisting, true},
		{"member removes an endorsement", "EMember", memberRoles, "SharedProfile", "SharedProfile-EOther", `{"aid":"EOther","displayName":"O","endorsements":[]}`, sharedExisting, true},
		{"unauthenticated (empty caller)", "", nil, "SharedProfile", "SharedProfile-EOther", `{"aid":"EOther"}`, nil, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reason := profileWritePolicy(tc.caller, tc.roles, tc.typ, tc.id, json.RawMessage(tc.data), tc.existing)
			if (reason != "") != tc.wantDenied {
				t.Errorf("denied=%v (reason %q), want denied=%v", reason != "", reason, tc.wantDenied)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// POST /contributions/{id}/transition {"status":"archived"}
// ---------------------------------------------------------------------------

func TestTransitionGuard_BlocksArchiveForMember(t *testing.T) {
	h := setupTestContributionsHandler()
	mux := http.NewServeMux()
	h.RegisterRoutes(mux, reviewLookup())

	if w := do(mux, http.MethodPost, "/api/v1/contributions/C1/transition", "EMember", `{"status":"archived"}`); w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 archiving via /transition as a member, got %d: %s", w.Code, w.Body.String())
	}
	if w := do(mux, http.MethodPost, "/api/v1/contributions/C1/transition", "", `{"status":"archived"}`); w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without X-User-AID, got %d", w.Code)
	}
}

func TestTransitionGuard_ArchiveViaTransitionUsesArchivePath(t *testing.T) {
	h := setupTestContributionsHandler()
	mux := http.NewServeMux()
	h.RegisterRoutes(mux, reviewLookup())

	// Ops steward passes the gate; the archive service path then runs (and
	// fails with "not found" for a missing contribution — a 400, never 403).
	w := do(mux, http.MethodPost, "/api/v1/contributions/C1/transition", "EOps", `{"status":"archived"}`)
	if w.Code == http.StatusForbidden || w.Code == http.StatusUnauthorized {
		t.Fatalf("ops steward should pass the archive gate, got %d: %s", w.Code, w.Body.String())
	}
}

// ---------------------------------------------------------------------------
// POST/DELETE /api/v1/org/config — bootstrap rule
// ---------------------------------------------------------------------------

const orgConfigBody = `{"organization":{"aid":"EOrg","name":"Test Org"},"admins":[{"aid":"EFM","name":"Admin"}]}`

func orgConfigMux(t *testing.T) (*http.ServeMux, *OrgConfigHandler) {
	t.Helper()
	h := NewOrgConfigHandler(t.TempDir(), nil)
	mux := http.NewServeMux()
	h.RegisterRoutes(mux, reviewLookup())
	return mux, h
}

func TestOrgConfig_BootstrapAllowsFirstSaveWithoutRoles(t *testing.T) {
	mux, h := orgConfigMux(t)
	if h.IsConfigured() {
		t.Fatal("fresh handler should not be configured")
	}
	if w := do(mux, http.MethodPost, "/api/v1/org/config", "", orgConfigBody); w.Code != http.StatusOK {
		t.Fatalf("first-run save should be allowed without X-User-AID, got %d: %s", w.Code, w.Body.String())
	}
	if !h.IsConfigured() {
		t.Fatal("handler should be configured after bootstrap save")
	}
}

func TestOrgConfig_RequiresAdminScopeOnceConfigured(t *testing.T) {
	mux, _ := orgConfigMux(t)
	if w := do(mux, http.MethodPost, "/api/v1/org/config", "", orgConfigBody); w.Code != http.StatusOK {
		t.Fatalf("bootstrap save failed: %d", w.Code)
	}

	if w := do(mux, http.MethodPost, "/api/v1/org/config", "", orgConfigBody); w.Code != http.StatusUnauthorized {
		t.Errorf("configured: expected 401 without X-User-AID, got %d", w.Code)
	}
	if w := do(mux, http.MethodPost, "/api/v1/org/config", "EMember", orgConfigBody); w.Code != http.StatusForbidden {
		t.Errorf("configured: expected 403 for a member, got %d", w.Code)
	}
	if w := do(mux, http.MethodPost, "/api/v1/org/config", "ECS", orgConfigBody); w.Code != http.StatusForbidden {
		t.Errorf("configured: expected 403 for a community steward, got %d", w.Code)
	}
	// #318: save_org_config now requires manage_community_settings (founder-only
	// by default), not manage_members. An operations steward still holds
	// manage_members but is refused here.
	if w := do(mux, http.MethodPost, "/api/v1/org/config", "EOps", orgConfigBody); w.Code != http.StatusForbidden {
		t.Errorf("configured: expected 403 for an operations steward (holds manage_members, not manage_community_settings), got %d", w.Code)
	}
	if w := do(mux, http.MethodPost, "/api/v1/org/config", "EFM", orgConfigBody); w.Code != http.StatusOK {
		t.Errorf("configured: expected 200 for a founding member, got %d: %s", w.Code, w.Body.String())
	}
	if w := do(mux, http.MethodDelete, "/api/v1/org/config", "EMember", ""); w.Code != http.StatusForbidden {
		t.Errorf("configured: expected 403 for a member deleting config, got %d", w.Code)
	}
	if w := do(mux, http.MethodDelete, "/api/v1/org/config", "EOps", ""); w.Code != http.StatusForbidden {
		t.Errorf("configured: expected 403 for an operations steward deleting config, got %d", w.Code)
	}
	if w := do(mux, http.MethodDelete, "/api/v1/org/config", "EFM", ""); w.Code != http.StatusOK {
		t.Errorf("configured: expected 200 for FM deleting config, got %d: %s", w.Code, w.Body.String())
	}
	// Deleted → back in bootstrap.
	if w := do(mux, http.MethodPost, "/api/v1/org/config", "", orgConfigBody); w.Code != http.StatusOK {
		t.Errorf("after delete: bootstrap save should be allowed again, got %d", w.Code)
	}
}

// ---------------------------------------------------------------------------
// POST /api/v1/identity/set, DELETE /api/v1/identity — bootstrap rule
// ---------------------------------------------------------------------------

func identityGuardMux(t *testing.T, ui *identity.UserIdentity) *http.ServeMux {
	t.Helper()
	h := &IdentityHandler{userIdentity: ui, roleLookup: reviewLookup()}
	mux := http.NewServeMux()
	// Exercise the guard around a stub so the test does not need an SDK client.
	ok := func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) }
	mux.HandleFunc("/api/v1/identity/set", h.withBootstrapRBAC(ok))
	mux.HandleFunc("/api/v1/identity", h.withBootstrapRBAC(ok))
	return mux
}

func TestIdentitySet_BootstrapAllowsFirstSet(t *testing.T) {
	ui := identity.New(t.TempDir())
	mux := identityGuardMux(t, ui)
	if w := do(mux, http.MethodPost, "/api/v1/identity/set", "", `{}`); w.Code != http.StatusNoContent {
		t.Fatalf("first identity/set should be allowed without X-User-AID, got %d", w.Code)
	}
}

func TestIdentitySet_GuardedOnceConfigured(t *testing.T) {
	ui := identity.New(t.TempDir())
	if err := ui.SetIdentity("EOwner", "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"); err != nil {
		t.Fatal(err)
	}
	mux := identityGuardMux(t, ui)

	if w := do(mux, http.MethodPost, "/api/v1/identity/set", "", `{}`); w.Code != http.StatusUnauthorized {
		t.Errorf("configured: expected 401 without X-User-AID, got %d", w.Code)
	}
	if w := do(mux, http.MethodPost, "/api/v1/identity/set", "EMember", `{}`); w.Code != http.StatusForbidden {
		t.Errorf("configured: expected 403 for a non-owner member, got %d", w.Code)
	}
	if w := do(mux, http.MethodDelete, "/api/v1/identity", "EMember", ""); w.Code != http.StatusForbidden {
		t.Errorf("configured: expected 403 for a non-owner member deleting identity, got %d", w.Code)
	}
	// The owner (any role — resolves to plain member in this lookup) may re-set.
	if w := do(mux, http.MethodPost, "/api/v1/identity/set", "EOwner", `{}`); w.Code != http.StatusNoContent {
		t.Errorf("configured: owner should be allowed, got %d", w.Code)
	}
	// Admin scope may re-point the identity.
	if w := do(mux, http.MethodPost, "/api/v1/identity/set", "EOps", `{}`); w.Code != http.StatusNoContent {
		t.Errorf("configured: ops steward should be allowed, got %d", w.Code)
	}
}

// ---------------------------------------------------------------------------
// POST /api/v1/spaces/grant-steward-admin
// ---------------------------------------------------------------------------

func TestGrantStewardAdmin_RequiresAdminScope(t *testing.T) {
	h := &SpacesHandler{}
	mux := http.NewServeMux()
	h.RegisterRoutes(mux, reviewLookup())
	body := `{"stewardAid":"EOther"}`

	if w := do(mux, http.MethodPost, "/api/v1/spaces/grant-steward-admin", "", body); w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 without X-User-AID, got %d", w.Code)
	}
	if w := do(mux, http.MethodPost, "/api/v1/spaces/grant-steward-admin", "EMember", body); w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for a member, got %d", w.Code)
	}
	if w := do(mux, http.MethodPost, "/api/v1/spaces/grant-steward-admin", "ECS", body); w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for a community steward (not admin scope), got %d", w.Code)
	}
}

// ---------------------------------------------------------------------------
// POST /api/v1/sync/credentials, POST /api/v1/credentials
// ---------------------------------------------------------------------------

func TestSyncCredentials_RequiresAIDAndOwnRecipient(t *testing.T) {
	h := &SyncHandler{}
	mux := http.NewServeMux()
	h.RegisterRoutes(mux, reviewLookup())
	other := `{"userAid":"EMember","credentials":[{"said":"ES1","issuer":"EOrg","recipient":"EOther","schema":"S","data":{"role":"Founding Member"}}]}`

	if w := do(mux, http.MethodPost, "/api/v1/sync/credentials", "", other); w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 without X-User-AID, got %d", w.Code)
	}
	if w := do(mux, http.MethodPost, "/api/v1/sync/credentials", "EMember", other); w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for a member syncing another AID's credential, got %d: %s", w.Code, w.Body.String())
	}
	spoofUser := `{"userAid":"EOther","credentials":[]}`
	if w := do(mux, http.MethodPost, "/api/v1/sync/credentials", "EMember", spoofUser); w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for a member with a mismatching userAid, got %d: %s", w.Code, w.Body.String())
	}
}

func TestCredentialSubjectPolicy(t *testing.T) {
	own := []keri.Credential{{SAID: "S", Issuer: "EOrg", Recipient: "EMember"}}
	other := []keri.Credential{{SAID: "S", Issuer: "EOrg", Recipient: "EOther"}}
	if msg := credentialSubjectPolicy("EMember", memberRoles, "EMember", own); msg != "" {
		t.Errorf("member syncing own credential should pass: %s", msg)
	}
	if msg := credentialSubjectPolicy("EMember", memberRoles, "", own); msg != "" {
		t.Errorf("member syncing own credential without userAid should pass: %s", msg)
	}
	if msg := credentialSubjectPolicy("EMember", memberRoles, "", other); msg == "" {
		t.Error("member syncing another AID's credential should be denied")
	}
	if msg := credentialSubjectPolicy("ECS", csRoles, "", other); msg != "" {
		t.Errorf("steward syncing a credential they issued should pass: %s", msg)
	}
}

func TestStoreCredential_MemberCannotCacheOthersCredential(t *testing.T) {
	h, cleanup := setupTestHandler(t)
	defer cleanup()
	mux := http.NewServeMux()
	h.RegisterRoutes(mux, reviewLookup())
	body := `{"credential":{"said":"ES1","issuer":"EOrg","recipient":"EOther","schema":"S","data":{"role":"Member"}}}`
	if w := do(mux, http.MethodPost, "/api/v1/credentials", "EMember", body); w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for a member caching another AID's credential, got %d: %s", w.Code, w.Body.String())
	}
}
