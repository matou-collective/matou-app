package anysync

import (
	"context"
	"fmt"
	"testing"

	"github.com/anyproto/any-sync/commonspace"
	"github.com/anyproto/any-sync/commonspace/acl/aclclient/mock_aclclient"
	"github.com/anyproto/any-sync/commonspace/mock_commonspace"
	"github.com/anyproto/any-sync/commonspace/object/acl/aclrecordproto"
	"github.com/anyproto/any-sync/commonspace/object/acl/list"
	"github.com/anyproto/any-sync/commonspace/object/acl/syncacl/mock_syncacl"
	"github.com/anyproto/any-sync/consensus/consensusproto"
	"github.com/anyproto/any-sync/util/crypto"
	"go.uber.org/mock/gomock"
)

// =============================================================================
// Mock AclRecordBuilder (no pre-generated gomock mock exists for this interface)
// =============================================================================

type mockAclRecordBuilder struct {
	buildInviteAnyoneResult list.InviteResult
	buildInviteAnyoneErr    error

	buildInviteJoinWithoutApproveResult *consensusproto.RawRecord
	buildInviteJoinWithoutApproveErr    error

	// Track calls
	buildInviteAnyoneCalls              []list.AclPermissions
	buildInviteJoinWithoutApproveCalls  []list.InviteJoinPayload
}

func (m *mockAclRecordBuilder) UnmarshallWithId(rawIdRecord *consensusproto.RawRecordWithId) (rec *list.AclRecord, err error) {
	return nil, fmt.Errorf("not implemented")
}

func (m *mockAclRecordBuilder) Unmarshall(rawRecord *consensusproto.RawRecord) (rec *list.AclRecord, err error) {
	return nil, fmt.Errorf("not implemented")
}

func (m *mockAclRecordBuilder) BuildRoot(content list.RootContent) (rec *consensusproto.RawRecordWithId, err error) {
	return nil, fmt.Errorf("not implemented")
}

func (m *mockAclRecordBuilder) BuildOneToOneRoot(content list.RootContent, oneToOneInfo *aclrecordproto.AclOneToOneInfo) (rec *consensusproto.RawRecordWithId, err error) {
	return nil, fmt.Errorf("not implemented")
}

func (m *mockAclRecordBuilder) BuildBatchRequest(payload list.BatchRequestPayload) (batchResult list.BatchResult, err error) {
	return list.BatchResult{}, fmt.Errorf("not implemented")
}

func (m *mockAclRecordBuilder) BuildInvite() (res list.InviteResult, err error) {
	return list.InviteResult{}, fmt.Errorf("not implemented")
}

func (m *mockAclRecordBuilder) BuildInviteAnyone(permissions list.AclPermissions) (res list.InviteResult, err error) {
	m.buildInviteAnyoneCalls = append(m.buildInviteAnyoneCalls, permissions)
	return m.buildInviteAnyoneResult, m.buildInviteAnyoneErr
}

func (m *mockAclRecordBuilder) BuildInviteChange(inviteChange list.InviteChangePayload) (rawRecord *consensusproto.RawRecord, err error) {
	return nil, fmt.Errorf("not implemented")
}

func (m *mockAclRecordBuilder) BuildInviteRevoke(inviteRecordId string) (rawRecord *consensusproto.RawRecord, err error) {
	return nil, fmt.Errorf("not implemented")
}

func (m *mockAclRecordBuilder) BuildInviteJoinWithoutApprove(payload list.InviteJoinPayload) (rawRecord *consensusproto.RawRecord, err error) {
	m.buildInviteJoinWithoutApproveCalls = append(m.buildInviteJoinWithoutApproveCalls, payload)
	return m.buildInviteJoinWithoutApproveResult, m.buildInviteJoinWithoutApproveErr
}

func (m *mockAclRecordBuilder) BuildRequestJoin(payload list.RequestJoinPayload) (rawRecord *consensusproto.RawRecord, err error) {
	return nil, fmt.Errorf("not implemented")
}

func (m *mockAclRecordBuilder) BuildRequestAccept(payload list.RequestAcceptPayload) (rawRecord *consensusproto.RawRecord, err error) {
	return nil, fmt.Errorf("not implemented")
}

