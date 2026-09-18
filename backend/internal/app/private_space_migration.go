package app

import (
	"context"
	"fmt"
	"log"
	"sort"
	"time"

	"github.com/anyproto/any-sync/util/crypto"

	"github.com/matou-dao/backend/internal/anysync"
)

// spaceTypePrivateLegacy retypes the local space record of a private space that
// has been migrated away from. The space store answers "which is this user's
// private space" by owner + type "private" (GetUserSpace), so the legacy record
// must stop matching once the derived space has taken over. The record is kept —
// it is the only pointer to the legacy space, which is never deleted.
const spaceTypePrivateLegacy = "private-legacy"

const (
	// privateSpaceMigrationBootTimeout bounds the synchronous attempt made
	// before the API starts serving. Everything it does is local (the legacy
	// space is already on disk and a derived space is created locally), so this
	// is generous; it only guards a wedged store from blocking the boot.
	privateSpaceMigrationBootTimeout = 30 * time.Second
	// privateSpaceMigrationRetryEvery paces background retries after a failed
	// boot attempt.
	privateSpaceMigrationRetryEvery = 2 * time.Minute
)

// The interfaces below are the narrow slices of the identity, SDK client and
// tree managers the migrator consumes, declared so it can be unit-tested with
// fakes (*identity.UserIdentity, *anysync.SDKClient + *UnifiedTreeManager, and
// the three tree managers satisfy them in production).
type migrationIdentity interface {
	GetAID() string
	GetMnemonic() string
	GetPrivateSpaceID() string
	SetPrivateSpaceID(spaceID string) error
}

type migrationSpaces interface {
	DeriveSpaceIDWithKeys(ctx context.Context, ownerAID string, spaceType string, keys *anysync.SpaceKeySet) (string, error)
	DeriveSpaceWithKeys(ctx context.Context, ownerAID string, spaceType string, keys *anysync.SpaceKeySet) (*anysync.SpaceCreateResult, error)
	BuildSpaceIndex(ctx context.Context, spaceID string) error
	StoredTreeIDs(ctx context.Context, spaceID string) ([]string, error)
	ForgetSpace(spaceID string)
	RetireSpace(spaceID string)
	ReviveSpace(spaceID string)
}

type migrationObjects interface {
	ReadObjects(ctx context.Context, spaceID string) ([]*anysync.ObjectPayload, error)
	AddObject(ctx context.Context, spaceID string, payload *anysync.ObjectPayload, signingKey crypto.PrivKey) (string, error)
}

type migrationSaves interface {
	ReadSaves(ctx context.Context, spaceID string) ([]*anysync.NoticeSavePayload, error)
	CreateSave(ctx context.Context, spaceID string, save *anysync.NoticeSavePayload, signingKey crypto.PrivKey) (string, error)
}

type migrationCredentials interface {
	ReadCredentials(ctx context.Context, spaceID string) ([]*anysync.CredentialPayload, error)
	AddCredential(ctx context.Context, spaceID string, cred *anysync.CredentialPayload, signingKey crypto.PrivKey) (string, error)
}

type migrationSpaceStore interface {
	SaveSpace(ctx context.Context, space *anysync.Space) error
	ListAllSpaces(ctx context.Context) ([]*anysync.Space, error)
}

// privateSpaceMigrator moves a pre-#526 account's private space to the id every
// device can compute (#508 item 3).
//
// Before #526 the private space was created with CreateSpaceWithKeys, whose id
// hashes a timestamp: only the device that created it knows where it is
// (identity.json is local). Link mode pulls the mnemonic-derived id and never
// creates, so such an account can never be linked — the pull misses forever —
// and a recovery on a fresh device starts an empty private space. Since linking
// never worked for these accounts, the device holding identity.json is the one
// place the legacy id is known, so that device migrates: it creates the derived
// space, copies the latest state of every object, notice save and credential
// into it, and repoints identity.json.
//
// The copy is at the application level (latest state, not change history): a
// tree's root is bound to its space, so trees cannot be moved between spaces.
// Private-space content is single-author state, so nothing but history is lost.
//
// The legacy space is only ever read. The snapshot must account for every tree
// the legacy space holds in storage, or the run aborts: the Read* helpers skip a
// tree they cannot build, and repointing after a partial read would strand it.
// identity.json is repointed last, after every copy succeeded and the local
// space records were put right, so a failed or interrupted run leaves the
// account on the legacy space and the next run starts over; re-running is safe
// (objects upsert by id, saves and credentials are skipped when already present).
type privateSpaceMigrator struct {
	identity    migrationIdentity
	spaces      migrationSpaces
	objects     migrationObjects
	saves       migrationSaves
	credentials migrationCredentials
	store       migrationSpaceStore

	// deriveKeys returns the mnemonic-derived private-space key set — the same
	// derivation POST /api/v1/identity/set uses, so the id computed here is the
	// id a linking or recovering device will compute.
	deriveKeys func(mnemonic string) (*anysync.SpaceKeySet, error)
}

