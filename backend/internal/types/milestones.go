package types

// MilestoneTypeDefinitions returns the built-in milestone type definitions.
func MilestoneTypeDefinitions() []*TypeDefinition {
	return []*TypeDefinition{
		MilestoneTypeDefinition(),
	}
}

// MilestoneTypeDefinition returns the built-in Milestone type definition. It
// mirrors the fields of backend/internal/contributions.Milestone.
//
// The structural fields backend handlers and state machines depend on —
// identity, the owning plan/project links, lifecycle status, the schedule
// dates, the linked contributions and the budget/cost figures — are marked
// Core: they are always present and admin schema edits may not remove them.
// The descriptive body (title, description, success criteria, dependencies)
// plus any org-added custom fields are schema-driven: an org may tighten their
// validation, mark them required/optional, or add new fields, and the backend
// validates and round-trips them via the object's data map.
//
// Stored in the community space alongside the implementation plan it belongs
// to; project leads/stewards (the owners) mutate milestones.
func MilestoneTypeDefinition() *TypeDefinition {
	maxTitle := 200

	return &TypeDefinition{
		Name:        "Milestone",
		Version:     1,
		Description: "A phase of an implementation plan grouping related contributions",
		Space:       "community",
		Fields: []FieldDef{
			// --- Core: identity, links, lifecycle, schedule and budget ---
			{Name: "milestone_id", Type: "string", Required: true, ReadOnly: true, Core: true,
				UIHints: &UIHints{Label: "ID", Section: "core"}},
			{Name: "implementation_plan_id", Type: "string", Required: true, ReadOnly: true, Core: true,
				UIHints: &UIHints{Label: "Implementation Plan", Section: "core", Filterable: true}},
			{Name: "project_id", Type: "string", ReadOnly: true, Core: true,
				UIHints: &UIHints{Label: "Project", Section: "core", Filterable: true}},
			{Name: "status", Type: "string", Core: true,
				Validation: &Validation{Enum: []string{
					"planned", "in_progress", "completed", "delayed", "archived",
				}},
				UIHints: &UIHints{DisplayFormat: "badge", Label: "Status", Section: "core", Filterable: true}},
			{Name: "start_date", Type: "datetime", Core: true,
				UIHints: &UIHints{DisplayFormat: "relative-date", Label: "Start Date", Section: "schedule"}},
			{Name: "end_date", Type: "datetime", Core: true,
				UIHints: &UIHints{DisplayFormat: "relative-date", Label: "End Date", Section: "schedule"}},
			{Name: "contribution_ids", Type: "array", Core: true,
				UIHints: &UIHints{Label: "Contributions", Section: "core"}},
			{Name: "budget_allocation", Type: "number", Core: true,
				UIHints: &UIHints{Label: "Budget Allocation", Section: "budget"}},
			{Name: "actual_cost", Type: "number", ReadOnly: true, Core: true,
				UIHints: &UIHints{Label: "Actual Cost", Section: "budget"}},

			// --- Schema-driven descriptive body ---
			{Name: "title", Type: "string", Required: true,
				Validation: &Validation{MaxLength: &maxTitle},
				UIHints:    &UIHints{InputType: "text", Label: "Title", Placeholder: "Milestone title", Section: "body"}},
			{Name: "description", Type: "string",
				UIHints: &UIHints{InputType: "textarea", Label: "Description", Section: "body"}},
			{Name: "duration", Type: "string",
				UIHints: &UIHints{InputType: "text", Label: "Duration", Section: "body"}},
			{Name: "success_criteria", Type: "array",
				UIHints: &UIHints{Label: "Success Criteria", Section: "body"}},
			{Name: "dependencies", Type: "array",
				UIHints: &UIHints{Label: "Dependencies", Section: "body"}},
		},
		Layouts: map[string]Layout{
			"card":   {Fields: []string{"title", "status", "start_date", "end_date"}},
			"detail": {Fields: []string{"title", "description", "status", "start_date", "end_date", "duration", "success_criteria", "dependencies", "budget_allocation", "actual_cost"}},
			"form":   {Fields: []string{"title", "description", "duration", "start_date", "end_date", "success_criteria", "dependencies", "budget_allocation"}},
		},
		Permissions: TypePermissions{
			Read:  "community",
			Write: "owner",
		},
	}
}
