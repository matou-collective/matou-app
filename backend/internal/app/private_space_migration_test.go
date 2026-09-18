package app

import (
	"context"
	"errors"
	"testing"

	"github.com/anyproto/any-sync/util/crypto"

	"github.com/matou-dao/backend/internal/anysync"
)

const (
	migAID       = "EAbcMigrationAid"
	migLegacyID  = "bafyLEGACY.rep"
	migDerivedID = "bafyDERIVED.rep"
)

// fakeMigrationIdentity stands in for *identity.UserIdentity.
type fakeMigrationIdentity struct {
	aid, mnemonic, privateSpaceID string
	setErr                        error
	sets                          []string
}

func (f *fakeMigrationIdentity) GetAID() string            { return f.aid }
func (f *fakeMigrationIdentity) GetMnemonic() string       { return f.mnemonic }
func (f *fakeMigrationIdentity) GetPrivateSpaceID() string { return f.privateSpaceID }
func (f *fakeMigrationIdentity) SetPrivateSpaceID(id string) error {
	if f.setErr != nil {
		return f.setErr
	}
	f.sets = append(f.sets, id)
	f.privateSpaceID = id
	return nil
}

// fakeMigrationSpaces stands in for the SDK client + tree index. It records the
// order of the calls that matter so the tests can pin "forget the legacy index
// before writing" and "repoint last".
type fakeMigrationSpaces struct {
	derivedID  string
	deriveErr  error
	indexErr   map[string]error
	calls      *[]string
	derivedFor []string
}

func (f *fakeMigrationSpaces) DeriveSpaceIDWithKeys(_ context.Context, _ string, _ string, _ *anysync.SpaceKeySet) (string, error) {
	return f.derivedID, nil
}

func (f *fakeMigrationSpaces) DeriveSpaceWithKeys(_ context.Context, aid string, _ string, keys *anysync.SpaceKeySet) (*anysync.SpaceCreateResult, error) {
	*f.calls = append(*f.calls, "derive")
	if f.deriveErr != nil {
		return nil, f.deriveErr
	}
	f.derivedFor = append(f.derivedFor, aid)
	return &anysync.SpaceCreateResult{SpaceID: f.derivedID, Keys: keys}, nil
}

func (f *fakeMigrationSpaces) BuildSpaceIndex(_ context.Context, spaceID string) error {
	*f.calls = append(*f.calls, "index:"+spaceID)
	return f.indexErr[spaceID]
}

func (f *fakeMigrationSpaces) ForgetSpace(spaceID string) {
	*f.calls = append(*f.calls, "forget:"+spaceID)
}

func (f *fakeMigrationSpaces) RetireSpace(spaceID string) {
	*f.calls = append(*f.calls, "retire:"+spaceID)
}

func (f *fakeMigrationSpaces) ReviveSpace(spaceID string) {
	*f.calls = append(*f.calls, "revive:"+spaceID)
}

// fakeMigrationContent stands in for the object / notice-save / credential tree
// managers, keyed by space id.
type fakeMigrationContent struct {
	objects  map[string][]*anysync.ObjectPayload
	saves    map[string][]*anysync.NoticeSavePayload
	creds    map[string][]*anysync.CredentialPayload
	writeErr error
	calls    *[]string
}

func newFakeMigrationContent(calls *[]string) *fakeMigrationContent {
	return &fakeMigrationContent{
		objects: map[string][]*anysync.ObjectPayload{},
		saves:   map[string][]*anysync.NoticeSavePayload{},
		creds:   map[string][]*anysync.CredentialPayload{},
		calls:   calls,
	}
}

func (f *fakeMigrationContent) ReadObjects(_ context.Context, spaceID string) ([]*anysync.ObjectPayload, error) {
	return f.objects[spaceID], nil
}

