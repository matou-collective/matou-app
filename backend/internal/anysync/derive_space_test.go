package anysync

import (
	"strconv"
	"strings"
	"testing"

	"github.com/anyproto/any-sync/commonspace/spacepayloads"
)

const otherTestMnemonic = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong"

// TestSpaceDerivePayload_IDStableAcrossKeySets pins #506 defect C / #508: the
// private space must live at an id that every device holding the mnemonic can
// recompute. DeriveSpaceKeySet draws a fresh random read key on every call, so
// two key sets from the same mnemonic differ — the derive payload must depend
// only on the mnemonic-derived signing + master keys and the owner AID, never
// on the read key, or claim / recovery / link disagree about where the private
// space is.
func TestSpaceDerivePayload_IDStableAcrossKeySets(t *testing.T) {
	const aid = "EAid_test_owner"

	keysA, err := DeriveSpaceKeySet(testMnemonic, 0)
	if err != nil {
		t.Fatal(err)
	}
	keysB, err := DeriveSpaceKeySet(testMnemonic, 0)
	if err != nil {
		t.Fatal(err)
	}
	if keysA.ReadKey.Equals(keysB.ReadKey) {
		t.Fatal("precondition: two DeriveSpaceKeySet calls should draw different read keys")
	}

	storeA, err := spacepayloads.StoragePayloadForSpaceDerive(spaceDerivePayload(aid, keysA))
	if err != nil {
		t.Fatal(err)
	}
	storeB, err := spacepayloads.StoragePayloadForSpaceDerive(spaceDerivePayload(aid, keysB))
	if err != nil {
		t.Fatal(err)
	}

	if got, want := storeA.SpaceHeaderWithId.Id, storeB.SpaceHeaderWithId.Id; got != want {
		t.Errorf("derived space id must not depend on the random read key: %s vs %s", got, want)
	}
	// A device that derives locally while a peer already holds the space must
	// converge with it, so the ACL root and settings root must be byte-identical
	// too — not just the header.
	if storeA.AclWithId.Id != storeB.AclWithId.Id {
		t.Errorf("derived ACL root must be deterministic: %s vs %s", storeA.AclWithId.Id, storeB.AclWithId.Id)
	}
	if storeA.SpaceSettingsWithId.Id != storeB.SpaceSettingsWithId.Id {
		t.Errorf("derived settings root must be deterministic: %s vs %s", storeA.SpaceSettingsWithId.Id, storeB.SpaceSettingsWithId.Id)
	}

	// And it must still be per-identity: a different mnemonic or a different
	// owner AID lands somewhere else.
	keysC, err := DeriveSpaceKeySet(otherTestMnemonic, 0)
	if err != nil {
		t.Fatal(err)
	}
	storeC, err := spacepayloads.StoragePayloadForSpaceDerive(spaceDerivePayload(aid, keysC))
	if err != nil {
		t.Fatal(err)
	}
	if storeC.SpaceHeaderWithId.Id == storeA.SpaceHeaderWithId.Id {
		t.Error("a different mnemonic must derive a different private space id")
	}
	storeD, err := spacepayloads.StoragePayloadForSpaceDerive(spaceDerivePayload("EAid_someone_else", keysA))
	if err != nil {
		t.Fatal(err)
	}
	if storeD.SpaceHeaderWithId.Id == storeA.SpaceHeaderWithId.Id {
		t.Error("a different owner AID must derive a different private space id")
	}
}

// TestSpaceDerivePayload_MatchesCreateReplicationKey pins that a derived
// private space is held by the same tree node as a CreateSpaceWithKeys space
// for the same signing key: any-sync's derive path computes the replication
// key from the signing public key exactly as ComputeReplicationKey does.
func TestSpaceDerivePayload_MatchesCreateReplicationKey(t *testing.T) {
	keys, err := DeriveSpaceKeySet(testMnemonic, 0)
	if err != nil {
		t.Fatal(err)
	}
	repKey, err := ComputeReplicationKey(keys.SigningKey)
	if err != nil {
		t.Fatal(err)
	}
	store, err := spacepayloads.StoragePayloadForSpaceDerive(spaceDerivePayload("EAid", keys))
	if err != nil {
		t.Fatal(err)
	}
	if want := "." + strconv.FormatUint(repKey, 36); !strings.HasSuffix(store.SpaceHeaderWithId.Id, want) {
		t.Errorf("derived id %s must carry replication-key suffix %s", store.SpaceHeaderWithId.Id, want)
	}
}

// TestDeriveSpaceKeySet_SigningKeyIsAccountKey pins the invariant that a
// derived private space at index 0 signs with exactly the mnemonic-derived
// account key (DeriveKeyFromMnemonic(m, 0)). any-sync only derives the owner
// read key for a derived ACL root when AclState.pubKey.Equals(root.Identity)
// (aclstate applyRoot → saveKeysFromRoot → DeriveSymmetricKey(accountKey, ...)),
// so if this equality ever breaks — a non-zero peer KeyIndex, multi-account,
// or a change to DeriveSpaceKeySet's index arithmetic — every device would
// stop decrypting the private space with no other compiler or test signal.
// The private-space call sites (identity.go, spaces.go) override SigningKey to
// the client's signing key precisely because this must hold; this test fails
// loudly if the coincidence they rely on ever stops being true.
func TestDeriveSpaceKeySet_SigningKeyIsAccountKey(t *testing.T) {
	keys, err := DeriveSpaceKeySet(testMnemonic, 0)
	if err != nil {
		t.Fatal(err)
	}
	accountKey, err := DeriveKeyFromMnemonic(testMnemonic, 0)
	if err != nil {
		t.Fatal(err)
	}
	if !keys.SigningKey.GetPublic().Equals(accountKey.GetPublic()) {
		t.Fatal("DeriveSpaceKeySet(m, 0).SigningKey must equal DeriveKeyFromMnemonic(m, 0): " +
			"the derived private-space read key any-sync computes depends on this equality")
	}
}
