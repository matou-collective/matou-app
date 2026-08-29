package types

// ProposalTypeDefinitions returns the built-in proposal type definitions.
func ProposalTypeDefinitions() []*TypeDefinition {
	return []*TypeDefinition{
		ProposalTypeDefinition(),
	}
}

// ProposalTypeDefinition returns the built-in Proposal type definition. It
// mirrors the fields of backend/internal/contributions.Proposal.
//
// Fields the handlers and state machine depend on structurally — identity,
// status, decision/voting fields, timestamps and assigned-role links — are
// marked Core: they are always present and admin schema edits may not remove
// them. The descriptive body (title, description, problem/solution, outcomes,
// budget, timeline, plan, links/attachments) plus any org-added custom fields
// are schema-driven: an org may tighten their validation, mark them
// required/optional, or add new fields, and the backend validates and
// round-trips them via the object's data map.
//
// Stored in the community space — members create, stewards/admins act on them.
func ProposalTypeDefinition() *TypeDefinition {
	maxTitle := 200
	maxBudget := 200
	maxTimeline := 200

	return &TypeDefinition{
		Name:        "Proposal",
		Version:     1,
		Description: "A community proposal moving through endorsement, review and voting",
		Space:       "community",
		Fields: []FieldDef{
			// --- Core: identity, decision/voting and state-machine fields ---
			{Name: "id", Type: "string", Required: true, ReadOnly: true, Core: true,
				UIHints: &UIHints{Label: "ID", Section: "core"}},
			{Name: "proposer_id", Type: "string", Required: true, ReadOnly: true, Core: true,
				UIHints: &UIHints{Label: "Proposer", Section: "core"}},
			{Name: "type", Type: "array", Required: true, Core: true,
				UIHints: &UIHints{InputType: "tags", DisplayFormat: "chip-list", Label: "Type", Section: "core", Filterable: true}},
			{Name: "priority", Type: "string", Required: true, Core: true,
				Validation: &Validation{Enum: []string{"low", "medium", "high", "critical"}},
				UIHints:    &UIHints{InputType: "select", DisplayFormat: "badge", Label: "Priority", Section: "core", Filterable: true}},
			{Name: "status", Type: "string", ReadOnly: true, Core: true,
				Validation: &Validation{Enum: []string{
					"draft", "submitted", "endorsing", "in_review", "signed_off",
					"voting_process", "approved", "rejected", "completed", "withdrawn",
				}},
				UIHints: &UIHints{DisplayFormat: "badge", Label: "Status", Section: "core", Filterable: true}},
			{Name: "endorsement_threshold", Type: "number", Core: true,
				UIHints: &UIHints{Label: "Endorsement Threshold", Section: "core"}},
			{Name: "proposal_lead_id", Type: "string", Core: true,
				UIHints: &UIHints{Label: "Proposal Lead", Section: "roles"}},
			{Name: "proposal_steward_id", Type: "string", Core: true,
				UIHints: &UIHints{Label: "Proposal Steward", Section: "roles"}},
			{Name: "lead_contribution_id", Type: "string", ReadOnly: true, Core: true,
				UIHints: &UIHints{Label: "Lead Contribution", Section: "roles"}},
			{Name: "steward_contribution_id", Type: "string", ReadOnly: true, Core: true,
				UIHints: &UIHints{Label: "Steward Contribution", Section: "roles"}},
			{Name: "created_at", Type: "datetime", ReadOnly: true, Core: true,
				UIHints: &UIHints{DisplayFormat: "relative-date", Label: "Created", Section: "core"}},
			{Name: "updated_at", Type: "datetime", ReadOnly: true, Core: true,
				UIHints: &UIHints{DisplayFormat: "relative-date", Label: "Updated", Section: "core"}},

			// --- Schema-driven descriptive body ---
			{Name: "title", Type: "string", Required: true,
				Validation: &Validation{MaxLength: &maxTitle},
				UIHints:    &UIHints{InputType: "text", Label: "Title", Placeholder: "Proposal title", Section: "body"}},
			{Name: "description", Type: "string", Required: true,
				UIHints: &UIHints{InputType: "textarea", Label: "Description", Section: "body"}},
			{Name: "problem_statement", Type: "string", Required: true,
				UIHints: &UIHints{InputType: "textarea", Label: "Problem Statement", Section: "body"}},
			{Name: "solution", Type: "string", Required: true,
				UIHints: &UIHints{InputType: "textarea", Label: "Solution", Section: "body"}},
			{Name: "expected_outcomes", Type: "array", Required: true,
				UIHints: &UIHints{Label: "Expected Outcomes", Section: "body"}},
			{Name: "estimated_budget", Type: "string", Required: true,
				Validation: &Validation{MaxLength: &maxBudget},
				UIHints:    &UIHints{InputType: "text", Label: "Estimated Budget", Section: "body"}},
			{Name: "timeline", Type: "string", Required: true,
				Validation: &Validation{MaxLength: &maxTimeline},
				UIHints:    &UIHints{InputType: "text", Label: "Timeline", Section: "body"}},
			{Name: "project_plan", Type: "array",
				UIHints: &UIHints{Label: "Project Plan", Section: "body"}},
			{Name: "attachments", Type: "array",
				UIHints: &UIHints{Label: "Attachments", Section: "body"}},
		},
		Layouts: map[string]Layout{
			"card":   {Fields: []string{"title", "type", "priority", "status"}},
			"detail": {Fields: []string{"title", "description", "problem_statement", "solution", "expected_outcomes", "estimated_budget", "timeline", "project_plan", "attachments", "status", "priority"}},
			"form":   {Fields: []string{"title", "type", "priority", "description", "problem_statement", "solution", "expected_outcomes", "estimated_budget", "timeline", "project_plan", "attachments"}},
		},
		Permissions: TypePermissions{
			Read:  "community",
			Write: "owner",
		},
	}
}
