// Package identity manages the local user's identity in per-user mode.
// The backend only operates on behalf of one user at a time.
package identity

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// UserIdentity holds the local user's AID and mnemonic with thread-safe access.
// It persists to {dataDir}/identity.json so it survives restarts.
type UserIdentity struct {
	mu       sync.RWMutex
	aid      string
	mnemonic string
	peerID   string
	dataDir  string

	// encKey, when non-empty, encrypts identity.json at rest with AES-256-GCM.
	// The key material is handed over by the shell at start from the OS trust
	// root (Android Keystore / iOS Keychain / Electron safeStorage) — the same
	// trust root SecureStorage uses. Empty preserves the legacy plaintext format
	// so dev/test and any not-yet-wired shell are unaffected (issue #117).
	encKey []byte

	// Runtime config fields (set by frontend after fetching org config)
	orgAID                   string
	communitySpaceID         string
	communityReadOnlySpaceID string
	adminSpaceID             string
	privateSpaceID           string
}

// persistedIdentity is the JSON structure written to disk.
type persistedIdentity struct {
	AID                      string `json:"aid"`
	Mnemonic                 string `json:"mnemonic"`
	PeerID                   string `json:"peerId,omitempty"`
	OrgAID                   string `json:"orgAid,omitempty"`
	CommunitySpaceID         string `json:"communitySpaceId,omitempty"`
	CommunityReadOnlySpaceID string `json:"communityReadOnlySpaceId,omitempty"`
	AdminSpaceID             string `json:"adminSpaceId,omitempty"`
	PrivateSpaceID           string `json:"privateSpaceId,omitempty"`
}

// New creates a new UserIdentity bound to the given data directory.
// If an identity file exists on disk, it is loaded automatically.
//
// The identity is persisted in the legacy plaintext JSON format. Prefer
// NewEncrypted on device, where a shell-supplied key encrypts it at rest.
func New(dataDir string) *UserIdentity {
	return NewEncrypted(dataDir, nil)
}

// NewEncrypted creates a UserIdentity that encrypts identity.json at rest with
// the given key material (see UserIdentity.encKey). A nil/empty key falls back
// to the legacy plaintext format, so callers can pass whatever the shell hands
// over without branching. A legacy plaintext file is migrated to encrypted form
// transparently the first time it is opened with a key.
func NewEncrypted(dataDir string, encKey []byte) *UserIdentity {
	ui := &UserIdentity{dataDir: dataDir, encKey: encKey}
	ui.load()
	return ui
}

// SetIdentity sets the user's AID and mnemonic and persists to disk.
func (u *UserIdentity) SetIdentity(aid, mnemonic string) error {
	u.mu.Lock()
	defer u.mu.Unlock()

	u.aid = aid
	u.mnemonic = mnemonic
	return u.persist()
}

// SetPeerID stores the derived peer ID.
func (u *UserIdentity) SetPeerID(peerID string) error {
	u.mu.Lock()
	defer u.mu.Unlock()

	u.peerID = peerID
	return u.persist()
}

// SetOrgConfig stores org-level runtime config fields.
func (u *UserIdentity) SetOrgConfig(orgAID, communitySpaceID string) error {
	u.mu.Lock()
	defer u.mu.Unlock()

	u.orgAID = orgAID
	u.communitySpaceID = communitySpaceID
	return u.persist()
}

// SetPrivateSpaceID stores the user's private space ID.
func (u *UserIdentity) SetPrivateSpaceID(spaceID string) error {
	u.mu.Lock()
	defer u.mu.Unlock()

	u.privateSpaceID = spaceID
	return u.persist()
}

// GetAID returns the current AID (empty if not configured).
func (u *UserIdentity) GetAID() string {
	u.mu.RLock()
	defer u.mu.RUnlock()
	return u.aid
}

// GetMnemonic returns the stored mnemonic (empty if not configured).
func (u *UserIdentity) GetMnemonic() string {
	u.mu.RLock()
	defer u.mu.RUnlock()
	return u.mnemonic
}

// GetPeerID returns the stored peer ID.
func (u *UserIdentity) GetPeerID() string {
	u.mu.RLock()
	defer u.mu.RUnlock()
	return u.peerID
}

// GetOrgAID returns the org AID from runtime config.
func (u *UserIdentity) GetOrgAID() string {
	u.mu.RLock()
	defer u.mu.RUnlock()
	return u.orgAID
}

// GetCommunitySpaceID returns the community space ID from runtime config.
func (u *UserIdentity) GetCommunitySpaceID() string {
	u.mu.RLock()
	defer u.mu.RUnlock()
	return u.communitySpaceID
}

// GetCommunityReadOnlySpaceID returns the community read-only space ID.
func (u *UserIdentity) GetCommunityReadOnlySpaceID() string {
	u.mu.RLock()
	defer u.mu.RUnlock()
	return u.communityReadOnlySpaceID
}

