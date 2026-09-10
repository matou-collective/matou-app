package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/matou-dao/backend/internal/anysync"
	"github.com/matou-dao/backend/internal/types"
)

// registryWithSharedProfile returns a registry seeded with the built-in profile
// types, optionally with an extra required SharedProfile field appended (used to
// model an org-added custom registration question).
func registryWithSharedProfile(t *testing.T, extra ...types.FieldDef) *types.Registry {
	t.Helper()
	reg := types.NewRegistry()
	reg.Bootstrap()
	if len(extra) > 0 {
		def := types.SharedProfileType()
		def.Fields = append(def.Fields, extra...)
		reg.Register(def)
	}
	return reg
}

func baseRequest() *InitMemberProfilesRequest {
	return &InitMemberProfilesRequest{
		MemberAID:      "EMember123",
		CredentialSAID: "ECred456",
		Role:           "Member",
		Status:         "pending",
		DisplayName:    "Ada Lovelace",
		Email:          "ada@example.com",
		Bio:            "Mathematician",
	}
}

// TestMergedProfileData_TypedFieldsFormBase confirms the legacy typed fields are
// still accepted (one-release compat) and mapped to their canonical SharedProfile
// keys.
func TestMergedProfileData_TypedFieldsFormBase(t *testing.T) {
	req := baseRequest()
	req.Interests = []string{"governance"}

	merged, err := req.mergedProfileData()
	if err != nil {
		t.Fatalf("mergedProfileData: %v", err)
	}
	if merged["displayName"] != "Ada Lovelace" {
		t.Errorf("displayName = %v, want Ada Lovelace", merged["displayName"])
	}
	// Email maps onto the SharedProfile's publicEmail key, not "email".
	if merged["publicEmail"] != "ada@example.com" {
		t.Errorf("publicEmail = %v, want ada@example.com", merged["publicEmail"])
	}
	if _, ok := merged["email"]; ok {
		t.Errorf("legacy 'email' key must map to publicEmail, got %v", merged["email"])
	}
}

// TestMergedProfileData_OpaqueMapWins confirms profileData overlays (and beats)
// the typed base, and carries an org-added custom field through untouched.
func TestMergedProfileData_OpaqueMapWins(t *testing.T) {
	req := baseRequest()
	req.ProfileData = json.RawMessage(`{"displayName":"Ada L.","iwi":"Ngāti Example"}`)

	merged, err := req.mergedProfileData()
	if err != nil {
		t.Fatalf("mergedProfileData: %v", err)
	}
	if merged["displayName"] != "Ada L." {
		t.Errorf("profileData did not override typed displayName: %v", merged["displayName"])
	}
	if merged["iwi"] != "Ngāti Example" {
		t.Errorf("custom field iwi did not flow through: %v", merged["iwi"])
	}
}

func TestMergedProfileData_InvalidJSON(t *testing.T) {
	req := baseRequest()
	req.ProfileData = json.RawMessage(`{not json`)
	if _, err := req.mergedProfileData(); err == nil {
		t.Fatal("expected an error for invalid profileData JSON")
	}
}

// TestCustomRequiredField_RejectedAtSubmit is the core acceptance case: a member
// registering without a custom required SharedProfile field is rejected.
func TestCustomRequiredField_RejectedAtSubmit(t *testing.T) {
	reg := registryWithSharedProfile(t, types.FieldDef{Name: "iwi", Type: "string", Required: true})
	h := &ProfilesHandler{registry: reg}

	req := baseRequest() // no iwi
	merged, err := req.mergedProfileData()
	if err != nil {
		t.Fatalf("mergedProfileData: %v", err)
	}
	shared := buildSharedProfileData(merged, req.MemberAID, req.Status, "2026-09-04T00:00:00Z")
	data, _ := json.Marshal(shared)

	errs := h.validateProfile("SharedProfile", data)
	if len(errs) == 0 {
		t.Fatal("missing custom required field 'iwi' should have been rejected")
	}
}

// TestCustomRequiredField_SurvivesSubmitToStored is the round-trip case: a custom
// field supplied via the opaque map passes validation and is present in the
// stored SharedProfile payload.
func TestCustomRequiredField_SurvivesSubmitToStored(t *testing.T) {
	reg := registryWithSharedProfile(t, types.FieldDef{Name: "iwi", Type: "string", Required: true})
	h := &ProfilesHandler{registry: reg}

	req := baseRequest()
	req.ProfileData = json.RawMessage(`{"iwi":"Ngāti Example"}`)
	merged, err := req.mergedProfileData()
	if err != nil {
		t.Fatalf("mergedProfileData: %v", err)
	}
	shared := buildSharedProfileData(merged, req.MemberAID, req.Status, "2026-09-04T00:00:00Z")
	data, _ := json.Marshal(shared)

	if errs := h.validateProfile("SharedProfile", data); len(errs) > 0 {
		t.Fatalf("valid profile rejected: %v", errs)
	}
	if shared["iwi"] != "Ngāti Example" {
		t.Errorf("custom field not present in stored payload: %v", shared["iwi"])
	}
}

