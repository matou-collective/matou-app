package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/matou-dao/backend/internal/contributions"
	matouTypes "github.com/matou-dao/backend/internal/types"
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
	req = asMember(req)
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
	req = asMember(req)
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
	req = asMember(req)
	w := httptest.NewRecorder()
	handler.HandleCreate(w, req)

	var created map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &created)
	id := created["id"].(string)

	// Transition to submitted
	transBody := map[string]string{"status": "submitted"}
	b, _ = json.Marshal(transBody)
	req = httptest.NewRequest(http.MethodPost, "/api/v1/proposals/"+id+"/transition", bytes.NewReader(b))
	req = asMember(req)
	w = httptest.NewRecorder()
	handler.HandleTransition(w, req, id)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

// withRBACContext adds user AID and roles to a request for testing.
func withRBACContext(r *http.Request, aid string, roles []contributions.Role) *http.Request {
	ctx := context.WithValue(r.Context(), ctxUserAID, aid)
	ctx = context.WithValue(ctx, ctxUserRoles, roles)
	return r.WithContext(ctx)
}

// asMember sets the X-User-AID header and a Member role context — the minimum
// to pass the create_proposals gate (#315), which every member role holds by
// default. Used by tests that just need a proposal created/submitted.
func asMember(r *http.Request) *http.Request {
	r.Header.Set("X-User-AID", "user-1")
	return withRBACContext(r, "user-1", []contributions.Role{contributions.RoleMember})
}

// createTestProposalInReview creates a proposal and transitions it to in_review
// with lead and steward assigned. Returns the proposal ID.
func createTestProposalInReview(t *testing.T, handler *ProposalsHandler) string {
	t.Helper()

	// Create proposal
	body := map[string]interface{}{
		"proposer_id": "user-1", "title": "Test", "type": []string{"technical"},
		"priority": "low", "description": "d", "problem_statement": "p",
		"solution": "s", "expected_outcomes": []string{"o"},
		"estimated_budget": "$1", "timeline": "1w",
	}
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/proposals", bytes.NewReader(b))
	req = asMember(req)
	w := httptest.NewRecorder()
	handler.HandleCreate(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("create failed: %d %s", w.Code, w.Body.String())
	}
	var created map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &created)
	id := created["id"].(string)

	// Transition draft → submitted
	b, _ = json.Marshal(map[string]string{"status": "submitted"})
	req = httptest.NewRequest(http.MethodPost, "/api/v1/proposals/"+id+"/transition", bytes.NewReader(b))
	req = asMember(req)
	w = httptest.NewRecorder()
	handler.HandleTransition(w, req, id)
	if w.Code != http.StatusOK {
		t.Fatalf("submit failed: %d %s", w.Code, w.Body.String())
	}

	// Transition submitted → in_review
	b, _ = json.Marshal(map[string]string{"status": "in_review"})
	req = httptest.NewRequest(http.MethodPost, "/api/v1/proposals/"+id+"/transition", bytes.NewReader(b))
	w = httptest.NewRecorder()
	handler.HandleTransition(w, req, id)
	if w.Code != http.StatusOK {
		t.Fatalf("in_review failed: %d %s", w.Code, w.Body.String())
	}

	// Assign lead and steward (proposer_id is "user-1", use matching AID)
	b, _ = json.Marshal(map[string]interface{}{
		"proposal_lead_id":    "lead-1",
		"proposal_steward_id": "steward-1",
	})
	req = httptest.NewRequest(http.MethodPatch, "/api/v1/proposals/"+id, bytes.NewReader(b))
	req.Header.Set("X-User-AID", "user-1") // matches proposer_id
	w = httptest.NewRecorder()
	handler.HandleUpdate(w, req, id)
	if w.Code != http.StatusOK {
		t.Fatalf("update failed: %d %s", w.Code, w.Body.String())
	}

	return id
}

