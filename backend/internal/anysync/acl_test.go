package anysync

import (
	"testing"
)

func TestPrivateACL(t *testing.T) {
	ownerAID := "EOwner1234567890abcdef"

	policy := PrivateACL(ownerAID)

	if policy.PolicyType != PolicyTypePrivate {
		t.Errorf("expected policy type %s, got %s", PolicyTypePrivate, policy.PolicyType)
	}

	if policy.OwnerAID != ownerAID {
		t.Errorf("expected owner AID %s, got %s", ownerAID, policy.OwnerAID)
	}

	if policy.RequiredSchema != "" {
		t.Errorf("expected no required schema, got %s", policy.RequiredSchema)
	}

	if policy.DefaultPermission != PermissionNone {
		t.Errorf("expected default permission %s, got %s", PermissionNone, policy.DefaultPermission)
	}

	if policy.OwnerPermission != PermissionOwner {
		t.Errorf("expected owner permission %s, got %s", PermissionOwner, policy.OwnerPermission)
	}
}

func TestCommunityACL(t *testing.T) {
	orgAID := "EOrg1234567890abcdef"
	requiredSchema := "EMatouMembershipSchemaV1"

	policy := CommunityACL(orgAID, requiredSchema)

	if policy.PolicyType != PolicyTypeCommunity {
		t.Errorf("expected policy type %s, got %s", PolicyTypeCommunity, policy.PolicyType)
	}

	if policy.OwnerAID != orgAID {
		t.Errorf("expected owner AID %s, got %s", orgAID, policy.OwnerAID)
	}

	if policy.RequiredSchema != requiredSchema {
		t.Errorf("expected required schema %s, got %s", requiredSchema, policy.RequiredSchema)
	}

	if policy.DefaultPermission != PermissionWrite {
		t.Errorf("expected default permission %s, got %s", PermissionWrite, policy.DefaultPermission)
	}

	if policy.OwnerPermission != PermissionOwner {
		t.Errorf("expected owner permission %s, got %s", PermissionOwner, policy.OwnerPermission)
	}
}

func TestPublicACL(t *testing.T) {
	ownerAID := "EOwner1234567890abcdef"

	policy := PublicACL(ownerAID)

	if policy.PolicyType != PolicyTypePublic {
		t.Errorf("expected policy type %s, got %s", PolicyTypePublic, policy.PolicyType)
	}

	if policy.OwnerAID != ownerAID {
		t.Errorf("expected owner AID %s, got %s", ownerAID, policy.OwnerAID)
	}

	if policy.RequiredSchema != "" {
		t.Errorf("expected no required schema, got %s", policy.RequiredSchema)
	}

	if policy.DefaultPermission != PermissionRead {
		t.Errorf("expected default permission %s, got %s", PermissionRead, policy.DefaultPermission)
	}

	if policy.OwnerPermission != PermissionOwner {
		t.Errorf("expected owner permission %s, got %s", PermissionOwner, policy.OwnerPermission)
	}
}

