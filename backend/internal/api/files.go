package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/anyproto/any-sync/util/crypto"
	"github.com/ipfs/go-cid"
	"github.com/matou-dao/backend/internal/anysync"
)

const maxFileSize = 5 << 20 // 5 MB

// FilesHandler handles file upload and download using the any-sync filenode.
// Files are chunked into IPFS UnixFS DAG blocks, pushed to the filenode via
// dRPC, and metadata is persisted in the community space's ObjectTree for P2P sync.
type FilesHandler struct {
	fileManager  *anysync.FileManager
	spaceManager *anysync.SpaceManager
}

// NewFilesHandler creates a new files handler backed by the filenode.
func NewFilesHandler(fileManager *anysync.FileManager, spaceManager *anysync.SpaceManager) *FilesHandler {
	return &FilesHandler{
		fileManager:  fileManager,
		spaceManager: spaceManager,
	}
}

// HandleUpload handles POST /api/v1/files/upload
// Accepts multipart file upload (image/*, max 5MB).
// Returns a fileRef (CID string) that can be stored in profile objects.
func (h *FilesHandler) HandleUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	if h.fileManager == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "file storage not available (filenode not configured)",
		})
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxFileSize+1024) // extra for form overhead

	if err := r.ParseMultipartForm(maxFileSize); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf("file too large or invalid form: %v", err),
		})
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf("missing file field: %v", err),
		})
		return
	}
	defer file.Close()

	// Validate content type
	contentType := header.Header.Get("Content-Type")
	if !strings.HasPrefix(contentType, "image/") {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "only image files are accepted",
		})
		return
	}

	// Read file content (need to know size for metadata)
	data, err := io.ReadAll(io.LimitReader(file, maxFileSize+1))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to read file: %v", err),
		})
		return
	}
	if len(data) > maxFileSize {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "file exceeds 5MB limit",
		})
		return
	}

	// Determine target space (community space)
	spaceID := h.spaceManager.GetCommunitySpaceID()
	if spaceID == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "community space not configured",
		})
		return
	}

	// Load signing key for the space
	signingKey := h.spaceManager.GetClient().GetSigningKey()

	// Upload to filenode
	fileRef, err := h.fileManager.AddFile(
		r.Context(),
		spaceID,
		bytes.NewReader(data),
		contentType,
		int64(len(data)),
		signingKey,
	)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to upload file: %v", err),
		})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{
		"fileRef":     fileRef,
		"contentType": contentType,
		"size":        fmt.Sprintf("%d", len(data)),
	})
}

// HandleDownload handles GET /api/v1/files/{ref}
// Returns the file bytes with appropriate Content-Type.
func (h *FilesHandler) HandleDownload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	if h.fileManager == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "file storage not available (filenode not configured)",
		})
		return
	}

	// Extract file ref from URL path
	path := r.URL.Path
	ref := strings.TrimPrefix(path, "/api/v1/files/")
	if ref == "" || ref == path {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "fileRef is required"})
		return
	}

	// Validate ref is a valid CID
	if _, err := cid.Decode(ref); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid fileRef (not a valid CID)"})
		return
	}

	// Determine target space
	spaceID := h.spaceManager.GetCommunitySpaceID()
	if spaceID == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "community space not configured",
		})
		return
	}

	// Fetch from filenode
	reader, contentType, err := h.fileManager.GetFile(r.Context(), spaceID, ref)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{
			"error": fmt.Sprintf("file not found: %v", err),
		})
		return
	}
	defer reader.Close()

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.WriteHeader(http.StatusOK)
	io.Copy(w, reader)
}

// uploadBase64Avatar decodes base64-encoded image data and uploads it to the
// filenode. Returns the content-addressed fileRef (CID) on success.
// This is used as a fallback when the normal file upload couldn't run because
// the community space didn't exist yet (e.g. during onboarding).
// Retries with backoff because the filenode peer pool may not be connected yet
// after an SDK reinit (which happens during identity setup just before this).
func uploadBase64Avatar(ctx context.Context, fileManager *anysync.FileManager, spaceID string, signingKey crypto.PrivKey, base64Data string, mimeType string) (string, error) {
	if fileManager == nil {
		return "", fmt.Errorf("file manager not available")
	}
	if spaceID == "" {
		return "", fmt.Errorf("space ID is required")
	}

	if mimeType == "" {
		mimeType = "image/png"
	}
	if !strings.HasPrefix(mimeType, "image/") {
		return "", fmt.Errorf("only image files are accepted, got %s", mimeType)
	}

	data, err := base64.StdEncoding.DecodeString(base64Data)
	if err != nil {
		return "", fmt.Errorf("failed to decode base64 data: %w", err)
	}

	if len(data) > maxFileSize {
		return "", fmt.Errorf("decoded image exceeds %d byte limit", maxFileSize)
	}

	const maxAttempts = 5
	var lastErr error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		fileRef, err := fileManager.AddFile(
			ctx,
			spaceID,
			bytes.NewReader(data),
			mimeType,
			int64(len(data)),
			signingKey,
		)
		if err == nil {
			return fileRef, nil
		}
		lastErr = err
		if attempt < maxAttempts {
			delay := time.Duration(attempt) * 2 * time.Second
			fmt.Printf("[uploadBase64Avatar] attempt %d/%d failed: %v — retrying in %v\n", attempt, maxAttempts, err, delay)
			select {
			case <-time.After(delay):
			case <-ctx.Done():
				return "", ctx.Err()
			}
		}
	}

	return "", fmt.Errorf("failed to upload avatar after %d attempts: %w", maxAttempts, lastErr)
}

// RegisterRoutes registers file routes on the mux.
func (h *FilesHandler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/v1/files/upload", h.HandleUpload)
	mux.HandleFunc("/api/v1/files/", h.HandleDownload)
}