func (f *fakeMigrationContent) AddObject(_ context.Context, spaceID string, p *anysync.ObjectPayload, _ crypto.PrivKey) (string, error) {
	*f.calls = append(*f.calls, "object:"+p.ID)
	if f.writeErr != nil {
		return "", f.writeErr
	}
	for i, existing := range f.objects[spaceID] {
		if existing.ID == p.ID {
			f.objects[spaceID][i] = p
			return "head", nil
		}
	}
	f.objects[spaceID] = append(f.objects[spaceID], p)
	return "head", nil
}

func (f *fakeMigrationContent) ReadSaves(_ context.Context, spaceID string) ([]*anysync.NoticeSavePayload, error) {
	return f.saves[spaceID], nil
}

func (f *fakeMigrationContent) CreateSave(_ context.Context, spaceID string, s *anysync.NoticeSavePayload, _ crypto.PrivKey) (string, error) {
	*f.calls = append(*f.calls, "save:"+s.NoticeID)
	f.saves[spaceID] = append(f.saves[spaceID], s)
	return "tree", nil
}

func (f *fakeMigrationContent) ReadCredentials(_ context.Context, spaceID string) ([]*anysync.CredentialPayload, error) {
	return f.creds[spaceID], nil
}

func (f *fakeMigrationContent) AddCredential(_ context.Context, spaceID string, c *anysync.CredentialPayload, _ crypto.PrivKey) (string, error) {
	*f.calls = append(*f.calls, "cred:"+c.SAID)
	f.creds[spaceID] = append(f.creds[spaceID], c)
	return "tree", nil
}

// fakeMigrationStore stands in for the local space-record store.
type fakeMigrationStore struct {
	saved []*anysync.Space
}

func (f *fakeMigrationStore) SaveSpace(_ context.Context, s *anysync.Space) error {
	f.saved = append(f.saved, s)
	return nil
}

type migrationHarness struct {
	identity *fakeMigrationIdentity
	spaces   *fakeMigrationSpaces
	content  *fakeMigrationContent
	store    *fakeMigrationStore
	calls    *[]string
	m        *privateSpaceMigrator
}

func newMigrationHarness() *migrationHarness {
	calls := &[]string{}
	h := &migrationHarness{
		identity: &fakeMigrationIdentity{aid: migAID, mnemonic: "twelve words", privateSpaceID: migLegacyID},
		spaces:   &fakeMigrationSpaces{derivedID: migDerivedID, calls: calls, indexErr: map[string]error{}},
		content:  newFakeMigrationContent(calls),
		store:    &fakeMigrationStore{},
		calls:    calls,
	}
	h.m = &privateSpaceMigrator{
		identity:    h.identity,
		spaces:      h.spaces,
		objects:     h.content,
		saves:       h.content,
		credentials: h.content,
		store:       h.store,
		deriveKeys: func(string) (*anysync.SpaceKeySet, error) {
			return &anysync.SpaceKeySet{}, nil
		},
	}
	return h
}

func lastIndexOf(calls []string, want string) int {
	for i := len(calls) - 1; i >= 0; i-- {
		if calls[i] == want {
			return i
		}
	}
	return -1
}

func indexOf(calls []string, want string) int {
	for i, c := range calls {
		if c == want {
			return i
		}
	}
	return -1
}

