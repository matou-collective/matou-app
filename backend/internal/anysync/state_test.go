package anysync

import (
	"encoding/json"
	"testing"
)

func TestInitChange(t *testing.T) {
	fields := map[string]json.RawMessage{
		"displayName": json.RawMessage(`"Alice"`),
		"bio":         json.RawMessage(`"Hello world"`),
		"age":         json.RawMessage(`42`),
	}

	change := InitChange(fields)
	if change == nil {
		t.Fatal("InitChange returned nil")
	}
	if len(change.Ops) != 3 {
		t.Fatalf("expected 3 ops, got %d", len(change.Ops))
	}

	// All ops should be "set"
	for _, op := range change.Ops {
		if op.Op != "set" {
			t.Errorf("expected op 'set', got '%s'", op.Op)
		}
	}

	// Verify round-trip: apply ops to empty state
	state := &ObjectState{Fields: make(map[string]json.RawMessage)}
	for _, op := range change.Ops {
		state.Fields[op.Field] = op.Value
	}

	if string(state.Fields["displayName"]) != `"Alice"` {
		t.Errorf("expected displayName 'Alice', got %s", state.Fields["displayName"])
	}
	if string(state.Fields["age"]) != `42` {
		t.Errorf("expected age 42, got %s", state.Fields["age"])
	}
}

func TestInitChange_Empty(t *testing.T) {
	change := InitChange(nil)
	if change == nil {
		t.Fatal("InitChange returned nil for nil fields")
	}
	if len(change.Ops) != 0 {
		t.Errorf("expected 0 ops for nil fields, got %d", len(change.Ops))
	}
}

func TestDiffState_NoChanges(t *testing.T) {
	current := &ObjectState{
		Fields: map[string]json.RawMessage{
			"name": json.RawMessage(`"Alice"`),
			"age":  json.RawMessage(`30`),
		},
	}

	newFields := map[string]json.RawMessage{
		"name": json.RawMessage(`"Alice"`),
		"age":  json.RawMessage(`30`),
	}

	diff := DiffState(current, newFields)
	if diff != nil {
		t.Errorf("expected nil diff when no changes, got %+v", diff)
	}
}

func TestDiffState_FieldChanged(t *testing.T) {
	current := &ObjectState{
		Fields: map[string]json.RawMessage{
			"name": json.RawMessage(`"Alice"`),
			"age":  json.RawMessage(`30`),
		},
	}

	newFields := map[string]json.RawMessage{
		"name": json.RawMessage(`"Alice"`),
		"age":  json.RawMessage(`31`),
	}

	diff := DiffState(current, newFields)
	if diff == nil {
		t.Fatal("expected non-nil diff")
	}
	if len(diff.Ops) != 1 {
		t.Fatalf("expected 1 op, got %d", len(diff.Ops))
	}
	if diff.Ops[0].Op != "set" || diff.Ops[0].Field != "age" || string(diff.Ops[0].Value) != `31` {
		t.Errorf("unexpected op: %+v", diff.Ops[0])
	}
}

func TestDiffState_FieldAdded(t *testing.T) {
	current := &ObjectState{
		Fields: map[string]json.RawMessage{
			"name": json.RawMessage(`"Alice"`),
		},
	}

	newFields := map[string]json.RawMessage{
		"name": json.RawMessage(`"Alice"`),
		"bio":  json.RawMessage(`"New bio"`),
	}

	diff := DiffState(current, newFields)
	if diff == nil {
		t.Fatal("expected non-nil diff")
	}
	if len(diff.Ops) != 1 {
		t.Fatalf("expected 1 op, got %d", len(diff.Ops))
	}
	if diff.Ops[0].Op != "set" || diff.Ops[0].Field != "bio" {
		t.Errorf("expected set bio, got %+v", diff.Ops[0])
	}
}

func TestDiffState_FieldRemoved(t *testing.T) {
	current := &ObjectState{
		Fields: map[string]json.RawMessage{
			"name": json.RawMessage(`"Alice"`),
			"bio":  json.RawMessage(`"Old bio"`),
		},
	}

	newFields := map[string]json.RawMessage{
		"name": json.RawMessage(`"Alice"`),
	}

	diff := DiffState(current, newFields)
	if diff == nil {
		t.Fatal("expected non-nil diff")
	}
	if len(diff.Ops) != 1 {
		t.Fatalf("expected 1 op, got %d", len(diff.Ops))
	}
	if diff.Ops[0].Op != "unset" || diff.Ops[0].Field != "bio" {
		t.Errorf("expected unset bio, got %+v", diff.Ops[0])
	}
}

