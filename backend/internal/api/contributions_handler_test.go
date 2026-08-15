package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/matou-dao/backend/internal/contributions"
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

// TestContributionsHandler_SignOff_PersistsProof verifies that a KERI proof
// envelope (issue #20) sent in the sign-off request body is persisted onto
// the saved Contribution. No verification is performed by the backend.
func TestContributionsHandler_SignOff_PersistsProof(t *testing.T) {
	handler := setupTestContributionsHandler()
	ctx := context.Background()
	spaceID := "community"

	proj, err := handler.service.CreateProject(ctx, spaceID, &contributions.CreateProjectRequest{
		Title: "P", Description: "d", CreatedBy: "u",
	})
	if err != nil {
		t.Fatalf("CreateProject: %v", err)
	}

	plan, err := handler.service.CreateImplementationPlan(ctx, spaceID, &contributions.CreateImplementationPlanRequest{
		ProjectID: proj.ID, ProjectLeadID: "u",
	})
	if err != nil {
		t.Fatalf("CreateImplementationPlan: %v", err)
	}
	plan.SignedOff = true
	now := time.Now()
	plan.SignedOffAt = &now
	if err := handler.service.SaveImplementationPlan(ctx, spaceID, plan); err != nil {
		t.Fatalf("SaveImplementationPlan: %v", err)
	}

	contrib, err := handler.service.CreateContribution(ctx, spaceID, &contributions.CreateContributionRequest{
		ProjectID: proj.ID, Title: "C", Description: "d", ContributionType: "development", CreatedBy: "u",
		Objectives: []string{"o"}, Deliverables: []string{"d"}, AcceptanceCriteria: []string{"a"},
	})
	if err != nil {
		t.Fatalf("CreateContribution: %v", err)
	}
	contrib.Status = contributions.ContribApproved
	if err := handler.service.SaveContribution(ctx, spaceID, contrib); err != nil {
		t.Fatalf("SaveContribution: %v", err)
	}

	proof := &contributions.Proof{
		V:       "matou-proof/v1",
		Action:  "contribution_signoff",
		Subject: contrib.ID,
		Space:   "community",
		Value:   "signed_off",
		Dt:      now.Format(time.RFC3339),
		AID:     "steward-1", // must match X-User-AID: ValidateConsistency requires signer == actor
		Sig:     "0Bsig123",
	}
	body, _ := json.Marshal(map[string]interface{}{"proof": proof})

	req := httptest.NewRequest(http.MethodPost, "/api/v1/contributions/"+contrib.ID+"/sign-off", bytes.NewReader(body))
	req.Header.Set("X-User-AID", "steward-1")
	req = req.WithContext(context.WithValue(req.Context(), ctxUserAID, "steward-1"))
	w := httptest.NewRecorder()
	handler.HandleSignOff(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	saved, err := handler.service.GetContribution(ctx, spaceID, contrib.ID)
	if err != nil {
		t.Fatalf("GetContribution: %v", err)
	}
	if saved.SignOffProof == nil {
		t.Fatal("expected proof to be persisted on the contribution")
	}
	if saved.SignOffProof.Sig != proof.Sig || saved.SignOffProof.AID != proof.AID || saved.SignOffProof.Action != proof.Action {
		t.Errorf("persisted proof mismatch: got %+v, want %+v", saved.SignOffProof, proof)
	}
}

// TestContributionsHandler_SignOff_NoBody verifies that HandleSignOff tolerates
// an absent request body (proof is optional) without erroring on decode.
func TestContributionsHandler_SignOff_NoBody(t *testing.T) {
	handler := setupTestContributionsHandler()
	ctx := context.Background()
	spaceID := "community"

	proj, _ := handler.service.CreateProject(ctx, spaceID, &contributions.CreateProjectRequest{
		Title: "P", Description: "d", CreatedBy: "u",
	})
	plan, _ := handler.service.CreateImplementationPlan(ctx, spaceID, &contributions.CreateImplementationPlanRequest{
		ProjectID: proj.ID, ProjectLeadID: "u",
	})
	plan.SignedOff = true
	now := time.Now()
	plan.SignedOffAt = &now
	_ = handler.service.SaveImplementationPlan(ctx, spaceID, plan)

	contrib, _ := handler.service.CreateContribution(ctx, spaceID, &contributions.CreateContributionRequest{
		ProjectID: proj.ID, Title: "C", Description: "d", ContributionType: "development", CreatedBy: "u",
		Objectives: []string{"o"}, Deliverables: []string{"d"}, AcceptanceCriteria: []string{"a"},
	})
	contrib.Status = contributions.ContribApproved
	_ = handler.service.SaveContribution(ctx, spaceID, contrib)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/contributions/"+contrib.ID+"/sign-off", nil)
	req.Header.Set("X-User-AID", "steward-1")
	req = req.WithContext(context.WithValue(req.Context(), ctxUserAID, "steward-1"))
	w := httptest.NewRecorder()
	handler.HandleSignOff(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	saved, err := handler.service.GetContribution(ctx, spaceID, contrib.ID)
	if err != nil {
		t.Fatalf("GetContribution: %v", err)
	}
	if saved.SignOffProof != nil {
		t.Errorf("expected no proof when none was sent, got %+v", saved.SignOffProof)
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