// TestPrivateSpaceMigrationCopiesLegacyContentAndRepoints is the #508 item-3
// regression: an account whose private space sits at a CreateSpace-shaped
// (timestamp-hashed) id must end up with all of its private content at the
// mnemonic-derived id — the only id a linked or recovering device can compute —
// and with identity.json pointing there.
func TestPrivateSpaceMigrationCopiesLegacyContentAndRepoints(t *testing.T) {
	h := newMigrationHarness()
	h.content.objects[migLegacyID] = []*anysync.ObjectPayload{
		{ID: "PrivateProfile-" + migAID, Type: "PrivateProfile", Data: []byte(`{"membershipCredentialSAID":"ESaid"}`)},
		{ID: "typedef-PrivateProfile-1", Type: "type_definition", Data: []byte(`{}`)},
		{ID: "ChatCursor-x", Type: "ChatReadCursor", Data: []byte(`{"at":1}`)},
	}
	h.content.saves[migLegacyID] = []*anysync.NoticeSavePayload{{NoticeID: "n1", UserID: migAID, Pinned: true}}
	h.content.creds[migLegacyID] = []*anysync.CredentialPayload{{SAID: "ESaid", Recipient: migAID}}

	migrated, err := h.m.run(context.Background())
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if !migrated {
		t.Fatal("expected migrated=true")
	}

	if got := len(h.content.objects[migDerivedID]); got != 3 {
		t.Errorf("derived space objects = %d, want 3", got)
	}
	if got := len(h.content.saves[migDerivedID]); got != 1 {
		t.Errorf("derived space saves = %d, want 1", got)
	}
	if got := len(h.content.creds[migDerivedID]); got != 1 {
		t.Errorf("derived space credentials = %d, want 1", got)
	}
	if h.identity.privateSpaceID != migDerivedID {
		t.Errorf("identity private space = %q, want %q", h.identity.privateSpaceID, migDerivedID)
	}

	// The legacy space is kept (never deleted) — but its contents must be read
	// untouched, so nothing may have been written to it.
	if got := len(h.content.objects[migLegacyID]); got != 3 {
		t.Errorf("legacy space objects = %d, want 3 (untouched)", got)
	}

	calls := *h.calls
	// Type definitions go first: profile writes validate against them.
	if td, pp := indexOf(calls, "object:typedef-PrivateProfile-1"), indexOf(calls, "object:PrivateProfile-"+migAID); td < 0 || pp < 0 || td > pp {
		t.Errorf("type definition must be written before the profile, calls=%v", calls)
	}
	// The tree index maps object ids globally, so the legacy space must be
	// retired before the same object ids are written into the derived space —
	// otherwise AddObject resolves them to the legacy trees.
	retire := indexOf(calls, "retire:"+migLegacyID)
	firstWrite := indexOf(calls, "object:typedef-PrivateProfile-1")
	if retire < 0 || retire > firstWrite {
		t.Errorf("legacy space must be retired before the first write, calls=%v", calls)
	}
	// ...and stay retired: the account no longer lives there.
	if indexOf(calls, "revive:"+migLegacyID) >= 0 {
		t.Errorf("legacy space must stay retired after a successful migration, calls=%v", calls)
	}
}

// The local space store answers "which is this user's private space" by owner +
// type, so the derived record must be the only one typed private afterwards.
func TestPrivateSpaceMigrationRetypesLegacySpaceRecord(t *testing.T) {
	h := newMigrationHarness()

	if _, err := h.m.run(context.Background()); err != nil {
		t.Fatalf("run: %v", err)
	}

	byID := map[string]string{}
	for _, s := range h.store.saved {
		byID[s.SpaceID] = s.SpaceType
		if s.OwnerAID != migAID {
			t.Errorf("space record %s owner = %q, want %q", s.SpaceID, s.OwnerAID, migAID)
		}
	}
	if byID[migDerivedID] != anysync.SpaceTypePrivate {
		t.Errorf("derived record type = %q, want %q", byID[migDerivedID], anysync.SpaceTypePrivate)
	}
	if byID[migLegacyID] != spaceTypePrivateLegacy {
		t.Errorf("legacy record type = %q, want %q", byID[migLegacyID], spaceTypePrivateLegacy)
	}
}

func TestPrivateSpaceMigrationNoOpWhenAlreadyDerived(t *testing.T) {
	h := newMigrationHarness()
	h.identity.privateSpaceID = migDerivedID

	migrated, err := h.m.run(context.Background())
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if migrated {
		t.Error("expected migrated=false for an already-derived private space")
	}
	if len(*h.calls) != 0 {
		t.Errorf("expected no side effects, got %v", *h.calls)
	}
}