// SetCommunityReadOnlySpaceID stores the community read-only space ID.
func (u *UserIdentity) SetCommunityReadOnlySpaceID(spaceID string) error {
	u.mu.Lock()
	defer u.mu.Unlock()

	u.communityReadOnlySpaceID = spaceID
	return u.persist()
}

// GetAdminSpaceID returns the admin space ID.
func (u *UserIdentity) GetAdminSpaceID() string {
	u.mu.RLock()
	defer u.mu.RUnlock()
	return u.adminSpaceID
}

// SetAdminSpaceID stores the admin space ID.
func (u *UserIdentity) SetAdminSpaceID(spaceID string) error {
	u.mu.Lock()
	defer u.mu.Unlock()

	u.adminSpaceID = spaceID
	return u.persist()
}

// GetPrivateSpaceID returns the user's private space ID.
func (u *UserIdentity) GetPrivateSpaceID() string {
	u.mu.RLock()
	defer u.mu.RUnlock()
	return u.privateSpaceID
}

// IsConfigured returns true if an AID and mnemonic have been set.
func (u *UserIdentity) IsConfigured() bool {
	u.mu.RLock()
	defer u.mu.RUnlock()
	return u.aid != "" && u.mnemonic != ""
}

// Clear removes the identity and deletes the persisted file.
func (u *UserIdentity) Clear() error {
	u.mu.Lock()
	defer u.mu.Unlock()

	u.aid = ""
	u.mnemonic = ""
	u.peerID = ""
	u.orgAID = ""
	u.communitySpaceID = ""
	u.communityReadOnlySpaceID = ""
	u.adminSpaceID = ""
	u.privateSpaceID = ""

	path := u.filePath()
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("removing identity file: %w", err)
	}
	return nil
}

// filePath returns the path to the identity JSON file.
func (u *UserIdentity) filePath() string {
	return filepath.Join(u.dataDir, "identity.json")
}

// persist writes the current state to disk. Caller must hold u.mu.
func (u *UserIdentity) persist() error {
	data := persistedIdentity{
		AID:                      u.aid,
		Mnemonic:                 u.mnemonic,
		PeerID:                   u.peerID,
		OrgAID:                   u.orgAID,
		CommunitySpaceID:         u.communitySpaceID,
		CommunityReadOnlySpaceID: u.communityReadOnlySpaceID,
		AdminSpaceID:             u.adminSpaceID,
		PrivateSpaceID:           u.privateSpaceID,
	}

	bytes, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return fmt.Errorf("marshaling identity: %w", err)
	}

	if len(u.encKey) > 0 {
		bytes, err = encrypt(bytes, u.encKey)
		if err != nil {
			return fmt.Errorf("encrypting identity: %w", err)
		}
	}

	if err := os.MkdirAll(u.dataDir, 0755); err != nil {
		return fmt.Errorf("creating data directory: %w", err)
	}

	if err := os.WriteFile(u.filePath(), bytes, 0600); err != nil {
		return fmt.Errorf("writing identity file: %w", err)
	}

	return nil
}

// load reads identity from disk if available. Does not return errors
// because missing identity is normal (first boot).
func (u *UserIdentity) load() {
	raw, err := os.ReadFile(u.filePath())
	if err != nil {
		return // File doesn't exist yet — normal for first boot
	}

	// migrate is set when a legacy plaintext file is opened with a key, so we
	// rewrite it encrypted below.
	migrate := false
	bytes := raw
	switch {
	case isEncrypted(raw):
		if len(u.encKey) == 0 {
			fmt.Printf("Warning: identity.json is encrypted but no key was supplied; identity not loaded\n")
			return
		}
		bytes, err = decrypt(raw, u.encKey)
		if err != nil {
			// Wrong key or corrupt file: stay unconfigured rather than boot with
			// a half-loaded identity. The frontend still holds the mnemonic in
			// secure storage and can re-run /api/v1/identity/set.
			fmt.Printf("Warning: failed to decrypt identity.json: %v\n", err)
			return
		}
	case len(u.encKey) > 0:
		// Legacy plaintext file, but we now have a key — migrate on load.
		migrate = true
	}

	var data persistedIdentity
	if err := json.Unmarshal(bytes, &data); err != nil {
		fmt.Printf("Warning: failed to parse identity.json: %v\n", err)
		return
	}

	u.aid = data.AID
	u.mnemonic = data.Mnemonic
	u.peerID = data.PeerID
	u.orgAID = data.OrgAID
	u.communitySpaceID = data.CommunitySpaceID
	u.communityReadOnlySpaceID = data.CommunityReadOnlySpaceID
	u.adminSpaceID = data.AdminSpaceID
	u.privateSpaceID = data.PrivateSpaceID

	if migrate {
		if err := u.persist(); err != nil {
			fmt.Printf("Warning: failed to migrate identity.json to encrypted form: %v\n", err)
		}
	}
}
