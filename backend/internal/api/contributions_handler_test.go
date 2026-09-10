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
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
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
	_ = json.Unmarshal(w.Body.Bytes(), &created)
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
	_ = json.Unmarshal(w.Body.Bytes(), &created)
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
	_ = json.Unmarshal(w.Body.Bytes(), &created)
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
	_ = json.Unmarshal(w.Body.Bytes(), &updated)
	// The model serialises AssignedContributorID as "assigned_contributor"
	if updated["assigned_contributor"] != "new-assignee-aid" {
		t.Errorf("expected assigned_contributor = new-assignee-aid, got %v", updated["assigned_contributor"])
	}
}

// recordingNotifier captures ContribNotifications for assertions.
type recordingNotifier struct {
	sent []*ContribNotification
}

func (n *recordingNotifier) Notify(c *ContribNotification) error {
	n.sent = append(n.sent, c)
	return nil
}

// setupSubmittedForEdit creates a contribution assigned to contributor-1 that
// has been submitted (needs_review), approved by reviewer-1, and returns the
// handler plus its id.
func setupSubmittedForEdit(t *testing.T) (*ContributionsHandler, *recordingNotifier, chan SSEEvent, string) {
	t.Helper()
	store := contributions.NewMockStore()
	svc := contributions.NewService(store)
	notifier := &recordingNotifier{}
	handler := NewContributionsHandler(svc, nil, notifier)
	broker := NewEventBroker()
	handler.SetBroker(broker)
	events := broker.Subscribe()

	ctx := context.Background()
	c, err := svc.CreateContribution(ctx, "community", &contributions.CreateContributionRequest{
		ProjectID: "proj-1", Title: "Task", Description: "Do it",
		ContributionType: "technical", Priority: "low", CreatedBy: "lead-1",
		Objectives: []string{"o"}, Deliverables: []string{"d"},
		AcceptanceCriteria: []string{"a"}, SkillRequirements: []string{"s"},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	_, _ = svc.TransitionContribution(ctx, "community", c.ID, contributions.ContribConfirmed)
	_, _ = svc.AssignContributor(ctx, "community", c.ID, "contributor-1")
	if _, err := svc.SubmitEvidence(ctx, "community", c.ID, "contributor-1", contributions.SubmitEvidenceRequest{CompletionNotes: "done"}); err != nil {
		t.Fatalf("submit: %v", err)
	}
	approved, err := svc.ReviewContribution(ctx, "community", c.ID, contributions.ReviewRequest{Decision: "approved"})
	if err != nil {
		t.Fatalf("approve: %v", err)
	}
	approved.ReviewedBy = "reviewer-1"
	if err := svc.SaveContribution(ctx, "community", approved); err != nil {
		t.Fatalf("save: %v", err)
	}
	return handler, notifier, events, c.ID
}

func editEvidenceRequest(id, actor string) *http.Request {
	body, _ := json.Marshal(map[string]interface{}{"completion_notes": "revised"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/contributions/"+id+"/edit-evidence", bytes.NewReader(body))
	req.Header.Set("X-User-AID", actor)
	return req.WithContext(context.WithValue(req.Context(), ctxUserAID, actor))
}

func TestContributionsHandler_EditEvidence_NonOwnerForbidden(t *testing.T) {
	handler, notifier, events, id := setupSubmittedForEdit(t)

	for _, actor := range []string{"lead-1", "reviewer-1", "", "stranger"} {
		w := httptest.NewRecorder()
		handler.HandleEditEvidence(w, editEvidenceRequest(id, actor))
		if w.Code != http.StatusForbidden {
			t.Errorf("actor %q: expected 403, got %d: %s", actor, w.Code, w.Body.String())
		}
	}
	if len(notifier.sent) != 0 {
		t.Errorf("no notifications expected on rejected edit, got %d", len(notifier.sent))
	}
	select {
	case ev := <-events:
		t.Errorf("no SSE event expected on rejected edit, got %s", ev.Type)
	default:
	}
}

func TestContributionsHandler_EditEvidence_OwnerNotifiesAndBroadcasts(t *testing.T) {
	handler, notifier, events, id := setupSubmittedForEdit(t)

	w := httptest.NewRecorder()
	handler.HandleEditEvidence(w, editEvidenceRequest(id, "contributor-1"))
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp contributions.Contribution
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.Status != contributions.ContribNeedsReview {
		t.Errorf("status = %s, want needs_review", resp.Status)
	}
	if resp.EvidenceEditedAt == nil {
		t.Error("evidence_edited_at should be set")
	}

	// SSE broadcast so open views refresh.
	select {
	case ev := <-events:
		if ev.Type != "contribution:evidence_edited" {
			t.Errorf("event type = %s, want contribution:evidence_edited", ev.Type)
		}
		data := ev.Data.(map[string]string)
		if data["contribution_id"] != id || data["previous_status"] != "approved" || data["status"] != "needs_review" {
			t.Errorf("unexpected event data: %v", data)
		}
	default:
		t.Error("expected an SSE broadcast on edit")
	}

	// Lead AND the reviewer whose approval was voided are notified; the
	// editor is not.
	recipients := map[string]bool{}
	for _, n := range notifier.sent {
		if n.Type != "contribution:evidence_edited" {
			t.Errorf("notification type = %s", n.Type)
		}
		recipients[n.RecipientID] = true
	}
	if !recipients["lead-1"] || !recipients["reviewer-1"] || recipients["contributor-1"] || len(recipients) != 2 {
		t.Errorf("recipients = %v, want {lead-1, reviewer-1}", recipients)
	}
}
