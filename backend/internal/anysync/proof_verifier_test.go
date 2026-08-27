package anysync

import (
	"crypto/ed25519"
	"encoding/base64"
	"testing"

	"github.com/matou-dao/backend/internal/contributions"
)

// --- CESR test helpers (mirror auth/cesr_test.go, which is in another package).

// encodeVerferD CESR-encodes an Ed25519 public key with the "D" (transferable)
// derivation code, as signify/keripy qualify a verfer.
func encodeVerferD(pub ed25519.PublicKey) string {
	raw := make([]byte, 1+len(pub))
	copy(raw[1:], pub)
	b64 := base64.URLEncoding.EncodeToString(raw)
	return "D" + b64[1:]
}

// encodeSig0B CESR-encodes a 64-byte Ed25519 signature with the "0B"
// (non-indexed Cigar) derivation code, as signify emits from keeper.sign(...,false).
func encodeSig0B(sig []byte) string {
	raw := make([]byte, 2+len(sig))
	copy(raw[2:], sig)
	b64 := base64.URLEncoding.EncodeToString(raw)
	return "0B" + b64[2:]
}

// signer is a test AID with an Ed25519 keypair.
type signer struct {
	aid    string
	verfer string
	priv   ed25519.PrivateKey
}

func newSigner(t *testing.T, aid string) signer {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("keygen: %v", err)
	}
	return signer{aid: aid, verfer: encodeVerferD(pub), priv: priv}
}

// sign produces a proof envelope signed over the canonical message for the given
// object fields. Fields written into the envelope default to the signed values;
// override them afterwards to build tampered/forged proofs.
func (s signer) sign(action, subject, space, value, dt string) *contributions.Proof {
	msg := canonicalProofMessage(action, subject, space, value, dt)
	sig := encodeSig0B(ed25519.Sign(s.priv, msg))
	return &contributions.Proof{
		V: proofVersion, Action: action, Subject: subject, Space: space,
		Value: value, Dt: dt, AID: s.aid, Sig: sig,
	}
}

const (
	tSubject = "contrib-1"
	tSpace   = "space-community"
	tDt      = "2026-08-27T00:00:00Z"
)

func TestVerifyActionProof_Valid(t *testing.T) {
	s := newSigner(t, "E-steward")
	keys := NewStaticKeyProvider()
	keys.Set(s.aid, s.verfer)
	p := s.sign("contribution_signoff", tSubject, tSpace, "signed_off", tDt)

	aid, ok, reason := verifyActionProof(keys, "contribution_signoff", tSubject, tSpace, "signed_off", p)
	if !ok {
		t.Fatalf("valid proof must verify, got reason %q", reason)
	}
	if aid != "E-steward" {
		t.Fatalf("verified aid: got %q", aid)
	}
}

func TestVerifyActionProof_ForgedSignature(t *testing.T) {
	steward := newSigner(t, "E-steward")
	attacker := newSigner(t, "E-attacker")
	// Snapshot binds E-steward → the steward's real verfer.
	keys := NewStaticKeyProvider()
	keys.Set(steward.aid, steward.verfer)

	// Attacker signs the message but claims to be E-steward.
	p := attacker.sign("contribution_signoff", tSubject, tSpace, "signed_off", tDt)
	p.AID = steward.aid

	_, ok, reason := verifyActionProof(keys, "contribution_signoff", tSubject, tSpace, "signed_off", p)
	if ok {
		t.Fatal("a signature not made by the claimed AID's key must be rejected")
	}
	if reason == "" {
		t.Fatal("rejection must carry a reason")
	}
}

func TestVerifyActionProof_TamperedValue(t *testing.T) {
	s := newSigner(t, "E-steward")
	keys := NewStaticKeyProvider()
	keys.Set(s.aid, s.verfer)
	// Signed for value "signed_off" but the object's authoritative value is
	// "rewarded" — the envelope copy can't be trusted; the check compares to
	// the asserted value.
	p := s.sign("contribution_signoff", tSubject, tSpace, "signed_off", tDt)
	if _, ok, _ := verifyActionProof(keys, "contribution_signoff", tSubject, tSpace, "rewarded", p); ok {
		t.Fatal("a proof whose value does not match the transition must be rejected")
	}
}

func TestVerifyActionProof_CrossSpaceReplay(t *testing.T) {
	s := newSigner(t, "E-steward")
	keys := NewStaticKeyProvider()
	keys.Set(s.aid, s.verfer)
	// A genuine proof signed for space-A, replayed onto the same object id in
	// space-B, must not verify against space-B.
	p := s.sign("contribution_signoff", tSubject, "space-A", "signed_off", tDt)
	if _, ok, reason := verifyActionProof(keys, "contribution_signoff", tSubject, "space-B", "signed_off", p); ok {
		t.Fatalf("cross-space replay must be rejected, got ok (reason %q)", reason)
	}
}

