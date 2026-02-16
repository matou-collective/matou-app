package types

import (
	"encoding/json"
	"testing"
)

func TestNoticeTypeDefinitions(t *testing.T) {
	defs := NoticeTypeDefinitions()
	if len(defs) != 4 {
		t.Fatalf("expected 4 notice type definitions, got %d", len(defs))
	}

	names := map[string]bool{}
	for _, def := range defs {
		names[def.Name] = true
	}

	expected := []string{"Notice", "NoticeAck", "NoticeRSVP", "NoticeSave"}
	for _, name := range expected {
		if !names[name] {
			t.Errorf("missing type definition: %s", name)
		}
	}
}

func TestNoticeType(t *testing.T) {
	def := NoticeType()
	if def.Name != "Notice" {
		t.Errorf("expected name 'Notice', got %q", def.Name)
	}
	if def.Version != 1 {
		t.Errorf("expected version 1, got %d", def.Version)
	}
	if def.Space != "community" {
		t.Errorf("expected space 'community', got %q", def.Space)
	}
	if def.Permissions.Read != "community" {
		t.Errorf("expected read permission 'community', got %q", def.Permissions.Read)
	}
	if def.Permissions.Write != "admin" {
		t.Errorf("expected write permission 'admin', got %q", def.Permissions.Write)
	}

	// Verify required fields exist
	requiredFields := []string{"type", "title", "summary", "state", "issuerType", "issuerId"}
	fieldMap := make(map[string]FieldDef)
	for _, f := range def.Fields {
		fieldMap[f.Name] = f
	}

	for _, name := range requiredFields {
		f, ok := fieldMap[name]
		if !ok {
			t.Errorf("missing required field: %s", name)
			continue
		}
		if !f.Required {
			t.Errorf("field %s should be required", name)
		}
	}

	// Verify enum validation on type field
	typeField := fieldMap["type"]
	if typeField.Validation == nil || len(typeField.Validation.Enum) != 2 {
		t.Errorf("type field should have enum validation with 2 values")
	}

	// Verify state enum
	stateField := fieldMap["state"]
	if stateField.Validation == nil || len(stateField.Validation.Enum) != 3 {
		t.Errorf("state field should have enum validation with 3 values")
	}

	// Verify layouts exist
	for _, layout := range []string{"card", "detail", "form"} {
		if _, ok := def.Layouts[layout]; !ok {
			t.Errorf("missing layout: %s", layout)
		}
	}
}

func TestNoticeAckType(t *testing.T) {
	def := NoticeAckType()
	if def.Name != "NoticeAck" {
		t.Errorf("expected name 'NoticeAck', got %q", def.Name)
	}
	if def.Space != "community" {
		t.Errorf("expected space 'community', got %q", def.Space)
	}
	if def.Permissions.Write != "community" {
		t.Errorf("expected write permission 'community', got %q", def.Permissions.Write)
	}

	// method field should have enum
	for _, f := range def.Fields {
		if f.Name == "method" {
			if f.Validation == nil || len(f.Validation.Enum) != 2 {
				t.Errorf("method field should have enum validation with 2 values (open, explicit)")
			}
		}
	}
}

func TestNoticeRSVPType(t *testing.T) {
	def := NoticeRSVPType()
	if def.Name != "NoticeRSVP" {
		t.Errorf("expected name 'NoticeRSVP', got %q", def.Name)
	}

	// status field should have enum
	for _, f := range def.Fields {
		if f.Name == "status" {
			if f.Validation == nil || len(f.Validation.Enum) != 3 {
				t.Errorf("status field should have enum validation with 3 values (going, maybe, not_going)")
			}
		}
	}
}

func TestNoticeSaveType(t *testing.T) {
	def := NoticeSaveType()
	if def.Name != "NoticeSave" {
		t.Errorf("expected name 'NoticeSave', got %q", def.Name)
	}
	if def.Space != "private" {
		t.Errorf("expected space 'private', got %q", def.Space)
	}
	if def.Permissions.Read != "owner" {
		t.Errorf("expected read permission 'owner', got %q", def.Permissions.Read)
	}
}

func TestIsValidNoticeTransition(t *testing.T) {
	tests := []struct {
		from     string
		to       string
		expected bool
	}{
		{"draft", "published", true},
		{"published", "archived", true},
		{"draft", "archived", false},   // skip state not allowed
		{"published", "draft", false},  // no backward transitions
		{"archived", "published", false}, // terminal state
		{"archived", "draft", false},
		{"invalid", "published", false},
	}

	for _, tt := range tests {
		result := IsValidNoticeTransition(tt.from, tt.to)
		if result != tt.expected {
			t.Errorf("IsValidNoticeTransition(%q, %q) = %v, want %v", tt.from, tt.to, result, tt.expected)
		}
	}
}

func TestNoticeTypeJSONRoundTrip(t *testing.T) {
	def := NoticeType()

	data, err := json.Marshal(def)
	if err != nil {
		t.Fatalf("failed to marshal NoticeType: %v", err)
	}

	var decoded TypeDefinition
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("failed to unmarshal NoticeType: %v", err)
	}

	if decoded.Name != def.Name {
		t.Errorf("name mismatch after round-trip: got %q, want %q", decoded.Name, def.Name)
	}
	if decoded.Version != def.Version {
		t.Errorf("version mismatch after round-trip: got %d, want %d", decoded.Version, def.Version)
	}
	if len(decoded.Fields) != len(def.Fields) {
		t.Errorf("field count mismatch after round-trip: got %d, want %d", len(decoded.Fields), len(def.Fields))
	}
}

func TestRegistryIncludesNoticeTypes(t *testing.T) {
	registry := NewRegistry()
	registry.Bootstrap()

	noticeTypes := []string{"Notice", "NoticeAck", "NoticeRSVP", "NoticeSave"}
	for _, name := range noticeTypes {
		if _, ok := registry.Get(name); !ok {
			t.Errorf("registry missing notice type: %s", name)
		}
	}
}