func (m *mockAclRecordBuilder) BuildRequestDecline(requestRecordId string) (rawRecord *consensusproto.RawRecord, err error) {
	return nil, fmt.Errorf("not implemented")
}

func (m *mockAclRecordBuilder) BuildRequestCancel(requestRecordId string) (rawRecord *consensusproto.RawRecord, err error) {
	return nil, fmt.Errorf("not implemented")
}

func (m *mockAclRecordBuilder) BuildRequestRemove() (rawRecord *consensusproto.RawRecord, err error) {
	return nil, fmt.Errorf("not implemented")
}

func (m *mockAclRecordBuilder) BuildPermissionChange(payload list.PermissionChangePayload) (rawRecord *consensusproto.RawRecord, err error) {
	return nil, fmt.Errorf("not implemented")
}

func (m *mockAclRecordBuilder) BuildPermissionChanges(payload list.PermissionChangesPayload) (rawRecord *consensusproto.RawRecord, err error) {
	return nil, fmt.Errorf("not implemented")
}

func (m *mockAclRecordBuilder) BuildOwnershipChange(ownershipChange list.OwnershipChangePayload) (rawRecord *consensusproto.RawRecord, err error) {
	return nil, fmt.Errorf("not implemented")
}

func (m *mockAclRecordBuilder) BuildReadKeyChange(payload list.ReadKeyChangePayload) (rawRecord *consensusproto.RawRecord, err error) {
	return nil, fmt.Errorf("not implemented")
}

func (m *mockAclRecordBuilder) BuildAccountRemove(payload list.AccountRemovePayload) (rawRecord *consensusproto.RawRecord, err error) {
	return nil, fmt.Errorf("not implemented")
}

func (m *mockAclRecordBuilder) BuildAccountsAdd(payload list.AccountsAddPayload) (rawRecord *consensusproto.RawRecord, err error) {
	return nil, fmt.Errorf("not implemented")
}

// =============================================================================
// ToSDKPermissions tests
// =============================================================================

func TestToSDKPermissions(t *testing.T) {
	tests := []struct {
		input    ACLPermission
		expected list.AclPermissions
	}{
		{PermissionRead, list.AclPermissionsReader},
		{PermissionWrite, list.AclPermissionsWriter},
		{PermissionAdmin, list.AclPermissionsAdmin},
		{PermissionOwner, list.AclPermissionsOwner},
		{PermissionNone, list.AclPermissionsNone},
		{ACLPermission("invalid"), list.AclPermissionsNone},
	}

	for _, tt := range tests {
		t.Run(string(tt.input), func(t *testing.T) {
			got := tt.input.ToSDKPermissions()
			if got != tt.expected {
				t.Errorf("ToSDKPermissions(%s) = %v, want %v", tt.input, got, tt.expected)
			}
		})
	}
}

// =============================================================================
// MatouACLManager tests
// =============================================================================

func TestMatouACLManager_CreateOpenInvite(t *testing.T) {
	ctrl := gomock.NewController(t)

	// Generate a test invite key to return
	inviteKey, _, err := crypto.GenerateRandomEd25519KeyPair()
	if err != nil {
		t.Fatalf("generating test key: %v", err)
	}

	inviteRec := &consensusproto.RawRecord{Payload: []byte("test-invite-record")}

	// Set up mock chain: client -> space -> acl -> builder -> result
	mockSpace := mock_commonspace.NewMockSpace(ctrl)
	mockAcl := mock_syncacl.NewMockSyncAcl(ctrl)
	mockAclClient := mock_aclclient.NewMockAclSpaceClient(ctrl)
	builder := &mockAclRecordBuilder{
		buildInviteAnyoneResult: list.InviteResult{
			InviteRec: inviteRec,
			InviteKey: inviteKey,
		},
	}

	// Mock client that returns our mock space
	client := &testACLClient{
		space: mockSpace,
	}

	// Expectations
	mockSpace.EXPECT().Acl().Return(mockAcl)
	mockAcl.EXPECT().Lock()
	mockAcl.EXPECT().Unlock()
	mockAcl.EXPECT().RecordBuilder().Return(builder)
	mockSpace.EXPECT().AclClient().Return(mockAclClient)
	mockAclClient.EXPECT().AddRecord(gomock.Any(), inviteRec).Return(nil)

	mgr := NewMatouACLManager(client, nil)
	gotKey, err := mgr.CreateOpenInvite(context.Background(), "test-space-id", list.AclPermissionsWriter)
	if err != nil {
		t.Fatalf("CreateOpenInvite error: %v", err)
	}

	if gotKey == nil {
		t.Fatal("expected non-nil invite key")
	}

	// Verify the returned key matches
	gotRaw, _ := gotKey.GetPublic().Raw()
	expectedRaw, _ := inviteKey.GetPublic().Raw()
	if string(gotRaw) != string(expectedRaw) {
		t.Error("returned invite key does not match expected key")
	}

	// Verify builder was called with correct permissions
	if len(builder.buildInviteAnyoneCalls) != 1 {
		t.Fatalf("expected 1 call to BuildInviteAnyone, got %d", len(builder.buildInviteAnyoneCalls))
	}
	if builder.buildInviteAnyoneCalls[0] != list.AclPermissionsWriter {
		t.Errorf("expected Writer permissions, got %v", builder.buildInviteAnyoneCalls[0])
	}
}

