package contributions

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/matou-dao/backend/internal/types"
)

// newMilestonePlan creates a project + implementation plan on svc and returns
// the plan ID, so milestone tests have a plan to attach milestones to.
func newMilestonePlan(t *testing.T, svc *Service) (spaceID, planID string) {
	t.Helper()
	ctx := context.Background()
	spaceID = "space-1"
	proj, err := svc.CreateProject(ctx, spaceID, &CreateProjectRequest{Title: "P", Description: "d", CreatedBy: "u"})
	if err != nil {
		t.Fatalf("CreateProject: %v", err)
	}
	plan, err := svc.CreateImplementationPlan(ctx, spaceID, &CreateImplementationPlanRequest{ProjectID: proj.ID, ProjectLeadID: "u"})
	if err != nil {
		t.Fatalf("CreateImplementationPlan: %v", err)
	}
	return spaceID, plan.ID
}

// A valid milestone passes schema validation against the built-in schema.
func TestAddMilestone_SchemaValidationPasses(t *testing.T) {
	svc := newSchemaService(t, nil)
	spaceID, planID := newMilestonePlan(t, svc)
	if _, err := svc.AddMilestone(context.Background(), spaceID, "u", &CreateMilestoneRequest{
		ImplementationPlanID: planID, Title: "M1", Duration: "1w",
	}); err != nil {
		t.Fatalf("expected valid milestone to pass schema validation, got: %v", err)
	}
}

// An org that adds a required custom field to the Milestone schema has it
// enforced on add, and a supplied custom field round-trips via Data.
func TestAddMilestone_CustomRequiredFieldEnforced(t *testing.T) {
	def := types.MilestoneTypeDefinition()
	def.Fields = append(def.Fields, types.FieldDef{
		Name: "risk_level", Type: "string", Required: true,
		UIHints: &types.UIHints{Label: "Risk Level", Section: "body"},
	})
	svc := newSchemaService(t, def)
	spaceID, planID := newMilestonePlan(t, svc)
	ctx := context.Background()

	// Missing the custom required field → rejected.
	if _, err := svc.AddMilestone(ctx, spaceID, "u", &CreateMilestoneRequest{
		ImplementationPlanID: planID, Title: "M1", Duration: "1w",
	}); err == nil {
		t.Fatal("expected add to fail when required custom field 'risk_level' is missing")
	} else if !strings.Contains(err.Error(), "risk_level") {
		t.Fatalf("expected error to mention 'risk_level', got: %v", err)
	}

	// Supplied via the data map → accepted and rounds-trips.
	ms, err := svc.AddMilestone(ctx, spaceID, "u", &CreateMilestoneRequest{
		ImplementationPlanID: planID, Title: "M1", Duration: "1w",
		Data: map[string]interface{}{"risk_level": "high"},
	})
	if err != nil {
		t.Fatalf("expected add to succeed with custom field supplied, got: %v", err)
	}
	if got := ms.Data["risk_level"]; got != "high" {
		t.Fatalf("expected custom field to round-trip, got %v", got)
	}

	// It survives a reload from the store.
	reloaded, err := svc.GetMilestone(ctx, spaceID, ms.MilestoneID)
	if err != nil {
		t.Fatalf("GetMilestone: %v", err)
	}
	if got := reloaded.Data["risk_level"]; got != "high" {
		t.Fatalf("expected custom field to persist, got %v", got)
	}
}

// Tightening the status enum in the schema (dropping a previously-valid value)
// is enforced on update.
func TestUpdateMilestone_EnumChangeValidated(t *testing.T) {
	def := types.MilestoneTypeDefinition()
	for i := range def.Fields {
		if def.Fields[i].Name == "status" {
			def.Fields[i].Validation = &types.Validation{Enum: []string{"planned", "in_progress", "completed"}}
		}
	}
	svc := newSchemaService(t, def)
	spaceID, planID := newMilestonePlan(t, svc)
	ctx := context.Background()

	ms, err := svc.AddMilestone(ctx, spaceID, "u", &CreateMilestoneRequest{
		ImplementationPlanID: planID, Title: "M1", Duration: "1w",
	})
	if err != nil {
		t.Fatalf("AddMilestone: %v", err)
	}

	delayed := string(MilestoneDelayed) // no longer allowed by the tightened enum
	if _, err := svc.UpdateMilestone(ctx, spaceID, ms.MilestoneID, "u", &UpdateMilestoneRequest{Status: &delayed}); err == nil {
		t.Fatal("expected update to fail when status is outside the schema enum")
	} else if !strings.Contains(err.Error(), "status") {
		t.Fatalf("expected error to mention 'status', got: %v", err)
	}

	// A value still in the enum is accepted.
	inProgress := string(MilestoneInProgress)
	if _, err := svc.UpdateMilestone(ctx, spaceID, ms.MilestoneID, "u", &UpdateMilestoneRequest{Status: &inProgress}); err != nil {
		t.Fatalf("expected in-enum status update to succeed, got: %v", err)
	}
}

