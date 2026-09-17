package communityspace

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/anyproto/any-sync/util/crypto"
)

// Space types. A community owns three spaces, created together at fixed
// mnemonic-derived key indexes.
const (
	SpaceTypeCommunity         = "community"
	SpaceTypeCommunityReadOnly = "community-readonly"
	SpaceTypeAdmin             = "admin"
)

// Space key-derivation indexes. Index 0 is the account (ACL identity) / private
// space; the community's three spaces derive their master/metadata keys at these
// indexes. These are part of the convention: every device or platform holding
// the mnemonic must agree on them, so they must never drift.
const (
	CommunitySpaceIndex         uint32 = 1
	CommunityReadOnlySpaceIndex uint32 = 2
	AdminSpaceIndex             uint32 = 3
)

// SpaceCreateResult contains the result of creating a single space.
type SpaceCreateResult struct {
	SpaceID   string       `json:"spaceId"`
	CreatedAt time.Time    `json:"createdAt"`
	OwnerAID  string       `json:"ownerAid"`
	SpaceType string       `json:"spaceType"`
	Keys      *SpaceKeySet `json:"-"` // In-memory only, not serialized
}

// SpaceCreator is the port through which the convention reaches an any-sync
// network. A caller supplies a network-connected client built from the
// coordinator address (this backend passes its *anysync.SDKClient; the IDSS
// founding tail passes the platform's client). Keeping this an interface is what
// lets the module depend on the any-sync libraries only — never on the server's
// wiring.
type SpaceCreator interface {
	// CreateSpaceWithKeys creates a space using a full key set and registers it
	// with the coordinator, returning the assigned space ID.
	CreateSpaceWithKeys(ctx context.Context, ownerAID string, spaceType string, keys *SpaceKeySet) (*SpaceCreateResult, error)

	// MakeSpaceShareable marks a space as shareable on the coordinator, enabling
	// later ACL invite operations.
	MakeSpaceShareable(ctx context.Context, spaceID string) error

	// GetSigningKey returns the mnemonic-derived account (ACL identity) key. It
	// becomes the signing key — hence the ACL owner — of every community space,
	// so the creating account is recognised as owner for invites and grants.
	GetSigningKey() crypto.PrivKey
}

// spaceVerifier is an optional capability a SpaceCreator may implement so the
// convention can reuse an already-created space instead of minting a fresh one.
//
// CreateSpaceWithKeys is NOT idempotent: any-sync hashes a random header seed
// (and, in this backend, a wall-clock timestamp) into a "created" space, so a
// second call with the identical key set lands at a brand-new CID. When org
// setup re-runs on an already-configured account, unconditionally recreating a
// space overwrites the working, propagated ID with a phantom that never fully
// syncs (issue #539). A creator that can answer "does this space still exist on
// the network?" lets CreateCommunitySpaces keep the working ID.
//
// It is discovered by type assertion rather than folded into SpaceCreator so
// existing implementers (e.g. the IDSS founding tail) keep compiling; a creator
// that does not implement it falls back to the previous always-create behaviour.
type spaceVerifier interface {
	// SpaceExists reports whether a space with the given ID already exists and is
	// reachable on the network. An empty spaceID must return false.
	SpaceExists(ctx context.Context, spaceID string) bool
}

// CommunitySpaces holds the IDs of a community's three any-sync spaces.
type CommunitySpaces struct {
	CommunitySpaceID         string
	CommunityReadOnlySpaceID string
	AdminSpaceID             string
}

