// Package anysync provides any-sync integration for MATOU.
// atrest.go seals the on-disk key material any-sync persists — space read
// keys ({dataDir}/keys/*.keys) and peer keys ({dataDir}/peer.key,
// {dataDir}/users/{aid}/peer.key) — under the same shell-supplied encryption
// key that protects identity.json, routed through internal/identity's
// AES-256-GCM seal/open (issue #117).
//
// The key is injected via the SDK client rather than every persistence call
// site: NewSDKClient registers its data directory against the key from
// app.Options, and the package-level Persist/Load helpers (whose signatures do
// not change) look the key up by data directory. An unregistered data
// directory — dev, test, or any not-yet-wired shell — keeps the legacy
// plaintext behaviour byte-for-byte.
package anysync

import (
	"errors"
	"sync"

	"github.com/matou-dao/backend/internal/identity"
)

var (
	encKeysMu sync.RWMutex
	encKeys   = map[string][]byte{}
)

// RegisterDataDirKey associates an at-rest encryption key with a data
// directory. The Persist/Load helpers seal files under {dataDir} with this
// key. An empty key clears any prior registration and restores the legacy
// plaintext behaviour. Called by NewSDKClient from
// app.Options.IdentityEncryptionKey.
func RegisterDataDirKey(dataDir string, key []byte) {
	encKeysMu.Lock()
	defer encKeysMu.Unlock()
	if len(key) == 0 {
		delete(encKeys, dataDir)
		return
	}
	k := make([]byte, len(key))
	copy(k, key)
	encKeys[dataDir] = k
}

// dataDirEncKey returns the at-rest key registered for dataDir, or nil when no
// key is registered (legacy plaintext).
func dataDirEncKey(dataDir string) []byte {
	encKeysMu.RLock()
	defer encKeysMu.RUnlock()
	return encKeys[dataDir]
}

// sealBytes seals data under dataDir's registered key. With no key registered
// it returns data unchanged, preserving the legacy plaintext format.
func sealBytes(dataDir string, data []byte) ([]byte, error) {
	key := dataDirEncKey(dataDir)
	if len(key) == 0 {
		return data, nil
	}
	return identity.Seal(data, key)
}

// openBytes reverses sealBytes. It transparently accepts legacy plaintext
// (returning it unchanged with wasSealed=false) so callers can migrate on
// first keyed open. A sealed file with no key registered, or a sealed file
// that fails to open with the registered key, is a hard error: the caller
// must fail closed rather than proceed with half-loaded key material.
func openBytes(dataDir string, data []byte) (plain []byte, wasSealed bool, err error) {
	key := dataDirEncKey(dataDir)
	if identity.IsSealed(data) {
		if len(key) == 0 {
			return nil, true, errors.New("key file is encrypted but no encryption key is registered for this data directory")
		}
		p, err := identity.Open(data, key)
		if err != nil {
			return nil, true, err
		}
		return p, true, nil
	}
	return data, false, nil
}

// shouldMigrate reports whether an on-disk file that was read as plaintext
// (wasSealed=false) should be rewritten sealed — true exactly when a key is
// registered for dataDir. Mirrors the identity.json migrate-on-open path.
func shouldMigrate(dataDir string, wasSealed bool) bool {
	return !wasSealed && len(dataDirEncKey(dataDir)) > 0
}
