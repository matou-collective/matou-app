package api

import (
	"encoding/json"
	"testing"

	"github.com/matou-dao/backend/internal/types"
)

func sampleInitReq() *InitMemberProfilesRequest {
	return &InitMemberProfilesRequest{
		MemberAID:           "EmemberAID",
		CredentialSAID:      "Ecred",
		Role:                "Member",
		Status:              "approved",
		DisplayName:         "Aroha",
		Email:               "aroha@example.nz",
		Avatar:              "file:avatar",
		Bio:                 "kia ora",
		Interests:           []string{"governance"},
		CustomInterests:     "weaving",
		Location:            "Aotearoa",
		IndigenousCommunity: "Ngāti Example",
		JoinReason:          "to contribute",
		FacebookURL:         "https://fb/x",
	}
}

// split runs the merged-map assembly the handler runs: typed fields + opaque
// profileData → merged map → schema-routed CommunityProfile/SharedProfile.
func split(t *testing.T, communityDef, sharedDef *types.TypeDefinition, req *InitMemberProfilesRequest) (community, shared map[string]interface{}, dropped []string) {
	t.Helper()
	merged, err := req.mergedProfileData()
	if err != nil {
		t.Fatalf("mergedProfileData: %v", err)
	}
	return buildMemberProfileData(communityDef, sharedDef, req, merged, "2026-09-04T00:00:00Z")
}

func withoutField(fields []types.FieldDef, name string) []types.FieldDef {
	out := make([]types.FieldDef, 0, len(fields))
	for _, f := range fields {
		if f.Name != name {
			out = append(out, f)
		}
	}
	return out
}

// TestBuildMemberProfileDataDefaultSplit verifies the default schema puts
// display fields on the community-writable SharedProfile and keeps only the
// admin-managed membership fields on the read-only CommunityProfile.
func TestBuildMemberProfileDataDefaultSplit(t *testing.T) {
	community, shared, dropped := split(t, types.CommunityProfileType(), types.SharedProfileType(), sampleInitReq())

	// SharedProfile carries the display fields (routed) + core identity fields (pinned).
	for _, k := range []string{"aid", "status", "displayName", "avatar", "bio", "publicEmail",
		"location", "indigenousCommunity", "joinReason", "participationInterests",
		"customInterests", "facebookUrl", "createdAt", "updatedAt", "typeVersion"} {
		if _, ok := shared[k]; !ok {
			t.Errorf("expected SharedProfile to contain %q", k)
		}
	}
	if shared["publicEmail"] != "aroha@example.nz" {
		t.Errorf("publicEmail = %v", shared["publicEmail"])
	}

	// CommunityProfile carries only membership fields — no display fields.
	for _, k := range []string{"userAID", "credential", "role", "memberSince", "lastActiveAt", "credentials"} {
		if _, ok := community[k]; !ok {
			t.Errorf("expected CommunityProfile to contain core field %q", k)
		}
	}
	for _, k := range []string{"displayName", "bio", "avatar", "location", "joinReason",
		"participationInterests", "customInterests", "email", "publicEmail",
		"indigenousCommunity", "facebookUrl"} {
		if _, ok := community[k]; ok {
			t.Errorf("CommunityProfile should not carry display field %q (schema does not declare it)", k)
		}
	}
	if len(dropped) != 0 {
		t.Errorf("default schema declares every typed field; dropped = %v", dropped)
	}
}

// TestBuildMemberProfileDataMoveFieldChangesSpace models an admin moving a
// non-core field between the two profile schemas: a new member's value follows
// the schema to the other space (issue #300 acceptance criterion). Covered for
// both request shapes — the typed field and the opaque profileData map.
func TestBuildMemberProfileDataMoveFieldChangesSpace(t *testing.T) {
	opaque := &InitMemberProfilesRequest{
		MemberAID: "EmemberAID", CredentialSAID: "Ecred", Role: "Member", Status: "approved",
		ProfileData: json.RawMessage(`{"displayName":"Aroha","location":"Aotearoa"}`),
	}
	for name, req := range map[string]*InitMemberProfilesRequest{"typed": sampleInitReq(), "opaque": opaque} {
		sharedDef := types.SharedProfileType()
		communityDef := types.CommunityProfileType()

		// Move `location` from SharedProfile to CommunityProfile in the schema.
		sharedDef.Fields = withoutField(sharedDef.Fields, "location")
		communityDef.Fields = append(communityDef.Fields, types.FieldDef{Name: "location", Type: "string"})

		community, shared, dropped := split(t, communityDef, sharedDef, req)

		if _, ok := shared["location"]; ok {
			t.Errorf("%s: after schema move, location should not be stored on SharedProfile", name)
		}
		if community["location"] != "Aotearoa" {
			t.Errorf("%s: after schema move, expected location on CommunityProfile, got %v", name, community["location"])
		}
		if len(dropped) != 0 {
			t.Errorf("%s: nothing should be dropped, got %v", name, dropped)
		}
	}
}

// TestBuildMemberProfileDataCoreFieldsPinned verifies core fields handlers
// depend on stay in their expected profile even if a schema edit tries to move
// them (issue #300 acceptance criterion).
func TestBuildMemberProfileDataCoreFieldsPinned(t *testing.T) {
	sharedDef := types.SharedProfileType()
	communityDef := types.CommunityProfileType()

	// Adversarial schema edit: drop core fields from SharedProfile and try to
	// declare them on CommunityProfile instead.
	for _, f := range []string{"displayName", "status", "avatar"} {
		sharedDef.Fields = withoutField(sharedDef.Fields, f)
	}
	communityDef.Fields = append(communityDef.Fields,
		types.FieldDef{Name: "displayName", Type: "string"},
		types.FieldDef{Name: "status", Type: "string"},
		types.FieldDef{Name: "avatar", Type: "string"})

	community, shared, _ := split(t, communityDef, sharedDef, sampleInitReq())

	if shared["displayName"] != "Aroha" {
		t.Errorf("displayName must remain pinned to SharedProfile, got %v", shared["displayName"])
	}
	if shared["status"] != "approved" {
		t.Errorf("status must remain pinned to SharedProfile, got %v", shared["status"])
	}
	if shared["avatar"] != "file:avatar" {
		t.Errorf("avatar must remain pinned to SharedProfile, got %v", shared["avatar"])
	}
	for _, k := range []string{"displayName", "status", "avatar"} {
		if _, ok := community[k]; ok {
			t.Errorf("core %s must not be moved onto CommunityProfile by a schema edit", k)
		}
	}
}

