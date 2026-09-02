package contributions

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/matou-dao/backend/internal/types"
)

// newSchemaService builds a Service wired to a registry whose Proposal schema
// is def (or the built-in Proposal schema when def is nil).
func newSchemaService(t *testing.T, def *types.TypeDefinition) *Service {
	t.Helper()
	reg := types.NewRegistry()
	reg.Bootstrap()
	if def != nil {
		reg.Register(def)
	}
	svc := NewService(NewMockStore())
	svc.SetRegistry(reg)
	return svc
}

func validProposalRequest() *CreateProposalRequest {
	return &CreateProposalRequest{
		ProposerID:       "user-1",
		Title:            "Build website",
		Types:            []ProposalType{ProposalTypeTechnical},
		Priority:         PriorityMedium,
		Description:      "Build a new website",
		ProblemStatement: "No website exists",
		Solution:         "Build one",
		ExpectedOutcomes: []string{"Website launched"},
		EstimatedBudget:  "$5000",
		Timeline:         "4 weeks",
	}
}

// A valid proposal passes schema validation against the built-in schema.
func TestCreateProposal_SchemaValidationPasses(t *testing.T) {
	svc := newSchemaService(t, nil)
	if _, err := svc.CreateProposal(context.Background(), "space-1", validProposalRequest()); err != nil {
		t.Fatalf("expected valid proposal to pass schema validation, got: %v", err)
	}
}

// An org that adds a required custom field to the Proposal schema has it
// enforced on create, and a supplied custom field round-trips via Data.
func TestCreateProposal_CustomRequiredFieldEnforced(t *testing.T) {
	def := types.ProposalTypeDefinition()
	def.Fields = append(def.Fields, types.FieldDef{
		Name: "impact", Type: "string", Required: true,
		UIHints: &types.UIHints{Label: "Impact", Section: "body"},
	})
	svc := newSchemaService(t, def)
	ctx := context.Background()

	// Missing the custom required field → rejected.
	if _, err := svc.CreateProposal(ctx, "space-1", validProposalRequest()); err == nil {
		t.Fatal("expected create to fail when required custom field 'impact' is missing")
	} else if !strings.Contains(err.Error(), "impact") {
		t.Fatalf("expected error to mention 'impact', got: %v", err)
	}

	// Supplied via the data map → accepted and rounds-trips.
	req := validProposalRequest()
	req.Data = map[string]interface{}{"impact": "high"}
	p, err := svc.CreateProposal(ctx, "space-1", req)
	if err != nil {
		t.Fatalf("expected create to succeed with custom field supplied, got: %v", err)
	}
	if got := p.Data["impact"]; got != "high" {
		t.Fatalf("expected custom field to round-trip, got %v", got)
	}

	// It survives a reload from the store.
	reloaded, err := svc.GetProposal(ctx, "space-1", p.ID)
	if err != nil {
		t.Fatalf("GetProposal: %v", err)
	}
	if got := reloaded.Data["impact"]; got != "high" {
		t.Fatalf("expected custom field to persist, got %v", got)
	}
}

// Tightening an enum in the schema (dropping a previously-valid value) is
// enforced on create.
func TestCreateProposal_EnumChangeValidated(t *testing.T) {
	def := types.ProposalTypeDefinition()
	for i := range def.Fields {
		if def.Fields[i].Name == "priority" {
			def.Fields[i].Validation = &types.Validation{Enum: []string{"low", "medium", "high"}}
		}
	}
	svc := newSchemaService(t, def)

	req := validProposalRequest()
	req.Priority = PriorityCritical // no longer allowed by the tightened enum
	if _, err := svc.CreateProposal(context.Background(), "space-1", req); err == nil {
		t.Fatal("expected create to fail when priority is outside the schema enum")
	} else if !strings.Contains(err.Error(), "priority") {
		t.Fatalf("expected error to mention 'priority', got: %v", err)
	}
}

// An object carrying a field the current schema no longer defines validates
// clean — removing an optional field does not break objects written earlier.
func TestProposalSchema_RemovedOptionalFieldTolerated(t *testing.T) {
	reg := types.NewRegistry()
	reg.Bootstrap()

	p := &Proposal{
		ID: "prop-1", ProposerID: "user-1", Title: "T",
		Types: []ProposalType{ProposalTypeTechnical}, Priority: PriorityLow,
		Description: "d", ProblemStatement: "p", Solution: "s",
		ExpectedOutcomes: []string{"o"}, EstimatedBudget: "$1", Timeline: "1w",
		Status: ProposalDraft,
		// legacyNote is not (or no longer) part of the Proposal schema.
		Data: map[string]interface{}{"legacyNote": "written under an older schema"},
	}
	raw, err := json.Marshal(p.SchemaMap())
	if err != nil {
		t.Fatalf("marshal SchemaMap: %v", err)
	}
	errs, err := reg.Validate("Proposal", raw)
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if len(errs) != 0 {
		t.Fatalf("expected no validation errors for tolerated extra field, got: %v", errs)
	}
}

// Without a registry the service keeps working (built-in Go validation only),
// so environments that never loaded a schema are unaffected.
func TestCreateProposal_NoRegistrySkipsSchema(t *testing.T) {
	svc := NewService(NewMockStore())
	if _, err := svc.CreateProposal(context.Background(), "space-1", validProposalRequest()); err != nil {
		t.Fatalf("expected create to succeed without a registry, got: %v", err)
	}
}
