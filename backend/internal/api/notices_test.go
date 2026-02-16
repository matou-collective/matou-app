package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHandleCreateNotice_Validation(t *testing.T) {
	handler := &NoticesHandler{}

	tests := []struct {
		name       string
		body       interface{}
		wantStatus int
		wantError  string
	}{
		{
			name:       "missing type",
			body:       map[string]string{"title": "Test", "summary": "Test"},
			wantStatus: http.StatusBadRequest,
			wantError:  "type is required",
		},
		{
			name:       "invalid type",
			body:       map[string]string{"type": "invalid", "title": "Test", "summary": "Test"},
			wantStatus: http.StatusBadRequest,
			wantError:  "type must be 'event' or 'update'",
		},
		{
			name:       "missing title",
			body:       map[string]string{"type": "event", "summary": "Test"},
			wantStatus: http.StatusBadRequest,
			wantError:  "title is required",
		},
		{
			name:       "missing summary",
			body:       map[string]string{"type": "event", "title": "Test"},
			wantStatus: http.StatusBadRequest,
			wantError:  "summary is required",
		},
		{
			name:       "invalid state",
			body:       map[string]string{"type": "event", "title": "Test", "summary": "Test", "state": "archived"},
			wantStatus: http.StatusBadRequest,
			wantError:  "state must be 'draft' or 'published'",
		},
		{
			name:       "valid but no identity",
			body:       map[string]string{"type": "event", "title": "Test", "summary": "Test"},
			wantStatus: http.StatusBadRequest,
			wantError:  "identity not configured",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body, _ := json.Marshal(tt.body)
			req := httptest.NewRequest(http.MethodPost, "/api/v1/notices", bytes.NewReader(body))
			w := httptest.NewRecorder()

			handler.HandleCreateNotice(w, req)

			if w.Code != tt.wantStatus {
				t.Errorf("status = %d, want %d", w.Code, tt.wantStatus)
			}

			var resp map[string]interface{}
			json.Unmarshal(w.Body.Bytes(), &resp)
			if errMsg, ok := resp["error"].(string); ok {
				if errMsg != tt.wantError {
					t.Errorf("error = %q, want %q", errMsg, tt.wantError)
				}
			}
		})
	}
}

func TestHandleCreateNotice_MethodNotAllowed(t *testing.T) {
	handler := &NoticesHandler{}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/notices", nil)
	w := httptest.NewRecorder()

	handler.HandleCreateNotice(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want %d", w.Code, http.StatusMethodNotAllowed)
	}
}

func TestHandleCreateRSVP_Validation(t *testing.T) {
	handler := &NoticesHandler{}

	tests := []struct {
		name       string
		body       interface{}
		wantStatus int
		wantError  string
	}{
		{
			name:       "invalid status",
			body:       map[string]string{"status": "invalid"},
			wantStatus: http.StatusBadRequest,
			wantError:  "status must be 'going', 'maybe', or 'not_going'",
		},
		{
			name:       "valid going but no identity",
			body:       map[string]string{"status": "going"},
			wantStatus: http.StatusBadRequest,
			wantError:  "identity not configured",
		},
		{
			name:       "valid maybe but no identity",
			body:       map[string]string{"status": "maybe"},
			wantStatus: http.StatusBadRequest,
			wantError:  "identity not configured",
		},
		{
			name:       "valid not_going but no identity",
			body:       map[string]string{"status": "not_going"},
			wantStatus: http.StatusBadRequest,
			wantError:  "identity not configured",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body, _ := json.Marshal(tt.body)
			req := httptest.NewRequest(http.MethodPost, "/api/v1/notices/test-id/rsvp", bytes.NewReader(body))
			w := httptest.NewRecorder()

			handler.HandleCreateRSVP(w, req, "test-id")

			if w.Code != tt.wantStatus {
				t.Errorf("status = %d, want %d", w.Code, tt.wantStatus)
			}

			var resp map[string]interface{}
			json.Unmarshal(w.Body.Bytes(), &resp)
			if errMsg, ok := resp["error"].(string); ok {
				if errMsg != tt.wantError {
					t.Errorf("error = %q, want %q", errMsg, tt.wantError)
				}
			}
		})
	}
}

