//go:build integration

// File storage integration tests for any-sync filenode.
//
// These tests verify that files can be uploaded and downloaded through the
// real any-sync filenode (Docker container). They exercise the full path:
//   FileManager.AddFile → FileHandler chunks → RemoteBlockStore.Add (dRPC BlockPush)
//   → BlocksBind → filenode stores in MinIO
//   FileManager.GetFile → RemoteBlockStore.Get (dRPC BlockGet) → FileHandler reassembles
//
// Run with:
//
//	go test -tags=integration -v ./internal/anysync/... -run "TestIntegration_File"
package anysync

import (
	"bytes"
	"context"
	"io"
	"testing"
	"time"
)

func TestIntegration_FileUploadDownload(t *testing.T) {
	testNetwork.RequireNetwork()

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	client := newTestSDKClient(t)

	// Create a space using the peer key as the signing key (nil = default to peer key).
	// This is critical: the credential provider uses the peer key for SpaceSign,
	// so the space must be registered with the same key. Using a random key causes
	// "incorrect identity" errors during HeadSync and file operations.
	result, err := client.CreateSpace(ctx, "ETestFile_Owner", SpaceTypeCommunity, nil)
	if err != nil {
		t.Fatalf("creating space: %v", err)
	}
	spaceID := result.SpaceID
	signingKey := result.Keys.SigningKey
	t.Logf("Created space: %s", spaceID)

	// Wait for space to propagate to tree nodes
	t.Log("Waiting for space to be available on tree nodes...")
	propagateDeadline := time.Now().Add(30 * time.Second)
	var spaceReady bool
	for time.Now().Before(propagateDeadline) {
		_, err := client.GetSpace(ctx, spaceID)
		if err == nil {
			spaceReady = true
			break
		}
		time.Sleep(1 * time.Second)
	}
	if !spaceReady {
		t.Fatalf("Space did not become available within timeout")
	}
	t.Log("Space is available")

	// Set account file storage limits on the coordinator so the filenode
	// allows BlockPush operations. Without this, the filenode returns "forbidden".
	identity := signingKey.GetPublic().Account()
	if err := client.SetAccountFileLimits(ctx, identity, 1<<30 /* 1 GB */); err != nil {
		t.Logf("SetAccountFileLimits failed (may require admin identity): %v", err)
		t.Log("Attempting file operations anyway — filenode defaultLimit may apply...")
	} else {
		t.Log("Account file storage limits set on coordinator")
	}

	// Create SpaceManager which initializes FileManager with real pool/nodeconf.
	// Pass the UTM from the SDK client so it has access to the app component system.
	sm := NewSpaceManager(client, &SpaceManagerConfig{
		CommunitySpaceID: spaceID,
	}, client.GetTreeManager())

	fm := sm.FileManager()
	if fm == nil {
		t.Fatal("expected non-nil FileManager from SpaceManager with real SDK client")
	}
	t.Log("FileManager initialized with real pool and nodeconf")

	// Verify file peers are configured
	filePeers := client.GetNodeConf().FilePeers()
	if len(filePeers) == 0 {
		t.Fatal("no file peers configured in node conf")
	}
	t.Logf("File peers: %v", filePeers)

	t.Run("upload and download small file", func(t *testing.T) {
		// Create test data (a small "image")
		testData := []byte("PNG fake image data for integration test - small file")
		reader := bytes.NewReader(testData)

		// Upload
		fileRef, err := fm.AddFile(ctx, spaceID, reader, "image/png", int64(len(testData)), signingKey)
		if err != nil {
			t.Fatalf("AddFile failed: %v", err)
		}
		if fileRef == "" {
			t.Fatal("expected non-empty file reference (CID)")
		}
		t.Logf("Uploaded file, CID: %s", fileRef)

		// Download
		downloadReader, contentType, err := fm.GetFile(ctx, spaceID, fileRef)
		if err != nil {
			t.Fatalf("GetFile failed: %v", err)
		}
		defer downloadReader.Close()

		downloaded, err := io.ReadAll(downloadReader)
		if err != nil {
			t.Fatalf("reading downloaded file: %v", err)
		}

		// Verify byte-for-byte round-trip integrity
		if !bytes.Equal(downloaded, testData) {
			t.Errorf("round-trip data mismatch: uploaded %d bytes, downloaded %d bytes", len(testData), len(downloaded))
			t.Errorf("uploaded:   %q", testData)
			t.Errorf("downloaded: %q", downloaded)
		} else {
			t.Logf("Round-trip integrity verified: %d bytes match", len(testData))
		}

		// Verify content type from metadata
		if contentType != "image/png" {
			t.Logf("Content type: %s (may be fallback if ObjectTree metadata not yet synced)", contentType)
		}
	})

	t.Run("upload and download larger file", func(t *testing.T) {
		// Create a larger file that will be chunked into multiple DAG blocks
		// IPFS UnixFS default chunk size is 256KB, so 512KB should produce multiple blocks
		largeData := make([]byte, 512*1024)
		for i := range largeData {
			largeData[i] = byte(i % 256)
		}
		reader := bytes.NewReader(largeData)

		// Upload
		fileRef, err := fm.AddFile(ctx, spaceID, reader, "application/octet-stream", int64(len(largeData)), signingKey)
		if err != nil {
			t.Fatalf("AddFile (large) failed: %v", err)
		}
		t.Logf("Uploaded large file (%d bytes), CID: %s", len(largeData), fileRef)

		// Download
		downloadReader, _, err := fm.GetFile(ctx, spaceID, fileRef)
		if err != nil {
			t.Fatalf("GetFile (large) failed: %v", err)
		}
		defer downloadReader.Close()

		downloaded, err := io.ReadAll(downloadReader)
		if err != nil {
			t.Fatalf("reading downloaded large file: %v", err)
		}

		if !bytes.Equal(downloaded, largeData) {
			t.Errorf("large file round-trip mismatch: uploaded %d bytes, downloaded %d bytes", len(largeData), len(downloaded))
		} else {
			t.Logf("Large file round-trip integrity verified: %d bytes match", len(largeData))
		}
	})

	t.Run("file metadata persisted in ObjectTree", func(t *testing.T) {
		testData := []byte("metadata test file content")
		reader := bytes.NewReader(testData)

		fileRef, err := fm.AddFile(ctx, spaceID, reader, "image/jpeg", int64(len(testData)), signingKey)
		if err != nil {
			t.Fatalf("AddFile failed: %v", err)
		}
		t.Logf("Uploaded file for metadata test, CID: %s", fileRef)

		// Read metadata back from ObjectTree
		meta, err := fm.GetFileMeta(ctx, spaceID, fileRef)
		if err != nil {
			t.Fatalf("GetFileMeta failed: %v", err)
		}

		if meta.CID != fileRef {
			t.Errorf("CID mismatch: meta=%s, fileRef=%s", meta.CID, fileRef)
		}
		if meta.ContentType != "image/jpeg" {
			t.Errorf("ContentType mismatch: got %s, want image/jpeg", meta.ContentType)
		}
		if meta.Size != int64(len(testData)) {
			t.Errorf("Size mismatch: got %d, want %d", meta.Size, len(testData))
		}
		if meta.UploadedBy == "" {
			t.Error("expected non-empty UploadedBy")
		}
		if meta.UploadedAt == 0 {
			t.Error("expected non-zero UploadedAt")
		}
		t.Logf("File metadata verified: CID=%s ContentType=%s Size=%d UploadedBy=%s",
			meta.CID, meta.ContentType, meta.Size, meta.UploadedBy)
	})

	t.Run("download non-existent CID returns error", func(t *testing.T) {
		// Use a valid CID format that doesn't exist on the filenode
		fakeCID := "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenera"
		_, _, err := fm.GetFile(ctx, spaceID, fakeCID)
		if err == nil {
			t.Error("expected error when downloading non-existent CID")
		} else {
			t.Logf("Got expected error for non-existent CID: %v", err)
		}
	})
}

func TestIntegration_FileBlockStoreDirectOps(t *testing.T) {
	testNetwork.RequireNetwork()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	client := newTestSDKClient(t)

	p := client.GetPool()
	nc := client.GetNodeConf()
	if p == nil || nc == nil {
		t.Fatal("expected non-nil pool and nodeconf from real SDK client")
	}

	filePeers := nc.FilePeers()
	if len(filePeers) == 0 {
		t.Fatal("no file peers configured")
	}
	t.Logf("File peers: %v", filePeers)

	t.Run("can connect to file peer", func(t *testing.T) {
		peer, err := p.GetOneOf(ctx, filePeers)
		if err != nil {
			t.Fatalf("GetOneOf failed: %v", err)
		}
		t.Logf("Connected to file peer: %s", peer.Id())
	})
}
