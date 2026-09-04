package types

import "testing"

// TestRouteFieldsBySchemaRoutesByDeclaringType verifies a value lands only in
// the destination type(s) whose schema declares the field.
func TestRouteFieldsBySchemaRoutesByDeclaringType(t *testing.T) {
	shared := SharedProfileType()
	community := CommunityProfileType()

	inputs := map[string]interface{}{
		"bio":         "kia ora", // SharedProfile declares it; CommunityProfile does not
		"publicEmail": "a@b.nz",  // SharedProfile only
		"adminNotes":  "flagged", // CommunityProfile only
		"undeclared":  "gone",    // neither declares it
	}

	routed := RouteFieldsBySchema(inputs, community, shared)

	if got, ok := routed["SharedProfile"]["bio"]; !ok || got != "kia ora" {
		t.Errorf("expected bio routed to SharedProfile, got %v (present=%v)", got, ok)
	}
	if _, ok := routed["SharedProfile"]["publicEmail"]; !ok {
		t.Errorf("expected publicEmail routed to SharedProfile")
	}
	if _, ok := routed["CommunityProfile"]["bio"]; ok {
		t.Errorf("bio must not land in CommunityProfile (schema does not declare it)")
	}
	if _, ok := routed["CommunityProfile"]["adminNotes"]; !ok {
		t.Errorf("expected adminNotes routed to CommunityProfile")
	}
	// A field no destination declares is dropped everywhere.
	for _, name := range []string{"SharedProfile", "CommunityProfile"} {
		if _, ok := routed[name]["undeclared"]; ok {
			t.Errorf("undeclared field should be dropped, found it in %s", name)
		}
	}
}

// TestRouteFieldsBySchemaMoveFieldChangesDestination models an admin moving a
// field between spaces by editing the schema: the same input then routes to the
// other type (issue #300 acceptance criterion).
func TestRouteFieldsBySchemaMoveFieldChangesDestination(t *testing.T) {
	shared := SharedProfileType()
	community := CommunityProfileType()

	// Baseline: location is a SharedProfile field.
	routed := RouteFieldsBySchema(map[string]interface{}{"location": "Aotearoa"}, community, shared)
	if _, ok := routed["SharedProfile"]["location"]; !ok {
		t.Fatalf("baseline: expected location in SharedProfile")
	}
	if _, ok := routed["CommunityProfile"]["location"]; ok {
		t.Fatalf("baseline: location should not be in CommunityProfile")
	}

	// Admin moves `location` from SharedProfile to CommunityProfile in the schema.
	shared.Fields = dropField(shared.Fields, "location")
	community.Fields = append(community.Fields, FieldDef{Name: "location", Type: "string"})

	routed = RouteFieldsBySchema(map[string]interface{}{"location": "Aotearoa"}, community, shared)
	if _, ok := routed["SharedProfile"]["location"]; ok {
		t.Errorf("after move: location should no longer route to SharedProfile")
	}
	if got := routed["CommunityProfile"]["location"]; got != "Aotearoa" {
		t.Errorf("after move: expected location in CommunityProfile, got %v", got)
	}
}

// TestRouteFieldsBySchemaEmptyForUnknownDef keeps a map for every def even when
// it declares none of the inputs, and skips nil defs.
func TestRouteFieldsBySchemaEmptyForUnknownDef(t *testing.T) {
	admin := AdminOnlyProfileType()
	routed := RouteFieldsBySchema(map[string]interface{}{"bio": "x"}, admin, nil)
	if m, ok := routed["AdminOnlyProfile"]; !ok || len(m) != 0 {
		t.Errorf("expected empty map for AdminOnlyProfile, got %v (present=%v)", m, ok)
	}
}

func dropField(fields []FieldDef, name string) []FieldDef {
	out := fields[:0]
	for _, f := range fields {
		if f.Name != name {
			out = append(out, f)
		}
	}
	return out
}
