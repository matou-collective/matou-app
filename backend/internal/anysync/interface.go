// Package anysync provides any-sync integration for MATOU.
// interface.go defines the common interface for any-sync clients.
package anysync

import (
	"context"

	"github.com/anyproto/any-sync/commonspace"
	"github.com/anyproto/any-sync/commonspace/object/acl/list"
	"github.com/anyproto/any-sync/net/pool"
	"github.com/anyproto/any-sync/nodeconf"
	"github.com/anyproto/any-sync/util/crypto"
)

// AnySyncClient is the common interface implemented by SDKClient.
//
// Renaming this to Client would fix the anysync.AnySyncClient stutter, but the name is
// depended on widely outside this package (internal/api, internal/app, and their tests);
// that broad cross-package rename is beyond this mechanical lint-debt sweep (#349).
//
//nolint:revive // stutter rename deferred — see comment above
type AnySyncClient interface {
	// CreateSpace creates a new space
	CreateSpace(ctx context.Context, ownerAID string, spaceType string, signingKey crypto.PrivKey) (*SpaceCreateResult, error)

	// CreateSpaceWithKeys creates a new space using a full SpaceKeySet.
	// This is the preferred method for creating spaces with proper
	// cryptographic key management.
	CreateSpaceWithKeys(ctx context.Context, ownerAID string, spaceType string, keys *SpaceKeySet) (*SpaceCreateResult, error)

	// GetSpace returns an opened Space by ID. The space must have been
	// previously created via CreateSpace or CreateSpaceWithKeys.
	GetSpace(ctx context.Context, spaceID string) (commonspace.Space, error)

	// DeriveSpace creates a deterministic space
	DeriveSpace(ctx context.Context, ownerAID string, spaceType string, signingKey crypto.PrivKey) (*SpaceCreateResult, error)

	// DeriveSpaceID returns the deterministic space ID without creating
	DeriveSpaceID(ctx context.Context, ownerAID string, spaceType string, signingKey crypto.PrivKey) (string, error)

	// Deprecated: AddToACL builds raw JSON as a proto record which is rejected
	// by the consensus node. Use MatouACLManager.CreateOpenInvite/JoinWithInvite instead.
	AddToACL(ctx context.Context, spaceID string, peerID string, permissions []string) error

	// SyncDocument syncs a document to a space
	SyncDocument(ctx context.Context, spaceID string, docID string, data []byte) error

	// GetNetworkID returns the any-sync network ID
	GetNetworkID() string

	// GetCoordinatorURL returns the coordinator address
	GetCoordinatorURL() string

	// GetPeerID returns the client's peer ID
	GetPeerID() string

	// GetSigningKey returns the client's signing private key (peer key)
	GetSigningKey() crypto.PrivKey

	// GetDataDir returns the data directory path
	GetDataDir() string

	// MakeSpaceShareable marks a space as shareable on the coordinator,
	// enabling ACL invite operations. Must be called before CreateOpenInvite.
	MakeSpaceShareable(ctx context.Context, spaceID string) error

	// GetPool returns the connection pool for dRPC peer communication.
	GetPool() pool.Pool

	// GetNodeConf returns the node configuration service for peer discovery.
	GetNodeConf() nodeconf.Service

	// SetAccountFileLimits sets the file storage limit for an account identity
	// on the coordinator. Must be called before uploading files via the filenode.
	SetAccountFileLimits(ctx context.Context, identity string, limitBytes uint64) error

	// Ping tests connectivity to the any-sync network
	Ping() error

	// Close shuts down the client
	Close() error
}

// InviteManager manages ACL invitations for any-sync spaces using the SDK's
// AclRecordBuilder. It supports open invite codes (encrypted read key) and
// join-without-approval flows.
type InviteManager interface {
	// CreateOpenInvite creates an "anyone can join" invite code for a space.
	// Returns the invite private key which should be shared out-of-band.
	CreateOpenInvite(ctx context.Context, spaceID string, permissions list.AclPermissions) (crypto.PrivKey, error)

	// JoinWithInvite joins a space using an invite key obtained out-of-band.
	// The invite key decrypts the space's read key from the invite record.
	JoinWithInvite(ctx context.Context, spaceID string, inviteKey crypto.PrivKey, metadata []byte) error

	// GetPermissions returns a user's permissions in a space.
	GetPermissions(ctx context.Context, spaceID string, identity crypto.PubKey) (list.AclPermissions, error)
}
