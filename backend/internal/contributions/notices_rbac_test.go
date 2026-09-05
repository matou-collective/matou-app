package contributions

import "testing"

// The notice-board capabilities wire to their actions (#317): post_notices →
// post_notice (authoring: create/publish), manage_notices → manage_notice
// (moderation: pin/archive).
func TestNoticeCapabilityActionMapping(t *testing.T) {
	if capID, ok := ActionCapability(ActionPostNotice); !ok || capID != CapPostNotices {
		t.Errorf("post_notice → %q (ok=%v), want post_notices", capID, ok)
	}
	if capID, ok := ActionCapability(ActionManageNotice); !ok || capID != CapManageNotices {
		t.Errorf("manage_notice → %q (ok=%v), want manage_notices", capID, ok)
	}
}

// The default policy grants post_notices to every community member role and
// manage_notices to stewards + founder only. Project-only roles never hold a
// community-scoped notice capability on their own.
func TestDefaultPolicyNoticeGrants(t *testing.T) {
	p := DefaultRolePolicy()

	cases := []struct {
		keriRole  string
		canPost   bool
		canManage bool
	}{
		{"Member", true, false},
		{"Community Steward", true, true},
		{"Operations Steward", true, true},
		{"Founding Member", true, true},
	}
	for _, c := range cases {
		bundle := MapKERIRole(c.keriRole)
		if got := CanPerformActionWithPolicy(p, bundle, ActionPostNotice); got != c.canPost {
			t.Errorf("%s post_notice = %v, want %v", c.keriRole, got, c.canPost)
		}
		if got := CanPerformActionWithPolicy(p, bundle, ActionManageNotice); got != c.canManage {
			t.Errorf("%s manage_notice = %v, want %v", c.keriRole, got, c.canManage)
		}
	}

	// A bare project role (no community member role) holds neither capability:
	// both are community-scoped.
	projectOnly := []Role{RoleContributor}
	if CanPerformActionWithPolicy(p, projectOnly, ActionPostNotice) {
		t.Error("a bare contributor role must not hold post_notices")
	}
	if CanPerformActionWithPolicy(p, projectOnly, ActionManageNotice) {
		t.Error("a bare contributor role must not hold manage_notices")
	}
}
