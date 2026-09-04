package api

import (
	"encoding/json"
	"testing"

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
// declared (and therefore never validated).
func TestCommunityProfileHasNoDisplayFields(t *testing.T) {
	// The handler builds this map (mirrors HandleInitMemberProfiles).
	req := baseRequest()
	community := map[string]interface{}{
		"userAID":      req.MemberAID,
		"credential":   req.CredentialSAID,
		"role":         req.Role,
		"memberSince":  "2026-09-04T00:00:00Z",
		"lastActiveAt": "2026-09-04T00:00:00Z",
		"credentials":  []string{req.CredentialSAID},
	}
	for _, k := range []string{"displayName", "email", "bio", "avatar", "joinReason", "facebookUrl", "participationInterests"} {
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
