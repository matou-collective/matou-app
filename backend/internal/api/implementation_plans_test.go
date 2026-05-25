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
	json.Unmarshal(w.Body.Bytes(), &resp)
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

func TestImplementationPlansHandler_Get(t *testing.T) {
	handler := setupTestImplementationPlansHandler()

	body, _ := json.Marshal(map[string]interface{}{
		"project_id": "proj-1", "title": "Plan", "description": "d", "created_by": "lead-1",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/implementation-plans", bytes.NewReader(body))
	w := httptest.NewRecorder()
	handler.HandleCreate(w, req)

	var created map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &created)
	id := created["id"].(string)

	req = httptest.NewRequest(http.MethodGet, "/api/v1/implementation-plans/"+id, nil)
	w = httptest.NewRecorder()
	handler.HandleGet(w, req, id)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}
