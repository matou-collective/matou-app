package types

import (
	"strings"
	"testing"
)

// sharedProfileEdit returns the SharedProfile built-in with its custom (non-core)
// fields intact — a valid starting point for edits in these tests.
func sharedProfileEdit() *TypeDefinition {
	return SharedProfileType()
}

// TestValidateSchemaUpdate_CustomFieldsFree verifies an org may add, edit, and
// remove non-core fields freely: the built-in core fields survive, so the
// update is accepted.
func TestValidateSchemaUpdate_CustomFieldsFree(t *testing.T) {
	builtin := SharedProfileType()
	incoming := sharedProfileEdit()

	// Drop a removable field (bio) — from the layouts too, since a layout may
	// not name a field the definition no longer has — and add a fresh custom
	// one (iwi).
	kept := incoming.Fields[:0]
	for _, f := range incoming.Fields {
		if f.Name == "bio" {
			continue
		}
		kept = append(kept, f)
	}
	incoming.Fields = append(kept, FieldDef{Name: "iwi", Type: "string"})
	for key, layout := range incoming.Layouts {
		names := layout.Fields[:0]
		for _, n := range layout.Fields {
			if n != "bio" {
				names = append(names, n)
			}
		}
		incoming.Layouts[key] = Layout{Fields: names}
	}

	if msg := ValidateSchemaUpdate(builtin, incoming); msg != "" {
		t.Fatalf("valid custom-field edit rejected: %s", msg)
	}
}

// TestValidateSchemaUpdate_RemovedFieldStillInLayout: dropping a field without
// dropping it from the layouts is rejected — the layout would otherwise point
// at nothing.
func TestValidateSchemaUpdate_RemovedFieldStillInLayout(t *testing.T) {
	builtin := SharedProfileType()
	incoming := sharedProfileEdit()
	kept := incoming.Fields[:0]
	for _, f := range incoming.Fields {
		if f.Name == "bio" {
			continue
		}
		kept = append(kept, f)
	}
	incoming.Fields = kept

	msg := ValidateSchemaUpdate(builtin, incoming)
	if msg == "" || !strings.Contains(msg, "bio") {
		t.Fatalf("removed field left in a layout should be rejected naming it, got %q", msg)
	}
}

// TestValidateSchemaUpdate_CoreFieldRemoved rejects dropping a core field.
func TestValidateSchemaUpdate_CoreFieldRemoved(t *testing.T) {
	builtin := SharedProfileType()
	incoming := sharedProfileEdit()

	kept := incoming.Fields[:0]
	for _, f := range incoming.Fields {
		if f.Name == "status" { // core
			continue
		}
		kept = append(kept, f)
	}
	incoming.Fields = kept

	msg := ValidateSchemaUpdate(builtin, incoming)
	if !strings.Contains(msg, "status") || !strings.Contains(msg, "core") {
		t.Fatalf("expected core-field removal to be rejected mentioning status, got %q", msg)
	}
}

// TestValidateSchemaUpdate_CoreFieldTypeChanged rejects changing a core field's
// type even when its name is preserved.
func TestValidateSchemaUpdate_CoreFieldTypeChanged(t *testing.T) {
	builtin := SharedProfileType()
	incoming := sharedProfileEdit()

	for i := range incoming.Fields {
		if incoming.Fields[i].Name == "status" {
			incoming.Fields[i].Type = "number"
		}
	}

	msg := ValidateSchemaUpdate(builtin, incoming)
	if !strings.Contains(msg, "status") || !strings.Contains(msg, "type") {
		t.Fatalf("expected core-field type change to be rejected, got %q", msg)
	}
}

// TestValidateSchemaUpdate_FieldCap rejects an over-cap field count.
func TestValidateSchemaUpdate_FieldCap(t *testing.T) {
	incoming := &TypeDefinition{Name: "Custom"}
	for i := 0; i < MaxSchemaFields+1; i++ {
		incoming.Fields = append(incoming.Fields, FieldDef{Name: "f" + itoa(i), Type: "string"})
	}
	if msg := ValidateSchemaUpdate(nil, incoming); !strings.Contains(msg, "too many fields") {
		t.Fatalf("expected field-cap rejection, got %q", msg)
	}
}

// TestValidateSchemaUpdate_BadFieldName rejects a hostile field name.
func TestValidateSchemaUpdate_BadFieldName(t *testing.T) {
	incoming := &TypeDefinition{
		Name:   "Custom",
		Fields: []FieldDef{{Name: "ok", Type: "string"}, {Name: "bad name!", Type: "string"}},
	}
	if msg := ValidateSchemaUpdate(nil, incoming); !strings.Contains(msg, "invalid field name") {
		t.Fatalf("expected bad field name rejection, got %q", msg)
	}
}

// TestValidateSchemaUpdate_UnknownType rejects an unknown field type.
func TestValidateSchemaUpdate_UnknownType(t *testing.T) {
	incoming := &TypeDefinition{
		Name:   "Custom",
		Fields: []FieldDef{{Name: "f", Type: "geopoint"}},
	}
	if msg := ValidateSchemaUpdate(nil, incoming); !strings.Contains(msg, "unknown type") {
		t.Fatalf("expected unknown-type rejection, got %q", msg)
	}
}

