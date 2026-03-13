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