func TestACLManager_ValidateAccess_Owner(t *testing.T) {
	ownerAID := "EOwner1234567890abcdef"
	policy := PrivateACL(ownerAID)

	mgr := NewACLManager(nil) // Client not needed for validation

	perm, err := mgr.ValidateAccess(policy, ownerAID, false, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if perm != PermissionOwner {
		t.Errorf("expected owner permission, got %s", perm)
	}
}

func TestACLManager_ValidateAccess_PrivateNonOwner(t *testing.T) {
	ownerAID := "EOwner1234567890abcdef"
	otherAID := "EOther1234567890abcdef"
	policy := PrivateACL(ownerAID)

	mgr := NewACLManager(nil)

	perm, err := mgr.ValidateAccess(policy, otherAID, false, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if perm != PermissionNone {
		t.Errorf("expected no permission for non-owner in private space, got %s", perm)
	}
}

func TestACLManager_ValidateAccess_CommunityWithCredential(t *testing.T) {
	orgAID := "EOrg1234567890abcdef"
	memberAID := "EMember1234567890abcdef"
	requiredSchema := "EMatouMembershipSchemaV1"
	policy := CommunityACL(orgAID, requiredSchema)

	mgr := NewACLManager(nil)

	// Member with correct credential
	perm, err := mgr.ValidateAccess(policy, memberAID, true, requiredSchema)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if perm != PermissionWrite {
		t.Errorf("expected write permission for member with credential, got %s", perm)
	}
}

func TestACLManager_ValidateAccess_CommunityWithoutCredential(t *testing.T) {
	orgAID := "EOrg1234567890abcdef"
	memberAID := "EMember1234567890abcdef"
	requiredSchema := "EMatouMembershipSchemaV1"
	policy := CommunityACL(orgAID, requiredSchema)

	mgr := NewACLManager(nil)

	// User without credential
	perm, err := mgr.ValidateAccess(policy, memberAID, false, "")
	if err == nil {
		t.Error("expected error for missing credential")
	}

	if perm != PermissionNone {
		t.Errorf("expected no permission without credential, got %s", perm)
	}
}

func TestACLManager_ValidateAccess_CommunityWrongSchema(t *testing.T) {
	orgAID := "EOrg1234567890abcdef"
	memberAID := "EMember1234567890abcdef"
	requiredSchema := "EMatouMembershipSchemaV1"
	wrongSchema := "ESomeOtherSchema"
	policy := CommunityACL(orgAID, requiredSchema)

	mgr := NewACLManager(nil)

	// User with wrong credential schema
	perm, err := mgr.ValidateAccess(policy, memberAID, true, wrongSchema)
	if err == nil {
		t.Error("expected error for wrong credential schema")
	}

	if perm != PermissionNone {
		t.Errorf("expected no permission with wrong schema, got %s", perm)
	}
}

func TestACLManager_ValidateAccess_Public(t *testing.T) {
	ownerAID := "EOwner1234567890abcdef"
	anyoneAID := "EAnyone1234567890abcdef"
	policy := PublicACL(ownerAID)

	mgr := NewACLManager(nil)

	perm, err := mgr.ValidateAccess(policy, anyoneAID, false, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if perm != PermissionRead {
		t.Errorf("expected read permission for public space, got %s", perm)
	}
}

func TestACLManager_ValidateAccess_UnknownPolicyType(t *testing.T) {
	policy := &ACLPolicy{
		PolicyType:        "unknown",
		OwnerAID:          "EOwner123",
		DefaultPermission: PermissionRead,
		OwnerPermission:   PermissionOwner,
	}

	mgr := NewACLManager(nil)

	perm, err := mgr.ValidateAccess(policy, "EUser123", false, "")
	if err == nil {
		t.Error("expected error for unknown policy type")
	}

	if perm != PermissionNone {
		t.Errorf("expected no permission for unknown policy type, got %s", perm)
	}
}

func TestACLPolicyForSpaceType_Private(t *testing.T) {
	ownerAID := "EOwner1234567890abcdef"
	orgAID := "EOrg1234567890abcdef"

	policy := ACLPolicyForSpaceType(SpaceTypePrivate, ownerAID, orgAID)

	if policy.PolicyType != PolicyTypePrivate {
		t.Errorf("expected private policy, got %s", policy.PolicyType)
	}

	if policy.OwnerAID != ownerAID {
		t.Errorf("expected owner %s, got %s", ownerAID, policy.OwnerAID)
	}
}

func TestACLPolicyForSpaceType_Community(t *testing.T) {
	ownerAID := "EOwner1234567890abcdef"
	orgAID := "EOrg1234567890abcdef"

	policy := ACLPolicyForSpaceType(SpaceTypeCommunity, ownerAID, orgAID)

	if policy.PolicyType != PolicyTypeCommunity {
		t.Errorf("expected community policy, got %s", policy.PolicyType)
	}

	if policy.OwnerAID != orgAID {
		t.Errorf("expected org owner %s, got %s", orgAID, policy.OwnerAID)
	}

	if policy.RequiredSchema != "EMatouMembershipSchemaV1" {
		t.Errorf("expected membership schema, got %s", policy.RequiredSchema)
	}
}

func TestACLPolicyForSpaceType_Unknown(t *testing.T) {
	ownerAID := "EOwner1234567890abcdef"
	orgAID := "EOrg1234567890abcdef"

	policy := ACLPolicyForSpaceType("unknown", ownerAID, orgAID)

	// Should default to private
	if policy.PolicyType != PolicyTypePrivate {
		t.Errorf("expected private policy for unknown type, got %s", policy.PolicyType)
	}
}

func TestACLEntry_Structure(t *testing.T) {
	entry := ACLEntry{
		PeerID:         "12D3KooWTest",
		AID:            "EUser123",
		Permission:     PermissionWrite,
		CredentialSAID: "ESAID123",
		AddedAt:        1234567890,
	}

	if entry.PeerID != "12D3KooWTest" {
		t.Errorf("unexpected peer ID: %s", entry.PeerID)
	}

	if entry.AID != "EUser123" {
		t.Errorf("unexpected AID: %s", entry.AID)
	}

	if entry.Permission != PermissionWrite {
		t.Errorf("unexpected permission: %s", entry.Permission)
	}
}

func TestACLPermission_Constants(t *testing.T) {
	permissions := []ACLPermission{
		PermissionNone,
		PermissionRead,
		PermissionWrite,
		PermissionAdmin,
		PermissionOwner,
	}

	expected := []string{"none", "read", "write", "admin", "owner"}

	for i, perm := range permissions {
		if string(perm) != expected[i] {
			t.Errorf("expected permission %s, got %s", expected[i], perm)
		}
	}
}
