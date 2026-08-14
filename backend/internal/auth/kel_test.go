package auth

import (
	"encoding/json"
	"fmt"
	"testing"
)

type kelEvt struct {
	V string   `json:"v"`
	T string   `json:"t"`
	I string   `json:"i"`
	S string   `json:"s"`
	K []string `json:"k"`
}

// makeEvent builds a self-framed KERI JSON event whose version string encodes
// its exact byte length (fixed-width 6-hex size, so re-encoding preserves size).
func makeEvent(t *testing.T, typ, seqHex string, keys []string) []byte {
	t.Helper()
	ev := kelEvt{V: "KERI10JSON000000_", T: typ, I: "Etest", S: seqHex, K: keys}
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

	keys, err := ExtractCurrentKeys(stream)
	if err != nil {
		t.Fatalf("ExtractCurrentKeys: %v", err)
	}
	if len(keys) != 2 || keys[0] != "Dkey2a" || keys[1] != "Dkey2b" {
		t.Fatalf("expected latest rotation keys, got %v", keys)
	}
}

func TestExtractCurrentKeysSingleInception(t *testing.T) {
	icp := makeEvent(t, "icp", "0", []string{"DsingleKey"})
	keys, err := ExtractCurrentKeys(icp)
	if err != nil {
		t.Fatalf("ExtractCurrentKeys: %v", err)
	}
	if len(keys) != 1 || keys[0] != "DsingleKey" {
		t.Fatalf("expected inception key, got %v", keys)
	}
}

func TestExtractCurrentKeysNoEstablishment(t *testing.T) {
	if _, err := ExtractCurrentKeys([]byte("no kel here")); err == nil {
		t.Fatal("expected error when no establishment event present")
	}
}
