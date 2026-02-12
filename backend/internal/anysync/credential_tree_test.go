package anysync

import (
	"encoding/json"
	"testing"
	"time"
)

func TestCredentialPayload_JSONRoundTrip(t *testing.T) {
	original := &CredentialPayload{
		SAID:      "ESAID_test_12345",
		Issuer:    "EIssuer_org_abc",
		Recipient: "ERecipient_user_xyz",
		Schema:    "EMatouMembershipSchemaV1",
		Data:      json.RawMessage(`{"role":"member","level":"gold"}`),
		Timestamp: time.Now().Unix(),
	}

	data, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var restored CredentialPayload
	if err := json.Unmarshal(data, &restored); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if restored.SAID != original.SAID {
		t.Errorf("SAID mismatch: got %s, want %s", restored.SAID, original.SAID)
	}
	if restored.Issuer != original.Issuer {
		t.Errorf("Issuer mismatch: got %s, want %s", restored.Issuer, original.Issuer)
	}
	if restored.Recipient != original.Recipient {
		t.Errorf("Recipient mismatch: got %s, want %s", restored.Recipient, original.Recipient)
	}
	if restored.Schema != original.Schema {
		t.Errorf("Schema mismatch: got %s, want %s", restored.Schema, original.Schema)
	}
	if string(restored.Data) != string(original.Data) {
		t.Errorf("Data mismatch: got %s, want %s", restored.Data, original.Data)
	}
	if restored.Timestamp != original.Timestamp {
		t.Errorf("Timestamp mismatch: got %d, want %d", restored.Timestamp, original.Timestamp)
	}
}

func TestCredentialPayload_TreeIDField(t *testing.T) {
	cred := &CredentialPayload{
		SAID:   "ESAID_abc",
		TreeID: "tree-123",
	}

	data, _ := json.Marshal(cred)
	var decoded CredentialPayload
	json.Unmarshal(data, &decoded)

	if decoded.TreeID != "tree-123" {
		t.Errorf("TreeID mismatch: got %s, want tree-123", decoded.TreeID)
	}
}

func TestCredentialPayload_TreeIDOmitEmpty(t *testing.T) {
	cred := &CredentialPayload{
		SAID: "ESAID_abc",
	}

	data, _ := json.Marshal(cred)
	if string(data) == "" {
		t.Fatal("marshal returned empty")
	}
	// TreeID should be omitted when empty
	var raw map[string]interface{}
	json.Unmarshal(data, &raw)
	if _, exists := raw["treeId"]; exists {
		t.Error("treeId should be omitted when empty")
	}
}

func TestCredentialTreeManager_NewInstance(t *testing.T) {
	utm := NewUnifiedTreeManager()
	mgr := NewCredentialTreeManager(nil, nil, utm)
	if mgr == nil {
		t.Fatal("NewCredentialTreeManager returned nil")
	}
	if mgr.treeManager != utm {
		t.Error("treeManager not set correctly")
	}
}

func TestCredentialTreeManager_GetTreeID(t *testing.T) {
	utm := NewUnifiedTreeManager()
	mgr := NewCredentialTreeManager(nil, nil, utm)

	// No tree registered — should return empty
	if id := mgr.GetTreeID("nonexistent-said"); id != "" {
		t.Errorf("expected empty string for nonexistent SAID, got %s", id)
	}

	// Register a tree in the object map
	utm.addToIndex("space-1", "tree-cred-1", ObjectIndexEntry{
		TreeID:     "tree-cred-1",
		ObjectID:   "Credential-ESAID_123",
		ObjectType: "EMatouMembershipSchemaV1",
		ChangeType: CredentialTreeType,
	})

	// Now GetTreeID should find it
	if id := mgr.GetTreeID("ESAID_123"); id != "tree-cred-1" {
		t.Errorf("expected tree-cred-1, got %s", id)
	}
}

func TestCredentialChangeType_Value(t *testing.T) {
	if CredentialChangeType != "matou.credential.v1" {
		t.Errorf("expected 'matou.credential.v1', got %s", CredentialChangeType)
	}
}

func TestStateToCredential(t *testing.T) {
	state := &ObjectState{
		ObjectID:   "Credential-ESAID_test",
		ObjectType: "EMatouMembershipSchemaV1",
		Fields: map[string]json.RawMessage{
			"said":      json.RawMessage(`"ESAID_test"`),
			"issuer":    json.RawMessage(`"EIssuer_org"`),
			"recipient": json.RawMessage(`"ERecipient_user"`),
			"schema":    json.RawMessage(`"EMatouMembershipSchemaV1"`),
			"data":      json.RawMessage(`{"role":"member"}`),
		},
		Timestamp: 12345,
		Version:   1,
	}

	cred, err := stateToCredential(state, "tree-abc")
	if err != nil {
		t.Fatalf("stateToCredential error: %v", err)
	}

	if cred.SAID != "ESAID_test" {
		t.Errorf("SAID mismatch: got %s", cred.SAID)
	}
	if cred.Issuer != "EIssuer_org" {
		t.Errorf("Issuer mismatch: got %s", cred.Issuer)
	}
	if cred.Recipient != "ERecipient_user" {
		t.Errorf("Recipient mismatch: got %s", cred.Recipient)
	}
	if cred.Schema != "EMatouMembershipSchemaV1" {
		t.Errorf("Schema mismatch: got %s", cred.Schema)
	}
	if string(cred.Data) != `{"role":"member"}` {
		t.Errorf("Data mismatch: got %s", cred.Data)
	}
	if cred.Timestamp != 12345 {
		t.Errorf("Timestamp mismatch: got %d", cred.Timestamp)
	}
	if cred.TreeID != "tree-abc" {
		t.Errorf("TreeID mismatch: got %s", cred.TreeID)
	}
}

func TestStateToCredential_EmptyFields(t *testing.T) {
	state := &ObjectState{
		Fields:    make(map[string]json.RawMessage),
		Timestamp: 100,
	}

	cred, err := stateToCredential(state, "tree-xyz")
	if err != nil {
		t.Fatalf("stateToCredential error: %v", err)
	}

	// All fields should be zero-valued
	if cred.SAID != "" {
		t.Errorf("expected empty SAID, got %s", cred.SAID)
	}
	if cred.Issuer != "" {
		t.Errorf("expected empty Issuer, got %s", cred.Issuer)
	}
	if cred.TreeID != "tree-xyz" {
		t.Errorf("TreeID mismatch: got %s", cred.TreeID)
	}
}

func TestCredentialTreeManager_ReadCredentials_EmptySpace(t *testing.T) {
	utm := NewUnifiedTreeManager()
	mgr := NewCredentialTreeManager(nil, nil, utm)

	creds, err := mgr.ReadCredentials(nil, "empty-space")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(creds) != 0 {
		t.Errorf("expected 0 credentials for empty space, got %d", len(creds))
	}
}
