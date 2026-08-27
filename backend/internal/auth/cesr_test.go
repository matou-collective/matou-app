package auth

import (
	"crypto/ed25519"
	"encoding/base64"
	"testing"
)

// encodeVerferD CESR-encodes an Ed25519 public key with the "D" (transferable)
// derivation code, mirroring how signify/keripy qualify a verfer.
func encodeVerferD(pub ed25519.PublicKey) string {
	// One leading pad byte, code 'D' overwrites the first base64 char.
	raw := make([]byte, 1+len(pub))
	copy(raw[1:], pub)
	b64 := base64.URLEncoding.EncodeToString(raw) // 44 chars, first char encodes pad+top bits
	return "D" + b64[1:]
}

// encodeSig0B CESR-encodes a 64-byte Ed25519 signature with the "0B"
// (non-indexed Cigar) derivation code.
func encodeSig0B(sig []byte) string {
	raw := make([]byte, 2+len(sig)) // two leading pad bytes for the 2-char code
	copy(raw[2:], sig)
	b64 := base64.URLEncoding.EncodeToString(raw) // 88 chars
	return "0B" + b64[2:]
}

func TestDecodePublicKeyRoundTrip(t *testing.T) {
	pub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	qb64 := encodeVerferD(pub)
	if len(qb64) != 44 {
		t.Fatalf("expected 44-char verfer, got %d (%q)", len(qb64), qb64)
	}
	got, err := DecodePublicKey(qb64)
	if err != nil {
		t.Fatalf("DecodePublicKey: %v", err)
	}
	if !got.Equal(pub) {
		t.Fatalf("decoded key mismatch")
	}
}

func TestDecodePublicKeyRejectsBadCode(t *testing.T) {
	pub, _, _ := ed25519.GenerateKey(nil)
	qb64 := encodeVerferD(pub)
	bad := "E" + qb64[1:] // E = self-addressing digest, not a basic key
	if _, err := DecodePublicKey(bad); err == nil {
		t.Fatal("expected error for unsupported derivation code")
	}
	if _, err := DecodePublicKey("D" + qb64[1:] + "extra"); err == nil {
		t.Fatal("expected error for wrong length")
	}
}

func TestVerifySignatureRoundTrip(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(nil)
	msg := []byte("challenge-nonce-abc123")
	sig := ed25519.Sign(priv, msg)

	keyQB64 := encodeVerferD(pub)
	sigQB64 := encodeSig0B(sig)
	if len(sigQB64) != 88 {
		t.Fatalf("expected 88-char signature, got %d", len(sigQB64))
	}

	ok, err := VerifySignature(keyQB64, msg, sigQB64)
	if err != nil {
		t.Fatalf("VerifySignature: %v", err)
	}
	if !ok {
		t.Fatal("expected signature to verify")
	}

	// Tampered message must not verify.
	ok, err = VerifySignature(keyQB64, []byte("different"), sigQB64)
	if err != nil {
		t.Fatalf("VerifySignature (tampered): %v", err)
	}
	if ok {
		t.Fatal("expected tampered message to fail verification")
	}

	// Signature from a different key must not verify.
	otherPub, _, _ := ed25519.GenerateKey(nil)
	ok, _ = VerifySignature(encodeVerferD(otherPub), msg, sigQB64)
	if ok {
		t.Fatal("expected wrong-key verification to fail")
	}
}

func TestDecodeSignatureRejectsBadInput(t *testing.T) {
	if _, err := DecodeSignature("0Bshort"); err == nil {
		t.Fatal("expected length error")
	}
	_, priv, _ := ed25519.GenerateKey(nil)
	sig := ed25519.Sign(priv, []byte("x"))
	good := encodeSig0B(sig)
	bad := "0C" + good[2:]
	if _, err := DecodeSignature(bad); err == nil {
		t.Fatal("expected derivation-code error")
	}
}
