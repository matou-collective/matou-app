package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"testing"

	"github.com/anyproto/any-sync/util/crypto"

	"github.com/matou-dao/backend/internal/anysync"
	"github.com/matou-dao/backend/internal/types"
)

// fakeSchemaObjectStore is an in-memory stand-in for the ObjectTreeManager
// pair the schema writer uses. Like the real manager, AddObject decides
// create-vs-update by exact object ID — the property the #405 review found the
// writer tripping over (a seeded `typedef-<name>-<ms>` object versus the
// writer's `typedef-<name>` ID).
type fakeSchemaObjectStore struct {
	mu      sync.Mutex
	objects map[string]*anysync.ObjectPayload
	order   []string
	readErr error
}

func (f *fakeSchemaObjectStore) AddObject(_ context.Context, _ string, p *anysync.ObjectPayload, _ crypto.PrivKey) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.objects == nil {
		f.objects = make(map[string]*anysync.ObjectPayload)
	}
	if existing, ok := f.objects[p.ID]; ok {
		existing.Data = append(json.RawMessage(nil), p.Data...)
		existing.Version++ // change count, as the real manager reports it
		return "head-" + p.ID, nil
	}
	cp := *p
	cp.Data = append(json.RawMessage(nil), p.Data...)
	cp.Version = 1
	f.objects[p.ID] = &cp
	f.order = append(f.order, p.ID)
	return "head-" + p.ID, nil
}

