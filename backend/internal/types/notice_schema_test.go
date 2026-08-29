package types

import (
	"encoding/json"
	"testing"
)

// baseNotice returns a minimal valid Notice object (all built-in required core
// fields present) as JSON, so tests can add/remove fields around it.
func baseNotice() map[string]interface{} {
	return map[string]interface{}{
		"type":       "announcement",
		"title":      "Working bee",
		"summary":    "Come help out",
		"state":      "published",
		"issuerType": "person",
		"issuerId":   "EAbc123",
	}
}

func validate(t *testing.T, def *TypeDefinition, obj map[string]interface{}) []string {
	t.Helper()
	data, err := json.Marshal(obj)
	if err != nil {
		t.Fatalf("marshal object: %v", err)
	}
	return ValidateData(def, data)
}

// A custom required field an org adds to the Notice schema is enforced.
func TestNoticeSchema_CustomRequiredFieldEnforced(t *testing.T) {
	def := NoticeType()
	def.Fields = append(def.Fields, FieldDef{
		Name: "marae", Type: "string", Required: true,
	})

	// Missing the custom required field → rejected.
	if errs := validate(t, def, baseNotice()); len(errs) == 0 {
		t.Fatal("expected validation error for missing custom required field 'marae'")
	}

	// Present → accepted.
	obj := baseNotice()
	obj["marae"] = "Ōrākei"
	if errs := validate(t, def, obj); len(errs) != 0 {
		t.Fatalf("expected no errors with custom field present, got %v", errs)
	}
}

// An optional field removed from the schema is tolerated on older objects that
// still carry it (validation only checks fields the schema defines).
func TestNoticeSchema_RemovedOptionalFieldTolerated(t *testing.T) {
	def := NoticeType()
	// Simulate the org dropping the optional "timezone" field from its schema.
	kept := def.Fields[:0]
	for _, f := range def.Fields {
		if f.Name == "timezone" {
			continue
		}
		kept = append(kept, f)
	}
	def.Fields = kept

	obj := baseNotice()
	obj["timezone"] = "Pacific/Auckland" // an old object still has it
	if errs := validate(t, def, obj); len(errs) != 0 {
		t.Fatalf("expected removed optional field to be tolerated, got %v", errs)
	}
}

// Tightening an enum (e.g. removing a value) is enforced on write.
func TestNoticeSchema_EnumChangeValidated(t *testing.T) {
	def := NoticeType()
	for i := range def.Fields {
		if def.Fields[i].Name == "type" {
			def.Fields[i].Validation = &Validation{Enum: []string{"update", "announcement"}}
		}
	}

	// "event" was valid before the org narrowed the enum; now it is rejected.
	obj := baseNotice()
	obj["type"] = "event"
	errs := validate(t, def, obj)
	if len(errs) == 0 {
		t.Fatal("expected validation error after enum narrowed to exclude 'event'")
	}

	// A still-allowed value passes.
	obj["type"] = "update"
	if errs := validate(t, def, obj); len(errs) != 0 {
		t.Fatalf("expected 'update' to pass narrowed enum, got %v", errs)
	}
}

// Per-subtype variant fields are validated only when the subtype matches.
func TestNoticeSchema_VariantFields(t *testing.T) {
	def := NoticeType()
	def.Variants = map[string]Variant{
		"tangihanga": {Fields: []FieldDef{
			{Name: "location", Type: "string", Required: true},
		}},
	}

	// No subtype → variant not applied → base object valid.
	if errs := validate(t, def, baseNotice()); len(errs) != 0 {
		t.Fatalf("base notice without subtype should be valid, got %v", errs)
	}

	// Matching subtype without the variant-required field → rejected.
	obj := baseNotice()
	obj["subtype"] = "tangihanga"
	if errs := validate(t, def, obj); len(errs) == 0 {
		t.Fatal("expected variant required field 'location' to be enforced for subtype tangihanga")
	}

	// With the variant field present → accepted.
	obj["location"] = "Ōrākei Marae"
	if errs := validate(t, def, obj); len(errs) != 0 {
		t.Fatalf("expected valid tangihanga notice, got %v", errs)
	}

	// A different subtype does not require the variant field.
	other := baseNotice()
	other["subtype"] = "general"
	if errs := validate(t, def, other); len(errs) != 0 {
		t.Fatalf("non-matching subtype should not require variant field, got %v", errs)
	}
}

// The built-in Notice schema marks its fields core and the board's filter/sort
// fields filterable.
func TestNoticeSchema_CoreAndFilterableFlags(t *testing.T) {
	def := NoticeType()
	byName := map[string]FieldDef{}
	for _, f := range def.Fields {
		byName[f.Name] = f
		if !f.Core {
			t.Errorf("built-in Notice field %q should be core", f.Name)
		}
	}

	for _, name := range []string{"type", "subtype", "state", "pinned", "eventStart"} {
		if !byName[name].Filterable {
			t.Errorf("field %q should be filterable", name)
		}
	}
	for _, name := range []string{"title", "summary", "body"} {
		if byName[name].Filterable {
			t.Errorf("field %q should not be filterable", name)
		}
	}
}

// Registry.IsFilterable reflects the schema flags.
func TestRegistry_IsFilterable(t *testing.T) {
	r := NewRegistry()
	r.Bootstrap()

	if !r.IsFilterable("Notice", "type") {
		t.Error("Notice.type should be filterable")
	}
	if r.IsFilterable("Notice", "title") {
		t.Error("Notice.title should not be filterable")
	}
	if r.IsFilterable("Notice", "nonexistent") {
		t.Error("unknown field should not be filterable")
	}
	if r.IsFilterable("Nope", "type") {
		t.Error("unknown type should not be filterable")
	}
}