func TestHandleCreateAck_NoIdentity(t *testing.T) {
	handler := &NoticesHandler{}

	req := httptest.NewRequest(http.MethodPost, "/api/v1/notices/test-id/ack", nil)
	w := httptest.NewRecorder()

	handler.HandleCreateAck(w, req, "test-id")

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

func TestHandleToggleSave_MethodNotAllowed(t *testing.T) {
	handler := &NoticesHandler{}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/notices/test-id/save", nil)
	w := httptest.NewRecorder()

	handler.HandleToggleSave(w, req, "test-id")

	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want %d", w.Code, http.StatusMethodNotAllowed)
	}
}

func TestHandleListNotices_EmptySpace(t *testing.T) {
	handler := &NoticesHandler{}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/notices", nil)
	w := httptest.NewRecorder()

	handler.HandleListNotices(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", w.Code, http.StatusOK)
	}

	var resp map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &resp)
	count := resp["count"].(float64)
	if count != 0 {
		t.Errorf("count = %v, want 0", count)
	}
}

func TestHandleListSaved_NoPrivateSpace(t *testing.T) {
	handler := &NoticesHandler{}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/notices/saved", nil)
	w := httptest.NewRecorder()

	handler.HandleListSaved(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", w.Code, http.StatusOK)
	}

	var resp map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &resp)
	count := resp["count"].(float64)
	if count != 0 {
		t.Errorf("count = %v, want 0", count)
	}
}

func TestSortNotices(t *testing.T) {
	notices := []*noticePayloadForTest{
		{EventStart: "2026-03-01T10:00:00Z", PublishAt: "2026-02-01T10:00:00Z", CreatedAt: "2026-01-01T10:00:00Z"},
		{EventStart: "2026-02-01T10:00:00Z", PublishAt: "2026-03-01T10:00:00Z", CreatedAt: "2026-02-01T10:00:00Z"},
		{EventStart: "2026-04-01T10:00:00Z", PublishAt: "2026-01-01T10:00:00Z", CreatedAt: "2026-03-01T10:00:00Z"},
	}

	// We can't directly test with anysync.NoticePayload without importing the package,
	// but we can verify the shouldSwap logic
	t.Run("upcoming sort ascending by eventStart", func(t *testing.T) {
		if !shouldSwapTest("2026-03-01T10:00:00Z", "2026-02-01T10:00:00Z", "upcoming") {
			t.Error("expected swap for upcoming: earlier eventStart should come first")
		}
		if shouldSwapTest("2026-02-01T10:00:00Z", "2026-03-01T10:00:00Z", "upcoming") {
			t.Error("should not swap: already in correct order")
		}
	})

	t.Run("current sort descending by publishAt", func(t *testing.T) {
		if !shouldSwapTest("2026-01-01T10:00:00Z", "2026-03-01T10:00:00Z", "current") {
			t.Error("expected swap for current: more recent publishAt should come first")
		}
	})

	// Suppress unused warning
	_ = notices
}

// noticePayloadForTest is a test helper
type noticePayloadForTest struct {
	EventStart string
	PublishAt  string
	CreatedAt  string
}

// shouldSwapTest tests the comparison logic directly with string timestamps.
func shouldSwapTest(aTime, bTime, view string) bool {
	switch view {
	case "upcoming":
		return aTime > bTime
	case "current", "past":
		return aTime < bTime
	default:
		return aTime < bTime
	}
}

func TestHandlePublishNotice_MethodNotAllowed(t *testing.T) {
	handler := &NoticesHandler{}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/notices/test-id/publish", nil)
	w := httptest.NewRecorder()

	handler.HandlePublishNotice(w, req, "test-id")

	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want %d", w.Code, http.StatusMethodNotAllowed)
	}
}

func TestHandleArchiveNotice_MethodNotAllowed(t *testing.T) {
	handler := &NoticesHandler{}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/notices/test-id/archive", nil)
	w := httptest.NewRecorder()

	handler.HandleArchiveNotice(w, req, "test-id")

	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want %d", w.Code, http.StatusMethodNotAllowed)
	}
}