func TestDiffState_MultipleChanges(t *testing.T) {
	current := &ObjectState{
		Fields: map[string]json.RawMessage{
			"name":     json.RawMessage(`"Alice"`),
			"bio":      json.RawMessage(`"Old bio"`),
			"location": json.RawMessage(`"Auckland"`),
		},
	}

	newFields := map[string]json.RawMessage{
		"name":  json.RawMessage(`"Bob"`),    // changed
		"email": json.RawMessage(`"b@b.io"`), // added
		// bio removed, location removed
	}

	diff := DiffState(current, newFields)
	if diff == nil {
		t.Fatal("expected non-nil diff")
	}

	// Should have: set name, set email, unset bio, unset location = 4 ops
	if len(diff.Ops) != 4 {
		t.Fatalf("expected 4 ops, got %d: %+v", len(diff.Ops), diff.Ops)
	}

	// Verify all ops are present (order may vary due to map iteration)
	opMap := make(map[string]string) // field → op
	for _, op := range diff.Ops {
		opMap[op.Field] = op.Op
	}
	if opMap["name"] != "set" {
		t.Error("expected set name")
	}
	if opMap["email"] != "set" {
		t.Error("expected set email")
	}
	if opMap["bio"] != "unset" {
		t.Error("expected unset bio")
	}
	if opMap["location"] != "unset" {
		t.Error("expected unset location")
	}
}

func TestSnapshotChange(t *testing.T) {
	state := &ObjectState{
		Fields: map[string]json.RawMessage{
			"name": json.RawMessage(`"Alice"`),
			"bio":  json.RawMessage(`"Hello"`),
		},
	}

	snap := SnapshotChange(state)
	if snap == nil {
		t.Fatal("SnapshotChange returned nil")
	}
	if len(snap.Ops) != 2 {
		t.Fatalf("expected 2 ops, got %d", len(snap.Ops))
	}

	// All should be "set" ops
	for _, op := range snap.Ops {
		if op.Op != "set" {
			t.Errorf("expected set op, got %s", op.Op)
		}
	}
}

func TestObjectState_ToJSON(t *testing.T) {
	state := &ObjectState{
		Fields: map[string]json.RawMessage{
			"name":   json.RawMessage(`"Alice"`),
			"age":    json.RawMessage(`30`),
			"active": json.RawMessage(`true`),
		},
	}

	data := state.ToJSON()
	var result map[string]json.RawMessage
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatalf("ToJSON produced invalid JSON: %v", err)
	}

	if string(result["name"]) != `"Alice"` {
		t.Errorf("expected name Alice, got %s", result["name"])
	}
	if string(result["age"]) != `30` {
		t.Errorf("expected age 30, got %s", result["age"])
	}
	if string(result["active"]) != `true` {
		t.Errorf("expected active true, got %s", result["active"])
	}
}

func TestObjectState_ToJSON_Empty(t *testing.T) {
	state := &ObjectState{
		Fields: make(map[string]json.RawMessage),
	}

	data := state.ToJSON()
	if string(data) != `{}` {
		t.Errorf("expected {}, got %s", data)
	}
}

func TestFieldsFromJSON(t *testing.T) {
	data := json.RawMessage(`{"name":"Alice","age":30,"nested":{"key":"val"}}`)

	fields, err := FieldsFromJSON(data)
	if err != nil {
		t.Fatalf("FieldsFromJSON failed: %v", err)
	}

	if len(fields) != 3 {
		t.Fatalf("expected 3 fields, got %d", len(fields))
	}

	if string(fields["name"]) != `"Alice"` {
		t.Errorf("expected name Alice, got %s", fields["name"])
	}
	if string(fields["age"]) != `30` {
		t.Errorf("expected age 30, got %s", fields["age"])
	}
}

func TestFieldsFromJSON_Invalid(t *testing.T) {
	_, err := FieldsFromJSON(json.RawMessage(`not json`))
	if err == nil {
		t.Error("expected error for invalid JSON")
	}
}

func TestFieldsFromJSON_Array(t *testing.T) {
	_, err := FieldsFromJSON(json.RawMessage(`[1,2,3]`))
	if err == nil {
		t.Error("expected error for JSON array")
	}
}

