package types

import (
	"encoding/json"
	"testing"
)

// TestVersionForEditBumpsOnSchemaChange verifies the version-bump rule: a
// substantive schema edit bumps the version, a cosmetic one does not.
func TestVersionForEditBumpsOnSchemaChange(t *testing.T) {
	base := SharedProfileType()

	// Cosmetic edit: relabel a field. Version must not move.
	cosmetic := SharedProfileType()
	for i := range cosmetic.Fields {
		if cosmetic.Fields[i].Name == "bio" {
			cosmetic.Fields[i].UIHints.Label = "Bio (renamed)"
		}
	}
	if SchemaChanged(base, cosmetic) {
		t.Errorf("relabelling a field is cosmetic, must not count as a schema change")
	}
	if got := VersionForEdit(base, cosmetic); got != base.Version {
		t.Errorf("cosmetic edit should keep version %d, got %d", base.Version, got)
	}

	// Layout-only edit: reorder the form layout. Not a schema change.
	layout := SharedProfileType()
	layout.Layouts["form"] = Layout{Fields: []string{"displayName", "bio"}}
	if SchemaChanged(base, layout) {
		t.Errorf("changing a layout is cosmetic, must not count as a schema change")
	}

	// Substantive edit: add a required field. Version bumps by one.
	added := SharedProfileType()
	added.Fields = append(added.Fields, FieldDef{Name: "iwi", Type: "string", Required: true})
	if !SchemaChanged(base, added) {
		t.Errorf("adding a field must count as a schema change")
	}
	if got := VersionForEdit(base, added); got != base.Version+1 {
		t.Errorf("adding a field should bump version to %d, got %d", base.Version+1, got)
	}

	// Substantive edit: tighten a field's validation.
	tightened := SharedProfileType()
	for i := range tightened.Fields {
		if tightened.Fields[i].Name == "status" {
			tightened.Fields[i].Validation = &Validation{Enum: []string{"pending", "approved"}}
		}
	}
	if !SchemaChanged(base, tightened) {
		t.Errorf("changing a field's validation must count as a schema change")
	}

	// Removing a field is a schema change.
	removed := SharedProfileType()
	kept := removed.Fields[:0]
	for _, f := range removed.Fields {
		if f.Name == "bio" {
			continue
		}
		kept = append(kept, f)
	}
	removed.Fields = kept
	if !SchemaChanged(base, removed) {
		t.Errorf("removing a field must count as a schema change")
	}

	// Field reordering alone is not a schema change.
	reordered := SharedProfileType()
	reordered.Fields[0], reordered.Fields[1] = reordered.Fields[1], reordered.Fields[0]
	if SchemaChanged(base, reordered) {
		t.Errorf("reordering fields must not count as a schema change")
	}
}

// TestSchemaVersionAndIsStale covers reading the stamped version and staleness.
func TestSchemaVersionAndIsStale(t *testing.T) {
	def := SharedProfileType()
	def.Version = 2

	// A profile written under v1 is stale relative to a live v2 schema.
	v1 := mustJSON(t, map[string]interface{}{
		"aid": "E", "status": "approved", "displayName": "Ada", "typeVersion": 1,
	})
	if got := SchemaVersion(v1); got != 1 {
		t.Fatalf("expected version 1, got %d", got)
	}
	if !def.IsStale(v1) {
		t.Errorf("a v1 profile should be stale under a v2 schema")
	}

	// A pre-versioning profile (no typeVersion) reads as version 0 and is stale.
	pre := mustJSON(t, map[string]interface{}{"aid": "E", "status": "approved", "displayName": "Ada"})
	if got := SchemaVersion(pre); got != 0 {
		t.Fatalf("expected version 0 for unstamped data, got %d", got)
	}
	if !def.IsStale(pre) {
		t.Errorf("an unstamped profile should be stale under a v2 schema")
	}

	// A profile at the live version is not stale.
	v2 := mustJSON(t, map[string]interface{}{
		"aid": "E", "status": "approved", "displayName": "Ada", "typeVersion": 2,
	})
	if def.IsStale(v2) {
		t.Errorf("a v2 profile should not be stale under a v2 schema")
	}
}