func TestProposalsHandler_Transition_SignOff_AdminAllowed(t *testing.T) {
	handler := setupTestProposalsHandler()
	id := createTestProposalInReview(t, handler)

	// Sign off with admin role — should succeed
	b, _ := json.Marshal(map[string]string{"status": "signed_off"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/proposals/"+id+"/transition", bytes.NewReader(b))
	req.Header.Set("X-User-AID", "steward-aid")
	// roleLookup is nil in test handler, so roles come from context
	req = withRBACContext(req, "steward-aid", []contributions.Role{contributions.RoleProjectSteward})
	w := httptest.NewRecorder()
	handler.HandleTransition(w, req, id)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200 for admin sign-off, got %d: %s", w.Code, w.Body.String())
	}
}

func TestProposalsHandler_Transition_SignOff_NonAdminForbidden(t *testing.T) {
	handler := setupTestProposalsHandler()
	id := createTestProposalInReview(t, handler)

	// Sign off with non-admin role — should be forbidden
	b, _ := json.Marshal(map[string]string{"status": "signed_off"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/proposals/"+id+"/transition", bytes.NewReader(b))
	req.Header.Set("X-User-AID", "contributor-aid")
	req = withRBACContext(req, "contributor-aid", []contributions.Role{contributions.RoleContributor})
	w := httptest.NewRecorder()
	handler.HandleTransition(w, req, id)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for non-admin sign-off, got %d: %s", w.Code, w.Body.String())
	}
}

func TestProposalsHandler_Transition_SignOff_NoAIDUnauthorized(t *testing.T) {
	handler := setupTestProposalsHandler()
	id := createTestProposalInReview(t, handler)

	// Sign off without X-User-AID — should be unauthorized
	b, _ := json.Marshal(map[string]string{"status": "signed_off"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/proposals/"+id+"/transition", bytes.NewReader(b))
	w := httptest.NewRecorder()
	handler.HandleTransition(w, req, id)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 for missing AID, got %d: %s", w.Code, w.Body.String())
	}
}

// createDraft creates a proposal as a member and returns its id.
func createDraft(t *testing.T, handler *ProposalsHandler) string {
	t.Helper()
	body := map[string]interface{}{
		"proposer_id": "user-1", "title": "Test", "type": []string{"technical"},
		"priority": "low", "description": "d", "problem_statement": "p",
		"solution": "s", "expected_outcomes": []string{"o"},
		"estimated_budget": "$1", "timeline": "1w",
	}
	b, _ := json.Marshal(body)
	req := asMember(httptest.NewRequest(http.MethodPost, "/api/v1/proposals", bytes.NewReader(b)))
	w := httptest.NewRecorder()
	handler.HandleCreate(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("create failed: %d %s", w.Code, w.Body.String())
	}
	var created map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &created)
	return created["id"].(string)
}

// Create requires the create_proposals capability (#315), which every member
// role holds by default — so a member succeeds.
func TestProposalsHandler_Create_MemberAllowed(t *testing.T) {
	handler := setupTestProposalsHandler()
	_ = createDraft(t, handler) // fails the test if the member is refused
}

// A caller with no AID is refused create (401).
func TestProposalsHandler_Create_NoAIDUnauthorized(t *testing.T) {
	handler := setupTestProposalsHandler()
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
	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 for missing AID, got %d: %s", w.Code, w.Body.String())
	}
}

// A role stripped of create_proposals is refused create (403). A bare
// project-scoped contributor never holds the community-scoped create_proposals
// capability, so it stands in for a role an org narrowed.
func TestProposalsHandler_Create_NoCapabilityForbidden(t *testing.T) {
	handler := setupTestProposalsHandler()
	body := map[string]interface{}{
		"proposer_id": "user-1", "title": "Test", "type": []string{"technical"},
		"priority": "low", "description": "d", "problem_statement": "p",
		"solution": "s", "expected_outcomes": []string{"o"},
		"estimated_budget": "$1", "timeline": "1w",
	}
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/proposals", bytes.NewReader(b))
	req = withRBACContext(req, "contributor-aid", []contributions.Role{contributions.RoleContributor})
	w := httptest.NewRecorder()
	handler.HandleCreate(w, req)
	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for role without create_proposals, got %d: %s", w.Code, w.Body.String())
	}
}