func TestMatouACLManager_CreateOpenInvite_GetSpaceError(t *testing.T) {
	client := &testACLClient{
		getSpaceErr: fmt.Errorf("space not found"),
	}

	mgr := NewMatouACLManager(client, nil)
	_, err := mgr.CreateOpenInvite(context.Background(), "missing-space", list.AclPermissionsWriter)
	if err == nil {
		t.Fatal("expected error when GetSpace fails")
	}
}

func TestMatouACLManager_CreateOpenInvite_BuildError(t *testing.T) {
	ctrl := gomock.NewController(t)

	mockSpace := mock_commonspace.NewMockSpace(ctrl)
	mockAcl := mock_syncacl.NewMockSyncAcl(ctrl)
	builder := &mockAclRecordBuilder{
		buildInviteAnyoneErr: fmt.Errorf("crypto error"),
	}

	client := &testACLClient{space: mockSpace}

	mockSpace.EXPECT().Acl().Return(mockAcl)
	mockAcl.EXPECT().Lock()
	mockAcl.EXPECT().Unlock()
	mockAcl.EXPECT().RecordBuilder().Return(builder)

	mgr := NewMatouACLManager(client, nil)
	_, err := mgr.CreateOpenInvite(context.Background(), "test-space", list.AclPermissionsWriter)
	if err == nil {
		t.Fatal("expected error when BuildInviteAnyone fails")
	}
}

func TestMatouACLManager_CreateOpenInvite_AddRecordError(t *testing.T) {
	ctrl := gomock.NewController(t)

	inviteKey, _, _ := crypto.GenerateRandomEd25519KeyPair()
	inviteRec := &consensusproto.RawRecord{Payload: []byte("test")}

	mockSpace := mock_commonspace.NewMockSpace(ctrl)
	mockAcl := mock_syncacl.NewMockSyncAcl(ctrl)
	mockAclClient := mock_aclclient.NewMockAclSpaceClient(ctrl)
	builder := &mockAclRecordBuilder{
		buildInviteAnyoneResult: list.InviteResult{
			InviteRec: inviteRec,
			InviteKey: inviteKey,
		},
	}

	client := &testACLClient{space: mockSpace}

	mockSpace.EXPECT().Acl().Return(mockAcl)
	mockAcl.EXPECT().Lock()
	mockAcl.EXPECT().Unlock()
	mockAcl.EXPECT().RecordBuilder().Return(builder)
	mockSpace.EXPECT().AclClient().Return(mockAclClient)
	mockAclClient.EXPECT().AddRecord(gomock.Any(), inviteRec).Return(fmt.Errorf("network error"))

	mgr := NewMatouACLManager(client, nil)
	_, err := mgr.CreateOpenInvite(context.Background(), "test-space", list.AclPermissionsWriter)
	if err == nil {
		t.Fatal("expected error when AddRecord fails")
	}
}

