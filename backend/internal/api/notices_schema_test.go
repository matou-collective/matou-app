package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/matou-dao/backend/internal/anysync"
	"github.com/matou-dao/backend/internal/types"
)

func noticeRegistry() *types.Registry {
	r := types.NewRegistry()
	r.Bootstrap()
	return r
}

// newTestNotice returns a notice with all built-in required core fields set.
func newTestNotice() *anysync.NoticePayload {
	return &anysync.NoticePayload{
		ID:         "n1",
		Type:       "announcement",
		Title:      "Title",
		Summary:    "Summary",
		State:      "published",
		IssuerType: "person",
		IssuerID:   "EAbc",
		CreatedAt:  "2026-08-29T00:00:00Z",
		CreatedBy:  "EAbc",
	}
}

// A list request that filters on a non-filterable field is rejected before any
// space work happens.
func TestHandleListNotices_RejectsNonFilterableField(t *testing.T) {
	h := &NoticesHandler{registry: noticeRegistry()}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/notices?title=hello", nil)
	w := httptest.NewRecorder()
	h.HandleListNotices(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
	var resp map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if errMsg, _ := resp["error"].(string); errMsg == "" {
		t.Errorf("expected an error message, got %v", resp)
	}
}

// Filtering on a filterable field (type) is accepted (empty space → empty list).
func TestHandleListNotices_AllowsFilterableField(t *testing.T) {
	h := &NoticesHandler{registry: noticeRegistry()}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/notices?type=event", nil)
	w := httptest.NewRecorder()
	h.HandleListNotices(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusOK)
	}
}

// extractCustomNoticeFields keeps only schema-defined non-core fields and drops
// both core fields and truly-unknown keys.
func TestExtractCustomNoticeFields(t *testing.T) {
	r := types.NewRegistry()
	r.Bootstrap()
	// Extend the Notice schema with a custom (non-core) field.
	def, _ := r.Get("Notice")
	def.Fields = append(def.Fields, types.FieldDef{Name: "marae", Type: "string"})
	r.Register(def)

	h := &NoticesHandler{registry: r}

	raw := map[string]json.RawMessage{
		"title":   json.RawMessage(`"t"`),      // core → dropped
		"marae":   json.RawMessage(`"Ōrākei"`), // schema custom → kept
		"unknown": json.RawMessage(`"nope"`),   // not in schema → dropped
	}
	got := h.extractCustomNoticeFields(raw)
	if len(got) != 1 {
		t.Fatalf("expected exactly 1 custom field, got %v", got)
	}
	if string(got["marae"]) != `"Ōrākei"` {
		t.Errorf("marae = %s, want \"Ōrākei\"", string(got["marae"]))
	}
}

// validateNoticeAgainstSchema flags a missing custom-required field on the
// assembled notice.
func TestValidateNoticeAgainstSchema_CustomRequired(t *testing.T) {
	r := types.NewRegistry()
	r.Bootstrap()
	def, _ := r.Get("Notice")
	def.Fields = append(def.Fields, types.FieldDef{Name: "marae", Type: "string", Required: true})
	r.Register(def)

	h := &NoticesHandler{registry: r}

	// Minimal core-complete notice, but missing the custom required field.
	// Reuse a payload via the anysync struct through the handler's validator by
	// constructing an equivalent object.
	notice := newTestNotice()
	if errs := h.validateNoticeAgainstSchema(notice); len(errs) == 0 {
		t.Fatal("expected validation error for missing custom required field")
	}

	notice.Data = map[string]json.RawMessage{"marae": json.RawMessage(`"Ōrākei"`)}
	if errs := h.validateNoticeAgainstSchema(notice); len(errs) != 0 {
		t.Fatalf("expected notice with custom field to pass, got %v", errs)
	}
}
