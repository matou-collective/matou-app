package types

import (
	"encoding/json"
	"fmt"
	"regexp"
)

// ValidateData validates data against a type definition's field definitions.
// If the type declares a VariantField, the fields of the matching variant are
// merged in before validation, so per-subtype required/enum rules apply.
// Returns a list of validation errors (empty if valid).
func ValidateData(def *TypeDefinition, data json.RawMessage) []string {
	var m map[string]interface{}
	if err := json.Unmarshal(data, &m); err != nil {
		return []string{fmt.Sprintf("data is not a valid JSON object: %v", err)}
	}

	fields := effectiveFields(def, m)

	var errors []string
	for _, field := range fields {
		val, exists := m[field.Name]
		if field.Required && (!exists || val == nil) {
			errors = append(errors, fmt.Sprintf("field %q is required", field.Name))
			continue
		}
		if !exists || val == nil {
			continue
		}
		fieldErrors := validateField(field, val)
		errors = append(errors, fieldErrors...)
	}
	return errors
}

// effectiveFields returns the base field set plus, when the type declares a
// VariantField whose value in the data matches a variant, that variant's
// fields. Variant fields with a name already present in the base set replace
// the base definition (so a subtype can tighten a shared field).
func effectiveFields(def *TypeDefinition, data map[string]interface{}) []FieldDef {
	if def.VariantField == "" || len(def.Variants) == 0 {
		return def.Fields
	}
	key, _ := data[def.VariantField].(string)
	if key == "" {
		return def.Fields
	}
	variant, ok := def.Variants[key]
	if !ok || len(variant.Fields) == 0 {
		return def.Fields
	}

	merged := make([]FieldDef, 0, len(def.Fields)+len(variant.Fields))
	overridden := make(map[string]int, len(variant.Fields))
	for _, vf := range variant.Fields {
		overridden[vf.Name] = -1
	}
	for _, f := range def.Fields {
		if _, ok := overridden[f.Name]; ok {
			continue // replaced by a variant field below
		}
		merged = append(merged, f)
	}
	merged = append(merged, variant.Fields...)
	return merged
}

// validateField validates a single field value against its definition.
func validateField(field FieldDef, val interface{}) []string {
	var errors []string

	switch field.Type {
	case "string", "datetime", "enum":
		s, ok := val.(string)
		if !ok {
			errors = append(errors, fmt.Sprintf("field %q must be a string", field.Name))
			return errors
		}
		if field.Validation != nil {
			errors = append(errors, validateString(field.Name, s, field.Validation)...)
		}

	case "number":
		n, ok := val.(float64)
		if !ok {
			errors = append(errors, fmt.Sprintf("field %q must be a number", field.Name))
			return errors
		}
		if field.Validation != nil {
			errors = append(errors, validateNumber(field.Name, n, field.Validation)...)
		}

	case "boolean":
		if _, ok := val.(bool); !ok {
			errors = append(errors, fmt.Sprintf("field %q must be a boolean", field.Name))
		}

	case "array":
		if _, ok := val.([]interface{}); !ok {
			errors = append(errors, fmt.Sprintf("field %q must be an array", field.Name))
		}

	case "object":
		if _, ok := val.(map[string]interface{}); !ok {
			errors = append(errors, fmt.Sprintf("field %q must be an object", field.Name))
		}
	}

	return errors
}

// validateString validates a string field value.
func validateString(name, val string, v *Validation) []string {
	var errors []string

	if v.MinLength != nil && len(val) < *v.MinLength {
		errors = append(errors, fmt.Sprintf("field %q must be at least %d characters", name, *v.MinLength))
	}
	if v.MaxLength != nil && len(val) > *v.MaxLength {
		errors = append(errors, fmt.Sprintf("field %q must be at most %d characters", name, *v.MaxLength))
	}
	if v.Pattern != "" {
		if matched, err := regexp.MatchString(v.Pattern, val); err == nil && !matched {
			errors = append(errors, fmt.Sprintf("field %q does not match pattern %q", name, v.Pattern))
		}
	}
	if len(v.Enum) > 0 {
		found := false
		for _, e := range v.Enum {
			if val == e {
				found = true
				break
			}
		}
		if !found {
			errors = append(errors, fmt.Sprintf("field %q must be one of %v", name, v.Enum))
		}
	}

	return errors
}

// validateNumber validates a number field value.
func validateNumber(name string, val float64, v *Validation) []string {
	var errors []string

	if v.Min != nil && val < *v.Min {
		errors = append(errors, fmt.Sprintf("field %q must be >= %v", name, *v.Min))
	}
	if v.Max != nil && val > *v.Max {
		errors = append(errors, fmt.Sprintf("field %q must be <= %v", name, *v.Max))
	}

	return errors
}
