package types

import "testing"

func TestMatchesFilters(t *testing.T) {
	def := SharedProfileType()

	data := map[string]interface{}{
		"aid":                    "E1",
		"status":                 "approved",
		"displayName":            "Ada Lovelace",
		"location":               "Wellington",
		"participationInterests": []interface{}{"governance", "events"},
		"skills":                 []interface{}{"go", "vue"},
	}

	cases := []struct {
		name    string
		filters map[string]string
		want    bool
	}{
		{"scalar match", map[string]string{"status": "approved"}, true},
		{"scalar case-insensitive", map[string]string{"status": "APPROVED"}, true},
		{"scalar mismatch", map[string]string{"status": "pending"}, false},
		{"array membership", map[string]string{"skills": "go"}, true},
		{"array membership miss", map[string]string{"skills": "rust"}, false},
		{"array interests", map[string]string{"participationInterests": "governance"}, true},
		{"combined all-match", map[string]string{"status": "approved", "location": "Wellington"}, true},
		{"combined one-miss", map[string]string{"status": "approved", "location": "Auckland"}, false},
		// A filter naming a non-filterable field is ignored (does not constrain).
		{"non-filterable ignored", map[string]string{"bio": "anything"}, true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := MatchesFilters(def, data, tc.filters); got != tc.want {
				t.Errorf("MatchesFilters(%v) = %v, want %v", tc.filters, got, tc.want)
			}
		})
	}
}

func TestMatchesFiltersMissingValue(t *testing.T) {
	def := SharedProfileType()
	// Object with no location set must not match a location filter.
	data := map[string]interface{}{"status": "approved"}
	if MatchesFilters(def, data, map[string]string{"location": "Wellington"}) {
		t.Errorf("expected no match when the filtered field is absent")
	}
}
