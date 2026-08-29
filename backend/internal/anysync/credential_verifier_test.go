package anysync

import (
	"testing"

	"github.com/matou-dao/backend/internal/contributions"
)

func hasRole(roles []contributions.Role, want contributions.Role) bool {
	for _, r := range roles {
		if r == want {
			return true
		}
	}
	return false
}

func TestSnapshotCredentialVerifier_UnrevokedRoles(t *testing.T) {
	v := NewSnapshotCredentialVerifier()
	v.Set("E-steward", CredentialRecord{Role: "Operations Steward", IssuedAt: 100})

	roles, ok, _ := v.UnrevokedRoles("E-steward", 200)
	if !ok {
		t.Fatal("a known AID must resolve ok=true")
	}
	if !hasRole(roles, contributions.RoleOperationsSteward) {
		t.Fatalf("expected operations-steward role, got %v", roles)
	}
}

// A credential revoked as of the change timestamp contributes no role — even if
// it was valid earlier — so a lagging profile role cannot rescue it (#112 AC).
func TestSnapshotCredentialVerifier_RevokedContributesNoRole(t *testing.T) {
	v := NewSnapshotCredentialVerifier()
	v.Set("E-steward", CredentialRecord{Role: "Operations Steward", IssuedAt: 100, RevokedAt: 150})

	// Before revocation: still granted.
	if roles, _, _ := v.UnrevokedRoles("E-steward", 120); !hasRole(roles, contributions.RoleOperationsSteward) {
		t.Fatalf("credential valid before revocation must grant its role, got %v", roles)
	}

	// At/after revocation: no role, ok=true (resolved), reason names revocation.
	roles, ok, reason := v.UnrevokedRoles("E-steward", 150)
	if !ok {
		t.Fatal("a revoked credential still resolves (ok=true) — it just grants nothing")
	}
	if len(roles) != 0 {
		t.Fatalf("a revoked credential must grant no role, got %v", roles)
	}
	if reason == "" {
		t.Error("expected a reason explaining the revocation")
	}
}

func TestSnapshotCredentialVerifier_UnknownAIDFailsClosed(t *testing.T) {
	v := NewSnapshotCredentialVerifier()
	if _, ok, _ := v.UnrevokedRoles("E-nobody", 100); ok {
		t.Fatal("an AID with no credential record must resolve ok=false (fail-closed)")
	}
}

func TestSnapshotCredentialVerifier_NotYetIssued(t *testing.T) {
	v := NewSnapshotCredentialVerifier()
	v.Set("E-steward", CredentialRecord{Role: "Operations Steward", IssuedAt: 100})
	if roles, _, _ := v.UnrevokedRoles("E-steward", 50); len(roles) != 0 {
		t.Fatalf("a credential dated after the change must not grant a role, got %v", roles)
	}
}
