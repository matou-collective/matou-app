package anysync

import (
	"encoding/json"
	"testing"
)

// Custom (non-core) fields on a NoticePayload are persisted by noticeToFields
// and are recovered into NoticePayload.Data by stateToNotice — i.e. they
// round-trip through the object tree.
func TestNoticeCustomFieldsRoundTrip(t *testing.T) {
	n := &NoticePayload{
		ID:         "abc",
		Type:       "announcement",
		Title:      "Hui",
		Summary:    "Monthly hui",
		State:      "published",
		IssuerType: "person",
		IssuerID:   "EAbc",
		CreatedAt:  "2026-08-29T00:00:00Z",
		CreatedBy:  "EAbc",
		Data: map[string]json.RawMessage{
			"marae":     json.RawMessage(`"Ōrākei"`),
			"headcount": json.RawMessage(`42`),
		},
	}

	fields := noticeToFields(n)

	// Custom fields are written alongside the core fields.
	if got := string(fields["marae"]); got != `"Ōrākei"` {
		t.Errorf("custom field marae = %s, want \"Ōrākei\"", got)
	}
	if got := string(fields["headcount"]); got != `42` {
		t.Errorf("custom field headcount = %s, want 42", got)
	}
	// Core fields still present.
	if _, ok := fields["title"]; !ok {
		t.Error("core field title missing")
	}

	// Round-trip back through stateToNotice.
	state := &ObjectState{ObjectID: "Notice-abc", Fields: fields}
	back, err := stateToNotice(state, "tree-1")
	if err != nil {
		t.Fatalf("stateToNotice: %v", err)
	}
	if back.Title != "Hui" {
		t.Errorf("core title lost: got %q", back.Title)
	}
	if string(back.Data["marae"]) != `"Ōrākei"` {
		t.Errorf("custom marae not recovered: got %s", string(back.Data["marae"]))
	}
	if string(back.Data["headcount"]) != `42` {
		t.Errorf("custom headcount not recovered: got %s", string(back.Data["headcount"]))
	}
	// Core fields must not leak into Data.
	if _, ok := back.Data["title"]; ok {
		t.Error("core field title leaked into Data map")
	}
}

// A custom field can never shadow a core field the fixed struct owns.
func TestNoticeCustomFieldsDoNotShadowCore(t *testing.T) {
	n := &NoticePayload{
		Type:       "update",
		Title:      "real title",
		Summary:    "s",
		State:      "draft",
		IssuerType: "person",
		IssuerID:   "E1",
		CreatedAt:  "t",
		CreatedBy:  "E1",
		Data: map[string]json.RawMessage{
			"title": json.RawMessage(`"hijacked"`),
		},
	}
	fields := noticeToFields(n)
	if string(fields["title"]) != `"real title"` {
		t.Errorf("core title was shadowed by custom data: got %s", string(fields["title"]))
	}
}
