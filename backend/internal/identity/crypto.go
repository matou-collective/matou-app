package identity

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
)

// encMagic prefixes an encrypted identity file so load() can tell an AES-256-GCM
// blob apart from a legacy plaintext JSON document (which always starts with '{').
// The magic is also fed to GCM as additional authenticated data.
var encMagic = []byte("MATOU-IDENC1\n")

// deriveKey normalises arbitrary key material handed over by the shell (an OS
// keyring / Android Keystore / iOS Keychain secret of any length) into a fixed
// 32-byte AES-256 key. GCM's per-write random nonce provides the uniqueness that
// a plain hash-as-key would otherwise lack.
func deriveKey(keyMaterial []byte) [32]byte {
	return sha256.Sum256(keyMaterial)
}

// isEncrypted reports whether data is an identity blob written by encrypt.
func isEncrypted(data []byte) bool {
	return len(data) >= len(encMagic) && bytes.Equal(data[:len(encMagic)], encMagic)
}

// Seal encrypts plaintext at rest under keyMaterial with AES-256-GCM, in the
// exact same on-disk format as identity.json. It exists so other packages
// (e.g. internal/anysync for space read keys and peer keys) can seal their
// own at-rest secrets through the one crypto path instead of re-implementing
// it (issue #117). A caller holding an empty key should skip Seal entirely and
// keep writing plaintext.
func Seal(plaintext, keyMaterial []byte) ([]byte, error) {
	return encrypt(plaintext, keyMaterial)
}

// Open reverses Seal. It returns an error when data is not a sealed blob or
// when keyMaterial does not match the key the blob was sealed with.
func Open(data, keyMaterial []byte) ([]byte, error) {
	return decrypt(data, keyMaterial)
}

// IsSealed reports whether data was written by Seal (as opposed to legacy
// plaintext), so callers can tell the two apart and migrate transparently.
func IsSealed(data []byte) bool {
	return isEncrypted(data)
}

// encrypt seals plaintext under keyMaterial as: encMagic || nonce || GCM(ciphertext).
func encrypt(plaintext, keyMaterial []byte) ([]byte, error) {
	key := deriveKey(keyMaterial)
	gcm, err := newGCM(key[:])
	if err != nil {
		return nil, err
	}

	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, fmt.Errorf("generating nonce: %w", err)
	}

	sealed := gcm.Seal(nil, nonce, plaintext, encMagic)

	out := make([]byte, 0, len(encMagic)+len(nonce)+len(sealed))
	out = append(out, encMagic...)
	out = append(out, nonce...)
	out = append(out, sealed...)
	return out, nil
}

// decrypt reverses encrypt. It returns an error when data is not an encrypted
// blob or when keyMaterial does not match the key the blob was sealed with.
func decrypt(data, keyMaterial []byte) ([]byte, error) {
	if !isEncrypted(data) {
		return nil, errors.New("not an encrypted identity blob")
	}
	body := data[len(encMagic):]

	key := deriveKey(keyMaterial)
	gcm, err := newGCM(key[:])
	if err != nil {
		return nil, err
	}

	if len(body) < gcm.NonceSize() {
		return nil, errors.New("encrypted identity blob is truncated")
	}
	nonce, ciphertext := body[:gcm.NonceSize()], body[gcm.NonceSize():]

	plaintext, err := gcm.Open(nil, nonce, ciphertext, encMagic)
	if err != nil {
		return nil, fmt.Errorf("decrypting identity (wrong key or corrupt file): %w", err)
	}
	return plaintext, nil
}

func newGCM(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("creating AES cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("creating GCM: %w", err)
	}
	return gcm, nil
}