func TestMatouACLManager_JoinWithInvite(t *testing.T) {
	ctrl := gomock.NewController(t)

	inviteKey, _, _ := crypto.GenerateRandomEd25519KeyPair()
	joinRec := &consensusproto.RawRecord{Payload: []byte("join-record")}

	mockSpace := mock_commonspace.NewMockSpace(ctrl)
	mockAcl := mock_syncacl.NewMockSyncAcl(ctrl)
	mockAclClient := mock_aclclient.NewMockAclSpaceClient(ctrl)
	builder := &mockAclRecordBuilder{
		buildInviteJoinWithoutApproveResult: joinRec,
	}

	client := &testACLClient{space: mockSpace}

	mockSpace.EXPECT().Acl().Return(mockAcl)
	mockAcl.EXPECT().Lock()
	mockAcl.EXPECT().Unlock()
	mockAcl.EXPECT().RecordBuilder().Return(builder)
	mockSpace.EXPECT().AclClient().Return(mockAclClient)
	mockAclClient.EXPECT().AddRecord(gomock.Any(), joinRec).Return(nil)

	mgr := NewMatouACLManager(client, nil)
	metadata := []byte(`{"aid":"EUser123"}`)
	err := mgr.JoinWithInvite(context.Background(), "test-space", inviteKey, metadata)
	if err != nil {
		t.Fatalf("JoinWithInvite error: %v", err)
	}

	// Verify builder was called with correct payload
	if len(builder.buildInviteJoinWithoutApproveCalls) != 1 {
		t.Fatalf("expected 1 call, got %d", len(builder.buildInviteJoinWithoutApproveCalls))
	}
	call := builder.buildInviteJoinWithoutApproveCalls[0]
	if call.InviteKey != inviteKey {
		t.Error("invite key mismatch")
	}
	if string(call.Metadata) != string(metadata) {
		t.Errorf("metadata mismatch: got %s, want %s", call.Metadata, metadata)
	}
}

func TestMatouACLManager_JoinWithInvite_GetSpaceError(t *testing.T) {
	client := &testACLClient{
		getSpaceErr: fmt.Errorf("space not found"),
	}

	mgr := NewMatouACLManager(client, nil)
	inviteKey, _, _ := crypto.GenerateRandomEd25519KeyPair()
	err := mgr.JoinWithInvite(context.Background(), "missing-space", inviteKey, nil)
	if err == nil {
		t.Fatal("expected error when GetSpace fails")
	}
}

func TestMatouACLManager_JoinWithInvite_BuildError(t *testing.T) {
	ctrl := gomock.NewController(t)

	inviteKey, _, _ := crypto.GenerateRandomEd25519KeyPair()

	mockSpace := mock_commonspace.NewMockSpace(ctrl)
	mockAcl := mock_syncacl.NewMockSyncAcl(ctrl)
	builder := &mockAclRecordBuilder{
		buildInviteJoinWithoutApproveErr: fmt.Errorf("invalid invite key"),
	}

	client := &testACLClient{space: mockSpace}

	mockSpace.EXPECT().Acl().Return(mockAcl)
	mockAcl.EXPECT().Lock()
	mockAcl.EXPECT().Unlock()
	mockAcl.EXPECT().RecordBuilder().Return(builder)

	mgr := NewMatouACLManager(client, nil)
	err := mgr.JoinWithInvite(context.Background(), "test-space", inviteKey, nil)
	if err == nil {
		t.Fatal("expected error when BuildInviteJoinWithoutApprove fails")
	}
}

func TestMatouACLManager_GetPermissions_GetSpaceError(t *testing.T) {
	client := &testACLClient{
		getSpaceErr: fmt.Errorf("space not found"),
	}

	identity, _, _ := crypto.GenerateRandomEd25519KeyPair()

	mgr := NewMatouACLManager(client, nil)
	perm, err := mgr.GetPermissions(context.Background(), "missing-space", identity.GetPublic())
	if err == nil {
		t.Fatal("expected error when GetSpace fails")
	}
	if perm != list.AclPermissionsNone {
		t.Errorf("expected AclPermissionsNone, got %v", perm)
	}
}

