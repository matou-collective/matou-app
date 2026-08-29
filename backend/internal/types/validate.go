package types

import (
	"encoding/json"
	"fmt"
	"regexp"
)

// ValidateData validates data against a type definition's field definitions.
// Returns a list of validation errors (empty if valid).
func ValidateData(def *TypeDefinition, data json.RawMessage) []string {
	var m map[string]interface{}
	if err := json.Unmarshal(data, &m); err != nil {
		return []string{fmt.Sprintf("data is not a valid JSON object: %v", err)}
	}

	var errors []string
	for _, field := range def.Fields {
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
		items, ok := val.([]interface{})
		if !ok {
			errors = append(errors, fmt.Sprintf("field %q must be an array", field.Name))
			return errors
		}
		// When a Validation.Enum is set on an array field, every element must be
		// one of the allowed values. This lets an org constrain, for example,
		// participationInterests to a fixed vocabulary purely from the schema.
		if field.Validation != nil && len(field.Validation.Enum) > 0 {
			for i, item := range items {
				s, ok := item.(string)
				if !ok {
					errors = append(errors, fmt.Sprintf("field %q[%d] must be a string", field.Name, i))
					continue
				}
				if !inEnum(s, field.Validation.Enum) {
					errors = append(errors, fmt.Sprintf("field %q[%d] must be one of %v", field.Name, i, field.Validation.Enum))
				}
			}
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
	if len(v.Enum) > 0 && !inEnum(val, v.Enum) {
		errors = append(errors, fmt.Sprintf("field %q must be one of %v", name, v.Enum))
	}

	return errors
}

// inEnum reports whether val is one of the allowed enum values.
func inEnum(val string, enum []string) bool {
	for _, e := range enum {
		if val == e {
			return true
		}
	}
	return false
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