func TestPrivateSpaceMigrationNoOpWithoutIdentity(t *testing.T) {
	for name, mutate := range map[string]func(*fakeMigrationIdentity){
		"no aid":           func(i *fakeMigrationIdentity) { i.aid = "" },
		"no mnemonic":      func(i *fakeMigrationIdentity) { i.mnemonic = "" },
		"no private space": func(i *fakeMigrationIdentity) { i.privateSpaceID = "" },
	} {
		t.Run(name, func(t *testing.T) {
			h := newMigrationHarness()
			mutate(h.identity)
			migrated, err := h.m.run(context.Background())
			if err != nil || migrated {
				t.Errorf("run = (%v, %v), want (false, nil)", migrated, err)
			}
			if len(*h.calls) != 0 {
				t.Errorf("expected no side effects, got %v", *h.calls)
			}
		})
	}
}

// A failure anywhere before the repoint must leave identity.json on the legacy
// space, so the account keeps working and the next run retries.
func TestPrivateSpaceMigrationFailureKeepsLegacyPointer(t *testing.T) {
	cases := map[string]func(*migrationHarness){
		"legacy space cannot be indexed": func(h *migrationHarness) {
			h.spaces.indexErr[migLegacyID] = errors.New("space not open")
		},
		"derived space cannot be created": func(h *migrationHarness) {
			h.spaces.deriveErr = errors.New("offline")
		},
		"copy fails": func(h *migrationHarness) {
			h.content.objects[migLegacyID] = []*anysync.ObjectPayload{{ID: "o1", Type: "PrivateProfile", Data: []byte(`{}`)}}
			h.content.writeErr = errors.New("write rejected")
		},
	}
	for name, arrange := range cases {
		t.Run(name, func(t *testing.T) {
			h := newMigrationHarness()
			arrange(h)

			migrated, err := h.m.run(context.Background())
			if err == nil {
				t.Fatal("expected an error")
			}
			if migrated {
				t.Error("expected migrated=false")
			}
			if h.identity.privateSpaceID != migLegacyID {
				t.Errorf("identity private space = %q, want it left on %q", h.identity.privateSpaceID, migLegacyID)
			}
			for _, s := range h.store.saved {
				if s.SpaceID == migLegacyID {
					t.Errorf("legacy space record must not be retyped on failure, saved %+v", s)
				}
			}
			// The account stays on the legacy space, so once it was retired it
			// must be revived and re-indexed or its objects become unreadable.
			calls := *h.calls
			if retire := indexOf(calls, "retire:"+migLegacyID); retire >= 0 {
				revive := indexOf(calls, "revive:"+migLegacyID)
				if revive < retire {
					t.Errorf("legacy space retired but never revived, calls=%v", calls)
				}
				if reindex := lastIndexOf(calls, "index:"+migLegacyID); reindex < revive {
					t.Errorf("legacy space must be re-indexed after revive, calls=%v", calls)
				}
			}
		})
	}
}

// A run that died after copying but before repointing is retried from the top.
// Objects and saves upsert by id; credentials always mint a new tree, so the
// retry must skip the ones the derived space already holds.
func TestPrivateSpaceMigrationRerunDoesNotDuplicate(t *testing.T) {
	h := newMigrationHarness()
	h.content.creds[migLegacyID] = []*anysync.CredentialPayload{{SAID: "ESaid1"}, {SAID: "ESaid2"}}
	h.content.saves[migLegacyID] = []*anysync.NoticeSavePayload{{NoticeID: "n1", UserID: migAID}, {NoticeID: "n2", UserID: migAID}}
	// Left behind by the interrupted run:
	h.content.creds[migDerivedID] = []*anysync.CredentialPayload{{SAID: "ESaid1"}}
	h.content.saves[migDerivedID] = []*anysync.NoticeSavePayload{{NoticeID: "n1", UserID: migAID}}

	if _, err := h.m.run(context.Background()); err != nil {
		t.Fatalf("run: %v", err)
	}

	if got := len(h.content.creds[migDerivedID]); got != 2 {
		t.Errorf("derived space credentials = %d, want 2", got)
	}
	if got := len(h.content.saves[migDerivedID]); got != 2 {
		t.Errorf("derived space saves = %d, want 2", got)
	}
}
