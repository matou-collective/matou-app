package app

import (
	"context"
	"testing"

	"github.com/matou-dao/backend/internal/anysync"
	"github.com/matou-dao/backend/internal/auth"
	"github.com/matou-dao/backend/internal/identity"
)

// fakeACLSource / fakeTreeSource / fakeKeyResolver stand in for the any-sync
// managers and KERIA key-state resolver so the refresher can be exercised
// without live infrastructure. Each keys its result on the space ID it is asked
// for, so a refresher that resolves the wrong (empty) space ID collects nothing.
type fakeACLSource struct {
	bySpace map[string]map[string]string // spaceID -> (account -> AID)
}

func (f fakeACLSource) AccountAIDMap(_ context.Context, spaceID string) (map[string]string, error) {
	return f.bySpace[spaceID], nil
}

type fakeTreeSource struct {
	histories   map[string]map[string][]anysync.RoleAt          // roSpaceID -> aid -> history
	assignments map[string]map[string]anysync.ProjectAssignment // communitySpaceID -> projectID -> assignment
}

func (f fakeTreeSource) CollectRoleHistories(_ context.Context, spaceID string) (map[string][]anysync.RoleAt, error) {
	return f.histories[spaceID], nil
}

func (f fakeTreeSource) CollectProjectAssignments(_ context.Context, spaceID string) (map[string]anysync.ProjectAssignment, error) {
	return f.assignments[spaceID], nil
}

type fakeKeyResolver struct {
	keys map[string][]string // aid -> current signing keys
}

func (f fakeKeyResolver) CurrentKeys(_ context.Context, aid string) ([]string, error) {
	return f.keys[aid], nil
}

// TestWriteRuleRefresherRunsAfterIdentitySetPostBoot is the regression for #522:
// a backend that boots before its identity exists must still populate the
// write-rule role / project / signing-key snapshots once the identity is set
// after boot (via the same UserIdentity setters POST /api/v1/identity/set uses),
// without a process restart. Before the fix the refresher captured the empty
// boot-time space IDs and returned silently forever, so every other member's
// proof-gated sign-off was rejected with "signer key state unavailable".
func TestWriteRuleRefresherRunsAfterIdentitySetPostBoot(t *testing.T) {
	const (
		communitySpaceID = "space.community.abc"
		roSpaceID        = "space.readonly.abc"
		account          = "account-1"
		memberAID        = "did:aid:member1"
		projectID        = "proj-1"
	)

	acl := fakeACLSource{bySpace: map[string]map[string]string{
		communitySpaceID: {account: memberAID},
	}}
	trees := fakeTreeSource{
		histories: map[string]map[string][]anysync.RoleAt{
			roSpaceID: {memberAID: {{Since: 0, Role: "Contributor"}}},
		},
		assignments: map[string]map[string]anysync.ProjectAssignment{
			communitySpaceID: {projectID: {Contributors: map[string]bool{memberAID: true}}},
		},
	}
	keyResolver := fakeKeyResolver{keys: map[string][]string{
		memberAID: {"DKey_member1"},
	}}

	roles := anysync.NewHistoryRoleResolver()
	projects := anysync.NewProjectAssignmentStore()
	keys := anysync.NewStaticKeyProvider()

	// The backend boots before an identity exists.
	userIdentity := identity.New(t.TempDir())

	refresher := &writeRuleRefresher{
		communitySpaceID: func() string { return userIdentity.GetCommunitySpaceID() },
		readOnlySpaceID:  userIdentity.GetCommunityReadOnlySpaceID,
		adminAIDs:        func() map[string]bool { return map[string]bool{} },
		acl:              acl,
		trees:            trees,
		roles:            roles,
		projects:         projects,
		keys:             keys,
		keyStateResolver: keyResolver,
		enforceProofs:    true,
	}

	ctx := context.Background()

	// Pre-identity: the refresher must bail (space IDs empty) and populate nothing.
	refresher.run(ctx)
	if _, ok := roles.AIDForAuthor(account); ok {
		t.Fatal("role snapshot populated before identity was set")
	}
	if _, ok := keys.SigningKeys(memberAID); ok {
		t.Fatal("signing-key snapshot populated before identity was set")
	}

	// Identity is set after boot, exactly as HandleSetIdentity does it.
	if err := userIdentity.SetIdentity(memberAID, "test mnemonic"); err != nil {
		t.Fatalf("SetIdentity: %v", err)
	}
	if err := userIdentity.SetOrgConfig("did:aid:org", communitySpaceID); err != nil {
		t.Fatalf("SetOrgConfig: %v", err)
	}
	if err := userIdentity.SetCommunityReadOnlySpaceID(roSpaceID); err != nil {
		t.Fatalf("SetCommunityReadOnlySpaceID: %v", err)
	}

	// The next refresh tick must now resolve the live IDs and fill every snapshot.
	refresher.run(ctx)

	gotAID, ok := roles.AIDForAuthor(account)
	if !ok || gotAID != memberAID {
		t.Fatalf("role snapshot not populated after identity-set: got (%q, %v)", gotAID, ok)
	}
	if roleList, ok := roles.RolesForAIDAt(memberAID, 1); !ok || len(roleList) == 0 {
		t.Fatalf("role history not populated after identity-set: got (%v, %v)", roleList, ok)
	}
	gotKeys, ok := keys.SigningKeys(memberAID)
	if !ok || len(gotKeys) == 0 {
		t.Fatalf("signing-key snapshot not populated after identity-set: got (%v, %v)", gotKeys, ok)
	}
	if projRoles, ok := projects.ProjectRolesForAID(projectID, memberAID); !ok || len(projRoles) == 0 {
		t.Fatalf("project-assignment snapshot not populated after identity-set: got (%v, %v)", projRoles, ok)
	}
}

