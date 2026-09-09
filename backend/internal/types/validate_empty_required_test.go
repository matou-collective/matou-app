package types

import (
	"encoding/json"
	"testing"
)

// hasRequiredError reports whether errs contains the "field %q is required"
// message for the named field.
func hasRequiredError(errs []string, field string) bool {
	want := "field \"" + field + "\" is required"
	for _, e := range errs {
		if e == want {
			return true
		}
	}
	return false
}

// A present-but-blank required string must be treated as absent: neither an
// empty string nor a whitespace-only string satisfies a required text field.
func TestValidateData_RequiredStringRejectsBlank(t *testing.T) {
	def := &TypeDefinition{
		Name: "Blankable",
		Fields: []FieldDef{
			{Name: "name", Type: "string", Required: true},
		},
	}

	cases := []struct {
		label   string
		data    string
		wantErr bool
	}{
		{"empty string", `{"name": ""}`, true},
		{"whitespace only", `{"name": "   "}`, true},
		{"tabs and newlines", `{"name": "\t\n "}`, true},
		{"absent", `{}`, true},
		{"null", `{"name": null}`, true},
		{"non-blank value", `{"name": "Amiria"}`, false},
		{"value with surrounding space", `{"name": "  Amiria  "}`, false},
	}

	for _, tc := range cases {
		t.Run(tc.label, func(t *testing.T) {
			errs := ValidateData(def, json.RawMessage(tc.data))
			got := hasRequiredError(errs, "name")
			if got != tc.wantErr {
				t.Errorf("data %s: required error = %v, want %v (errors: %v)", tc.data, got, tc.wantErr, errs)
			}
		})
	}
}

// The blank-as-absent rule applies only to string-shaped types. A required
// number/boolean/array with its zero value (0/false/[]) is a real value and
// must stay valid.
func TestValidateData_RequiredNonStringZeroValuesStayValid(t *testing.T) {
	def := &TypeDefinition{
		Name: "Zeros",
		Fields: []FieldDef{
			{Name: "count", Type: "number", Required: true},
			{Name: "flag", Type: "boolean", Required: true},
			{Name: "tags", Type: "array", Required: true},
		},
	}

	errs := ValidateData(def, json.RawMessage(`{"count": 0, "flag": false, "tags": []}`))
	if len(errs) != 0 {
		t.Errorf("expected zero-value non-string required fields to be valid, got errors: %v", errs)
	}
}

// A required datetime/enum (both string-shaped) also rejects a blank value.
func TestValidateData_RequiredDatetimeAndEnumRejectBlank(t *testing.T) {
	def := &TypeDefinition{
		Name: "DateEnum",
		Fields: []FieldDef{
			{Name: "when", Type: "datetime", Required: true},
			{Name: "kind", Type: "enum", Required: true,
				Validation: &Validation{Enum: []string{"a", "b"}}},
		},
	}

	errs := ValidateData(def, json.RawMessage(`{"when": "  ", "kind": ""}`))
	if !hasRequiredError(errs, "when") {
		t.Errorf("expected blank required datetime to be reported required, got: %v", errs)
	}
	if !hasRequiredError(errs, "kind") {
		t.Errorf("expected blank required enum to be reported required, got: %v", errs)
	}
}

// The rule reaches org-added custom required string fields automatically,
// since it lives in the one shared validator rather than per-built-in schema.
func TestValidateData_CustomRequiredStringRejectsBlank(t *testing.T) {
	def := &TypeDefinition{
		Name: "Custom",
		Fields: []FieldDef{
			{Name: "iwi", Type: "string", Required: true,
				UIHints: &UIHints{Label: "Iwi"}},
		},
	}

	errs := ValidateData(def, json.RawMessage(`{"iwi": "\t"}`))
	if !hasRequiredError(errs, "iwi") {
		t.Errorf("expected blank custom required string to be reported required, got: %v", errs)
	}
}

// Transfer across the three schema-validated entities that share ValidateData:
// a required text field that is present but blank is rejected on each.
func TestValidateData_BlankRequiredRejectedAcrossEntities(t *testing.T) {
	cases := []struct {
		entity string
		def    *TypeDefinition
		field  string
	}{
		{"SharedProfile", SharedProfileType(), "displayName"},
		{"Notice", NoticeType(), "title"},
		{"Proposal", ProposalTypeDefinition(), "title"},
	}

	for _, tc := range cases {
		t.Run(tc.entity, func(t *testing.T) {
			// Sanity: the field we probe is a required string on this schema.
			f, ok := tc.def.Field(tc.field)
			if !ok || !f.Required || f.Type != "string" {
				t.Fatalf("%s: expected %q to be a required string field (ok=%v required=%v type=%q)",
					tc.entity, tc.field, ok, f.Required, f.Type)
			}

			for _, blank := range []string{`""`, `"   "`} {
				data := json.RawMessage(`{"` + tc.field + `": ` + blank + `}`)
				errs := ValidateData(tc.def, data)
				if !hasRequiredError(errs, tc.field) {
					t.Errorf("%s: blank %s (%s) should be reported required, got: %v",
						tc.entity, tc.field, blank, errs)
				}
			}
		})
	}
}