// run performs one migration pass. It returns migrated=true only when the
// private space was moved by this call; an account that is already on its
// derived space, or a backend with no identity yet, is (false, nil).
func (m *privateSpaceMigrator) run(ctx context.Context) (migrated bool, err error) {
	aid := m.identity.GetAID()
	mnemonic := m.identity.GetMnemonic()
	legacyID := m.identity.GetPrivateSpaceID()
	if aid == "" || mnemonic == "" || legacyID == "" {
		return false, nil
	}

	keys, err := m.deriveKeys(mnemonic)
	if err != nil {
		return false, fmt.Errorf("deriving private space keys: %w", err)
	}
	derivedID, err := m.spaces.DeriveSpaceIDWithKeys(ctx, aid, anysync.SpaceTypePrivate, keys)
	if err != nil {
		return false, fmt.Errorf("deriving private space id: %w", err)
	}
	if derivedID == legacyID {
		// Nothing to migrate — but a run that died right after the repoint can
		// have left a second record typed private behind.
		if err := m.retireOtherPrivateRecords(ctx, aid, derivedID); err != nil {
			log.Printf("[private-space-migration] warning: %v", err)
		}
		return false, nil
	}

	log.Printf("[private-space-migration] private space %s is not at the derived id %s — migrating", legacyID, derivedID)

	// 1. Snapshot the legacy space.
	if err := m.spaces.BuildSpaceIndex(ctx, legacyID); err != nil {
		return false, fmt.Errorf("indexing legacy private space: %w", err)
	}
	objects, err := m.objects.ReadObjects(ctx, legacyID)
	if err != nil {
		return false, fmt.Errorf("reading legacy objects: %w", err)
	}
	saves, err := m.saves.ReadSaves(ctx, legacyID)
	if err != nil {
		return false, fmt.Errorf("reading legacy notice saves: %w", err)
	}
	creds, err := m.credentials.ReadCredentials(ctx, legacyID)
	if err != nil {
		return false, fmt.Errorf("reading legacy credentials: %w", err)
	}

	stored, err := m.spaces.StoredTreeIDs(ctx, legacyID)
	if err != nil {
		return false, fmt.Errorf("listing legacy trees: %w", err)
	}
	read := make(map[string]bool, len(objects)+len(saves)+len(creds))
	for _, o := range objects {
		read[o.TreeID] = true
	}
	for _, sv := range saves {
		read[sv.TreeID] = true
	}
	for _, c := range creds {
		read[c.TreeID] = true
	}
	var unread []string
	for _, id := range stored {
		if !read[id] {
			unread = append(unread, id)
		}
	}
	if len(unread) > 0 {
		return false, fmt.Errorf("legacy private space holds %d tree(s) the snapshot could not read, refusing to migrate without them: %v", len(unread), unread)
	}

	// 2. Create (or reopen — deriving an existing id is idempotent) the space at
	// the derived id. This also persists its key set.
	if _, err := m.spaces.DeriveSpaceWithKeys(ctx, aid, anysync.SpaceTypePrivate, keys); err != nil {
		return false, fmt.Errorf("creating derived private space: %w", err)
	}

	// 3. The tree index maps object ids to trees globally, not per space. Retire
	// the legacy space so the writes below land in the derived space instead of
	// resolving to (and updating) the legacy trees, then index whatever an
	// interrupted earlier run already copied. If the run fails from here on the
	// account stays on the legacy space, so hand the object ids back to it.
	m.spaces.RetireSpace(legacyID)
	defer func() {
		if migrated {
			return
		}
		m.spaces.ForgetSpace(derivedID)
		m.spaces.ReviveSpace(legacyID)
		if idxErr := m.spaces.BuildSpaceIndex(ctx, legacyID); idxErr != nil {
			log.Printf("[private-space-migration] warning: re-indexing legacy private space after a failed run: %v", idxErr)
		}
	}()
	if err := m.spaces.BuildSpaceIndex(ctx, derivedID); err != nil {
		return false, fmt.Errorf("indexing derived private space: %w", err)
	}

	// 4. Copy. Type definitions first: profile writes validate against them.
	sort.SliceStable(objects, func(i, j int) bool {
		return objects[i].Type == "type_definition" && objects[j].Type != "type_definition"
	})
	for _, obj := range objects {
		if _, err := m.objects.AddObject(ctx, derivedID, obj, keys.SigningKey); err != nil {
			return false, fmt.Errorf("copying object %s: %w", obj.ID, err)
		}
	}

	existingSaves, err := m.saves.ReadSaves(ctx, derivedID)
	if err != nil {
		return false, fmt.Errorf("reading derived notice saves: %w", err)
	}
	haveSave := make(map[string]bool, len(existingSaves))
	for _, s := range existingSaves {
		haveSave[s.NoticeID] = true
	}
	for _, s := range saves {
		// CreateSave on an existing save is a toggle, not an upsert.
		if haveSave[s.NoticeID] {
			continue
		}
		if _, err := m.saves.CreateSave(ctx, derivedID, s, keys.SigningKey); err != nil {
			return false, fmt.Errorf("copying notice save %s: %w", s.NoticeID, err)
		}
	}

	existingCreds, err := m.credentials.ReadCredentials(ctx, derivedID)
	if err != nil {
		return false, fmt.Errorf("reading derived credentials: %w", err)
	}
	haveCred := make(map[string]bool, len(existingCreds))
	for _, c := range existingCreds {
		haveCred[c.SAID] = true
	}
	for _, c := range creds {
		// AddCredential always mints a new tree.
		if haveCred[c.SAID] {
			continue
		}
		if _, err := m.credentials.AddCredential(ctx, derivedID, c, keys.SigningKey); err != nil {
			return false, fmt.Errorf("copying credential %s: %w", c.SAID, err)
		}
	}

	// 5. Commit. GetUserSpace resolves a user's private space by owner + type
	// and takes the first match — credential routing relies on it and never
	// consults identity.json — so the records are put right first, as hard
	// errors, and identity.json is repointed last. If the repoint then fails the
	// account stays on the legacy space while routed credentials land in the
	// derived one; the retry copies everything again, so nothing is lost.
	if err := m.store.SaveSpace(ctx, &anysync.Space{
		SpaceID:   derivedID,
		OwnerAID:  aid,
		SpaceType: anysync.SpaceTypePrivate,
	}); err != nil {
		return false, fmt.Errorf("saving derived space record: %w", err)
	}
	if err := m.retireOtherPrivateRecords(ctx, aid, derivedID); err != nil {
		return false, err
	}
	if err := m.identity.SetPrivateSpaceID(derivedID); err != nil {
		return false, fmt.Errorf("repointing identity at derived private space: %w", err)
	}

	log.Printf("[private-space-migration] migrated private space %s -> %s (%d objects, %d notice saves, %d credentials); legacy space kept",
		legacyID, derivedID, len(objects), len(saves), len(creds))
	return true, nil
}

