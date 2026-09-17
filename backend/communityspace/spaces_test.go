package communityspace

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/anyproto/any-sync/util/crypto"
)

// fakeCreator records the keys and space types it is asked to create and hands
// back deterministic IDs, so the orchestration can be tested without a live
// any-sync network.
type fakeCreator struct {
	signingKey crypto.PrivKey
	created    []createCall
	shareable  []string
	failType   string          // spaceType that CreateSpaceWithKeys should fail on
	existing   map[string]bool // space IDs the network still holds (for SpaceExists)
}

type createCall struct {
	ownerAID  string
	spaceType string
	keys      *SpaceKeySet
}

func newFakeCreator(t *testing.T) *fakeCreator {
	t.Helper()
	sk, _, err := crypto.GenerateRandomEd25519KeyPair()
	if err != nil {
		t.Fatal(err)
	}
	return &fakeCreator{signingKey: sk, existing: map[string]bool{}}
}

func (f *fakeCreator) GetSigningKey() crypto.PrivKey { return f.signingKey }

func (f *fakeCreator) CreateSpaceWithKeys(_ context.Context, ownerAID, spaceType string, keys *SpaceKeySet) (*SpaceCreateResult, error) {
	if f.failType != "" && spaceType == f.failType {
		return nil, errors.New("boom")
	}
	f.created = append(f.created, createCall{ownerAID: ownerAID, spaceType: spaceType, keys: keys})
	id := spaceType + "-id"
	f.existing[id] = true // a created space is reachable on the network thereafter
	return &SpaceCreateResult{
		SpaceID:   id,
		OwnerAID:  ownerAID,
		SpaceType: spaceType,
		CreatedAt: time.Now(),
		Keys:      keys,
	}, nil
}

func (f *fakeCreator) MakeSpaceShareable(_ context.Context, spaceID string) error {
	f.shareable = append(f.shareable, spaceID)
	return nil
}

// SpaceExists implements the optional spaceVerifier capability: a space that was
// created (and not since removed from f.existing) is still reachable.
func (f *fakeCreator) SpaceExists(_ context.Context, spaceID string) bool {
	return spaceID != "" && f.existing[spaceID]
}

func TestCreateCommunitySpaces_CreatesThreeAtRightIndexes(t *testing.T) {
	f := newFakeCreator(t)
	spaces, err := CreateCommunitySpaces(context.Background(), f, fixedMnemonic, "EORG")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if spaces.CommunitySpaceID != "community-id" ||
		spaces.CommunityReadOnlySpaceID != "community-readonly-id" ||
		spaces.AdminSpaceID != "admin-id" {
		t.Fatalf("unexpected IDs: %+v", spaces)
	}

	if len(f.created) != 3 {
		t.Fatalf("expected 3 spaces created, got %d", len(f.created))
	}
	if len(f.shareable) != 3 {
		t.Errorf("expected all 3 spaces made shareable, got %d", len(f.shareable))
	}

	// Every space's ACL owner must be the account signing key.
	accountKey := f.signingKey.GetPublic().PeerId()
	for _, c := range f.created {
		if c.keys.SigningKey.GetPublic().PeerId() != accountKey {
			t.Errorf("space %s not owned by account key", c.spaceType)
		}
		if c.ownerAID != "EORG" {
			t.Errorf("space %s owner AID = %q, want EORG", c.spaceType, c.ownerAID)
		}
	}

	// The master keys must be the ones derived at indexes 1/2/3 (proving the
	// convention indexes are wired to the right space types).
	wantMasters := map[string]uint32{
		SpaceTypeCommunity:         CommunitySpaceIndex,
		SpaceTypeCommunityReadOnly: CommunityReadOnlySpaceIndex,
		SpaceTypeAdmin:             AdminSpaceIndex,
	}
	for _, c := range f.created {
		want, err := DeriveSpaceKeySet(fixedMnemonic, wantMasters[c.spaceType])
		if err != nil {
			t.Fatal(err)
		}
		if c.keys.MasterKey.GetPublic().PeerId() != want.MasterKey.GetPublic().PeerId() {
			t.Errorf("space %s derived from wrong index", c.spaceType)
		}
	}
}