// Submit (draft → submitted) shares the create_proposals gate (#315): a member
// may submit.
func TestProposalsHandler_Submit_MemberAllowed(t *testing.T) {
	handler := setupTestProposalsHandler()
	id := createDraft(t, handler)

	b, _ := json.Marshal(map[string]string{"status": "submitted"})
	req := asMember(httptest.NewRequest(http.MethodPost, "/api/v1/proposals/"+id+"/transition", bytes.NewReader(b)))
	w := httptest.NewRecorder()
	handler.HandleTransition(w, req, id)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200 for member submit, got %d: %s", w.Code, w.Body.String())
	}
}

// Submit without an AID is refused (401).
func TestProposalsHandler_Submit_NoAIDUnauthorized(t *testing.T) {
	handler := setupTestProposalsHandler()
	id := createDraft(t, handler)

	b, _ := json.Marshal(map[string]string{"status": "submitted"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/proposals/"+id+"/transition", bytes.NewReader(b))
	w := httptest.NewRecorder()
	handler.HandleTransition(w, req, id)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 for submit without AID, got %d: %s", w.Code, w.Body.String())
	}
}

// Submit by a role stripped of create_proposals is refused (403).
func TestProposalsHandler_Submit_NoCapabilityForbidden(t *testing.T) {
	handler := setupTestProposalsHandler()
	id := createDraft(t, handler)

	b, _ := json.Marshal(map[string]string{"status": "submitted"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/proposals/"+id+"/transition", bytes.NewReader(b))
	req.Header.Set("X-User-AID", "contributor-aid")
	req = withRBACContext(req, "contributor-aid", []contributions.Role{contributions.RoleContributor})
	w := httptest.NewRecorder()
	handler.HandleTransition(w, req, id)
	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for submit without create_proposals, got %d: %s", w.Code, w.Body.String())
	}
}

// A non-submit, non-governance transition (submitted → in_review) still needs
// no role gate — only create/submit and the governance transitions are gated.
func TestProposalsHandler_Transition_InReview_NoRBACRequired(t *testing.T) {
	handler := setupTestProposalsHandler()
	id := createDraft(t, handler)

	// Submit as a member first.
	b, _ := json.Marshal(map[string]string{"status": "submitted"})
	req := asMember(httptest.NewRequest(http.MethodPost, "/api/v1/proposals/"+id+"/transition", bytes.NewReader(b)))
	w := httptest.NewRecorder()
	handler.HandleTransition(w, req, id)
	if w.Code != http.StatusOK {
		t.Fatalf("submit failed: %d %s", w.Code, w.Body.String())
	}

	// submitted → in_review with no AID, no roles — should still work.
	b, _ = json.Marshal(map[string]string{"status": "in_review"})
	req = httptest.NewRequest(http.MethodPost, "/api/v1/proposals/"+id+"/transition", bytes.NewReader(b))
	w = httptest.NewRecorder()
	handler.HandleTransition(w, req, id)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200 for in_review transition, got %d: %s", w.Code, w.Body.String())
	}
}

func TestProposalsHandler_Transition_Reject_AdminAllowed(t *testing.T) {
	handler := setupTestProposalsHandler()
	id := createTestProposalInReview(t, handler)

	// Reject with admin role — should succeed
	b, _ := json.Marshal(map[string]string{"status": "rejected", "reason": "Not aligned with goals"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/proposals/"+id+"/transition", bytes.NewReader(b))
	req.Header.Set("X-User-AID", "steward-aid")
	req = withRBACContext(req, "steward-aid", []contributions.Role{contributions.RoleOperationsSteward})
	w := httptest.NewRecorder()
	handler.HandleTransition(w, req, id)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200 for admin rejection, got %d: %s", w.Code, w.Body.String())
	}
}

func TestProposalsHandler_Transition_Reject_NonAdminForbidden(t *testing.T) {
	handler := setupTestProposalsHandler()
	id := createTestProposalInReview(t, handler)

	// Reject with non-admin role — should be forbidden
	b, _ := json.Marshal(map[string]string{"status": "rejected", "reason": "I disagree"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/proposals/"+id+"/transition", bytes.NewReader(b))
	req.Header.Set("X-User-AID", "member-aid")
	req = withRBACContext(req, "member-aid", []contributions.Role{contributions.RoleMember})
	w := httptest.NewRecorder()
	handler.HandleTransition(w, req, id)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for non-admin rejection, got %d: %s", w.Code, w.Body.String())
	}
}

// ── Update (edit) access-control tests ─────────────────────────────────────────

func TestProposalsHandler_Update_InReview_AdminAllowed(t *testing.T) {
	handler := setupTestProposalsHandler()
	id := createTestProposalInReview(t, handler)

	// Admin (steward) who is NOT the proposer can still edit
	b, _ := json.Marshal(map[string]interface{}{"title": "Updated by admin"})
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/proposals/"+id, bytes.NewReader(b))
	req.Header.Set("X-User-AID", "steward-aid")
	req = withRBACContext(req, "steward-aid", []contributions.Role{contributions.RoleProjectSteward})
	w := httptest.NewRecorder()
	handler.HandleUpdate(w, req, id)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200 for admin edit of in_review proposal, got %d: %s", w.Code, w.Body.String())
	}
}

func TestProposalsHandler_Update_InReview_ProposerAllowed(t *testing.T) {
	handler := setupTestProposalsHandler()
	id := createTestProposalInReview(t, handler)

	// Proposer (AID prefix matches proposer_id "user-1") can edit without admin role
	b, _ := json.Marshal(map[string]interface{}{"title": "Updated by proposer"})
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/proposals/"+id, bytes.NewReader(b))
	req.Header.Set("X-User-AID", "user-1") // matches proposer_id
	req = withRBACContext(req, "user-1", []contributions.Role{contributions.RoleMember})
	w := httptest.NewRecorder()
	handler.HandleUpdate(w, req, id)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200 for proposer edit of in_review proposal, got %d: %s", w.Code, w.Body.String())
	}
}

func TestProposalsHandler_Update_InReview_ProposerByNameAllowed(t *testing.T) {
	handler := setupTestProposalsHandler()
	id := createTestProposalInReview(t, handler)

	// Proposer identified by X-User-Name matching proposer_id, AID prefix differs
	b, _ := json.Marshal(map[string]interface{}{"title": "Updated by proposer name"})
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/proposals/"+id, bytes.NewReader(b))
	req.Header.Set("X-User-AID", "EBfdlu8R-different-prefix")
	req.Header.Set("X-User-Name", "user-1") // matches proposer_id
	req = withRBACContext(req, "EBfdlu8R-different-prefix", []contributions.Role{contributions.RoleMember})
	w := httptest.NewRecorder()
	handler.HandleUpdate(w, req, id)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200 for proposer-by-name edit of in_review proposal, got %d: %s", w.Code, w.Body.String())
	}
}

