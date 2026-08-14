package auth

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// establishmentEvent is the subset of a KERI event we need to find the current
// signing keys: the event type, sequence number and key list.
type establishmentEvent struct {
	Version string   `json:"v"`
	Type    string   `json:"t"`
	Seq     string   `json:"s"`
	Keys    []string `json:"k"`
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
// OOBI resolution, or the KEL the frontend forwards) and returns the qb64
// signing keys of the most recent establishment event.
//
// KERI JSON events are self-framing: the version string ("KERI10JSON0000fb_")
// encodes the exact byte length of the serialized event, so each event can be
// sliced out precisely regardless of the CESR signature material interleaved
// between events. Only JSON serialization is supported (what signify emits).
func ExtractCurrentKeys(stream []byte) ([]string, error) {
	s := string(stream)
	var best *establishmentEvent
	bestSeq := int64(-1)

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
		if !isEstablishment(ev.Type) {
			continue
		}
		seq, err := strconv.ParseInt(ev.Seq, 16, 64)
		if err != nil {
			continue
		}
		if seq >= bestSeq {
			bestSeq = seq
			evCopy := ev
			best = &evCopy
		}
	}

	if best == nil {
		return nil, fmt.Errorf("no establishment event found in KEL stream")
	}
	if len(best.Keys) == 0 {
		return nil, fmt.Errorf("establishment event has no keys")
	}
	return best.Keys, nil
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
