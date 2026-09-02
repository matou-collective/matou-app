package api

import (
	"encoding/json"
	"testing"

	"github.com/matou-dao/backend/internal/anysync"
	"github.com/matou-dao/backend/internal/types"
)

func TestCollectFilters(t *testing.T) {
	def := types.SharedProfileType()

	// Filterable + unknown (ignored) params accepted.
	filters, bad := collectFilters(def, map[string][]string{
		"status": {"approved"},
		"page":   {"2"}, // unknown → ignored
		"empty":  {""},  // blank → skipped
	})
	if bad != "" {
		t.Fatalf("expected no bad param, got %q", bad)
	}
	if filters["status"] != "approved" {
		t.Fatalf("expected status filter captured, got %v", filters)
	}
	if _, ok := filters["page"]; ok {
		t.Fatalf("unknown param should not be captured as a filter")
	}

	// A known-but-non-filterable field is rejected.
	if _, bad := collectFilters(def, map[string][]string{"bio": {"x"}}); bad != "bio" {
		t.Fatalf("expected bio to be rejected as non-filterable, got %q", bad)
	}
}

func TestFilterProfiles(t *testing.T) {
	def := types.SharedProfileType()

	mk := func(id, status, loc string) *anysync.ObjectPayload {
		data, _ := json.Marshal(map[string]interface{}{
			"aid": id, "status": status, "displayName": "N", "location": loc,
		})
		return &anysync.ObjectPayload{ID: id, Type: "SharedProfile", Data: data, Version: 1}
	}

	objs := []*anysync.ObjectPayload{
		mk("A", "approved", "Wellington"),
		mk("B", "pending", "Wellington"),
		mk("C", "approved", "Auckland"),
	}

	got := filterProfiles(def, objs, map[string]string{"status": "approved", "location": "Wellington"})
	if len(got) != 1 || got[0].ID != "A" {
		t.Fatalf("expected only A to match, got %+v", got)
	}
}