// A milestone carrying a field the current schema no longer defines validates
// clean — removing an optional field does not break objects written earlier.
func TestMilestoneSchema_RemovedOptionalFieldTolerated(t *testing.T) {
	reg := types.NewRegistry()
	reg.Bootstrap()

	m := &Milestone{
		MilestoneID: "ms_1", ImplementationPlanID: "ip_1", Title: "M1",
		Status: MilestonePlanned,
		// legacyNote is not (or no longer) part of the Milestone schema.
		Data: map[string]interface{}{"legacyNote": "written under an older schema"},
	}
	raw, err := json.Marshal(m.SchemaMap())
	if err != nil {
		t.Fatalf("marshal SchemaMap: %v", err)
	}
	errs, err := reg.Validate("Milestone", raw)
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if len(errs) != 0 {
		t.Fatalf("expected no validation errors for tolerated extra field, got: %v", errs)
	}
}

// Without a registry the service keeps working (built-in Go validation only),
// so environments that never loaded a schema are unaffected.
func TestAddMilestone_NoRegistrySkipsSchema(t *testing.T) {
	svc := NewService(NewMockStore())
	spaceID, planID := newMilestonePlan(t, svc)
	if _, err := svc.AddMilestone(context.Background(), spaceID, "u", &CreateMilestoneRequest{
		ImplementationPlanID: planID, Title: "M1", Duration: "1w",
	}); err != nil {
		t.Fatalf("expected add to succeed without a registry, got: %v", err)
	}
}

// TestUpdateMilestone_WriteThroughToStandalone is the drift-fix regression (the
// ADR-0174 ruling on issue #186): the standalone "milestone" record is the
// single source of truth, so an UpdateMilestone edit is visible via both
// GetMilestone (the standalone record) and GetImplementationPlan (which
// re-projects the standalone record onto the plan's embedded array).
func TestUpdateMilestone_WriteThroughToStandalone(t *testing.T) {
	ctx := context.Background()
	svc := NewService(NewMockStore())
	spaceID, planID := newMilestonePlan(t, svc)

	ms, err := svc.AddMilestone(ctx, spaceID, "u", &CreateMilestoneRequest{
		ImplementationPlanID: planID, Title: "Old", Duration: "1w",
	})
	if err != nil {
		t.Fatalf("AddMilestone: %v", err)
	}

	newTitle := "New title"
	if _, err := svc.UpdateMilestone(ctx, spaceID, ms.MilestoneID, "editor", &UpdateMilestoneRequest{Title: &newTitle}); err != nil {
		t.Fatalf("UpdateMilestone: %v", err)
	}

	// Standalone record reflects the edit (previously it went stale).
	standalone, err := svc.GetMilestone(ctx, spaceID, ms.MilestoneID)
	if err != nil {
		t.Fatalf("GetMilestone: %v", err)
	}
	if standalone.Title != "New title" {
		t.Errorf("standalone milestone title = %q, want New title", standalone.Title)
	}

	// The plan's embedded milestone is re-projected from the standalone record,
	// so it can never show the stale title either.
	plan, err := svc.GetImplementationPlan(ctx, spaceID, planID)
	if err != nil {
		t.Fatalf("GetImplementationPlan: %v", err)
	}
	if len(plan.Milestones) != 1 {
		t.Fatalf("expected 1 embedded milestone, got %d", len(plan.Milestones))
	}
	if plan.Milestones[0].Title != "New title" {
		t.Errorf("embedded milestone title = %q, want New title", plan.Milestones[0].Title)
	}
}
