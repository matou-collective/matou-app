package types

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestSharedProfileCoreFields verifies the fields backend handlers depend on
// are marked core (issue #180) and that non-structural fields are not.
func TestSharedProfileCoreFields(t *testing.T) {
	def := SharedProfileType()

	core := map[string]bool{}
	for _, name := range def.CoreFieldNames() {
		core[name] = true
	}

	wantCore := []string{"aid", "status", "displayName", "avatar", "publicPeerSignkey",
		"lastActiveAt", "createdAt", "updatedAt", "typeVersion"}
	for _, name := range wantCore {
		if !core[name] {
			t.Errorf("expected field %q to be core", name)
		}
	}

	// Removable / org-customisable fields must NOT be core.
	for _, name := range []string{"bio", "facebookUrl", "skills", "customInterests"} {
		if core[name] {
			t.Errorf("field %q should not be core (org may remove it)", name)
		}
	}
}

// TestSharedProfileFilterableFields verifies filterable fields are derived from
// the schema, not hardcoded, and cover the expected search dimensions.
func TestSharedProfileFilterableFields(t *testing.T) {
	def := SharedProfileType()

	filterable := map[string]bool{}
	for _, name := range def.FilterableFieldNames() {
		filterable[name] = true
	}

	for _, name := range []string{"status", "displayName", "location", "indigenousCommunity",
		"participationInterests", "skills", "languages"} {
		if !filterable[name] {
			t.Errorf("expected field %q to be filterable", name)
		}
	}

	// A free-text field with no filter intent stays non-filterable.
	if filterable["bio"] {
		t.Errorf("bio should not be filterable")
	}
}

// TestCustomRequiredFieldRejectedWhenEmpty models an org adding a required
// custom field to the SharedProfile schema: registration data missing it must
// fail validation.
func TestCustomRequiredFieldRejectedWhenEmpty(t *testing.T) {
	def := SharedProfileType()
	def.Fields = append(def.Fields, FieldDef{Name: "iwi", Type: "string", Required: true})

	data := mustJSON(t, map[string]interface{}{
		"aid":         "EABC",
		"status":      "approved",
		"displayName": "Ada",
		// iwi intentionally omitted
	})

	errs := ValidateData(def, data)
	if !hasErrorMentioning(errs, "iwi") {
		t.Fatalf("expected a validation error for missing required custom field, got %v", errs)
	}

	// Providing it passes.
	data = mustJSON(t, map[string]interface{}{
		"aid": "EABC", "status": "approved", "displayName": "Ada", "iwi": "Ngāti Example",
	})
	if errs := ValidateData(def, data); len(errs) != 0 {
		t.Fatalf("expected no errors once required field provided, got %v", errs)
	}
}

// TestRemovedFieldIgnoredOnRead verifies that data carrying fields no longer in
// the schema (an admin removed them) does not fail validation — unknown fields
// are preserved, not rejected.
func TestRemovedFieldIgnoredOnRead(t *testing.T) {
	// Schema with the six social URL fields dropped.
	def := SharedProfileType()
	kept := def.Fields[:0]
	for _, f := range def.Fields {
		switch f.Name {
		case "facebookUrl", "linkedinUrl", "twitterUrl", "instagramUrl", "githubUrl", "gitlabUrl":
			continue
		}
		kept = append(kept, f)
	}
	def.Fields = kept

	// Older object still carries a facebookUrl value.
	data := mustJSON(t, map[string]interface{}{
		"aid": "EABC", "status": "approved", "displayName": "Ada",
		"facebookUrl": "https://facebook.com/ada",
	})
	if errs := ValidateData(def, data); len(errs) != 0 {
		t.Fatalf("removed field should be ignored on validation, got %v", errs)
	}
}

// TestArrayEnumValidation verifies an org can constrain an array field (e.g.
// participationInterests) to a fixed vocabulary purely via Validation.Enum.
func TestArrayEnumValidation(t *testing.T) {
	def := SharedProfileType()
	for i := range def.Fields {
		if def.Fields[i].Name == "participationInterests" {
			def.Fields[i].Validation = &Validation{Enum: []string{"governance", "events", "tech"}}
		}
	}

	ok := mustJSON(t, map[string]interface{}{
		"aid": "E", "status": "approved", "displayName": "Ada",
		"participationInterests": []string{"governance", "tech"},
	})
	if errs := ValidateData(def, ok); len(errs) != 0 {
		t.Fatalf("expected in-enum interests to pass, got %v", errs)
	}

	bad := mustJSON(t, map[string]interface{}{
		"aid": "E", "status": "approved", "displayName": "Ada",
		"participationInterests": []string{"governance", "cooking"},
	})
	if errs := ValidateData(def, bad); !hasErrorMentioning(errs, "participationInterests") {
		t.Fatalf("expected out-of-enum interest to fail, got %v", errs)
	}
}

// TestEnumChangeValidated verifies that changing an enum in the schema changes
// what validates — a value valid under the old enum fails under the new one.
func TestEnumChangeValidated(t *testing.T) {
	def := SharedProfileType()
	// Narrow the status enum so "declined" is no longer allowed.
	for i := range def.Fields {
		if def.Fields[i].Name == "status" {
			def.Fields[i].Validation = &Validation{Enum: []string{"pending", "approved"}}
		}
	}

	data := mustJSON(t, map[string]interface{}{"aid": "E", "status": "declined", "displayName": "Ada"})
	if errs := ValidateData(def, data); !hasErrorMentioning(errs, "status") {
		t.Fatalf("expected removed enum value to fail, got %v", errs)
	}
}

func mustJSON(t *testing.T, v interface{}) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}

func hasErrorMentioning(errs []string, sub string) bool {
	for _, e := range errs {
		if strings.Contains(e, sub) {
			return true
		}
	}
	return false
}
