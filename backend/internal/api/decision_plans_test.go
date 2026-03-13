package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/matou-dao/backend/internal/contributions"
)

func setupTestDecisionPlansHandler() *DecisionPlansHandler {
	store := contributions.NewMockStore()
	svc := contributions.NewService(store)
	return NewDecisionPlansHandler(svc, nil)
}

func TestDecisionPlansHandler_Create(t *testing.T) {
	handler := setupTestDecisionPlansHandler()

	body, _ := json.Marshal(map[string]interface{}{
		"proposal_id":         "prop-1",
		"title":               "Test Plan",
		"description":         "A decision plan",
		"objectives":          []string{"Get approval"},
		"expected_outcomes":   []string{"Approved"},
		"proposal_lead_id":    "lead-1",
		"proposal_steward_id": "steward-1",
	})

	req := httptest.NewRequest(http.MethodPost, "/api/v1/decision-plans", bytes.NewReader(body))
	w := httptest.NewRecorder()
	handler.HandleCreate(w, req)

	if w.Code != http.StatusCreated {
		t.Errorf("expected 201, got %d: %s", w.Code, w.Body.String())
	}
}

func TestDecisionPlansHandler_Transition(t *testing.T) {
	handler := setupTestDecisionPlansHandler()

	body, _ := json.Marshal(map[string]interface{}{
		"proposal_id": "prop-1", "title": "Test", "description": "d",
		"objectives": []string{"o"}, "expected_outcomes": []string{"o"},
		"proposal_lead_id": "lead-1", "proposal_steward_id": "steward-1",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/decision-plans", bytes.NewReader(body))
	w := httptest.NewRecorder()
	handler.HandleCreate(w, req)

	var created map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &created)
	id := created["id"].(string)

	transBody, _ := json.Marshal(map[string]string{"status": "submitted"})
	req = httptest.NewRequest(http.MethodPost, "/api/v1/decision-plans/"+id+"/transition", bytes.NewReader(transBody))
	w = httptest.NewRecorder()
	handler.HandleTransition(w, req, id)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

func TestDecisionPlansHandler_List(t *testing.T) {
	handler := setupTestDecisionPlansHandler()

	body, _ := json.Marshal(map[string]interface{}{
		"proposal_id": "prop-1", "title": "Test", "description": "d",
		"objectives": []string{"o"}, "expected_outcomes": []string{"o"},
		"proposal_lead_id": "lead-1", "proposal_steward_id": "steward-1",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/decision-plans", bytes.NewReader(body))
	w := httptest.NewRecorder()
	handler.HandleCreate(w, req)

	req = httptest.NewRequest(http.MethodGet, "/api/v1/decision-plans", nil)
	w = httptest.NewRecorder()
	handler.HandleList(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}
