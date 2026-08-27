// Package auth implements KERI-signed request authentication for the Matou
// backend: a signed-challenge login flow that verifies a signature made with
// an AID's current signing key and mints a short-lived session token.
//
// The crypto here deliberately covers only the narrow set of CESR primitives
// the login path needs — non-indexed Ed25519 signatures (Cigar, code "0B") and
// basic Ed25519 public keys (verfers, codes "D" transferable / "B"
// non-transferable). It is not a general CESR codec.
package auth

import (
	"crypto/ed25519"
	"encoding/base64"
	"fmt"
)

// DecodePublicKey decodes a CESR-qualified base64 Ed25519 public key (verfer)
// into raw 32 bytes. It accepts the two basic Ed25519 derivation codes:
//
//	"D" — Ed25519 transferable public key
//	"B" — Ed25519 non-transferable public key
//
// Both are single-character codes over a 32-byte key, yielding a 44-char qb64
// string. The one leading pad byte (absorbed by the code) is stripped after a
// base64url decode with the code replaced by 'A'.
func DecodePublicKey(qb64 string) (ed25519.PublicKey, error) {
	if len(qb64) != 44 {
		return nil, fmt.Errorf("invalid Ed25519 public key length: got %d, want 44", len(qb64))
	}
	switch qb64[0] {
	case 'D', 'B':
	default:
		return nil, fmt.Errorf("unsupported public key derivation code %q (want D or B)", qb64[0:1])
	}
	raw, err := decodeQB64(qb64, 1)
	if err != nil {
		return nil, fmt.Errorf("decode public key: %w", err)
	}
	if len(raw) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("decoded public key is %d bytes, want %d", len(raw), ed25519.PublicKeySize)
	}
	return ed25519.PublicKey(raw), nil
}

// DecodeSignature decodes a CESR-qualified base64 non-indexed Ed25519 signature
// (a signify Cigar, derivation code "0B") into raw 64 bytes. The code is a
// two-character code over a 64-byte signature, yielding an 88-char qb64 string
// with two leading pad bytes absorbed by the code.
func DecodeSignature(qb64 string) ([]byte, error) {
	if len(qb64) != 88 {
		return nil, fmt.Errorf("invalid Ed25519 signature length: got %d, want 88", len(qb64))
	}
	if qb64[0:2] != "0B" {
		return nil, fmt.Errorf("unsupported signature derivation code %q (want 0B)", qb64[0:2])
	}
	raw, err := decodeQB64(qb64, 2)
	if err != nil {
		return nil, fmt.Errorf("decode signature: %w", err)
	}
	if len(raw) != ed25519.SignatureSize {
		return nil, fmt.Errorf("decoded signature is %d bytes, want %d", len(raw), ed25519.SignatureSize)
	}
	return raw, nil
}

// decodeQB64 decodes a fully-qualified base64url CESR primitive whose
// derivation code occupies codeSize characters. The code is replaced with 'A'
// characters (base64 value 0) so the standard decoder produces codeSize leading
// zero pad bytes, which are then stripped to recover the raw material.
//
// This holds because CESR aligns the code size to the pad size for these
// primitives ("D"/"B": 1, "0B": 2), so the number of pad bytes equals codeSize.
func decodeQB64(qb64 string, codeSize int) ([]byte, error) {
	if len(qb64) < codeSize {
		return nil, fmt.Errorf("qb64 shorter than code size")
	}
	substituted := make([]byte, len(qb64))
	for i := 0; i < codeSize; i++ {
		substituted[i] = 'A'
	}
	copy(substituted[codeSize:], qb64[codeSize:])
	decoded, err := base64.URLEncoding.DecodeString(string(substituted))
	if err != nil {
		return nil, fmt.Errorf("base64url: %w", err)
	}
	if len(decoded) < codeSize {
		return nil, fmt.Errorf("decoded material shorter than pad")
	}
	return decoded[codeSize:], nil
}

// VerifySignature reports whether sigQB64 is a valid Ed25519 signature over msg
// made by the key keyQB64. Both are CESR-qualified base64 strings.
func VerifySignature(keyQB64 string, msg []byte, sigQB64 string) (bool, error) {
	pub, err := DecodePublicKey(keyQB64)
	if err != nil {
		return false, err
	}
	sig, err := DecodeSignature(sigQB64)
	if err != nil {
		return false, err
	}
	return ed25519.Verify(pub, msg, sig), nil
}
