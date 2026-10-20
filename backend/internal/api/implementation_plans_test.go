package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestImplementationPlansHandler_Create(t *testing.T) {
	handler := setupTestImplementationPlansHandler()

	body, _ := json.Marshal(map[string]interface{}{
		"project_id":  "proj-1",
		"title":       "Test Plan",
		"description": "An implementation plan",
		"created_by":  "lead-1",
	})

	req := httptest.NewRequest(http.MethodPost, "/api/v1/implementation-plans", bytes.NewReader(body))
	w := httptest.NewRecorder()
	handler.HandleCreate(w, req)

	if w.Code != http.StatusCreated {
		t.Errorf("expected 201, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["id"] == nil || resp["id"] == "" {
		t.Error("expected non-empty id in response")
	}
}

func TestImplementationPlansHandler_List(t *testing.T) {
	handler := setupTestImplementationPlansHandler()

	body, _ := json.Marshal(map[string]interface{}{
		"project_id": "proj-1", "title": "Plan", "description": "d", "created_by": "lead-1",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/implementation-plans", bytes.NewReader(body))
	w := httptest.NewRecorder()
	handler.HandleCreate(w, req)

	req = httptest.NewRequest(http.MethodGet, "/api/v1/implementation-plans", nil)
	w = httptest.NewRecorder()
	handler.HandleList(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}

func TestImplementationPlansHandler_ListFilteredByProject(t *testing.T) {
	handler := setupTestImplementationPlansHandler()

	// Two plans in two different projects within the same community space.
	for _, projectID := range []string{"proj-1", "proj-2"} {
		body, _ := json.Marshal(map[string]interface{}{
			"project_id": projectID, "title": "Plan", "description": "d", "created_by": "lead-1",
		})
		req := httptest.NewRequest(http.MethodPost, "/api/v1/implementation-plans", bytes.NewReader(body))
		w := httptest.NewRecorder()
		handler.HandleCreate(w, req)
		if w.Code != http.StatusCreated {
			t.Fatalf("expected 201 creating plan for %s, got %d: %s", projectID, w.Code, w.Body.String())
		}
	}

	// Unfiltered: both plans come back.
	req := httptest.NewRequest(http.MethodGet, "/api/v1/implementation-plans", nil)
	w := httptest.NewRecorder()
	handler.HandleList(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var all struct {
		Plans []map[string]interface{} `json:"implementation_plans"`
		Total int                      `json:"total"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &all)
	if all.Total != 2 || len(all.Plans) != 2 {
		t.Fatalf("expected 2 plans unfiltered, got total=%d len=%d", all.Total, len(all.Plans))
	}

	// Filtered by project_id: only the matching plan comes back.
	req = httptest.NewRequest(http.MethodGet, "/api/v1/implementation-plans?project_id=proj-1", nil)
	w = httptest.NewRecorder()
	handler.HandleList(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var filtered struct {
		Plans []map[string]interface{} `json:"implementation_plans"`
		Total int                      `json:"total"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &filtered)
	if filtered.Total != 1 || len(filtered.Plans) != 1 {
		t.Fatalf("expected 1 plan for proj-1, got total=%d len=%d", filtered.Total, len(filtered.Plans))
	}
	if got := filtered.Plans[0]["project_id"]; got != "proj-1" {
		t.Errorf("expected project_id=proj-1, got %v", got)
	}
}

func TestImplementationPlansHandler_Get(t *testing.T) {
	handler := setupTestImplementationPlansHandler()

	body, _ := json.Marshal(map[string]interface{}{
		"project_id": "proj-1", "title": "Plan", "description": "d", "created_by": "lead-1",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/implementation-plans", bytes.NewReader(body))
	w := httptest.NewRecorder()
	handler.HandleCreate(w, req)

	var created map[string]interface{}
	_ = json.Unmarshal(w.Body.Bytes(), &created)
	id := created["id"].(string)

	req = httptest.NewRequest(http.MethodGet, "/api/v1/implementation-plans/"+id, nil)
	w = httptest.NewRecorder()
	handler.HandleGet(w, req, id)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}
