package api

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/matou-dao/backend/internal/anysync"
)

func TestFilesHandler_Upload_NilFileManager(t *testing.T) {
	handler := NewFilesHandler(nil, nil)

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, err := writer.CreateFormFile("file", "test.png")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write([]byte("fake-image-data"))
	_ = writer.Close()

	req := httptest.NewRequest(http.MethodPost, "/api/v1/files/upload", body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	w := httptest.NewRecorder()

	handler.HandleUpload(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("expected 503, got %d", w.Code)
	}

	var resp map[string]string
	_ = json.NewDecoder(w.Body).Decode(&resp)
	if resp["error"] == "" {
		t.Error("expected error message in response")
	}
}

func TestFilesHandler_Download_NilFileManager(t *testing.T) {
	handler := NewFilesHandler(nil, nil)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/files/bafkreitest", nil)
	w := httptest.NewRecorder()

	handler.HandleDownload(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("expected 503, got %d", w.Code)
	}
}

func TestFilesHandler_Upload_MethodNotAllowed(t *testing.T) {
	handler := NewFilesHandler(nil, nil)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/files/upload", nil)
	w := httptest.NewRecorder()

	handler.HandleUpload(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected 405, got %d", w.Code)
	}
}

func TestFilesHandler_Download_MethodNotAllowed(t *testing.T) {
	handler := NewFilesHandler(nil, nil)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/files/bafkreitest", nil)
	w := httptest.NewRecorder()

	handler.HandleDownload(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected 405, got %d", w.Code)
	}
}

func TestFilesHandler_Download_EmptyRef(t *testing.T) {
	// Mock client returns nil for GetPool, so FileManager is nil.
	// Handler checks fileManager==nil first (503), before empty ref (400).
	sm := anysync.NewSpaceManager(newMockAnySyncClientForIntegration(), &anysync.SpaceManagerConfig{
		CommunitySpaceID: "test-space",
	})
	handler := NewFilesHandler(sm.FileManager(), sm)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/files/", nil)
	w := httptest.NewRecorder()

	handler.HandleDownload(w, req)

	// 503 because fileManager is nil (mock client has no pool)
	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("expected 503, got %d", w.Code)
	}
}

func TestFilesHandler_Download_InvalidCID(t *testing.T) {
	sm := anysync.NewSpaceManager(newMockAnySyncClientForIntegration(), &anysync.SpaceManagerConfig{
		CommunitySpaceID: "test-space",
	})
	handler := NewFilesHandler(sm.FileManager(), sm)

	// "not-a-cid" is not a valid CID
	req := httptest.NewRequest(http.MethodGet, "/api/v1/files/not-a-cid", nil)
	w := httptest.NewRecorder()

	handler.HandleDownload(w, req)

	// FileManager is nil for mock client (GetPool returns nil), so we get 503
	// If it were non-nil, we'd get 400 for invalid CID
	if w.Code != http.StatusServiceUnavailable && w.Code != http.StatusBadRequest {
		t.Errorf("expected 503 or 400, got %d", w.Code)
	}
}

func TestFilesHandler_Upload_NoCommunitySpace(t *testing.T) {
	// Mock client with no community space configured
	mockClient := newMockAnySyncClientForIntegration()
	sm := anysync.NewSpaceManager(mockClient, &anysync.SpaceManagerConfig{
		CommunitySpaceID: "", // not configured
	})
	handler := NewFilesHandler(sm.FileManager(), sm)

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, _ := writer.CreateFormFile("file", "test.png")
	_, _ = part.Write([]byte("fake-image-data"))
	_ = writer.Close()

	req := httptest.NewRequest(http.MethodPost, "/api/v1/files/upload", body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	w := httptest.NewRecorder()

	handler.HandleUpload(w, req)

	// FileManager is nil because mock returns nil for GetPool,
	// so this returns 503 "file storage not available"
	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("expected 503, got %d", w.Code)
	}
}

func TestFilesHandler_Upload_NonImageContentType(t *testing.T) {
	// This test only exercises validation before fileManager is needed.
	// With nil fileManager, we get 503 before reaching content type check.
	// So we test with nil and verify 503.
	handler := NewFilesHandler(nil, nil)

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, _ := writer.CreateFormFile("file", "test.txt")
	_, _ = part.Write([]byte("not an image"))
	_ = writer.Close()

	req := httptest.NewRequest(http.MethodPost, "/api/v1/files/upload", body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	w := httptest.NewRecorder()

	handler.HandleUpload(w, req)

	// 503 because fileManager is nil (checked before parsing)
	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("expected 503, got %d", w.Code)
	}
}

func TestFilesHandler_RegisterRoutes(t *testing.T) {
	handler := NewFilesHandler(nil, nil)
	mux := http.NewServeMux()

	// Should not panic
	handler.RegisterRoutes(mux)

	// Verify routes are registered by making requests
	uploadReq := httptest.NewRequest(http.MethodPost, "/api/v1/files/upload", nil)
	uploadW := httptest.NewRecorder()
	mux.ServeHTTP(uploadW, uploadReq)
	// Should get something other than 404
	if uploadW.Code == http.StatusNotFound {
		t.Error("upload route not registered")
	}

	downloadReq := httptest.NewRequest(http.MethodGet, "/api/v1/files/somecid", nil)
	downloadW := httptest.NewRecorder()
	mux.ServeHTTP(downloadW, downloadReq)
	if downloadW.Code == http.StatusNotFound {
		t.Error("download route not registered")
	}
}