func TestVerifyActionProof_WrongSubject(t *testing.T) {
	s := newSigner(t, "E-steward")
	keys := NewStaticKeyProvider()
	keys.Set(s.aid, s.verfer)
	// Proof signed for contrib-1 lifted onto contrib-2.
	p := s.sign("contribution_signoff", "contrib-1", tSpace, "signed_off", tDt)
	if _, ok, _ := verifyActionProof(keys, "contribution_signoff", "contrib-2", tSpace, "signed_off", p); ok {
		t.Fatal("a proof cannot be lifted onto a different object id")
	}
}

func TestVerifyActionProof_MissingProof(t *testing.T) {
	keys := NewStaticKeyProvider()
	if _, ok, reason := verifyActionProof(keys, "contribution_signoff", tSubject, tSpace, "signed_off", nil); ok || reason == "" {
		t.Fatal("a missing proof must be rejected with a reason")
	}
}

func TestVerifyActionProof_UnresolvedKeyFailsClosed(t *testing.T) {
	s := newSigner(t, "E-steward")
	keys := NewStaticKeyProvider() // empty: no key for E-steward
	p := s.sign("contribution_signoff", tSubject, tSpace, "signed_off", tDt)
	if _, ok, _ := verifyActionProof(keys, "contribution_signoff", tSubject, tSpace, "signed_off", p); ok {
		t.Fatal("a present proof whose signer key is unavailable must fail closed")
	}
}

func TestVerifyActionProof_RotatedKeyReplayRejected(t *testing.T) {
	old := newSigner(t, "E-steward")
	// The AID rotated: the snapshot now carries a NEW verfer. A proof signed
	// with the rotated-away key (e.g. replayed after key compromise) must fail.
	newKeyPub, _, _ := ed25519.GenerateKey(nil)
	keys := NewStaticKeyProvider()
	keys.Set(old.aid, encodeVerferD(newKeyPub))

	p := old.sign("contribution_signoff", tSubject, tSpace, "signed_off", tDt)
	if _, ok, _ := verifyActionProof(keys, "contribution_signoff", tSubject, tSpace, "signed_off", p); ok {
		t.Fatal("a signature from a non-current key must be rejected")
	}
}

func TestVerifyActionProof_UnknownSpaceUsesProofSpace(t *testing.T) {
	s := newSigner(t, "E-steward")
	keys := NewStaticKeyProvider()
	keys.Set(s.aid, s.verfer)
	// On a read path that cannot determine the space (""), the proof's own space
	// is used to rebuild the message so a genuine proof still verifies.
	p := s.sign("contribution_signoff", tSubject, tSpace, "signed_off", tDt)
	if _, ok, reason := verifyActionProof(keys, "contribution_signoff", tSubject, "", "signed_off", p); !ok {
		t.Fatalf("unknown space must fall back to the proof's space, got reason %q", reason)
	}
}

func TestVerifyActionProof_WrongVersionOrAction(t *testing.T) {
	s := newSigner(t, "E-steward")
	keys := NewStaticKeyProvider()
	keys.Set(s.aid, s.verfer)

	bad := s.sign("contribution_signoff", tSubject, tSpace, "signed_off", tDt)
	bad.V = "matou-proof/v2"
	if _, ok, _ := verifyActionProof(keys, "contribution_signoff", tSubject, tSpace, "signed_off", bad); ok {
		t.Error("unsupported version must be rejected")
	}

	mism := s.sign("contribution_signoff", tSubject, tSpace, "signed_off", tDt)
	if _, ok, _ := verifyActionProof(keys, "contribution_reward", tSubject, tSpace, "signed_off", mism); ok {
		t.Error("a proof whose action does not match the transition must be rejected")
	}
}

// canonicalProofMessage must byte-match the frontend (actionProof.ts) format:
// version, action, subject, space, value, dt — each on its own line.
func TestCanonicalProofMessage_GoldenFormat(t *testing.T) {
	// These golden vectors are copied verbatim from the frontend's single source
	// of truth (frontend/tests/scripts/action-proof.test.ts); the two sides must
	// stay byte-for-byte in lockstep or a legitimate proof will fail to verify.
	cases := []struct {
		action, subject, space, value, dt, want string
	}{
		{"contribution_reward", "ECx", "sp1", "rewarded", "2026-01-02T03:04:05Z",
			"matou-proof/v1\ncontribution_reward\nECx\nsp1\nrewarded\n2026-01-02T03:04:05Z"},
		{"plan_signoff", "plan-1", "sp1", "signed_off", "2026-01-02T03:04:05Z",
			"matou-proof/v1\nplan_signoff\nplan-1\nsp1\nsigned_off\n2026-01-02T03:04:05Z"},
		{"project_completion", "proj-1", "sp1", "completed", "2026-01-02T03:04:05Z",
			"matou-proof/v1\nproject_completion\nproj-1\nsp1\ncompleted\n2026-01-02T03:04:05Z"},
	}
	for _, c := range cases {
		if got := string(canonicalProofMessage(c.action, c.subject, c.space, c.value, c.dt)); got != c.want {
			t.Errorf("canonical message mismatch:\n got %q\nwant %q", got, c.want)
		}
	}
}