// retireOtherPrivateRecords retypes every local space record that claims to be
// this user's private space but is not the derived one, keeping its other
// fields. The record stays as the only pointer to the (never deleted) legacy
// space; the store has no delete, and needs none.
func (m *privateSpaceMigrator) retireOtherPrivateRecords(ctx context.Context, aid, derivedID string) error {
	records, err := m.store.ListAllSpaces(ctx)
	if err != nil {
		return fmt.Errorf("listing space records: %w", err)
	}
	for _, rec := range records {
		if rec == nil || rec.OwnerAID != aid || rec.SpaceType != anysync.SpaceTypePrivate || rec.SpaceID == derivedID {
			continue
		}
		retired := *rec
		retired.SpaceType = spaceTypePrivateLegacy
		if err := m.store.SaveSpace(ctx, &retired); err != nil {
			return fmt.Errorf("retiring legacy space record %s: %w", rec.SpaceID, err)
		}
	}
	return nil
}

// runAtBoot makes one bounded attempt before the API starts serving, so in the
// common case no request ever sees the legacy id. It reports whether the
// background loop still has work to do. A backend with no identity yet needs no
// watching: every identity/set mode lands the private space on its derived id.
func (m *privateSpaceMigrator) runAtBoot(ctx context.Context) (pending bool) {
	ctx, cancel := context.WithTimeout(ctx, privateSpaceMigrationBootTimeout)
	defer cancel()
	if _, err := m.safeRun(ctx); err != nil {
		log.Printf("[private-space-migration] boot attempt failed, will retry in the background: %v", err)
		return true
	}
	return false
}

// retryUntilDone re-runs the migration until it succeeds or ctx ends.
func (m *privateSpaceMigrator) retryUntilDone(ctx context.Context) {
	ticker := time.NewTicker(privateSpaceMigrationRetryEvery)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		if _, err := m.safeRun(ctx); err != nil {
			log.Printf("[private-space-migration] retry failed: %v", err)
			continue
		}
		return
	}
}

// safeRun is run with panics converted to errors: a migration bug must never
// take the backend down at boot.
func (m *privateSpaceMigrator) safeRun(ctx context.Context) (migrated bool, err error) {
	defer func() {
		if rec := recover(); rec != nil {
			migrated, err = false, fmt.Errorf("panic: %v", rec)
		}
	}()
	return m.run(ctx)
}

// migrationSpacesAdapter joins the SDK client (space derivation) and the tree
// manager (indexing) behind migrationSpaces.
type migrationSpacesAdapter struct {
	*anysync.SDKClient
	utm *anysync.UnifiedTreeManager
}

func (a migrationSpacesAdapter) BuildSpaceIndex(ctx context.Context, spaceID string) error {
	return a.utm.BuildSpaceIndex(ctx, spaceID)
}

func (a migrationSpacesAdapter) StoredTreeIDs(ctx context.Context, spaceID string) ([]string, error) {
	return a.utm.StoredTreeIDs(ctx, spaceID)
}

func (a migrationSpacesAdapter) ForgetSpace(spaceID string) { a.utm.ForgetSpace(spaceID) }
func (a migrationSpacesAdapter) RetireSpace(spaceID string) { a.utm.RetireSpace(spaceID) }
func (a migrationSpacesAdapter) ReviveSpace(spaceID string) { a.utm.ReviveSpace(spaceID) }
