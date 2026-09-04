package api

import (
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
		FacebookUrl:         "https://fb/x",
	}
}

// TestBuildMemberProfileDataDefaultSplit verifies the default schema puts
// display fields on the community-writable SharedProfile and keeps only the
// admin-managed membership fields on the read-only CommunityProfile.
func TestBuildMemberProfileDataDefaultSplit(t *testing.T) {
	community, shared := buildMemberProfileData(
		types.CommunityProfileType(), types.SharedProfileType(), sampleInitReq(), "2026-09-04T00:00:00Z")

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
}

// TestBuildMemberProfileDataMoveFieldChangesSpace models an admin moving a
// non-core field between the two profile schemas: a new member's value follows
// the schema to the other space (issue #300 acceptance criterion).
func TestBuildMemberProfileDataMoveFieldChangesSpace(t *testing.T) {
	sharedDef := types.SharedProfileType()
	communityDef := types.CommunityProfileType()

	// Move `location` from SharedProfile to CommunityProfile in the schema.
	kept := sharedDef.Fields[:0]
	for _, f := range sharedDef.Fields {
		if f.Name != "location" {
			kept = append(kept, f)
		}
	}
	sharedDef.Fields = kept
	communityDef.Fields = append(communityDef.Fields, types.FieldDef{Name: "location", Type: "string"})

	community, shared := buildMemberProfileData(communityDef, sharedDef, sampleInitReq(), "2026-09-04T00:00:00Z")

	if _, ok := shared["location"]; ok {
		t.Errorf("after schema move, location should not be stored on SharedProfile")
	}
	if community["location"] != "Aotearoa" {
		t.Errorf("after schema move, expected location on CommunityProfile, got %v", community["location"])
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
	kept := sharedDef.Fields[:0]
	for _, f := range sharedDef.Fields {
		if f.Name != "displayName" && f.Name != "status" {
			kept = append(kept, f)
		}
	}
	sharedDef.Fields = kept
	communityDef.Fields = append(communityDef.Fields,
		types.FieldDef{Name: "displayName", Type: "string"},
		types.FieldDef{Name: "status", Type: "string"})

	community, shared := buildMemberProfileData(communityDef, sharedDef, sampleInitReq(), "2026-09-04T00:00:00Z")

	if shared["displayName"] != "Aroha" {
		t.Errorf("displayName must remain pinned to SharedProfile, got %v", shared["displayName"])
	}
	if shared["status"] != "approved" {
		t.Errorf("status must remain pinned to SharedProfile, got %v", shared["status"])
	}
	if _, ok := community["displayName"]; ok {
		t.Errorf("core displayName must not be moved onto CommunityProfile by a schema edit")
	}
	if _, ok := community["status"]; ok {
		t.Errorf("core status must not be moved onto CommunityProfile by a schema edit")
	}
}