func TestMatouACLManager_GetPermissions_NilState(t *testing.T) {
	ctrl := gomock.NewController(t)

	mockSpace := mock_commonspace.NewMockSpace(ctrl)
	mockAcl := mock_syncacl.NewMockSyncAcl(ctrl)

	client := &testACLClient{space: mockSpace}

	mockSpace.EXPECT().Acl().Return(mockAcl)
	mockAcl.EXPECT().RLock()
	mockAcl.EXPECT().RUnlock()
	mockAcl.EXPECT().AclState().Return(nil)

	identity, _, _ := crypto.GenerateRandomEd25519KeyPair()

	mgr := NewMatouACLManager(client, nil)
	perm, err := mgr.GetPermissions(context.Background(), "test-space", identity.GetPublic())
	if err == nil {
		t.Fatal("expected error for nil ACL state")
	}
	if perm != list.AclPermissionsNone {
		t.Errorf("expected AclPermissionsNone, got %v", perm)
	}
}

// =============================================================================
// Test helper: minimal AnySyncClient for ACL tests
// =============================================================================

// testACLClient implements AnySyncClient for MatouACLManager tests.
// Only GetSpace is functional; all other methods return errors.
type testACLClient struct {
	space       commonspace.Space
	getSpaceErr error
}

var _ AnySyncClient = (*testACLClient)(nil)

func (c *testACLClient) GetSpace(_ context.Context, _ string) (commonspace.Space, error) {
	if c.getSpaceErr != nil {
		return nil, c.getSpaceErr
	}
	return c.space, nil
}

func (c *testACLClient) CreateSpace(_ context.Context, _ string, _ string, _ crypto.PrivKey) (*SpaceCreateResult, error) {
	return nil, fmt.Errorf("not implemented")
}
func (c *testACLClient) CreateSpaceWithKeys(_ context.Context, _ string, _ string, _ *SpaceKeySet) (*SpaceCreateResult, error) {
	return nil, fmt.Errorf("not implemented")
}
func (c *testACLClient) DeriveSpace(_ context.Context, _ string, _ string, _ crypto.PrivKey) (*SpaceCreateResult, error) {
	return nil, fmt.Errorf("not implemented")
}
func (c *testACLClient) DeriveSpaceID(_ context.Context, _ string, _ string, _ crypto.PrivKey) (string, error) {
	return "", fmt.Errorf("not implemented")
}
func (c *testACLClient) AddToACL(_ context.Context, _ string, _ string, _ []string) error {
	return fmt.Errorf("not implemented")
}
func (c *testACLClient) SyncDocument(_ context.Context, _ string, _ string, _ []byte) error {
	return fmt.Errorf("not implemented")
}
func (c *testACLClient) MakeSpaceShareable(_ context.Context, _ string) error { return nil }
func (c *testACLClient) GetNetworkID() string     { return "" }
func (c *testACLClient) GetCoordinatorURL() string { return "" }
func (c *testACLClient) GetPeerID() string         { return "" }
func (c *testACLClient) GetDataDir() string        { return "" }
func (c *testACLClient) Ping() error               { return nil }
func (c *testACLClient) Close() error              { return nil }

// =============================================================================
// Application-layer ACL policy tests (existing)
// =============================================================================

func TestPrivateACL(t *testing.T) {
	ownerAID := "EOwner1234567890abcdef"

	policy := PrivateACL(ownerAID)

	if policy.PolicyType != PolicyTypePrivate {
		t.Errorf("expected policy type %s, got %s", PolicyTypePrivate, policy.PolicyType)
	}

	if policy.OwnerAID != ownerAID {
		t.Errorf("expected owner AID %s, got %s", ownerAID, policy.OwnerAID)
	}

	if policy.RequiredSchema != "" {
		t.Errorf("expected no required schema, got %s", policy.RequiredSchema)
	}

	if policy.DefaultPermission != PermissionNone {
		t.Errorf("expected default permission %s, got %s", PermissionNone, policy.DefaultPermission)
	}

	if policy.OwnerPermission != PermissionOwner {
		t.Errorf("expected owner permission %s, got %s", PermissionOwner, policy.OwnerPermission)
	}
}

