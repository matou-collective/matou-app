package types

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
)

// fakeReader is a stub ObjectReader returning canned entries (or an error) for
// the "type_definition" type.
type fakeReader struct {
	entries []ObjectEntry
	err     error
}

func (f fakeReader) ReadObjectsByType(_ context.Context, _ string, typeName string) ([]ObjectEntry, error) {
	if f.err != nil {
		return nil, f.err
	}
	if typeName != "type_definition" {
		return nil, nil
	}
	return f.entries, nil
}

func mustEntry(t *testing.T, id string, def *TypeDefinition) ObjectEntry {
	t.Helper()
	data, err := json.Marshal(def)
	if err != nil {
		t.Fatalf("marshal %s: %v", id, err)
	}
	return ObjectEntry{ID: id, Type: "type_definition", Data: data}
}

// TestLoadFromSpace_HappyPath: a persisted definition is merged over the
// built-in — its custom (non-core) fields land in the registry, and a bumped
// version is honoured.
func TestLoadFromSpace_HappyPath(t *testing.T) {
	r := NewRegistry()
	r.Bootstrap()

	builtin, ok := r.Get("Proposal")
	if !ok {
		t.Fatal("expected built-in Proposal type")
	}

	// Persisted definition: the built-in's fields plus one custom, non-core field.
	persisted := cloneDef(builtin)
	persisted.Version = builtin.Version + 1
	persisted.Fields = append(persisted.Fields, FieldDef{Name: "custom_note", Type: "string"})

	if err := r.LoadFromSpace(context.Background(), fakeReader{
		entries: []ObjectEntry{mustEntry(t, "obj1", persisted)},
	}, "space-community"); err != nil {
		t.Fatalf("LoadFromSpace: %v", err)
	}

	got, ok := r.Get("Proposal")
	if !ok {
		t.Fatal("Proposal missing after hydration")
	}
	if got.Version != builtin.Version+1 {
		t.Errorf("version: got %d, want %d", got.Version, builtin.Version+1)
	}
	if _, ok := got.Field("custom_note"); !ok {
		t.Error("expected custom_note field to be hydrated from persisted definition")
	}
}

// TestLoadFromSpace_CoreReassertion: a stored definition that drops and mutates
// core fields still ends up with the built-in's core fields intact.
func TestLoadFromSpace_CoreReassertion(t *testing.T) {
	r := NewRegistry()
	r.Bootstrap()

	builtin, _ := r.Get("Proposal")
	coreNames := builtin.CoreFieldNames()
	if len(coreNames) == 0 {
		t.Fatal("test needs a built-in with core fields")
	}

	// Tampered stored definition: keep only non-core fields, plus a mutated
	// copy of one core field (Core flag stripped, type changed).
	tampered := cloneDef(builtin)
	var mutatedCore string
	fields := []FieldDef{}
	for _, f := range builtin.Fields {
		if f.Core {
			if mutatedCore == "" {
				mutatedCore = f.Name
				fields = append(fields, FieldDef{Name: f.Name, Type: "boolean", Core: false})
			}
			continue // drop the rest of the core fields
		}
		fields = append(fields, f)
	}
	tampered.Fields = fields

	if err := r.LoadFromSpace(context.Background(), fakeReader{
		entries: []ObjectEntry{mustEntry(t, "obj1", tampered)},
	}, "space-community"); err != nil {
		t.Fatalf("LoadFromSpace: %v", err)
	}

	got, _ := r.Get("Proposal")

	// Every built-in core field must be present and match the built-in definition.
	for _, name := range coreNames {
		builtinField, _ := builtin.Field(name)
		gotField, ok := got.Field(name)
		if !ok {
			t.Errorf("core field %q was dropped by hydration", name)
			continue
		}
		if gotField.Type != builtinField.Type || !gotField.Core {
			t.Errorf("core field %q not re-asserted: got %+v, want type=%s core=true",
				name, gotField, builtinField.Type)
		}
	}
	// The mutated core field specifically must be back to the built-in type.
	bf, _ := builtin.Field(mutatedCore)
	gf, _ := got.Field(mutatedCore)
	if gf.Type != bf.Type {
		t.Errorf("mutated core field %q kept tampered type %q", mutatedCore, gf.Type)
	}
}

// TestLoadFromSpace_CorruptedFallback: an unparseable or nameless entry is
// skipped and never fatal; the built-in stays in force and valid siblings load.
func TestLoadFromSpace_CorruptedFallback(t *testing.T) {
	r := NewRegistry()
	r.Bootstrap()

	builtin, _ := r.Get("Proposal")
	valid := cloneDef(builtin)
	valid.Version = builtin.Version + 5

	entries := []ObjectEntry{
		{ID: "garbage", Type: "type_definition", Data: json.RawMessage(`{not valid json`)},
		{ID: "nameless", Type: "type_definition", Data: json.RawMessage(`{"version":9}`)},
		mustEntry(t, "valid", valid),
	}

	if err := r.LoadFromSpace(context.Background(), fakeReader{entries: entries}, "space"); err != nil {
		t.Fatalf("LoadFromSpace should not fail on corrupted entries: %v", err)
	}

	got, ok := r.Get("Proposal")
	if !ok {
		t.Fatal("Proposal missing — corrupted entry must not clobber the built-in")
	}
	if got.Version != builtin.Version+5 {
		t.Errorf("valid sibling not loaded: version %d, want %d", got.Version, builtin.Version+5)
	}
}

// TestLoadFromSpace_ReadError: a reader error is surfaced so the caller can fall
// back to the built-ins, and the registry is left untouched.
func TestLoadFromSpace_ReadError(t *testing.T) {
	r := NewRegistry()
	r.Bootstrap()
	before := len(r.All())

	err := r.LoadFromSpace(context.Background(), fakeReader{err: errors.New("space unreachable")}, "space")
	if err == nil {
		t.Fatal("expected a read error to be returned")
	}
	if got := len(r.All()); got != before {
		t.Errorf("registry mutated on read error: %d types, want %d", got, before)
	}
}

// TestLoadFromSpace_NewType: a persisted type with no matching built-in is
// registered as-is (orgs may define entirely new types).
func TestLoadFromSpace_NewType(t *testing.T) {
	r := NewRegistry()
	r.Bootstrap()

	custom := &TypeDefinition{
		Name:    "org_custom_type",
		Version: 1,
		Space:   "community",
		Fields:  []FieldDef{{Name: "label", Type: "string"}},
	}
	if err := r.LoadFromSpace(context.Background(), fakeReader{
		entries: []ObjectEntry{mustEntry(t, "c1", custom)},
	}, "space"); err != nil {
		t.Fatalf("LoadFromSpace: %v", err)
	}

	if _, ok := r.Get("org_custom_type"); !ok {
		t.Error("new persisted type should be registered")
	}
}

// cloneDef returns a shallow copy of def with a fresh Fields slice so tests can
// mutate the copy without touching the registry's built-in.
func cloneDef(def *TypeDefinition) *TypeDefinition {
	out := *def
	out.Fields = append([]FieldDef(nil), def.Fields...)
	return &out
}
