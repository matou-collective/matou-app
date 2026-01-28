// Package testing provides test utilities and fixtures for anysync package.
package testing

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/matou-dao/backend/internal/anysync"
)

// TestAIDs provides commonly used test AIDs
var TestAIDs = struct {
	Org    string
	Admin  string
	User1  string
	User2  string
	User3  string
}{
	Org:    "EOrg1234567890abcdefghijklmnopqrstuvwxyz",
	Admin:  "EAdmin1234567890abcdefghijklmnopqrstuvwxyz",
	User1:  "EUser1_1234567890abcdefghijklmnopqrstuvwxyz",
	User2:  "EUser2_1234567890abcdefghijklmnopqrstuvwxyz",
	User3:  "EUser3_1234567890abcdefghijklmnopqrstuvwxyz",
}

// TestMnemonics provides test mnemonics for key derivation
var TestMnemonics = struct {
	Valid12   string
	Valid24   string
	Invalid   string
	Empty     string
}{
	Valid12:   "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
	Valid24:   "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art",
	Invalid:   "invalid mnemonic words that should not work at all",
	Empty:     "",
}

// TestSchemas provides test credential schema identifiers
var TestSchemas = struct {
	Membership string
	Steward    string
	SelfClaim  string
	Invitation string
}{
	Membership: "EMatouMembershipSchemaV1",
	Steward:    "EOperationsStewardSchemaV1",
	SelfClaim:  "ESelfClaimSchemaV1",
	Invitation: "EInvitationSchemaV1",
}

// NewTestClient creates an anysync.Client configured for testing.
// It creates a temporary directory that is cleaned up after the test.
func NewTestClient(t *testing.T) (*anysync.Client, func()) {
	t.Helper()

	tmpDir, err := os.MkdirTemp("", "anysync_test_*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}

	// Create a minimal client config
	configPath := filepath.Join(tmpDir, "client.yml")
	configContent := `id: test-client
networkId: N4N6KzfYtNRNnC2LNDLjMtFik7846EPqLgi1PANKwpaAMGKF
nodes:
  - peerId: 12D3KooWTestCoordinator
    addresses:
      - localhost:1004
    types:
      - coordinator
  - peerId: 12D3KooWTestTreeNode
    addresses:
      - localhost:1001
    types:
      - tree
`
	if err := os.WriteFile(configPath, []byte(configContent), 0644); err != nil {
		os.RemoveAll(tmpDir)
		t.Fatalf("failed to write config: %v", err)
	}

	client, err := anysync.NewClient(configPath, &anysync.ClientOptions{
		DataDir:     tmpDir,
		PeerKeyPath: filepath.Join(tmpDir, "peer.key"),
	})
	if err != nil {
		os.RemoveAll(tmpDir)
		t.Fatalf("failed to create client: %v", err)
	}

	cleanup := func() {
		client.Close()
		os.RemoveAll(tmpDir)
	}

	return client, cleanup
}

// NewTestSpaceManager creates a SpaceManager configured for testing
func NewTestSpaceManager(t *testing.T) (*anysync.SpaceManager, *MockAnySyncClient, *MockSpaceStore, func()) {
	t.Helper()

	mockClient := NewMockAnySyncClient()
	mockStore := NewMockSpaceStore()

	mgr := anysync.NewSpaceManager(mockClient, &anysync.SpaceManagerConfig{
		CommunitySpaceID: "test-community-space-id",
		OrgAID:           TestAIDs.Org,
	})

	cleanup := func() {
		mockClient.Reset()
		mockStore.Reset()
	}

	return mgr, mockClient, mockStore, cleanup
}

// NewTestSpaceManagerNoCommunity creates a SpaceManager without community space configured
func NewTestSpaceManagerNoCommunity(t *testing.T) (*anysync.SpaceManager, *MockAnySyncClient, *MockSpaceStore, func()) {
	t.Helper()

	mockClient := NewMockAnySyncClient()
	mockStore := NewMockSpaceStore()

	mgr := anysync.NewSpaceManager(mockClient, &anysync.SpaceManagerConfig{
		CommunitySpaceID: "", // Not configured
		OrgAID:           TestAIDs.Org,
	})

	cleanup := func() {
		mockClient.Reset()
		mockStore.Reset()
	}

	return mgr, mockClient, mockStore, cleanup
}

// GenerateTestAID generates a unique test AID with the given prefix
func GenerateTestAID(prefix string) string {
	return prefix + "_1234567890abcdefghijklmnopqrstuvwxyz"
}

// GenerateTestSpaceID generates a unique test space ID
func GenerateTestSpaceID(spaceType, ownerAID string) string {
	if len(ownerAID) > 8 {
		ownerAID = ownerAID[:8]
	}
	return "space_" + spaceType + "_" + ownerAID
}

// NewTestCredential creates a test credential for testing
func NewTestCredential(schema, issuer, recipient string) *anysync.Credential {
	return &anysync.Credential{
		SAID:      "ESAID_" + schema[:8] + "_test",
		Issuer:    issuer,
		Recipient: recipient,
		Schema:    schema,
		Data: map[string]interface{}{
			"test": true,
		},
	}
}

// NewTestMembershipCredential creates a test membership credential
func NewTestMembershipCredential(issuer, recipient string) *anysync.Credential {
	return NewTestCredential(TestSchemas.Membership, issuer, recipient)
}

// NewTestSelfClaimCredential creates a test self-claim credential
func NewTestSelfClaimCredential(issuer, recipient string) *anysync.Credential {
	return NewTestCredential(TestSchemas.SelfClaim, issuer, recipient)
}

// TempDir creates a temporary directory and returns it with a cleanup function
func TempDir(t *testing.T, prefix string) (string, func()) {
	t.Helper()

	tmpDir, err := os.MkdirTemp("", prefix)
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}

	return tmpDir, func() {
		os.RemoveAll(tmpDir)
	}
}

// WriteTestFile writes content to a file in a temporary directory
func WriteTestFile(t *testing.T, dir, filename, content string) string {
	t.Helper()

	path := filepath.Join(dir, filename)
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("failed to write test file: %v", err)
	}
	return path
}

// AssertNil fails the test if err is not nil
func AssertNil(t *testing.T, err error, msgAndArgs ...interface{}) {
	t.Helper()
	if err != nil {
		if len(msgAndArgs) > 0 {
			t.Fatalf("%v: %v", msgAndArgs[0], err)
		} else {
			t.Fatalf("expected nil error, got: %v", err)
		}
	}
}

// AssertNotNil fails the test if val is nil
func AssertNotNil(t *testing.T, val interface{}, msgAndArgs ...interface{}) {
	t.Helper()
	if val == nil {
		if len(msgAndArgs) > 0 {
			t.Fatalf("%v: expected non-nil value", msgAndArgs[0])
		} else {
			t.Fatal("expected non-nil value")
		}
	}
}

// AssertEqual fails the test if expected != actual
func AssertEqual(t *testing.T, expected, actual interface{}, msgAndArgs ...interface{}) {
	t.Helper()
	if expected != actual {
		if len(msgAndArgs) > 0 {
			t.Fatalf("%v: expected %v, got %v", msgAndArgs[0], expected, actual)
		} else {
			t.Fatalf("expected %v, got %v", expected, actual)
		}
	}
}

// AssertError fails the test if err is nil
func AssertError(t *testing.T, err error, msgAndArgs ...interface{}) {
	t.Helper()
	if err == nil {
		if len(msgAndArgs) > 0 {
			t.Fatalf("%v: expected error, got nil", msgAndArgs[0])
		} else {
			t.Fatal("expected error, got nil")
		}
	}
}