func TestNeedsSnapshot(t *testing.T) {
	tests := []struct {
		version  int
		expected bool
	}{
		{0, false},
		{1, false},
		{9, false},
		{10, true},
		{11, false},
		{20, true},
		{100, true},
	}

	for _, tt := range tests {
		state := &ObjectState{Version: tt.version}
		result := NeedsSnapshot(state)
		if result != tt.expected {
			t.Errorf("NeedsSnapshot(version=%d) = %v, want %v", tt.version, result, tt.expected)
		}
	}
}

func TestObjectChange_Serialization(t *testing.T) {
	change := &ObjectChange{
		Ops: []ChangeOp{
			{Op: "set", Field: "name", Value: json.RawMessage(`"Alice"`)},
			{Op: "unset", Field: "bio"},
		},
	}

	data, err := json.Marshal(change)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}

	var decoded ObjectChange
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}

	if len(decoded.Ops) != 2 {
		t.Fatalf("expected 2 ops, got %d", len(decoded.Ops))
	}
	if decoded.Ops[0].Op != "set" || decoded.Ops[0].Field != "name" {
		t.Errorf("first op mismatch: %+v", decoded.Ops[0])
	}
	if decoded.Ops[1].Op != "unset" || decoded.Ops[1].Field != "bio" {
		t.Errorf("second op mismatch: %+v", decoded.Ops[1])
	}
}

func TestInitChange_RoundTrip_WithDiffState(t *testing.T) {
	// Create initial state
	fields := map[string]json.RawMessage{
		"displayName": json.RawMessage(`"Alice"`),
		"bio":         json.RawMessage(`"Hello"`),
		"role":        json.RawMessage(`"Member"`),
	}

	initChange := InitChange(fields)

	// Apply init change to build state
	state := &ObjectState{
		ObjectID: "test-1",
		Fields:   make(map[string]json.RawMessage),
		Version:  0,
	}
	for _, op := range initChange.Ops {
		state.Fields[op.Field] = op.Value
	}
	state.Version = 1

	// Now update: change bio, add email, remove role
	newFields := map[string]json.RawMessage{
		"displayName": json.RawMessage(`"Alice"`),
		"bio":         json.RawMessage(`"Updated bio"`),
		"email":       json.RawMessage(`"alice@example.com"`),
	}

	diff := DiffState(state, newFields)
	if diff == nil {
		t.Fatal("expected non-nil diff")
	}

	// Apply diff
	for _, op := range diff.Ops {
		switch op.Op {
		case "set":
			state.Fields[op.Field] = op.Value
		case "unset":
			delete(state.Fields, op.Field)
		}
	}

	// Verify final state
	if string(state.Fields["displayName"]) != `"Alice"` {
		t.Error("displayName should be unchanged")
	}
	if string(state.Fields["bio"]) != `"Updated bio"` {
		t.Error("bio should be updated")
	}
	if string(state.Fields["email"]) != `"alice@example.com"` {
		t.Error("email should be added")
	}
	if _, exists := state.Fields["role"]; exists {
		t.Error("role should be removed")
	}

	// Verify snapshot preserves state
	snap := SnapshotChange(state)
	newState := &ObjectState{Fields: make(map[string]json.RawMessage)}
	for _, op := range snap.Ops {
		newState.Fields[op.Field] = op.Value
	}

	// Snapshot state should match current state
	for k, v := range state.Fields {
		if string(newState.Fields[k]) != string(v) {
			t.Errorf("snapshot field %s mismatch: %s != %s", k, newState.Fields[k], v)
		}
	}
	if len(newState.Fields) != len(state.Fields) {
		t.Errorf("snapshot has %d fields, expected %d", len(newState.Fields), len(state.Fields))
	}
}

func TestObjectState_ToJSON_RoundTrip(t *testing.T) {
	// Build state from fields
	fields := map[string]json.RawMessage{
		"name":   json.RawMessage(`"Alice"`),
		"age":    json.RawMessage(`30`),
		"tags":   json.RawMessage(`["a","b"]`),
		"nested": json.RawMessage(`{"key":"value"}`),
	}

	state := &ObjectState{Fields: fields}
	data := state.ToJSON()

	// Parse back and verify
	recovered, err := FieldsFromJSON(data)
	if err != nil {
		t.Fatalf("FieldsFromJSON failed: %v", err)
	}

	for k, v := range fields {
		if string(recovered[k]) != string(v) {
			t.Errorf("field %s: expected %s, got %s", k, v, recovered[k])
		}
	}
}
