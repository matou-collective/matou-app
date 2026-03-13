package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestProposalsHandler_Create(t *testing.T) {
	handler := setupTestProposalsHandler()

	body := map[string]interface{}{
		"proposer_id":       "user-1",
		"title":             "Test Proposal",
		"type":              []string{"technical"},
		"priority":          "medium",
		"description":       "A test",
		"problem_statement": "Problem",
		"solution":          "Solution",
		"expected_outcomes": []string{"outcome"},
		"estimated_budget":  "$1000",
		"timeline":          "2 weeks",
	}
	b, _ := json.Marshal(body)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/proposals", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
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
	if resp["status"] != "draft" {
		t.Errorf("expected draft status, got %v", resp["status"])
	}
}

func TestProposalsHandler_List(t *testing.T) {
	handler := setupTestProposalsHandler()

	// Create one first
	body := map[string]interface{}{
		"proposer_id": "user-1", "title": "Test", "type": []string{"technical"},
		"priority": "low", "description": "d", "problem_statement": "p",
		"solution": "s", "expected_outcomes": []string{"o"},
		"estimated_budget": "$1", "timeline": "1w",
	}
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/proposals", bytes.NewReader(b))
	w := httptest.NewRecorder()
	handler.HandleCreate(w, req)

	// List
	req = httptest.NewRequest(http.MethodGet, "/api/v1/proposals", nil)
	w = httptest.NewRecorder()
	handler.HandleList(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}

func TestProposalsHandler_Transition(t *testing.T) {
	handler := setupTestProposalsHandler()

	// Create
	body := map[string]interface{}{
		"proposer_id": "user-1", "title": "Test", "type": []string{"technical"},
		"priority": "low", "description": "d", "problem_statement": "p",
		"solution": "s", "expected_outcomes": []string{"o"},
		"estimated_budget": "$1", "timeline": "1w",
	}
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/proposals", bytes.NewReader(b))
	w := httptest.NewRecorder()
	handler.HandleCreate(w, req)

	var created map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &created)
	id := created["id"].(string)

	// Transition to submitted
	transBody := map[string]string{"status": "submitted"}
	b, _ = json.Marshal(transBody)
	req = httptest.NewRequest(http.MethodPost, "/api/v1/proposals/"+id+"/transition", bytes.NewReader(b))
	w = httptest.NewRecorder()
	handler.HandleTransition(w, req, id)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}