func TestCommunityACL(t *testing.T) {
	orgAID := "EOrg1234567890abcdef"
	requiredSchema := "EMatouMembershipSchemaV1"

	policy := CommunityACL(orgAID, requiredSchema)

	if policy.PolicyType != PolicyTypeCommunity {
		t.Errorf("expected policy type %s, got %s", PolicyTypeCommunity, policy.PolicyType)
	}

	if policy.OwnerAID != orgAID {
		t.Errorf("expected owner AID %s, got %s", orgAID, policy.OwnerAID)
	}

	if policy.RequiredSchema != requiredSchema {
		t.Errorf("expected required schema %s, got %s", requiredSchema, policy.RequiredSchema)
	}

	if policy.DefaultPermission != PermissionWrite {
		t.Errorf("expected default permission %s, got %s", PermissionWrite, policy.DefaultPermission)
	}

	if policy.OwnerPermission != PermissionOwner {
		t.Errorf("expected owner permission %s, got %s", PermissionOwner, policy.OwnerPermission)
	}
}

func TestPublicACL(t *testing.T) {
	ownerAID := "EOwner1234567890abcdef"

	policy := PublicACL(ownerAID)

	if policy.PolicyType != PolicyTypePublic {
		t.Errorf("expected policy type %s, got %s", PolicyTypePublic, policy.PolicyType)
	}

	if policy.OwnerAID != ownerAID {
		t.Errorf("expected owner AID %s, got %s", ownerAID, policy.OwnerAID)
	}

	if policy.RequiredSchema != "" {
		t.Errorf("expected no required schema, got %s", policy.RequiredSchema)
	}

	if policy.DefaultPermission != PermissionRead {
		t.Errorf("expected default permission %s, got %s", PermissionRead, policy.DefaultPermission)
	}

	if policy.OwnerPermission != PermissionOwner {
		t.Errorf("expected owner permission %s, got %s", PermissionOwner, policy.OwnerPermission)
	}
}

