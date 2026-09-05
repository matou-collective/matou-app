package types

import (
	"fmt"
	"regexp"
)

// MaxSchemaFields caps the number of fields an admin-supplied type definition
// may carry (base fields plus any single variant's fields). It bounds the cost
// of validating and persisting a schema so a hostile PUT cannot blow up memory
// or the object payload.
const MaxSchemaFields = 200

// fieldNamePattern constrains a field name to a short identifier: a leading
// letter followed by up to 63 letters/digits/underscores. It rejects empty,
// whitespace, and structurally hostile names before they reach persistence.
var fieldNamePattern = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_]{0,63}$`)

// validFieldTypes is the set of field types the validator understands (mirrors
// the switch in validateField). A definition naming any other type is rejected.
var validFieldTypes = map[string]bool{
	"string":   true,
	"boolean":  true,
	"array":    true,
	"object":   true,
	"number":   true,
	"datetime": true,
	"enum":     true,
}

// BuiltinDefinition returns the built-in (Bootstrap) definition for a type name,
// if one exists. It bootstraps a fresh registry each call so the returned
// definition is the canonical shape shipped with the backend — the reference
// the core-field invariant is checked against — never a copy an org may have
// already edited. The second result is false for names with no built-in.
func BuiltinDefinition(name string) (*TypeDefinition, bool) {
	r := NewRegistry()
	r.Bootstrap()
	return r.Get(name)
}

// ValidateSchemaUpdate checks an admin-supplied replacement definition for a
// type. builtin is the canonical Bootstrap definition for the same name (nil
// when the type has no built-in, e.g. a fully custom type) — its core:true
// fields form the invariant every org schema must preserve.
//
// It returns "" when the update is acceptable, or a human-readable reason the
// caller returns as a 400. It enforces, in order:
//
//   - the core-field invariant: every field the built-in marks core:true must
//     be present in the incoming definition, unchanged in name and type;
//   - structural sanity: a field-count cap, an identifier pattern on every
//     field name, no duplicate names, a known field type, and coherent
//     Validation bounds (min ≤ max);
//   - variant integrity: VariantField, when set, must name a base field, and
//     every variant field must itself pass the structural checks.
func ValidateSchemaUpdate(builtin, incoming *TypeDefinition) string {
	if incoming == nil {
		return "definition is required"
	}

	// Structural sanity of the base field set.
	if len(incoming.Fields) > MaxSchemaFields {
		return fmt.Sprintf("too many fields: %d (max %d)", len(incoming.Fields), MaxSchemaFields)
	}
	seen := make(map[string]FieldDef, len(incoming.Fields))
	for _, f := range incoming.Fields {
		if msg := validateFieldDef(f); msg != "" {
			return msg
		}
		if _, dup := seen[f.Name]; dup {
			return fmt.Sprintf("duplicate field %q", f.Name)
		}
		seen[f.Name] = f
	}

	// Core-field invariant: every built-in core field must survive unchanged.
	if builtin != nil {
		for _, cf := range builtin.Fields {
			if !cf.Core {
				continue
			}
			got, ok := seen[cf.Name]
			if !ok {
				return fmt.Sprintf("core field %q may not be removed", cf.Name)
			}
			if got.Type != cf.Type {
				return fmt.Sprintf("core field %q type may not change (want %q, got %q)", cf.Name, cf.Type, got.Type)
			}
		}
	}

	// Variant integrity.
	if incoming.VariantField != "" {
		if _, ok := seen[incoming.VariantField]; !ok {
			return fmt.Sprintf("variantField %q names no field in the definition", incoming.VariantField)
		}
	}
	for key, variant := range incoming.Variants {
		if incoming.VariantField == "" {
			return fmt.Sprintf("variant %q defined but variantField is unset", key)
		}
		if len(variant.Fields) > MaxSchemaFields {
			return fmt.Sprintf("variant %q has too many fields: %d (max %d)", key, len(variant.Fields), MaxSchemaFields)
		}
		vseen := make(map[string]bool, len(variant.Fields))
		for _, f := range variant.Fields {
			if msg := validateFieldDef(f); msg != "" {
				return fmt.Sprintf("variant %q: %s", key, msg)
			}
			if vseen[f.Name] {
				return fmt.Sprintf("variant %q: duplicate field %q", key, f.Name)
			}
			vseen[f.Name] = true
		}
	}

	return ""
}

// validateFieldDef checks a single field definition's name, type, and any
// Validation bounds. It returns "" when the field is well-formed.
func validateFieldDef(f FieldDef) string {
	if !fieldNamePattern.MatchString(f.Name) {
		return fmt.Sprintf("invalid field name %q (want %s)", f.Name, fieldNamePattern.String())
	}
	if !validFieldTypes[f.Type] {
		return fmt.Sprintf("field %q has unknown type %q", f.Name, f.Type)
	}
	if v := f.Validation; v != nil {
		if v.MinLength != nil && *v.MinLength < 0 {
			return fmt.Sprintf("field %q: minLength may not be negative", f.Name)
		}
		if v.MinLength != nil && v.MaxLength != nil && *v.MinLength > *v.MaxLength {
			return fmt.Sprintf("field %q: minLength %d exceeds maxLength %d", f.Name, *v.MinLength, *v.MaxLength)
		}
		if v.Min != nil && v.Max != nil && *v.Min > *v.Max {
			return fmt.Sprintf("field %q: min %v exceeds max %v", f.Name, *v.Min, *v.Max)
		}
		if v.Pattern != "" {
			if _, err := regexp.Compile(v.Pattern); err != nil {
				return fmt.Sprintf("field %q: invalid validation pattern: %v", f.Name, err)
			}
		}
	}
	return ""
}
