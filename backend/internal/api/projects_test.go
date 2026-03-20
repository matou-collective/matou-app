package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestProjectsHandler_Create(t *testing.T) {
	handler := setupTestProjectsHandler()

	body := map[string]interface{}{
		"title":       "Test Project",
		"description": "A test project",
		"created_by":  "admin-1",
	}
	b, _ := json.Marshal(body)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects", bytes.NewReader(b))
	w := httptest.NewRecorder()
	handler.HandleCreate(w, req)

	if w.Code != http.StatusCreated {
		t.Errorf("expected 201, got %d: %s", w.Code, w.Body.String())
	}
}

func TestProjectsHandler_List(t *testing.T) {
	handler := setupTestProjectsHandler()

	body, _ := json.Marshal(map[string]interface{}{
		"title": "Project", "description": "Test", "created_by": "admin-1",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects", bytes.NewReader(body))
	w := httptest.NewRecorder()
	handler.HandleCreate(w, req)

	req = httptest.NewRequest(http.MethodGet, "/api/v1/projects", nil)
	w = httptest.NewRecorder()
	handler.HandleList(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}

func TestProjectsHandler_Update(t *testing.T) {
	handler := setupTestProjectsHandler()

	body, _ := json.Marshal(map[string]interface{}{
		"title": "Old", "description": "Test", "created_by": "admin-1",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects", bytes.NewReader(body))
	w := httptest.NewRecorder()
	handler.HandleCreate(w, req)

	var created map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &created)
	id := created["id"].(string)

	update, _ := json.Marshal(map[string]string{"title": "New Title"})
	req = httptest.NewRequest(http.MethodPut, "/api/v1/projects/"+id, bytes.NewReader(update))
	w = httptest.NewRecorder()
	handler.HandleUpdate(w, req, id)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

func TestProjectsHandler_ListByProposalID(t *testing.T) {
	handler := setupTestProjectsHandler()

	// Create a project and link a proposal
	body, _ := json.Marshal(map[string]interface{}{
		"title": "Linked Project", "description": "Test", "created_by": "admin-1",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects", bytes.NewReader(body))
	w := httptest.NewRecorder()
	handler.HandleCreate(w, req)

	var created map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &created)
	id := created["id"].(string)

	linkBody, _ := json.Marshal(map[string]string{"proposal_id": "prop-abc"})
	req = httptest.NewRequest(http.MethodPost, "/api/v1/projects/"+id+"/link-proposal", bytes.NewReader(linkBody))
	w = httptest.NewRecorder()
	handler.HandleLinkProposal(w, req, id)

	// Query with proposal_id filter — should return the project
	req = httptest.NewRequest(http.MethodGet, "/api/v1/projects?proposal_id=prop-abc", nil)
	w = httptest.NewRecorder()
	handler.HandleList(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var result struct {
		Projects []map[string]interface{} `json:"projects"`
		Total    int                      `json:"total"`
	}
	json.Unmarshal(w.Body.Bytes(), &result)
	if result.Total != 1 {
		t.Errorf("expected 1 project, got %d", result.Total)
	}
	if result.Projects[0]["id"] != id {
		t.Errorf("expected project %s, got %s", id, result.Projects[0]["id"])
	}

	// Query with unknown proposal_id — should return empty
	req = httptest.NewRequest(http.MethodGet, "/api/v1/projects?proposal_id=prop-unknown", nil)
	w = httptest.NewRecorder()
	handler.HandleList(w, req)

	json.Unmarshal(w.Body.Bytes(), &result)
	if result.Total != 0 {
		t.Errorf("expected 0 projects for unknown proposal, got %d", result.Total)
	}
}

func TestProjectsHandler_Delete(t *testing.T) {
	handler := setupTestProjectsHandler()

	body, _ := json.Marshal(map[string]interface{}{
		"title": "To Delete", "description": "Test", "created_by": "admin-1",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects", bytes.NewReader(body))
	w := httptest.NewRecorder()
	handler.HandleCreate(w, req)

	var created map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &created)
	id := created["id"].(string)

	req = httptest.NewRequest(http.MethodDelete, "/api/v1/projects/"+id, nil)
	w = httptest.NewRecorder()
	handler.HandleDelete(w, req, id)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}