func TestProposalsHandler_Update_InReview_NonAdminNonProposerForbidden(t *testing.T) {
	handler := setupTestProposalsHandler()
	id := createTestProposalInReview(t, handler)

	// Random user who is neither proposer nor admin
	b, _ := json.Marshal(map[string]interface{}{"title": "Unauthorized edit"})
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/proposals/"+id, bytes.NewReader(b))
	req.Header.Set("X-User-AID", "random-user")
	req = withRBACContext(req, "random-user", []contributions.Role{contributions.RoleMember})
	w := httptest.NewRecorder()
	handler.HandleUpdate(w, req, id)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for non-admin non-proposer edit, got %d: %s", w.Code, w.Body.String())
	}
}

func TestProposalsHandler_Update_InReview_NoAIDUnauthorized(t *testing.T) {
	handler := setupTestProposalsHandler()
	id := createTestProposalInReview(t, handler)

	// Missing X-User-AID header
	b, _ := json.Marshal(map[string]interface{}{"title": "No auth edit"})
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/proposals/"+id, bytes.NewReader(b))
	w := httptest.NewRecorder()
	handler.HandleUpdate(w, req, id)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 for missing AID on in_review edit, got %d: %s", w.Code, w.Body.String())
	}
}

func TestProposalsHandler_Update_NonInReview_NoRestriction(t *testing.T) {
	handler := setupTestProposalsHandler()

	// Create a draft proposal (no auth needed to edit)
	body := map[string]interface{}{
		"proposer_id": "user-1", "title": "Draft Test", "type": []string{"technical"},
		"priority": "low", "description": "d", "problem_statement": "p",
		"solution": "s", "expected_outcomes": []string{"o"},
		"estimated_budget": "$1", "timeline": "1w",
	}
	b, _ := json.Marshal(body)
	req := asMember(httptest.NewRequest(http.MethodPost, "/api/v1/proposals", bytes.NewReader(b)))
	w := httptest.NewRecorder()
	handler.HandleCreate(w, req)
	var created map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &created)
	id := created["id"].(string)

	// Edit without any auth — should succeed for draft
	b, _ = json.Marshal(map[string]interface{}{"title": "Updated draft"})
	req = httptest.NewRequest(http.MethodPatch, "/api/v1/proposals/"+id, bytes.NewReader(b))
	w = httptest.NewRecorder()
	handler.HandleUpdate(w, req, id)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200 for draft edit without auth, got %d: %s", w.Code, w.Body.String())
	}
}