// TestValidateSchemaUpdate_DuplicateField rejects a duplicated field name.
func TestValidateSchemaUpdate_DuplicateField(t *testing.T) {
	incoming := &TypeDefinition{
		Name:   "Custom",
		Fields: []FieldDef{{Name: "f", Type: "string"}, {Name: "f", Type: "number"}},
	}
	if msg := ValidateSchemaUpdate(nil, incoming); !strings.Contains(msg, "duplicate field") {
		t.Fatalf("expected duplicate-field rejection, got %q", msg)
	}
}

// TestValidateSchemaUpdate_DanglingVariantField rejects a variantField that
// names no field in the definition.
func TestValidateSchemaUpdate_DanglingVariantField(t *testing.T) {
	incoming := &TypeDefinition{
		Name:         "Custom",
		Fields:       []FieldDef{{Name: "title", Type: "string"}},
		VariantField: "kind",
	}
	if msg := ValidateSchemaUpdate(nil, incoming); !strings.Contains(msg, "variantField") {
		t.Fatalf("expected dangling variantField rejection, got %q", msg)
	}
}

// TestValidateSchemaUpdate_ValidVariant accepts a variantField that names a
// real field, with well-formed variant fields.
func TestValidateSchemaUpdate_ValidVariant(t *testing.T) {
	incoming := &TypeDefinition{
		Name:         "Custom",
		Fields:       []FieldDef{{Name: "kind", Type: "string"}},
		VariantField: "kind",
		Variants: map[string]Variant{
			"event": {Fields: []FieldDef{{Name: "startsAt", Type: "datetime"}}},
		},
	}
	if msg := ValidateSchemaUpdate(nil, incoming); msg != "" {
		t.Fatalf("valid variant rejected: %s", msg)
	}
}

// TestValidateSchemaUpdate_ValidationBounds rejects incoherent Validation bounds.
func TestValidateSchemaUpdate_ValidationBounds(t *testing.T) {
	lo, hi := 10, 2
	incoming := &TypeDefinition{
		Name:   "Custom",
		Fields: []FieldDef{{Name: "f", Type: "string", Validation: &Validation{MinLength: &lo, MaxLength: &hi}}},
	}
	if msg := ValidateSchemaUpdate(nil, incoming); !strings.Contains(msg, "minLength") {
		t.Fatalf("expected minLength>maxLength rejection, got %q", msg)
	}
}

// TestBuiltinDefinition returns the canonical shape for a bootstrap type and
// nothing for an unknown name.
func TestBuiltinDefinition(t *testing.T) {
	if def, ok := BuiltinDefinition("SharedProfile"); !ok || def == nil || def.Name != "SharedProfile" {
		t.Fatalf("expected SharedProfile built-in, got ok=%v def=%v", ok, def)
	}
	if _, ok := BuiltinDefinition("NoSuchType"); ok {
		t.Fatal("expected no built-in for unknown type")
	}
}

// TestValidateSchemaUpdate_DanglingLayoutField rejects a layout that names a
// field the definition does not declare — #403 renders only fields present in
// the form layout, so a dangling entry would otherwise hide a field silently.
func TestValidateSchemaUpdate_DanglingLayoutField(t *testing.T) {
	builtin := SharedProfileType()
	incoming := sharedProfileEdit()
	incoming.Layouts["form"] = Layout{Fields: []string{"displayName", "noSuchField"}}

	msg := ValidateSchemaUpdate(builtin, incoming)
	if msg == "" || !strings.Contains(msg, "noSuchField") || !strings.Contains(msg, "form") {
		t.Fatalf("dangling layout field should be rejected naming the layout and field, got %q", msg)
	}
}

// TestValidateSchemaUpdate_LayoutMayNameVariantFields accepts layout entries
// that resolve to a variant's fields (the Notice form layout lists event and
// RSVP fields that only exist on variants).
func TestValidateSchemaUpdate_LayoutMayNameVariantFields(t *testing.T) {
	builtin := SharedProfileType()
	incoming := sharedProfileEdit()
	incoming.Fields = append(incoming.Fields, FieldDef{Name: "kind", Type: "string"})
	incoming.VariantField = "kind"
	incoming.Variants = map[string]Variant{
		"event": {Fields: []FieldDef{{Name: "eventStart", Type: "datetime"}}},
	}
	incoming.Layouts["form"] = Layout{Fields: []string{"displayName", "kind", "eventStart"}}

	if msg := ValidateSchemaUpdate(builtin, incoming); msg != "" {
		t.Fatalf("layout naming a variant field should be accepted, got %q", msg)
	}
}

// TestValidateSchemaUpdate_BuiltinsSelfValidate: every shipped definition must
// pass validation against itself, so an admin can round-trip a built-in
// through GET → PUT unchanged. Guards the validator against rejecting shapes
// the built-ins actually use (variant fields in layouts, field types, …).
func TestValidateSchemaUpdate_BuiltinsSelfValidate(t *testing.T) {
	r := NewRegistry()
	r.Bootstrap()
	for _, def := range r.All() {
		if msg := ValidateSchemaUpdate(def, def); msg != "" {
			t.Errorf("built-in %q does not validate against itself: %s", def.Name, msg)
		}
	}
}

// itoa is a tiny int→string helper so the test avoids importing strconv purely
// for field-name generation.
func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b []byte
	for i > 0 {
		b = append([]byte{byte('0' + i%10)}, b...)
		i /= 10
	}
	return string(b)
}
