package pairing

import "fmt"

// Role is what a device reports about whether it already holds an identity.
type Role string

const (
	// RoleHolder means the device already has an identity to hand over.
	RoleHolder Role = "holder"
	// RoleFresh means the device has no identity and wants to receive one.
	RoleFresh Role = "fresh"
)

// Outcome is the direction (or refusal) decided after the scanner's hello, from
// the §1 table.
type Outcome string

const (
	// OutcomePhoneToDesktop means the phone holds and the desktop is fresh; the
	// phone approves.
	OutcomePhoneToDesktop Outcome = "phone-to-desktop"
	// OutcomeDesktopToPhone means the desktop holds and the phone is fresh; the
	// desktop approves.
	OutcomeDesktopToPhone Outcome = "desktop-to-phone"
	// OutcomeNeither means neither device has an identity yet.
	OutcomeNeither Outcome = "neither"
	// OutcomeAlreadyLinked means both hold the same AID.
	OutcomeAlreadyLinked Outcome = "already-linked"
	// OutcomeConflict means both hold, but different AIDs — linking never
	// overwrites.
	OutcomeConflict Outcome = "conflict"
)

// proceeds reports whether an outcome moves on to approval + identity transfer.
func (o Outcome) proceeds() bool {
	return o == OutcomePhoneToDesktop || o == OutcomeDesktopToPhone
}

// computeOutcome applies the §1 direction table. displayer is always the
// desktop, scanner always the phone.
func computeOutcome(displayerHolds bool, displayerAID string, scannerHolds bool, scannerAID string) Outcome {
	switch {
	case !displayerHolds && !scannerHolds:
		return OutcomeNeither
	case displayerHolds && scannerHolds:
		if displayerAID != "" && displayerAID == scannerAID {
			return OutcomeAlreadyLinked
		}
		return OutcomeConflict
	case !displayerHolds && scannerHolds:
		return OutcomePhoneToDesktop
	default: // displayerHolds && !scannerHolds
		return OutcomeDesktopToPhone
	}
}

// helloMsg is message 1 (slot a, scanner → displayer). scannerEphPub travels in
// the clear outside the AEAD because the displayer needs it to derive K; it is
// authenticated implicitly because a wrong key fails every subsequent tag.
type helloMsg struct {
	Role       Role   `json:"role"`
	AID        string `json:"aid,omitempty"`
	DeviceName string `json:"deviceName"`
	AppVersion string `json:"appVersion,omitempty"`
}

// ackMsg is message 2 (slot b, displayer → scanner): lets the scanner render the
// same §1 outcome and the code.
type ackMsg struct {
	Role       Role   `json:"role"`
	AID        string `json:"aid,omitempty"`
	DeviceName string `json:"deviceName"`
}

// identityMsg is message 3 (holder → receiver): the mnemonic plus non-secret
// hints, sent only after the holder's Approve. Redacted by String().
type identityMsg struct {
	Mnemonic        string `json:"mnemonic"`
	AID             string `json:"aid"`
	OrgAID          string `json:"orgAid,omitempty"`
	AdminAID        string `json:"adminAid,omitempty"`
	ConfigServerURL string `json:"configServerUrl,omitempty"`
}

// String redacts the mnemonic.
func (m identityMsg) String() string {
	return fmt.Sprintf("identityMsg{mnemonic:[REDACTED] aid:%s orgAid:%s adminAid:%s cs:%s}",
		m.AID, m.OrgAID, m.AdminAID, m.ConfigServerURL)
}

// GoString redacts the mnemonic for %#v.
func (m identityMsg) GoString() string { return m.String() }

// doneMsg is message 4 (receiver → holder): the holder shows "Linked ✓" or the
// error.
type doneMsg struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}
