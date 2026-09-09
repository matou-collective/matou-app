// Package pairing implements the linked-device sign-in protocol (design spec
// docs/superpowers/specs/2026-09-08-linked-device-sign-in-design.md §2): an
// X25519/HKDF/AES-GCM session over a rendezvous mailbox on the config server
// that lets one device hand its identity (the 12-word mnemonic plus non-secret
// hints) to another after the holder approves.
//
// The Go backend owns the protocol on both platforms; the frontend only renders
// the QR, scans it, shows the confirmation code and feeds the received mnemonic
// to the existing recovery path.
//
// Secrecy note: nothing about a session is ever persisted or logged. Every
// struct that can hold the mnemonic, the session key K or the pairing secret
// implements String()/GoString() that redacts, so an accidental %v or %+v never
// leaks them.
package pairing

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"fmt"
	"io"
	"math/big"

	"golang.org/x/crypto/hkdf"
)

const (
	// hkdfInfo is the domain-separation label for the pairing key derivation.
	hkdfInfo = "matou-pair-v1"
	// nonceSize is the AES-GCM nonce length prefixed to every blob.
	nonceSize = 12
	// keySize is the AES-256 / derived key length in bytes.
	keySize = 32
	// codeDigits is the length of the SAS confirmation code shown on both
	// screens.
	codeDigits = 6
)

// generateEphemeralKey returns a fresh X25519 key pair for one pairing session.
func generateEphemeralKey() (*ecdh.PrivateKey, error) {
	priv, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generating X25519 key: %w", err)
	}
	return priv, nil
}

// parsePeerPublicKey decodes a 32-byte X25519 public key.
func parsePeerPublicKey(raw []byte) (*ecdh.PublicKey, error) {
	pub, err := ecdh.X25519().NewPublicKey(raw)
	if err != nil {
		return nil, fmt.Errorf("parsing X25519 public key: %w", err)
	}
	return pub, nil
}

// deriveK computes the session key K shared by both devices:
//
//	shared = X25519(ownEph, peerPub)
//	K = HKDF-SHA256(ikm=shared, salt=pairSecret, info="matou-pair-v1")
//
// Because pairSecret only ever travels inside the QR image, a mailbox that
// swaps the peer's public key in transit derives a different K and every later
// blob fails to decrypt — the mailbox is untrusted for confidentiality and
// integrity alike.
func deriveK(own *ecdh.PrivateKey, peer *ecdh.PublicKey, pairSecret []byte) ([]byte, error) {
	shared, err := own.ECDH(peer)
	if err != nil {
		return nil, fmt.Errorf("X25519 agreement: %w", err)
	}
	r := hkdf.New(sha256.New, shared, pairSecret, []byte(hkdfInfo))
	k := make([]byte, keySize)
	if _, err := io.ReadFull(r, k); err != nil {
		return nil, fmt.Errorf("HKDF expand: %w", err)
	}
	return k, nil
}

// sasCode derives the 6-digit confirmation code shown on both screens:
// decimal(HMAC-SHA256(K, "sas"))[0:6]. Both devices compute an identical K, so
// they show an identical code; a device that photographed the QR from across
// the room but sits on a different session key shows a different code.
func sasCode(k []byte) string {
	mac := hmac.New(sha256.New, k)
	mac.Write([]byte("sas"))
	sum := mac.Sum(nil)
	dec := new(big.Int).SetBytes(sum).String()
	if len(dec) < codeDigits {
		// Astronomically unlikely (top bytes all zero); pad so the code is
		// always codeDigits wide and both sides still agree.
		for len(dec) < codeDigits {
			dec = "0" + dec
		}
	}
	return dec[:codeDigits]
}

// seal encrypts plaintext under K: output is a 12-byte random nonce followed by
// the AES-256-GCM ciphertext (tag included).
func seal(k, plaintext []byte) ([]byte, error) {
	gcm, err := newGCM(k)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, nonceSize)
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("nonce: %w", err)
	}
	return gcm.Seal(nonce, nonce, plaintext, nil), nil
}

// open reverses seal: it splits the nonce prefix and authenticates+decrypts the
// rest. A wrong K (e.g. a tampered peer key) fails the GCM tag here.
func open(k, blob []byte) ([]byte, error) {
	gcm, err := newGCM(k)
	if err != nil {
		return nil, err
	}
	if len(blob) < nonceSize {
		return nil, fmt.Errorf("blob too short")
	}
	nonce, ct := blob[:nonceSize], blob[nonceSize:]
	pt, err := gcm.Open(nil, nonce, ct, nil)
	if err != nil {
		return nil, fmt.Errorf("AEAD open: %w", err)
	}
	return pt, nil
}

func newGCM(k []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(k)
	if err != nil {
		return nil, fmt.Errorf("AES cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("GCM: %w", err)
	}
	return gcm, nil
}

// randomBytes returns n cryptographically random bytes.
func randomBytes(n int) ([]byte, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return nil, fmt.Errorf("random bytes: %w", err)
	}
	return b, nil
}