// TestSchemaChangeReValidated models a schema that gains a required field between
// registration submit and approval: the same payload that passed at submit must
// be rejected when re-validated against the newer schema.
func TestSchemaChangeReValidated(t *testing.T) {
	// Submit time: schema v1, no custom field. Payload passes.
	reg := registryWithSharedProfile(t)
	h := &ProfilesHandler{registry: reg}

	req := baseRequest()
	merged, err := req.mergedProfileData()
	if err != nil {
		t.Fatalf("mergedProfileData: %v", err)
	}
	shared := buildSharedProfileData(merged, req.MemberAID, req.Status, "2026-09-04T00:00:00Z")
	data, _ := json.Marshal(shared)
	if errs := h.validateProfile("SharedProfile", data); len(errs) > 0 {
		t.Fatalf("payload should pass under v1 schema, got %v", errs)
	}

	// Approval time: admin added a required field. Re-validation must reject.
	def := types.SharedProfileType()
	def.Fields = append(def.Fields, types.FieldDef{Name: "iwi", Type: "string", Required: true})
	reg.Register(def)

	if errs := h.validateProfile("SharedProfile", data); len(errs) == 0 {
		t.Fatal("schema change between submit and approval was not re-validated")
	}
}

// TestCommunityProfileHasNoDisplayFields locks in the schema-alignment fix: the
// CommunityProfile the handler builds carries only admin-managed membership
// fields — no display/social keys that the CommunityProfile schema never
// declared (and therefore never validated). It exercises the real assembler,
// not a hand-written copy of it.
func TestCommunityProfileHasNoDisplayFields(t *testing.T) {
	req := baseRequest()
	req.Interests = []string{"governance"}
	req.FacebookURL = "https://facebook.com/ada"
	req.ProfileData = json.RawMessage(`{"joinReason":"kaupapa","iwi":"Ngāti Example"}`)

	community := buildCommunityProfileData(req, "2026-09-04T00:00:00Z")

	for _, k := range []string{"userAID", "credential", "role", "memberSince", "lastActiveAt", "credentials"} {
		if _, ok := community[k]; !ok {
			t.Errorf("CommunityProfile missing membership field %q", k)
		}
	}
	for _, k := range []string{"displayName", "email", "publicEmail", "bio", "avatar", "joinReason", "facebookUrl", "participationInterests", "iwi"} {
		if _, ok := community[k]; ok {
			t.Errorf("CommunityProfile should not carry display field %q", k)
		}
	}

	// And it validates cleanly against the real CommunityProfile schema.
	reg := registryWithSharedProfile(t)
	h := &ProfilesHandler{registry: reg}
	data, _ := json.Marshal(community)
	if errs := h.validateProfile("CommunityProfile", data); len(errs) > 0 {
		t.Fatalf("membership-only CommunityProfile rejected: %v", errs)
	}
}

// TestBothRequestShapesValidate pins the one-release compat promise: the legacy
// typed field list and the opaque profileData map must each, alone, produce a
// SharedProfile that passes the org schema — and produce the same stored keys.
func TestBothRequestShapesValidate(t *testing.T) {
	reg := registryWithSharedProfile(t)
	h := &ProfilesHandler{registry: reg}

	typed := &InitMemberProfilesRequest{
		MemberAID: "EMember123", CredentialSAID: "ECred456", Status: "pending",
		DisplayName: "Ada Lovelace", Email: "ada@example.com", Bio: "Mathematician",
		Interests: []string{"governance"}, Location: "Aotearoa", GithubURL: "https://github.com/ada",
	}
	opaque := &InitMemberProfilesRequest{
		MemberAID: "EMember123", CredentialSAID: "ECred456", Status: "pending",
		ProfileData: json.RawMessage(`{"displayName":"Ada Lovelace","publicEmail":"ada@example.com","bio":"Mathematician","participationInterests":["governance"],"location":"Aotearoa","githubUrl":"https://github.com/ada"}`),
	}

	var stored [2]map[string]interface{}
	for i, req := range []*InitMemberProfilesRequest{typed, opaque} {
		merged, err := req.mergedProfileData()
		if err != nil {
			t.Fatalf("shape %d: mergedProfileData: %v", i, err)
		}
		shared := buildSharedProfileData(merged, req.MemberAID, req.Status, "2026-09-04T00:00:00Z")
		data, _ := json.Marshal(shared)
		if errs := h.validateProfile("SharedProfile", data); len(errs) > 0 {
			t.Fatalf("shape %d rejected by SharedProfile schema: %v", i, errs)
		}
		// Normalise through JSON so []string and []interface{} compare equal.
		var norm map[string]interface{}
		_ = json.Unmarshal(data, &norm)
		stored[i] = norm
	}
	if !reflect.DeepEqual(stored[0], stored[1]) {
		t.Errorf("typed and opaque shapes stored different SharedProfiles:\n typed=%v\n opaque=%v", stored[0], stored[1])
	}
}