// TestStampVersionMigratesOnWrite verifies StampVersion records the live version
// (regardless of any client-supplied value) and is a no-op for types without a
// typeVersion field.
func TestStampVersionMigratesOnWrite(t *testing.T) {
	def := SharedProfileType()
	def.Version = 3

	// A stale (or spoofed) client value is overwritten with the live version.
	in := mustJSON(t, map[string]interface{}{
		"aid": "E", "status": "approved", "displayName": "Ada", "typeVersion": 1,
	})
	out, err := StampVersion(def, in)
	if err != nil {
		t.Fatalf("StampVersion: %v", err)
	}
	if got := SchemaVersion(out); got != 3 {
		t.Fatalf("expected stamped version 3, got %d", got)
	}
	if def.IsStale(out) {
		t.Errorf("a freshly stamped profile must not be stale")
	}

	// Types without a typeVersion field are left untouched.
	priv := PrivateProfileType()
	privData := mustJSON(t, map[string]interface{}{"membershipCredentialSAID": "S"})
	out, err = StampVersion(priv, privData)
	if err != nil {
		t.Fatalf("StampVersion (no typeVersion field): %v", err)
	}
	var m map[string]interface{}
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, present := m["typeVersion"]; present {
		t.Errorf("StampVersion must not add typeVersion to a type that does not declare it")
	}
}

// TestNewRequiredFieldGrandfatheredOnRead is the acceptance test for #302: an
// admin adds a required field to the schema; an existing member's profile
// (written before the field existed) still LOADS via the tolerant read
// validation, while the member's NEXT SAVE is asked for the new field by the
// strict write validation. Saving with the field re-stamps the live version.
func TestNewRequiredFieldGrandfatheredOnRead(t *testing.T) {
	// v1 schema and an existing member profile written under it.
	oldDef := SharedProfileType()
	existing := mustJSON(t, map[string]interface{}{
		"aid": "EABC", "status": "approved", "displayName": "Ada", "typeVersion": oldDef.Version,
	})

	// Admin edits the schema, adding a required "iwi" field. The version bumps.
	newDef := SharedProfileType()
	newDef.Fields = append(newDef.Fields, FieldDef{Name: "iwi", Type: "string", Required: true})
	newDef.Version = VersionForEdit(oldDef, newDef)
	if newDef.Version != oldDef.Version+1 {
		t.Fatalf("schema edit should have bumped the version")
	}

	// The existing profile is now stale but must still LOAD: read validation
	// grandfathers the newly-required field.
	if !newDef.IsStale(existing) {
		t.Fatalf("existing profile should be stale under the new schema")
	}
	if errs := ValidateForRead(newDef, existing); len(errs) != 0 {
		t.Fatalf("existing member must still load under the new schema, got %v", errs)
	}

	// But the member's NEXT SAVE is strict: a save that still omits iwi is
	// rejected, so the UI asks for the new field.
	if errs := ValidateData(newDef, existing); !hasErrorMentioning(errs, "iwi") {
		t.Fatalf("next save must be asked for the new required field, got %v", errs)
	}

	// Once the member provides iwi, the save passes and re-stamps the live
	// version — the profile is migrated and no longer stale.
	saved := mustJSON(t, map[string]interface{}{
		"aid": "EABC", "status": "approved", "displayName": "Ada", "iwi": "Ngāti Example",
		"typeVersion": oldDef.Version, // client sends the stale version; the server re-stamps
	})
	if errs := ValidateData(newDef, saved); len(errs) != 0 {
		t.Fatalf("save with the new field should pass, got %v", errs)
	}
	stamped, err := StampVersion(newDef, saved)
	if err != nil {
		t.Fatalf("StampVersion: %v", err)
	}
	if newDef.IsStale(stamped) {
		t.Fatalf("migrated profile should no longer be stale")
	}
}

// TestValidateForReadStillValidatesPresentValues verifies read tolerance does
// not become read blindness: a value that IS present is still validated.
func TestValidateForReadStillValidatesPresentValues(t *testing.T) {
	def := SharedProfileType()
	// displayName present but too short (min length 2).
	data := mustJSON(t, map[string]interface{}{"aid": "E", "status": "approved", "displayName": "A"})
	if errs := ValidateForRead(def, data); !hasErrorMentioning(errs, "displayName") {
		t.Fatalf("a present-but-invalid value should still fail read validation, got %v", errs)
	}

	// A removed/unknown field present in old data stays inert on read.
	withUnknown := mustJSON(t, map[string]interface{}{
		"aid": "E", "status": "approved", "displayName": "Ada", "legacyField": "x",
	})
	if errs := ValidateForRead(def, withUnknown); len(errs) != 0 {
		t.Fatalf("unknown/removed field should be inert on read, got %v", errs)
	}
}