// createProposalForTest posts a proposal with the given priority and returns nothing;
// it fails the test if creation does not succeed.
func createProposalForTest(t *testing.T, h *ProposalsHandler, title, priority string) {
	t.Helper()
	body := map[string]interface{}{
		"proposer_id": "user-1", "title": title, "type": []string{"technical"},
		"priority": priority, "description": "d", "problem_statement": "p",
		"solution": "s", "expected_outcomes": []string{"o"},
		"estimated_budget": "$1", "timeline": "1w",
	}
	b, _ := json.Marshal(body)
	req := asMember(httptest.NewRequest(http.MethodPost, "/api/v1/proposals", bytes.NewReader(b)))
	w := httptest.NewRecorder()
	h.HandleCreate(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("create %q failed: %d %s", title, w.Code, w.Body.String())
	}
}

// The list endpoint filters on schema-marked filterable fields (priority).
func TestProposalsHandler_ListSchemaFilter(t *testing.T) {
	handler := setupTestProposalsHandler()
	reg := matouTypes.NewRegistry()
	reg.Bootstrap()
	handler.SetRegistry(reg)

	createProposalForTest(t, handler, "High one", "high")
	createProposalForTest(t, handler, "Low one", "low")

	req := httptest.NewRequest(http.MethodGet, "/api/v1/proposals?priority=high", nil)
	w := httptest.NewRecorder()
	handler.HandleList(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp struct {
		Proposals []map[string]interface{} `json:"proposals"`
		Total     int                      `json:"total"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.Total != 1 {
		t.Fatalf("expected 1 high-priority proposal, got %d", resp.Total)
	}
	if resp.Proposals[0]["priority"] != "high" {
		t.Fatalf("expected the high-priority proposal, got %v", resp.Proposals[0]["priority"])
	}
}

// A query parameter naming a known-but-non-filterable field is rejected.
func TestProposalsHandler_ListRejectsNonFilterableField(t *testing.T) {
	handler := setupTestProposalsHandler()
	reg := matouTypes.NewRegistry()
	reg.Bootstrap()
	handler.SetRegistry(reg)

	createProposalForTest(t, handler, "Any", "low")

	// description is defined in the schema but not filterable.
	req := httptest.NewRequest(http.MethodGet, "/api/v1/proposals?description=x", nil)
	w := httptest.NewRecorder()
	handler.HandleList(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for non-filterable field, got %d: %s", w.Code, w.Body.String())
	}
}
