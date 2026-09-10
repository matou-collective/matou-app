package pairing

import (
	"encoding/base64"
	"fmt"
	"net/url"
)

// idSize and secretSize are the 128-bit pairing id and pairing secret lengths.
const (
	idSize     = 16
	secretSize = 16
)

// b64 is the unpadded base64url alphabet the QR payload uses for the binary
// fields (id, pk, s).
var b64 = base64.RawURLEncoding

// qrPayload is the parsed form of the QR string
//
//	matou://pair?v=1&id=<pairId>&pk=<displayerEphPub>&s=<pairSecret>&cs=<configServerUrl>
//
// pairSecret is redacted by String()/GoString(): it is the one field that must
// never reach the mailbox or a log.
type qrPayload struct {
	version         string
	pairID          string // base64url, 128-bit
	displayerPub    []byte // 32-byte X25519 public key
	pairSecret      []byte // 128-bit; only ever in the QR image
	configServerURL string
}

// String redacts the pairing secret.
func (q qrPayload) String() string {
	return fmt.Sprintf("qrPayload{v:%s id:%s pk:%d bytes s:[REDACTED] cs:%s}",
		q.version, q.pairID, len(q.displayerPub), q.configServerURL)
}

// GoString redacts the pairing secret for %#v.
func (q qrPayload) GoString() string { return q.String() }

// encode renders the QR payload string.
func (q qrPayload) encode() string {
	v := url.Values{}
	v.Set("v", "1")
	v.Set("id", q.pairID)
	v.Set("pk", b64.EncodeToString(q.displayerPub))
	v.Set("s", b64.EncodeToString(q.pairSecret))
	v.Set("cs", q.configServerURL)
	// url.Values.Encode sorts keys; the spec lists v,id,pk,s,cs but the order is
	// not significant to any parser, so the sorted form is fine.
	return "matou://pair?" + v.Encode()
}

// parseQRPayload parses a matou://pair?… string, validating field sizes.
func parseQRPayload(s string) (*qrPayload, error) {
	u, err := url.Parse(s)
	if err != nil {
		return nil, fmt.Errorf("parsing QR payload: %w", err)
	}
	if u.Scheme != "matou" || u.Host != "pair" {
		return nil, fmt.Errorf("not a matou pairing URL")
	}
	q := u.Query()
	if q.Get("v") != "1" {
		return nil, fmt.Errorf("unsupported pairing version %q", q.Get("v"))
	}
	id := q.Get("id")
	if id == "" {
		return nil, fmt.Errorf("missing pairing id")
	}
	idBytes, err := b64.DecodeString(id)
	if err != nil || len(idBytes) != idSize {
		return nil, fmt.Errorf("invalid pairing id")
	}
	pk, err := b64.DecodeString(q.Get("pk"))
	if err != nil || len(pk) != 32 {
		return nil, fmt.Errorf("invalid displayer public key")
	}
	secret, err := b64.DecodeString(q.Get("s"))
	if err != nil || len(secret) != secretSize {
		return nil, fmt.Errorf("invalid pairing secret")
	}
	cs := q.Get("cs")
	if cs == "" {
		return nil, fmt.Errorf("missing config server URL")
	}
	if _, err := url.ParseRequestURI(cs); err != nil {
		return nil, fmt.Errorf("invalid config server URL")
	}
	return &qrPayload{
		version:         "1",
		pairID:          id,
		displayerPub:    pk,
		pairSecret:      secret,
		configServerURL: cs,
	}, nil
}
