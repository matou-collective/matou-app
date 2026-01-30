// Package anysync provides any-sync integration for MATOU.
// interface.go defines the common interface for any-sync clients.
package anysync

import (
	"context"

	"github.com/anyproto/any-sync/commonspace"
	"github.com/anyproto/any-sync/commonspace/object/acl/list"
	"github.com/anyproto/any-sync/util/crypto"
)

// AnySyncClient is the common interface implemented by both
// Client (local mode) and SDKClient (full network mode)
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

	// AddToACL adds a peer to a space's access control list
	AddToACL(ctx context.Context, spaceID string, peerID string, permissions []string) error

	// SyncDocument syncs a document to a space
	SyncDocument(ctx context.Context, spaceID string, docID string, data []byte) error

	// GetNetworkID returns the any-sync network ID
	GetNetworkID() string

	// GetCoordinatorURL returns the coordinator address
	GetCoordinatorURL() string

	// GetPeerID returns the client's peer ID
	GetPeerID() string

	// GetDataDir returns the data directory path
	GetDataDir() string

	// MakeSpaceShareable marks a space as shareable on the coordinator,
	// enabling ACL invite operations. Must be called before CreateOpenInvite.
	MakeSpaceShareable(ctx context.Context, spaceID string) error

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
