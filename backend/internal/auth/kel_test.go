package auth

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

// testAID / foreignAID are syntactically valid 44-char AIDs.
const (
	testAID    = "EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	foreignAID = "EWITNESSWITNESSWITNESSWITNESSWITNESSWITNESSW"
)

type kelEvt struct {
	V  string   `json:"v"`
	T  string   `json:"t"`
	I  string   `json:"i"`
	S  string   `json:"s"`
	KT string   `json:"kt,omitempty"`
	K  []string `json:"k"`
}

// makeEvent builds a self-framed KERI JSON event for testAID whose version
// string encodes its exact byte length (fixed-width 6-hex size, so re-encoding
// preserves size).
func makeEvent(t *testing.T, typ, seqHex string, keys []string) []byte {
	t.Helper()
	return makeEventFor(t, testAID, typ, seqHex, "", keys)
}

func makeEventFor(t *testing.T, aid, typ, seqHex, kt string, keys []string) []byte {
	t.Helper()
	ev := kelEvt{V: "KERI10JSON000000_", T: typ, I: aid, S: seqHex, KT: kt, K: keys}
	b, err := json.Marshal(ev)
	if err != nil {
		t.Fatal(err)
	}
	ev.V = fmt.Sprintf("KERI10JSON%06x_", len(b))
	b, err = json.Marshal(ev)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestExtractCurrentKeysPicksLatestEstablishment(t *testing.T) {
	icp := makeEvent(t, "icp", "0", []string{"Dkey0"})
	// An interaction event (ixn) has no keys and must be ignored.
	ixn := makeEvent(t, "ixn", "1", nil)
	rot := makeEvent(t, "rot", "2", []string{"Dkey2a", "Dkey2b"})

	// Interleave with CESR-like attachment noise between events.
	stream := append([]byte{}, icp...)
	stream = append(stream, []byte("-AABAAsomeattachedsig")...)
	stream = append(stream, ixn...)
	stream = append(stream, rot...)
	stream = append(stream, []byte("-AABAAanothersig")...)

	keys, err := ExtractCurrentKeys(stream, testAID)
	if err != nil {
		t.Fatalf("ExtractCurrentKeys: %v", err)
	}
	if len(keys) != 2 || keys[0] != "Dkey2a" || keys[1] != "Dkey2b" {
		t.Fatalf("expected latest rotation keys, got %v", keys)
	}
}

func TestExtractCurrentKeysSingleInception(t *testing.T) {
	icp := makeEvent(t, "icp", "0", []string{"DsingleKey"})
	keys, err := ExtractCurrentKeys(icp, testAID)
	if err != nil {
		t.Fatalf("ExtractCurrentKeys: %v", err)
	}
	if len(keys) != 1 || keys[0] != "DsingleKey" {
		t.Fatalf("expected inception key, got %v", keys)
	}
}

func TestExtractCurrentKeysNoEstablishment(t *testing.T) {
	if _, err := ExtractCurrentKeys([]byte("no kel here"), testAID); err == nil {
		t.Fatal("expected error when no establishment event present")
	}
}

// An OOBI response carries the witness's (or agent's) own KEL alongside the
// controller's. A foreign establishment event with a HIGHER sequence number
// must never be taken as the requested AID's key state.
func TestExtractCurrentKeysBindsToRequestedAID(t *testing.T) {
	user := makeEvent(t, "icp", "0", []string{"DuserKey"})
	witnessIcp := makeEventFor(t, foreignAID, "icp", "0", "", []string{"BwitnessKey0"})
	witnessRot := makeEventFor(t, foreignAID, "rot", "7", "", []string{"BwitnessKey7"})

	stream := append([]byte{}, witnessIcp...)
	stream = append(stream, witnessRot...)
	stream = append(stream, user...)
	stream = append(stream, witnessRot...) // again, after the user's

	keys, err := ExtractCurrentKeys(stream, testAID)
	if err != nil {
		t.Fatalf("ExtractCurrentKeys: %v", err)
	}
	if len(keys) != 1 || keys[0] != "DuserKey" {
		t.Fatalf("expected the user's key, got %v (witness key leaked)", keys)
	}

	// Asking for the witness must give the witness's latest key, not the user's.
	keys, err = ExtractCurrentKeys(stream, foreignAID)
	if err != nil {
		t.Fatalf("ExtractCurrentKeys(witness): %v", err)
	}
	if len(keys) != 1 || keys[0] != "BwitnessKey7" {
		t.Fatalf("expected witness rot key, got %v", keys)
	}

	// A stream with only foreign KELs yields no key state for the user.
	if _, err := ExtractCurrentKeys(append(witnessIcp, witnessRot...), testAID); err == nil {
		t.Fatal("expected error: no establishment event for the requested AID")
	}
}

func TestExtractKeyStateThreshold(t *testing.T) {
	single := makeEventFor(t, testAID, "icp", "0", "1", []string{"Dk"})
	ks, err := ExtractKeyState(single, testAID)
	if err != nil {
		t.Fatal(err)
	}
	if !ks.SingleKey() {
		t.Fatalf("kt=1 single key should be SingleKey, got %+v", ks)
	}

	multi := makeEventFor(t, testAID, "icp", "0", "2", []string{"Dk1", "Dk2", "Dk3"})
	ks, err = ExtractKeyState(multi, testAID)
	if err != nil {
		t.Fatal(err)
	}
	if ks.SingleKey() {
		t.Fatalf("multisig group must not be SingleKey: %+v", ks)
	}

	// Weighted threshold (list form) on a single key is still refused.
	weighted := frameJSON(`{"v":"KERI10JSON000000_","t":"icp","i":"` + testAID + `","s":"0","kt":["1/2","1/2"],"k":["Dk"]}`)
	ks, err = ExtractKeyState(weighted, testAID)
	if err != nil {
		t.Fatal(err)
	}
	if ks.SingleKey() {
		t.Fatalf("weighted threshold must not be SingleKey: %+v", ks)
	}
}

// frameJSON rewrites the version-string size field of a raw KERI JSON event
// so it self-frames correctly (the placeholder must be "KERI10JSON000000_").
func frameJSON(raw string) []byte {
	return []byte(strings.Replace(raw, "KERI10JSON000000_", fmt.Sprintf("KERI10JSON%06x_", len(raw)), 1))
}