// TestSystemFieldsCannotBeOverriddenViaProfileData: the opaque map must never
// be able to set the identity/status/timestamp fields the backend manages.
func TestSystemFieldsCannotBeOverriddenViaProfileData(t *testing.T) {
	req := baseRequest()
	req.ProfileData = json.RawMessage(`{"aid":"EAttacker","status":"approved","createdAt":"1999-01-01T00:00:00Z","typeVersion":99}`)
	merged, err := req.mergedProfileData()
	if err != nil {
		t.Fatalf("mergedProfileData: %v", err)
	}
	shared := buildSharedProfileData(merged, req.MemberAID, req.Status, "2026-09-04T00:00:00Z")
	if shared["aid"] != "EMember123" || shared["status"] != "pending" || shared["createdAt"] != "2026-09-04T00:00:00Z" || shared["typeVersion"] != 1 {
		t.Errorf("system fields overridden via profileData: %v", shared)
	}
}

// newInitMemberTestHandler builds a ProfilesHandler whose space manager reports
// both community spaces as configured, so HandleInitMemberProfiles gets past
// its space checks and into assembly + validation. No any-sync client is wired,
// so a request that reaches a write would fail loudly rather than succeed.
func newInitMemberTestHandler(reg *types.Registry) *ProfilesHandler {
	sm := anysync.NewSpaceManager(newMockClient(), &anysync.SpaceManagerConfig{
		CommunitySpaceID:         "test-community-space",
		CommunityReadOnlySpaceID: "test-community-readonly-space",
		OrgAID:                   "EORG",
	})
	return &ProfilesHandler{registry: reg, spaceManager: sm}
}

// TestHandleInitMemberProfiles_CustomRequiredFieldMissing400 drives the real
// HTTP handler: an org-added required SharedProfile field left out of the
// registration must be rejected with 400 and a validation error naming it,
// before anything is written.
func TestHandleInitMemberProfiles_CustomRequiredFieldMissing400(t *testing.T) {
	reg := registryWithSharedProfile(t, types.FieldDef{Name: "iwi", Type: "string", Required: true})
	h := newInitMemberTestHandler(reg)

	body := `{"memberAid":"EMember123","credentialSaid":"ECred456","status":"pending","profileData":{"displayName":"Ada Lovelace"}}`
	rr := httptest.NewRecorder()
	h.HandleInitMemberProfiles(rr, httptest.NewRequest(http.MethodPost, "/api/v1/profiles/init-member", strings.NewReader(body)))

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rr.Code, rr.Body.String())
	}
	var resp struct {
		Error            string   `json:"error"`
		ValidationErrors []string `json:"validationErrors"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Error != "SharedProfile validation failed" {
		t.Errorf("error = %q", resp.Error)
	}
	if !strings.Contains(strings.Join(resp.ValidationErrors, ";"), `"iwi"`) {
		t.Errorf("validationErrors should name iwi, got %v", resp.ValidationErrors)
	}
}

// TestHandleInitMemberProfiles_InvalidProfileData400 covers a malformed opaque
// map (e.g. an array instead of an object).
func TestHandleInitMemberProfiles_InvalidProfileData400(t *testing.T) {
	h := newInitMemberTestHandler(registryWithSharedProfile(t))
	body := `{"memberAid":"EMember123","credentialSaid":"ECred456","profileData":["not","an","object"]}`
	rr := httptest.NewRecorder()
	h.HandleInitMemberProfiles(rr, httptest.NewRequest(http.MethodPost, "/api/v1/profiles/init-member", strings.NewReader(body)))
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rr.Code, rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), "profileData") {
		t.Errorf("error should mention profileData: %s", rr.Body.String())
	}
}