func TestACLManager_ValidateAccess_Owner(t *testing.T) {
	ownerAID := "EOwner1234567890abcdef"
	policy := PrivateACL(ownerAID)

	mgr := NewACLManager(nil) // Client not needed for validation

	perm, err := mgr.ValidateAccess(policy, ownerAID, false, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if perm != PermissionOwner {
		t.Errorf("expected owner permission, got %s", perm)
	}
}

func TestACLManager_ValidateAccess_PrivateNonOwner(t *testing.T) {
	ownerAID := "EOwner1234567890abcdef"
	otherAID := "EOther1234567890abcdef"
	policy := PrivateACL(ownerAID)

	mgr := NewACLManager(nil)

	perm, err := mgr.ValidateAccess(policy, otherAID, false, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if perm != PermissionNone {
		t.Errorf("expected no permission for non-owner in private space, got %s", perm)
	}
}

func TestACLManager_ValidateAccess_CommunityWithCredential(t *testing.T) {
	orgAID := "EOrg1234567890abcdef"
	memberAID := "EMember1234567890abcdef"
	requiredSchema := "EMatouMembershipSchemaV1"
	policy := CommunityACL(orgAID, requiredSchema)

	mgr := NewACLManager(nil)

	// Member with correct credential
	perm, err := mgr.ValidateAccess(policy, memberAID, true, requiredSchema)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if perm != PermissionWrite {
		t.Errorf("expected write permission for member with credential, got %s", perm)
	}
}

func TestACLManager_ValidateAccess_CommunityWithoutCredential(t *testing.T) {
	orgAID := "EOrg1234567890abcdef"
	memberAID := "EMember1234567890abcdef"
	requiredSchema := "EMatouMembershipSchemaV1"
	policy := CommunityACL(orgAID, requiredSchema)

	mgr := NewACLManager(nil)

	// User without credential
	perm, err := mgr.ValidateAccess(policy, memberAID, false, "")
	if err == nil {
		t.Error("expected error for missing credential")
	}

	if perm != PermissionNone {
		t.Errorf("expected no permission without credential, got %s", perm)
	}
}

func TestACLManager_ValidateAccess_CommunityWrongSchema(t *testing.T) {
	orgAID := "EOrg1234567890abcdef"
	memberAID := "EMember1234567890abcdef"
	requiredSchema := "EMatouMembershipSchemaV1"
	wrongSchema := "ESomeOtherSchema"
	policy := CommunityACL(orgAID, requiredSchema)

	mgr := NewACLManager(nil)

	// User with wrong credential schema
	perm, err := mgr.ValidateAccess(policy, memberAID, true, wrongSchema)
	if err == nil {
		t.Error("expected error for wrong credential schema")
	}

	if perm != PermissionNone {
		t.Errorf("expected no permission with wrong schema, got %s", perm)
	}
}

func TestACLManager_ValidateAccess_Public(t *testing.T) {
	ownerAID := "EOwner1234567890abcdef"
	anyoneAID := "EAnyone1234567890abcdef"
	policy := PublicACL(ownerAID)

	mgr := NewACLManager(nil)

	perm, err := mgr.ValidateAccess(policy, anyoneAID, false, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if perm != PermissionRead {
		t.Errorf("expected read permission for public space, got %s", perm)
	}
}

func TestACLManager_ValidateAccess_UnknownPolicyType(t *testing.T) {
	policy := &ACLPolicy{
		PolicyType:        "unknown",
		OwnerAID:          "EOwner123",
		DefaultPermission: PermissionRead,
		OwnerPermission:   PermissionOwner,
	}

	mgr := NewACLManager(nil)

	perm, err := mgr.ValidateAccess(policy, "EUser123", false, "")
	if err == nil {
		t.Error("expected error for unknown policy type")
	}

	if perm != PermissionNone {
		t.Errorf("expected no permission for unknown policy type, got %s", perm)
	}
}

func TestACLPolicyForSpaceType_Private(t *testing.T) {
	ownerAID := "EOwner1234567890abcdef"
	orgAID := "EOrg1234567890abcdef"

	policy := ACLPolicyForSpaceType(SpaceTypePrivate, ownerAID, orgAID)

	if policy.PolicyType != PolicyTypePrivate {
		t.Errorf("expected private policy, got %s", policy.PolicyType)
	}

	if policy.OwnerAID != ownerAID {
		t.Errorf("expected owner %s, got %s", ownerAID, policy.OwnerAID)
	}
}

func TestACLPolicyForSpaceType_Community(t *testing.T) {
	ownerAID := "EOwner1234567890abcdef"
	orgAID := "EOrg1234567890abcdef"

	policy := ACLPolicyForSpaceType(SpaceTypeCommunity, ownerAID, orgAID)

	if policy.PolicyType != PolicyTypeCommunity {
		t.Errorf("expected community policy, got %s", policy.PolicyType)
	}

	if policy.OwnerAID != orgAID {
		t.Errorf("expected org owner %s, got %s", orgAID, policy.OwnerAID)
	}

	if policy.RequiredSchema != "EMatouMembershipSchemaV1" {
		t.Errorf("expected membership schema, got %s", policy.RequiredSchema)
	}
}

func TestACLPolicyForSpaceType_Unknown(t *testing.T) {
	ownerAID := "EOwner1234567890abcdef"
	orgAID := "EOrg1234567890abcdef"

	policy := ACLPolicyForSpaceType("unknown", ownerAID, orgAID)

	// Should default to private
	if policy.PolicyType != PolicyTypePrivate {
		t.Errorf("expected private policy for unknown type, got %s", policy.PolicyType)
	}
}

func TestACLEntry_Structure(t *testing.T) {
	entry := ACLEntry{
		PeerID:         "12D3KooWTest",
		AID:            "EUser123",
		Permission:     PermissionWrite,
		CredentialSAID: "ESAID123",
		AddedAt:        1234567890,
	}

	if entry.PeerID != "12D3KooWTest" {
		t.Errorf("unexpected peer ID: %s", entry.PeerID)
	}

	if entry.AID != "EUser123" {
		t.Errorf("unexpected AID: %s", entry.AID)
	}

	if entry.Permission != PermissionWrite {
		t.Errorf("unexpected permission: %s", entry.Permission)
	}
}

func TestACLPermission_Constants(t *testing.T) {
	permissions := []ACLPermission{
		PermissionNone,
		PermissionRead,
		PermissionWrite,
		PermissionAdmin,
		PermissionOwner,
	}

	expected := []string{"none", "read", "write", "admin", "owner"}

	for i, perm := range permissions {
		if string(perm) != expected[i] {
			t.Errorf("expected permission %s, got %s", expected[i], perm)
		}
	}
}
