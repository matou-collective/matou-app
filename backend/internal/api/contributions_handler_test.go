package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestContributionsHandler_Create(t *testing.T) {
	handler := setupTestContributionsHandler()

	body, _ := json.Marshal(map[string]interface{}{
		"project_id":          "proj-1",
		"title":               "Test Task",
		"description":         "Do the thing",
		"contribution_type":   "technical",
		"priority":            "medium",
		"created_by":          "lead-1",
		"objectives":          []string{"obj-1"},
		"deliverables":        []string{"del-1"},
		"acceptance_criteria": []string{"ac-1"},
		"skill_requirements":  []string{"Go"},
	})

	req := httptest.NewRequest(http.MethodPost, "/api/v1/contributions", bytes.NewReader(body))
	w := httptest.NewRecorder()
	handler.HandleCreate(w, req)

	if w.Code != http.StatusCreated {
		t.Errorf("expected 201, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["id"] == nil || resp["id"] == "" {
		t.Error("expected non-empty id in response")
	}
}

func TestContributionsHandler_List(t *testing.T) {
	handler := setupTestContributionsHandler()

	body, _ := json.Marshal(map[string]interface{}{
		"project_id": "proj-1", "title": "Task", "description": "Do it",
		"contribution_type": "technical", "priority": "low", "created_by": "lead-1",
		"objectives": []string{"o"}, "deliverables": []string{"d"},
		"acceptance_criteria": []string{"a"}, "skill_requirements": []string{"s"},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/contributions", bytes.NewReader(body))
	w := httptest.NewRecorder()
	handler.HandleCreate(w, req)

	req = httptest.NewRequest(http.MethodGet, "/api/v1/contributions", nil)
	w = httptest.NewRecorder()
	handler.HandleList(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}

func TestContributionsHandler_Get(t *testing.T) {
	handler := setupTestContributionsHandler()

	body, _ := json.Marshal(map[string]interface{}{
		"project_id": "proj-1", "title": "Task", "description": "Do it",
		"contribution_type": "technical", "priority": "low", "created_by": "lead-1",
		"objectives": []string{"o"}, "deliverables": []string{"d"},
		"acceptance_criteria": []string{"a"}, "skill_requirements": []string{"s"},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/contributions", bytes.NewReader(body))
	w := httptest.NewRecorder()
	handler.HandleCreate(w, req)

	var created map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &created)
	id := created["id"].(string)

	req = httptest.NewRequest(http.MethodGet, "/api/v1/contributions/"+id, nil)
	w = httptest.NewRecorder()
	handler.HandleGet(w, req, id)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

func TestContributionsHandler_Transition(t *testing.T) {
	handler := setupTestContributionsHandler()

	body, _ := json.Marshal(map[string]interface{}{
		"project_id": "proj-1", "title": "Task", "description": "Do it",
		"contribution_type": "technical", "priority": "low", "created_by": "lead-1",
		"objectives": []string{"o"}, "deliverables": []string{"d"},
		"acceptance_criteria": []string{"a"}, "skill_requirements": []string{"s"},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/contributions", bytes.NewReader(body))
	w := httptest.NewRecorder()
	handler.HandleCreate(w, req)

	var created map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &created)
	id := created["id"].(string)

	transBody, _ := json.Marshal(map[string]string{"status": "confirmed"})
	req = httptest.NewRequest(http.MethodPost, "/api/v1/contributions/"+id+"/transition", bytes.NewReader(transBody))
	w = httptest.NewRecorder()
	handler.HandleTransition(w, req, id)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

func TestContributionsHandler_UpdateAssignedContributorID(t *testing.T) {
	handler := setupTestContributionsHandler()

	// Create a contribution to update
	createBody, _ := json.Marshal(map[string]interface{}{
		"project_id": "proj-1", "title": "Sub Task", "description": "Sub task desc",
		"contribution_type": "technical", "priority": "medium", "created_by": "lead-1",
		"objectives": []string{"o"}, "deliverables": []string{"d"},
		"acceptance_criteria": []string{"a"}, "skill_requirements": []string{"s"},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/contributions", bytes.NewReader(createBody))
	w := httptest.NewRecorder()
	handler.HandleCreate(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("create failed: %d %s", w.Code, w.Body.String())
	}

	var created map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &created)
	id := created["id"].(string)

	// Update with a new assigned_contributor_id
	updateBody, _ := json.Marshal(map[string]interface{}{
		"assigned_contributor_id": "new-assignee-aid",
		"change_reason":           "Reassigning to new contributor",
	})
	req = httptest.NewRequest(http.MethodPut, "/api/v1/contributions/"+id, bytes.NewReader(updateBody))
	w = httptest.NewRecorder()
	handler.HandleUpdate(w, req, id)

	if w.Code != http.StatusOK {
		t.Fatalf("update failed: %d %s", w.Code, w.Body.String())
	}

	var updated map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &updated)
	// The model serialises AssignedContributorID as "assigned_contributor"
	if updated["assigned_contributor"] != "new-assignee-aid" {
		t.Errorf("expected assigned_contributor = new-assignee-aid, got %v", updated["assigned_contributor"])
	}
}
