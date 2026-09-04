package types

import (
	"encoding/json"
	"fmt"
	"reflect"
)

// Schema versioning for profiles (issue #302, part of #180 slice 5).
//
// Policy: migrate-on-write, grandfather-on-read.
//
//   - A substantive admin schema edit (field set / a field's validation rules /
//     variants) bumps TypeDefinition.Version via VersionForEdit; cosmetic edits
//     (labels, layouts, description, permissions) do not.
//   - Existing profiles carry a core typeVersion recording the schema version
//     they were last written under. A profile below the live version is stale
//     (predates the edit) — see IsStale.
//   - Reads grandfather newly-required fields (ValidateForRead) so a stale
//     profile still loads; present values are still validated and removed/unknown
//     fields stay inert (never rejected, never lost).
//   - Writes stay strict (ValidateData): the member is asked for a newly-required
//     field on their next save. A successful write re-stamps typeVersion to the
//     live version (StampVersion), migrating the profile so it is no longer stale.
//
// See backend/docs/profiles-schema-versioning.md for the full write-up.

// SchemaVersion returns the typeVersion recorded in a stored object's data, or 0
// when it is absent or unparseable (a profile written before versioning existed).
func SchemaVersion(data json.RawMessage) int {
	var m map[string]interface{}
	if err := json.Unmarshal(data, &m); err != nil {
		return 0
	}
	return versionFromMap(m)
}

func versionFromMap(m map[string]interface{}) int {
	switch n := m["typeVersion"].(type) {
	case float64:
		return int(n)
	case int:
		return n
	case json.Number:
		i, _ := n.Int64()
		return int(i)
	}
	return 0
}

// IsStale reports whether stored data predates the definition's live schema
// version — written under an older schema and not re-written (migrated) since.
// Data with no typeVersion is stale whenever the live version is above 1.
func (d *TypeDefinition) IsStale(data json.RawMessage) bool {
	return SchemaVersion(data) < d.Version
}

// StampVersion sets typeVersion to the definition's live version and returns the
// re-marshalled data — the migrate-on-write half of the policy. It is a no-op
// (returns data unchanged) for types that do not declare a typeVersion field, so
// it is safe to call on every profile write.
func StampVersion(def *TypeDefinition, data json.RawMessage) (json.RawMessage, error) {
	if _, ok := def.Field("typeVersion"); !ok {
		return data, nil
	}
	var m map[string]interface{}
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("stamping typeVersion: %w", err)
	}
	m["typeVersion"] = def.Version
	stamped, err := json.Marshal(m)
	if err != nil {
		return nil, fmt.Errorf("stamping typeVersion: %w", err)
	}
	return stamped, nil
}

// VersionForEdit returns the version an edited definition should carry: the old
// version for a cosmetic edit, old+1 for a substantive schema change. This is
// the version-bump rule an admin schema edit applies.
func VersionForEdit(oldDef, newDef *TypeDefinition) int {
	if SchemaChanged(oldDef, newDef) {
		return oldDef.Version + 1
	}
	return oldDef.Version
}

// SchemaChanged reports whether the change from oldDef to newDef affects what
// data validates: the field set, any field's validation-relevant attributes
// (type, required, readOnly, core, default, validation), the variant field, or
// the variant field-sets. Cosmetic edits — UIHints (labels/placeholders/
// sections), layouts, description, permissions — are not schema changes and must
// not bump the version. Field order is not significant.
func SchemaChanged(oldDef, newDef *TypeDefinition) bool {
	return !fieldSetsEqual(oldDef.Fields, newDef.Fields) ||
		oldDef.VariantField != newDef.VariantField ||
		!variantsEqual(oldDef.Variants, newDef.Variants)
}

// fieldSetsEqual compares two field lists as sets keyed by name (order-insensitive),
// ignoring UIHints. Field names are unique within a type, so equal length plus
// every field in b matching a same-named field in a implies set equality.
func fieldSetsEqual(a, b []FieldDef) bool {
	if len(a) != len(b) {
		return false
	}
	index := make(map[string]FieldDef, len(a))
	for _, f := range a {
		index[f.Name] = f
	}
	for _, bf := range b {
		af, ok := index[bf.Name]
		if !ok || !fieldValidationEqual(af, bf) {
			return false
		}
	}
	return true
}

// fieldValidationEqual reports whether two field definitions are equal in every
// attribute that affects validation — everything except UIHints, which are
// purely cosmetic.
func fieldValidationEqual(a, b FieldDef) bool {
	a.UIHints, b.UIHints = nil, nil
	return reflect.DeepEqual(a, b)
}

// variantsEqual compares two variant maps by their (validation-relevant) field
// sets.
func variantsEqual(a, b map[string]Variant) bool {
	if len(a) != len(b) {
		return false
	}
	for key, av := range a {
		bv, ok := b[key]
		if !ok || !fieldSetsEqual(av.Fields, bv.Fields) {
			return false
		}
	}
	return true
}

// ValidateForRead validates stored data the tolerant way a reader should:
// newly-required fields are grandfathered (a missing required value is not an
// error) so a profile written before the field existed still loads, while any
// value that IS present is still validated against its constraints. Unknown /
// removed fields stay inert. Writes use the strict ValidateData instead.
func ValidateForRead(def *TypeDefinition, data json.RawMessage) []string {
	var m map[string]interface{}
	if err := json.Unmarshal(data, &m); err != nil {
		return []string{fmt.Sprintf("data is not a valid JSON object: %v", err)}
	}

	fields := effectiveFields(def, m)

	var errors []string
	for _, field := range fields {
		val, exists := m[field.Name]
		if !exists || val == nil {
			continue // grandfather missing values, including newly-required fields
		}
		errors = append(errors, validateField(field, val)...)
	}
	return errors
}