func (f *fakeSchemaObjectStore) ReadObjectsByType(_ context.Context, _ string, typeName string) ([]*anysync.ObjectPayload, error) {
	if f.readErr != nil {
		return nil, f.readErr
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []*anysync.ObjectPayload
	for _, id := range f.order {
		if o := f.objects[id]; o.Type == typeName {
			cp := *o
			out = append(out, &cp)
		}
	}
	return out, nil
}

// seedTypeDef stores def the way spaces.go seedSpace does at org creation:
// type "type_definition" under the caller's object ID.
func (f *fakeSchemaObjectStore) seedTypeDef(t *testing.T, id string, def *types.TypeDefinition) {
	t.Helper()
	data, err := json.Marshal(def)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.AddObject(context.Background(), "space", &anysync.ObjectPayload{ID: id, Type: "type_definition", Data: data}, nil); err != nil {
		t.Fatal(err)
	}
}

// storedDef is one type_definition object with its data decoded.
type storedDef struct {
	ID      string
	Changes int // ObjectPayload.Version (number of changes applied)
	Def     types.TypeDefinition
}

// typeDefsNamed returns every stored type_definition whose data names name.
func (f *fakeSchemaObjectStore) typeDefsNamed(t *testing.T, name string) []storedDef {
	t.Helper()
	objs, err := f.ReadObjectsByType(context.Background(), "space", "type_definition")
	if err != nil {
		t.Fatal(err)
	}
	var out []storedDef
	for _, o := range objs {
		var def types.TypeDefinition
		if err := json.Unmarshal(o.Data, &def); err != nil {
			t.Fatalf("stored %s has invalid data: %v", o.ID, err)
		}
		if def.Name == name {
			out = append(out, storedDef{ID: o.ID, Changes: o.Version, Def: def})
		}
	}
	return out
}

// newStoreBackedHandler wires a ProfilesHandler to the real spaceSchemaWriter
// over the fake store, so a PUT exercises the persistence path end to end.
func newStoreBackedHandler(store *fakeSchemaObjectStore) (*ProfilesHandler, *http.ServeMux) {
	reg := types.NewRegistry()
	reg.Bootstrap()
	h := &ProfilesHandler{
		registry:     reg,
		schemaWriter: &spaceSchemaWriter{store: store, spaceID: "community-space"},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/types/", h.handleTypeByName)
	return h, mux
}

// TestSchemaWriter_UpdatesSeededObject: org setup seeded SharedProfile under a
// timestamped ID; an admin PUT must update that object, not create a second
// type_definition for the same name.
func TestSchemaWriter_UpdatesSeededObject(t *testing.T) {
	store := &fakeSchemaObjectStore{}
	const seededID = "typedef-SharedProfile-1700000000000"
	store.seedTypeDef(t, seededID, types.SharedProfileType())

	_, mux := newStoreBackedHandler(store)
	if rec := putType(t, mux, "SharedProfile", "", sharedProfileWithCustom()); rec.Code != http.StatusOK {
		t.Fatalf("PUT = %d, want 200; body %s", rec.Code, rec.Body.String())
	}

	got := store.typeDefsNamed(t, "SharedProfile")
	if len(got) != 1 {
		t.Fatalf("expected exactly one stored SharedProfile definition, got %d: %+v", len(got), got)
	}
	if got[0].ID != seededID {
		t.Errorf("stored under %q, want the seeded object %q", got[0].ID, seededID)
	}
	if got[0].Changes != 2 {
		t.Errorf("seeded object should carry the edit as a second change, got %d", got[0].Changes)
	}
	if got[0].Def.Version != 2 {
		t.Errorf("stored definition version = %d, want 2", got[0].Def.Version)
	}
	if _, ok := got[0].Def.Field("iwi"); !ok {
		t.Error("stored definition lacks the custom field iwi")
	}
}

// TestSchemaWriter_StableIDWhenUnseeded: with no stored definition for the
// name, the writer creates one under the stable typedef-<name> ID and a second
// edit updates it in place.
func TestSchemaWriter_StableIDWhenUnseeded(t *testing.T) {
	store := &fakeSchemaObjectStore{}
	_, mux := newStoreBackedHandler(store)

	if rec := putType(t, mux, "SharedProfile", "", sharedProfileWithCustom()); rec.Code != http.StatusOK {
		t.Fatalf("first PUT = %d, want 200; body %s", rec.Code, rec.Body.String())
	}
	second := sharedProfileWithCustom()
	second.Version = 2
	if rec := putType(t, mux, "SharedProfile", "", second); rec.Code != http.StatusOK {
		t.Fatalf("second PUT = %d, want 200; body %s", rec.Code, rec.Body.String())
	}

	got := store.typeDefsNamed(t, "SharedProfile")
	if len(got) != 1 {
		t.Fatalf("expected exactly one stored SharedProfile definition, got %d: %+v", len(got), got)
	}
	if got[0].ID != "typedef-SharedProfile" {
		t.Errorf("stored under %q, want typedef-SharedProfile", got[0].ID)
	}
	if got[0].Changes != 2 || got[0].Def.Version != 3 {
		t.Errorf("second edit should update in place: changes=%d version=%d, want 2/3", got[0].Changes, got[0].Def.Version)
	}
}

// TestSchemaWriter_PicksHighestVersionAmongDuplicates: when a space already
// holds several definitions for one name (a pre-fix write path left stale
// copies), the writer updates the one Registry.LoadFromSpace would load — the
// highest data.version — and leaves the others alone.
func TestSchemaWriter_PicksHighestVersionAmongDuplicates(t *testing.T) {
	store := &fakeSchemaObjectStore{}
	v1 := types.SharedProfileType()
	store.seedTypeDef(t, "typedef-SharedProfile-1700000000000", v1)
	v2 := sharedProfileWithCustom()
	v2.Version = 2
	store.seedTypeDef(t, "typedef-SharedProfile", v2)

	h, mux := newStoreBackedHandler(store)
	h.registry.Register(v2) // what LoadFromSpace registers at boot

	edit := sharedProfileWithCustom()
	edit.Version = 2
	if rec := putType(t, mux, "SharedProfile", "", edit); rec.Code != http.StatusOK {
		t.Fatalf("PUT = %d, want 200; body %s", rec.Code, rec.Body.String())
	}

	got := store.typeDefsNamed(t, "SharedProfile")
	if len(got) != 2 {
		t.Fatalf("writer must not create a third copy, got %d", len(got))
	}
	byID := map[string]storedDef{}
	for _, g := range got {
		byID[g.ID] = g
	}
	if s := byID["typedef-SharedProfile"]; s.Def.Version != 3 || s.Changes != 2 {
		t.Errorf("highest-version copy not updated: version=%d changes=%d", s.Def.Version, s.Changes)
	}
	if s := byID["typedef-SharedProfile-1700000000000"]; s.Def.Version != 1 || s.Changes != 1 {
		t.Errorf("stale v1 copy should be untouched: version=%d changes=%d", s.Def.Version, s.Changes)
	}
}

// TestSchemaWriter_LookupFailureIsError: a failed read of the existing
// definitions must not fall through to a blind create.
func TestSchemaWriter_LookupFailureIsError(t *testing.T) {
	store := &fakeSchemaObjectStore{readErr: errors.New("index unavailable")}
	w := &spaceSchemaWriter{store: store, spaceID: "community-space"}
	if err := w.WriteTypeDefinition(context.Background(), sharedProfileWithCustom()); err == nil {
		t.Fatal("expected an error when the existing-definition lookup fails")
	}
	if len(store.order) != 0 {
		t.Errorf("nothing should be written after a failed lookup, got %v", store.order)
	}
}
