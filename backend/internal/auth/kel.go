package auth

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// establishmentEvent is the subset of a KERI event we need to find the current
// signing keys: the event type, controller prefix, sequence number, signing
// threshold and key list.
type establishmentEvent struct {
	Version   string          `json:"v"`
	Type      string          `json:"t"`
	Prefix    string          `json:"i"`
	Seq       string          `json:"s"`
	Threshold json.RawMessage `json:"kt"`
	Keys      []string        `json:"k"`
}

// KeyState is the current signing key state of an AID as read from its KEL.
type KeyState struct {
	// Keys are the qb64 signing keys of the latest establishment event.
	Keys []string
	// Threshold is the raw signing threshold ("kt") as it appears in that
	// event: a decimal/hex string for a simple threshold, or a JSON list for a
	// weighted (fractional) threshold. Empty when the event carried none.
	Threshold string
}

// SingleKey reports whether the key state is a plain single-key AID with a
// signing threshold of 1 — the only shape the login path accepts. Multi-key
// AIDs (multisig groups) are refused so a single member cannot mint a session
// for the group; supporting them needs threshold-aware verification.
func (ks KeyState) SingleKey() bool {
	if len(ks.Keys) != 1 {
		return false
	}
	switch ks.Threshold {
	case "", "1", `"1"`:
		return true
	default:
		return false
	}
}

// isEstablishment reports whether a KERI event type establishes key state
// (inception, rotation and their delegated variants).
func isEstablishment(t string) bool {
	switch t {
	case "icp", "rot", "dip", "drt":
		return true
	default:
		return false
	}
}

// ExtractCurrentKeys parses a CESR event stream (as returned by a KERIA/witness
// OOBI resolution) and returns the qb64 signing keys of aid's most recent
// establishment event. See ExtractKeyState.
func ExtractCurrentKeys(stream []byte, aid string) ([]string, error) {
	ks, err := ExtractKeyState(stream, aid)
	if err != nil {
		return nil, err
	}
	return ks.Keys, nil
}

// EstablishmentKeyState is the signing key state established at a specific KEL
// sequence number — one entry of an AID's key-state history walk.
type EstablishmentKeyState struct {
	// Seq is the KEL sequence number of the establishment event.
	Seq int64
	// Keys are the qb64 signing keys established at Seq.
	Keys []string
	// Threshold is the raw signing threshold ("kt") of that event (see
	// KeyState.Threshold).
	Threshold string
}

// ExtractKeyState parses a CESR event stream and returns the key state of aid's
// most recent establishment event. See ExtractKeyStates for the framing and
// prefix-binding rules; this returns the latest state.
func ExtractKeyState(stream []byte, aid string) (*KeyState, error) {
	states, err := ExtractKeyStates(stream, aid)
	if err != nil {
		return nil, err
	}
	latest := states[len(states)-1]
	return &KeyState{Keys: latest.Keys, Threshold: latest.Threshold}, nil
}

// ExtractKeyStateAt parses a CESR event stream and returns aid's key state as of
// KEL sequence number sn: the most recent establishment event whose sequence
// number is <= sn. This is the authoritative signing key state at that point in
// the log, so an action proof signed under sn stays verifiable against these
// keys even after a later legitimate rotation past sn (GH#19 part 3 / #112).
// Returns an error when no establishment event at or before sn exists for aid.
func ExtractKeyStateAt(stream []byte, aid string, sn int64) (*KeyState, error) {
	states, err := ExtractKeyStates(stream, aid)
	if err != nil {
		return nil, err
	}
	var best *EstablishmentKeyState
	for i := range states {
		if states[i].Seq > sn {
			break
		}
		best = &states[i]
	}
	if best == nil {
		return nil, fmt.Errorf("no establishment event at or before sn %d for %s", sn, aid)
	}
	return &KeyState{Keys: best.Keys, Threshold: best.Threshold}, nil
}

// ExtractKeyStates parses a CESR event stream and returns aid's establishment
// key-state history — one entry per KEL sequence number, sorted by sequence
// number ascending. The last entry is the current key state.
//
// Only events whose controller prefix ("i") equals aid are considered. OOBI
// responses routinely carry other KELs alongside the controller's (witnesses,
// delegators, the agent), so binding on "i" is what stops a foreign event with
// a higher sequence number from being taken as the user's key state. On a
// duplicate sequence number the later event in the stream wins (matching the
// former ">=" latest-wins rule).
//
// KERI JSON events are self-framing: the version string ("KERI10JSON0000fb_")
// encodes the exact byte length of the serialized event, so each event can be
// sliced out precisely regardless of the CESR signature material interleaved
// between events. Only JSON serialization is supported (what signify emits).
func ExtractKeyStates(stream []byte, aid string) ([]EstablishmentKeyState, error) {
	if aid == "" {
		return nil, fmt.Errorf("aid is required")
	}
	s := string(stream)
	bySeq := map[int64]EstablishmentKeyState{}

	for i := 0; i < len(s); {
		start := strings.Index(s[i:], `{"v":"KERI`)
		if start < 0 {
			break
		}
		start += i
		size, err := eventSize(s[start:])
		if err != nil {
			// Malformed framing — skip past this marker and keep scanning.
			i = start + len(`{"v":"KERI`)
			continue
		}
		if start+size > len(s) {
			break
		}
		raw := s[start : start+size]
		i = start + size

		var ev establishmentEvent
		if err := json.Unmarshal([]byte(raw), &ev); err != nil {
			continue
		}
		if ev.Prefix != aid || !isEstablishment(ev.Type) {
			continue
		}
		seq, err := strconv.ParseInt(ev.Seq, 16, 64)
		if err != nil {
			continue
		}
		if len(ev.Keys) == 0 {
			continue
		}
		bySeq[seq] = EstablishmentKeyState{
			Seq:       seq,
			Keys:      ev.Keys,
			Threshold: strings.TrimSpace(string(ev.Threshold)),
		}
	}

	if len(bySeq) == 0 {
		return nil, fmt.Errorf("no establishment event for %s found in KEL stream", aid)
	}
	states := make([]EstablishmentKeyState, 0, len(bySeq))
	for _, st := range bySeq {
		states = append(states, st)
	}
	sort.Slice(states, func(i, j int) bool { return states[i].Seq < states[j].Seq })
	return states, nil
}

// eventSize reads the KERI version string at the start of a JSON event and
// returns the total serialized byte length it declares. The version string is
// 17 characters: "KERI" + version(2) + kind(4) + size(6 hex) + "_", e.g.
// "KERI10JSON0000fb_" (indices 0–9 = "KERI10JSON", 10–15 = size, 16 = "_").
func eventSize(s string) (int, error) {
	const vsLen = 17
	idx := strings.Index(s, "KERI")
	if idx < 0 || idx+vsLen > len(s) {
		return 0, fmt.Errorf("version string not found")
	}
	vs := s[idx : idx+vsLen]
	if vs[16] != '_' {
		return 0, fmt.Errorf("malformed version string %q", vs)
	}
	size, err := strconv.ParseInt(vs[10:16], 16, 64)
	if err != nil {
		return 0, fmt.Errorf("bad size in version string %q: %w", vs, err)
	}
	if size <= 0 {
		return 0, fmt.Errorf("non-positive event size %d", size)
	}
	return int(size), nil
}