// CreateCommunitySpaces creates a community's three any-sync spaces from the
// founder's mnemonic and returns their IDs. It is the single home of the
// convention: keys derived at indexes 1/2/3, the ACL owner set to the account
// (index-0) key, and each space made shareable.
//
// It writes no local store, reads no process-wide config and opens no HTTP
// listener — the network connection is entirely the caller's SpaceCreator,
// which was built from the coordinator address. App-specific seeding of profile
// objects is the caller's job (it needs types the convention deliberately does
// not depend on).
//
// The community space is required: if it cannot be created, the returned
// CommunitySpaces has an empty CommunitySpaceID and the error is fatal. The
// read-only and admin spaces are created after; a failure there returns the
// partially-filled CommunitySpaces alongside the error, so a caller that treats
// them as best-effort can inspect which IDs it got.
//
// Re-running setup is safe: pass the previously-known IDs as the optional
// existing argument and any space whose ID still resolves on the network (via
// the creator's optional SpaceExists capability) is kept as-is instead of
// recreated. Only a missing or unreachable space is minted fresh. This makes
// the read-only and admin spaces as resilient to accidental re-creation as the
// community space already was at the handler level, so a re-set never overwrites
// a working ID with a phantom one (issue #539).
func CreateCommunitySpaces(ctx context.Context, creator SpaceCreator, mnemonic, ownerAID string, existing ...*CommunitySpaces) (*CommunitySpaces, error) {
	spaces := &CommunitySpaces{}

	if creator == nil {
		return spaces, errors.New("space creator is required")
	}
	if mnemonic == "" {
		return spaces, errors.New("mnemonic is required")
	}
	if err := ValidateMnemonic(mnemonic); err != nil {
		return spaces, err
	}

	var prior *CommunitySpaces
	if len(existing) > 0 {
		prior = existing[0]
	}

	communityID, err := createOrReuseSpace(ctx, creator, mnemonic, ownerAID, priorID(prior, SpaceTypeCommunity), CommunitySpaceIndex, SpaceTypeCommunity)
	if err != nil {
		return spaces, fmt.Errorf("creating community space: %w", err)
	}
	spaces.CommunitySpaceID = communityID

	readOnlyID, err := createOrReuseSpace(ctx, creator, mnemonic, ownerAID, priorID(prior, SpaceTypeCommunityReadOnly), CommunityReadOnlySpaceIndex, SpaceTypeCommunityReadOnly)
	if err != nil {
		return spaces, fmt.Errorf("creating community-readonly space: %w", err)
	}
	spaces.CommunityReadOnlySpaceID = readOnlyID

	adminID, err := createOrReuseSpace(ctx, creator, mnemonic, ownerAID, priorID(prior, SpaceTypeAdmin), AdminSpaceIndex, SpaceTypeAdmin)
	if err != nil {
		return spaces, fmt.Errorf("creating admin space: %w", err)
	}
	spaces.AdminSpaceID = adminID

	return spaces, nil
}

// priorID returns the previously-known ID for a space type, or "" if none.
func priorID(prior *CommunitySpaces, spaceType string) string {
	if prior == nil {
		return ""
	}
	switch spaceType {
	case SpaceTypeCommunity:
		return prior.CommunitySpaceID
	case SpaceTypeCommunityReadOnly:
		return prior.CommunityReadOnlySpaceID
	case SpaceTypeAdmin:
		return prior.AdminSpaceID
	default:
		return ""
	}
}

// createOrReuseSpace reuses existingID when it still resolves on the network,
// otherwise creates the space at spaceIndex. Reuse keeps a working, propagated
// space ID stable across re-runs of setup (issue #539); recreation is the
// previous behaviour for a missing or unreachable space.
func createOrReuseSpace(ctx context.Context, creator SpaceCreator, mnemonic, ownerAID, existingID string, spaceIndex uint32, spaceType string) (string, error) {
	if existingID != "" {
		if verifier, ok := creator.(spaceVerifier); ok && verifier.SpaceExists(ctx, existingID) {
			// Keep the space shareable (idempotent, best-effort) so a reused space
			// is as invite-ready as a freshly created one.
			_ = creator.MakeSpaceShareable(ctx, existingID)
			return existingID, nil
		}
	}
	return createSpaceAtIndex(ctx, creator, mnemonic, ownerAID, spaceIndex, spaceType)
}

// createSpaceAtIndex derives the key set for spaceIndex, pins the ACL owner to
// the account (index-0) signing key, creates the space and makes it shareable.
func createSpaceAtIndex(ctx context.Context, creator SpaceCreator, mnemonic, ownerAID string, spaceIndex uint32, spaceType string) (string, error) {
	keys, err := DeriveSpaceKeySet(mnemonic, spaceIndex)
	if err != nil {
		return "", fmt.Errorf("deriving keys: %w", err)
	}

	// Use the account (ACL identity) key as the space signing key so the creating
	// account is the ACL owner. The account key is the mnemonic index-0 key, which
	// the connected client also uses as its identity — so ownership resolves.
	keys.SigningKey = creator.GetSigningKey()

	result, err := creator.CreateSpaceWithKeys(ctx, ownerAID, spaceType, keys)
	if err != nil {
		return "", err
	}

	// Making the space shareable is best-effort here: it is idempotent and is
	// re-attempted on the coordinator before every invite/join. A transient
	// failure must not sink an otherwise-created space.
	_ = creator.MakeSpaceShareable(ctx, result.SpaceID)

	return result.SpaceID, nil
}