// TestCreateCommunitySpaces_ReusesExistingSpaces is the issue #539 guard: a
// second run with the previously-known IDs must reuse every still-reachable
// space rather than minting fresh CIDs and overwriting the working IDs.
func TestCreateCommunitySpaces_ReusesExistingSpaces(t *testing.T) {
	f := newFakeCreator(t)

	first, err := CreateCommunitySpaces(context.Background(), f, fixedMnemonic, "EORG")
	if err != nil {
		t.Fatalf("first run: %v", err)
	}
	if len(f.created) != 3 {
		t.Fatalf("first run: expected 3 spaces created, got %d", len(f.created))
	}

	second, err := CreateCommunitySpaces(context.Background(), f, fixedMnemonic, "EORG", first)
	if err != nil {
		t.Fatalf("second run: %v", err)
	}

	// Same read-only space ID both times — the core acceptance criterion.
	if second.CommunityReadOnlySpaceID != first.CommunityReadOnlySpaceID {
		t.Errorf("read-only ID changed on re-run: %q -> %q",
			first.CommunityReadOnlySpaceID, second.CommunityReadOnlySpaceID)
	}
	if second.CommunitySpaceID != first.CommunitySpaceID || second.AdminSpaceID != first.AdminSpaceID {
		t.Errorf("space IDs changed on re-run: %+v -> %+v", first, second)
	}
	// Nothing was recreated: no additional CreateSpaceWithKeys calls.
	if len(f.created) != 3 {
		t.Errorf("re-run recreated spaces: expected 3 total creates, got %d", len(f.created))
	}
}

// TestCreateCommunitySpaces_RecreatesUnreachableSpace covers the mixed case
// (issue #539): the community space still resolves but the read-only space is
// gone. The community space is reused; only the read-only space is recreated.
func TestCreateCommunitySpaces_RecreatesUnreachableSpace(t *testing.T) {
	f := newFakeCreator(t)

	first, err := CreateCommunitySpaces(context.Background(), f, fixedMnemonic, "EORG")
	if err != nil {
		t.Fatalf("first run: %v", err)
	}

	// The read-only space vanishes from the network (phantom / never propagated).
	delete(f.existing, first.CommunityReadOnlySpaceID)

	second, err := CreateCommunitySpaces(context.Background(), f, fixedMnemonic, "EORG", first)
	if err != nil {
		t.Fatalf("second run: %v", err)
	}
	// Community + admin reused, read-only recreated → exactly one extra create.
	if len(f.created) != 4 {
		t.Errorf("expected 4 total creates (RO recreated), got %d", len(f.created))
	}
	if second.CommunitySpaceID != first.CommunitySpaceID {
		t.Errorf("community space should be reused, got %q -> %q", first.CommunitySpaceID, second.CommunitySpaceID)
	}
	if second.CommunityReadOnlySpaceID == "" {
		t.Error("read-only space should have been recreated")
	}
}

// TestCreateCommunitySpaces_UnknownExistingIDsAreRecreated: passing IDs that no
// longer resolve on the network recreates all spaces (no blind reuse).
func TestCreateCommunitySpaces_UnknownExistingIDsAreRecreated(t *testing.T) {
	f := newFakeCreator(t)
	stale := &CommunitySpaces{
		CommunitySpaceID:         "stale-community",
		CommunityReadOnlySpaceID: "stale-readonly",
		AdminSpaceID:             "stale-admin",
	}
	spaces, err := CreateCommunitySpaces(context.Background(), f, fixedMnemonic, "EORG", stale)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(f.created) != 3 {
		t.Errorf("expected all 3 spaces recreated, got %d creates", len(f.created))
	}
	if spaces.CommunityReadOnlySpaceID != "community-readonly-id" {
		t.Errorf("expected fresh read-only ID, got %q", spaces.CommunityReadOnlySpaceID)
	}
}

func TestCreateCommunitySpaces_Validation(t *testing.T) {
	f := newFakeCreator(t)
	if _, err := CreateCommunitySpaces(context.Background(), nil, fixedMnemonic, "EORG"); err == nil {
		t.Error("expected error for nil creator")
	}
	if _, err := CreateCommunitySpaces(context.Background(), f, "", "EORG"); err == nil {
		t.Error("expected error for empty mnemonic")
	}
	if _, err := CreateCommunitySpaces(context.Background(), f, "bogus words", "EORG"); err == nil {
		t.Error("expected error for invalid mnemonic")
	}
}

func TestCreateCommunitySpaces_CommunityFailureIsFatal(t *testing.T) {
	f := newFakeCreator(t)
	f.failType = SpaceTypeCommunity
	spaces, err := CreateCommunitySpaces(context.Background(), f, fixedMnemonic, "EORG")
	if err == nil {
		t.Fatal("expected error when community space fails")
	}
	if spaces.CommunitySpaceID != "" {
		t.Errorf("expected empty community ID on failure, got %q", spaces.CommunitySpaceID)
	}
}

func TestCreateCommunitySpaces_ReadOnlyFailureReturnsPartial(t *testing.T) {
	f := newFakeCreator(t)
	f.failType = SpaceTypeCommunityReadOnly
	spaces, err := CreateCommunitySpaces(context.Background(), f, fixedMnemonic, "EORG")
	if err == nil {
		t.Fatal("expected error when read-only space fails")
	}
	// The community space still succeeded — the caller can inspect the partial.
	if spaces.CommunitySpaceID != "community-id" {
		t.Errorf("expected community ID retained on partial failure, got %q", spaces.CommunitySpaceID)
	}
	if spaces.AdminSpaceID != "" {
		t.Errorf("expected admin space not attempted, got %q", spaces.AdminSpaceID)
	}
}
