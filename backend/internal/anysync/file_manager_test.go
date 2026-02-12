package anysync

import (
	"encoding/json"
	"testing"
)

func TestFileMeta_JSON(t *testing.T) {
	meta := &FileMeta{
		CID:         "bafkreitest123",
		ContentType: "image/png",
		Size:        12345,
		UploadedBy:  "pubkey123",
		UploadedAt:  1706745600,
	}

	data, err := json.Marshal(meta)
	if err != nil {
		t.Fatalf("failed to marshal FileMeta: %v", err)
	}

	var decoded FileMeta
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("failed to unmarshal FileMeta: %v", err)
	}

	if decoded.CID != meta.CID {
		t.Errorf("CID mismatch: %s != %s", decoded.CID, meta.CID)
	}
	if decoded.ContentType != meta.ContentType {
		t.Errorf("ContentType mismatch: %s != %s", decoded.ContentType, meta.ContentType)
	}
	if decoded.Size != meta.Size {
		t.Errorf("Size mismatch: %d != %d", decoded.Size, meta.Size)
	}
	if decoded.UploadedBy != meta.UploadedBy {
		t.Errorf("UploadedBy mismatch: %s != %s", decoded.UploadedBy, meta.UploadedBy)
	}
	if decoded.UploadedAt != meta.UploadedAt {
		t.Errorf("UploadedAt mismatch: %d != %d", decoded.UploadedAt, meta.UploadedAt)
	}
}

func TestFileMetaObjectType(t *testing.T) {
	if FileMetaObjectType != "file_meta" {
		t.Errorf("unexpected FileMetaObjectType: %s", FileMetaObjectType)
	}
}

func TestNewFileManager(t *testing.T) {
	nc := &mockNodeConf{filePeers: []string{"peer1"}}
	p := &mockPool{peer: &mockPeer{}}
	objTree := NewObjectTreeManager(nil, nil, NewUnifiedTreeManager())

	fm := NewFileManager(p, nc, objTree)
	if fm == nil {
		t.Fatal("expected non-nil FileManager")
	}
	if fm.handler == nil {
		t.Error("expected non-nil FileHandler")
	}
	if fm.blockStore == nil {
		t.Error("expected non-nil RemoteBlockStore")
	}
	if fm.objTree == nil {
		t.Error("expected non-nil ObjectTreeManager")
	}
}

func TestSpaceManager_FileManager_NilWhenMockClient(t *testing.T) {
	// Mock client returns nil for GetPool/GetNodeConf,
	// so FileManager should be nil
	mock := newMockAnySyncClient()
	sm := NewSpaceManager(mock, &SpaceManagerConfig{
		CommunitySpaceID: "test-space",
		OrgAID:           "EORG123",
	})

	if sm.FileManager() != nil {
		t.Error("expected nil FileManager for mock client")
	}
}

func TestObjectPayload_FileMetaRoundTrip(t *testing.T) {
	// Test that FileMeta can be stored as ObjectPayload.Data
	meta := &FileMeta{
		CID:         "bafkrei123",
		ContentType: "image/jpeg",
		Size:        54321,
		UploadedBy:  "key-abc",
		UploadedAt:  1706745600,
	}

	metaData, err := json.Marshal(meta)
	if err != nil {
		t.Fatal(err)
	}

	payload := &ObjectPayload{
		ID:        meta.CID,
		Type:      FileMetaObjectType,
		OwnerKey:  meta.UploadedBy,
		Data:      metaData,
		Timestamp: meta.UploadedAt,
		Version:   1,
	}

	// Verify payload fields
	if payload.Type != "file_meta" {
		t.Errorf("unexpected type: %s", payload.Type)
	}

	// Round-trip the data
	var decoded FileMeta
	if err := json.Unmarshal(payload.Data, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.CID != meta.CID {
		t.Errorf("CID mismatch after round-trip")
	}
	if decoded.ContentType != meta.ContentType {
		t.Errorf("ContentType mismatch after round-trip")
	}
}
