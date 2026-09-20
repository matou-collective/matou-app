package types

import "testing"

// TestMilestoneCoreFields verifies the structural fields backend handlers and
// state machines depend on are marked core (issue #186) and that the removable
// descriptive-body fields are not.
func TestMilestoneCoreFields(t *testing.T) {
	def := MilestoneTypeDefinition()

	core := map[string]bool{}
	for _, name := range def.CoreFieldNames() {
		core[name] = true
	}

	wantCore := []string{"milestone_id", "implementation_plan_id", "project_id",
		"status", "start_date", "end_date", "contribution_ids",
		"budget_allocation", "actual_cost"}
	for _, name := range wantCore {
		if !core[name] {
			t.Errorf("expected field %q to be core", name)
		}
	}

	// Org-customisable descriptive fields must NOT be core.
	for _, name := range []string{"description", "duration", "success_criteria", "dependencies"} {
		if core[name] {
			t.Errorf("field %q should not be core (org may remove it)", name)
		}
	}
}

// TestMilestoneFilterableFields verifies filterable fields are derived from the
// schema, not hardcoded, and cover the expected list/search dimensions.
func TestMilestoneFilterableFields(t *testing.T) {
	def := MilestoneTypeDefinition()

	filterable := map[string]bool{}
	for _, name := range def.FilterableFieldNames() {
		filterable[name] = true
	}

	for _, name := range []string{"status", "project_id", "implementation_plan_id"} {
		if !filterable[name] {
			t.Errorf("expected field %q to be filterable", name)
		}
	}

	// A free-text body field carries no filter intent.
	if filterable["description"] {
		t.Errorf("description should not be filterable")
	}
}

// TestMilestoneRegisteredByBootstrap verifies Bootstrap persists the built-in
// Milestone schema so #178's org setup can store it.
func TestMilestoneRegisteredByBootstrap(t *testing.T) {
	reg := NewRegistry()
	reg.Bootstrap()
	if _, ok := reg.Get("Milestone"); !ok {
		t.Fatal("expected Bootstrap to register the Milestone type")
	}
}

// TestMilestoneStatusEnumValidated verifies the built-in status enum is enforced
// and that tightening it (dropping a value) changes what validates.
func TestMilestoneStatusEnumValidated(t *testing.T) {
	def := MilestoneTypeDefinition()

	// A value in the built-in enum passes.
	ok := mustJSON(t, map[string]interface{}{
		"milestone_id": "ms_1", "implementation_plan_id": "ip_1",
		"title": "M1", "status": "in_progress",
	})
	if errs := ValidateData(def, ok); len(errs) != 0 {
		t.Fatalf("expected in-enum status to pass, got %v", errs)
	}

	// Tighten the enum so "delayed" is no longer allowed.
	for i := range def.Fields {
		if def.Fields[i].Name == "status" {
			def.Fields[i].Validation = &Validation{Enum: []string{"planned", "in_progress", "completed"}}
		}
	}
	bad := mustJSON(t, map[string]interface{}{
		"milestone_id": "ms_1", "implementation_plan_id": "ip_1",
		"title": "M1", "status": "delayed",
	})
	if errs := ValidateData(def, bad); !hasErrorMentioning(errs, "status") {
		t.Fatalf("expected removed enum value to fail, got %v", errs)
	}
}

// TestMilestoneRemovedFieldToleratedOnRead verifies data carrying a field the
// current schema no longer defines validates clean — removing an optional field
// does not break objects written under an older schema.
func TestMilestoneRemovedFieldToleratedOnRead(t *testing.T) {
	def := MilestoneTypeDefinition()

	data := mustJSON(t, map[string]interface{}{
		"milestone_id": "ms_1", "implementation_plan_id": "ip_1", "title": "M1",
		// legacyNote is not part of the Milestone schema.
		"legacyNote": "written under an older schema",
	})
	if errs := ValidateData(def, data); len(errs) != 0 {
		t.Fatalf("unknown field should be ignored on validation, got %v", errs)
	}
}
