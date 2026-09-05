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

	// Drop a removable field (bio) and add a fresh custom one (iwi).
	kept := incoming.Fields[:0]
	for _, f := range incoming.Fields {
		if f.Name == "bio" {
			continue
		}
		kept = append(kept, f)
	}
	incoming.Fields = append(kept, FieldDef{Name: "iwi", Type: "string"})

	if msg := ValidateSchemaUpdate(builtin, incoming); msg != "" {
		t.Fatalf("valid custom-field edit rejected: %s", msg)
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
