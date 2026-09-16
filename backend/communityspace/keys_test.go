package communityspace

import "testing"

// fixedMnemonic is the standard BIP39 all-"abandon" test vector.
const fixedMnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"

// goldenDerivation pins the deterministic public identities the community's
// three spaces derive at indexes 1, 2 and 3, plus the account (index-0) key that
// owns them. These values were captured from the in-tree implementation BEFORE
// this convention was extracted into its own module (issue #530). The test
// proves the extraction did not change the derivation by a single bit: any drift
// here would move where every device holding the mnemonic looks for its spaces.
var goldenDerivation = map[uint32]struct{ sign, master, meta string }{
	CommunitySpaceIndex: {
		sign:   "12D3KooWF4h6khXLZ37QwhKfDadv83NatPXYD6t63uypiK5vNp7r",
		master: "12D3KooWQhMk5kgsa7U8is7Zo5CPJMwEojZyJZhCYtjWZe47LzSu",
		meta:   "12D3KooWFy2NL1kNT8aaddULU9bvbQiHL4M5TZhitYF46agyhy6m",
	},
	CommunityReadOnlySpaceIndex: {
		sign:   "12D3KooWK4CQhaAV1BpCT5EvCE79zw2BT9kGrmVY9sK6txEfg5oB",
		master: "12D3KooWRQk6eKGQw3EZQbMxp9KvB6adbbPEVbFkW3dYZdEwDLd8",
		meta:   "12D3KooWN5tFjkj6JZbZfG9uD3LGic3heZDpmTchPQ4sgWKDBXfP",
	},
	AdminSpaceIndex: {
		sign:   "12D3KooWLdxayEGR4mtdEGL71N5kfVjsgsBz41V4LVMPpFPFoC2A",
		master: "12D3KooWFybZdoLXmMxFTh4xfnEUdF9DGq6wVu3ugFHnbTa8mVb2",
		meta:   "12D3KooWDSSMaaybnbkAjU9SmnNJV3AXdheBdEL6UBkGqevbNobh",
	},
}

const goldenAccountSignKey = "12D3KooWFVxctQK77QS2iv2WQzSCibE1sCayHKLqfu1nxnYrGbdF"

// TestDeriveSpaceKeySet_PinsIndexes1To3 asserts the community, read-only and
// admin spaces derive the exact same signing / master / metadata identities as
// before the extraction, for a fixed mnemonic.
func TestDeriveSpaceKeySet_PinsIndexes1To3(t *testing.T) {
	for _, idx := range []uint32{CommunitySpaceIndex, CommunityReadOnlySpaceIndex, AdminSpaceIndex} {
		keys, err := DeriveSpaceKeySet(fixedMnemonic, idx)
		if err != nil {
			t.Fatalf("index %d: %v", idx, err)
		}
		want := goldenDerivation[idx]
		if got := keys.SigningKey.GetPublic().PeerId(); got != want.sign {
			t.Errorf("index %d signing key drifted: got %s want %s", idx, got, want.sign)
		}
		if got := keys.MasterKey.GetPublic().PeerId(); got != want.master {
			t.Errorf("index %d master key drifted: got %s want %s", idx, got, want.master)
		}
		if got := keys.MetadataKey.GetPublic().PeerId(); got != want.meta {
			t.Errorf("index %d metadata key drifted: got %s want %s", idx, got, want.meta)
		}
	}
}

// TestDeriveKeyFromMnemonic_PinsAccountKey pins the index-0 account key that
// becomes the ACL owner of all three community spaces.
func TestDeriveKeyFromMnemonic_PinsAccountKey(t *testing.T) {
	key, err := DeriveKeyFromMnemonic(fixedMnemonic, 0)
	if err != nil {
		t.Fatal(err)
	}
	if got := key.GetPublic().PeerId(); got != goldenAccountSignKey {
		t.Errorf("account (index-0) key drifted: got %s want %s", got, goldenAccountSignKey)
	}
}

// TestDeriveSpaceKeySet_Deterministic confirms the derived (non-read) keys are
// stable across calls while the read key stays random.
func TestDeriveSpaceKeySet_Deterministic(t *testing.T) {
	a, err := DeriveSpaceKeySet(fixedMnemonic, CommunitySpaceIndex)
	if err != nil {
		t.Fatal(err)
	}
	b, err := DeriveSpaceKeySet(fixedMnemonic, CommunitySpaceIndex)
	if err != nil {
		t.Fatal(err)
	}
	if a.SigningKey.GetPublic().PeerId() != b.SigningKey.GetPublic().PeerId() {
		t.Error("signing key should be deterministic")
	}
	if a.MasterKey.GetPublic().PeerId() != b.MasterKey.GetPublic().PeerId() {
		t.Error("master key should be deterministic")
	}
	if a.MetadataKey.GetPublic().PeerId() != b.MetadataKey.GetPublic().PeerId() {
		t.Error("metadata key should be deterministic")
	}
	if a.ReadKey.Equals(b.ReadKey) {
		t.Error("read key should be random per derivation")
	}
}

func TestValidateMnemonic(t *testing.T) {
	if err := ValidateMnemonic(fixedMnemonic); err != nil {
		t.Errorf("valid mnemonic rejected: %v", err)
	}
	if err := ValidateMnemonic("not a valid mnemonic at all"); err == nil {
		t.Error("expected invalid mnemonic to be rejected")
	}
}