// TestWriteRuleRefresherIdentityAtBootUnchanged asserts the pre-existing path —
// a backend that already has an identity at boot — still populates on the first
// run, so the #522 fix does not regress the common case.
func TestWriteRuleRefresherIdentityAtBootUnchanged(t *testing.T) {
	const (
		communitySpaceID = "space.community.xyz"
		roSpaceID        = "space.readonly.xyz"
		account          = "account-2"
		memberAID        = "did:aid:member2"
	)

	userIdentity := identity.New(t.TempDir())
	// Identity already present at boot.
	if err := userIdentity.SetOrgConfig("did:aid:org", communitySpaceID); err != nil {
		t.Fatalf("SetOrgConfig: %v", err)
	}
	if err := userIdentity.SetCommunityReadOnlySpaceID(roSpaceID); err != nil {
		t.Fatalf("SetCommunityReadOnlySpaceID: %v", err)
	}

	roles := anysync.NewHistoryRoleResolver()
	refresher := &writeRuleRefresher{
		communitySpaceID: func() string { return userIdentity.GetCommunitySpaceID() },
		readOnlySpaceID:  userIdentity.GetCommunityReadOnlySpaceID,
		adminAIDs:        func() map[string]bool { return map[string]bool{} },
		acl: fakeACLSource{bySpace: map[string]map[string]string{
			communitySpaceID: {account: memberAID},
		}},
		trees: fakeTreeSource{histories: map[string]map[string][]anysync.RoleAt{
			roSpaceID: {memberAID: {{Since: 0, Role: "Contributor"}}},
		}},
		roles:         roles,
		projects:      anysync.NewProjectAssignmentStore(),
		keys:          anysync.NewStaticKeyProvider(),
		enforceProofs: false, // proof enforcement off (the default)
	}

	refresher.run(context.Background())

	if gotAID, ok := roles.AIDForAuthor(account); !ok || gotAID != memberAID {
		t.Fatalf("role snapshot not populated for identity-at-boot: got (%q, %v)", gotAID, ok)
	}
}

// Compile-time check that the fake satisfies the resolver interface the
// refresher holds (documents the seam production wires keyStateResolver into).
var _ auth.KeyStateResolver = fakeKeyResolver{}
