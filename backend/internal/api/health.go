package api

import (
	"context"
	"net/http"

	"github.com/matou-dao/backend/internal/anysync"
	"github.com/matou-dao/backend/internal/anystore"
	"github.com/matou-dao/backend/internal/trust"
)

// HealthHandler handles health check related HTTP requests
type HealthHandler struct {
	store      *anystore.LocalStore
	spaceStore anysync.SpaceStore
	orgAID     string
	adminAID   string
}

// NewHealthHandler creates a new health handler
func NewHealthHandler(
	store *anystore.LocalStore,
	spaceStore anysync.SpaceStore,
	orgAID string,
	adminAID string,
) *HealthHandler {
	return &HealthHandler{
		store:      store,
		spaceStore: spaceStore,
		orgAID:     orgAID,
		adminAID:   adminAID,
	}
}

// HealthResponse represents the health check response
type HealthResponse struct {
	Status       string       `json:"status"`
	Organization string       `json:"organization"`
	Admin        string       `json:"admin"`
	Sync         *SyncStatus  `json:"sync,omitempty"`
	Trust        *TrustStatus `json:"trust,omitempty"`
}

// SyncStatus represents sync-related statistics
type SyncStatus struct {
	CredentialsCached int `json:"credentialsCached"`
	SpacesCreated     int `json:"spacesCreated"`
	KELEventsStored   int `json:"kelEventsStored"`
}

// TrustStatus represents trust graph statistics
type TrustStatus struct {
	TotalNodes   int     `json:"totalNodes"`
	TotalEdges   int     `json:"totalEdges"`
	AverageScore float64 `json:"averageScore"`
}

// HandleHealth handles GET /health
func (h *HealthHandler) HandleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{
			"error": "method not allowed",
		})
		return
	}

	ctx := context.Background()

	// Basic health response
	response := HealthResponse{
		Status:       "healthy",
		Organization: h.orgAID,
		Admin:        h.adminAID,
	}

	// Get sync status
	syncStatus := h.getSyncStatus(ctx)
	if syncStatus != nil {
		response.Sync = syncStatus
	}

	// Get trust status
	trustStatus := h.getTrustStatus(ctx)
	if trustStatus != nil {
		response.Trust = trustStatus
	}

	writeJSON(w, http.StatusOK, response)
}

// getSyncStatus retrieves sync statistics from the store
func (h *HealthHandler) getSyncStatus(ctx context.Context) *SyncStatus {
	status := &SyncStatus{}

	// Count credentials
	credCount, err := h.store.CountCredentials(ctx)
	if err == nil {
		status.CredentialsCached = credCount
	}

	// Count spaces
	if h.spaceStore != nil {
		spaces, err := h.spaceStore.ListAllSpaces(ctx)
		if err == nil {
			status.SpacesCreated = len(spaces)
		}
	}

	// Count KEL events
	kelCount, err := h.store.CountKELEvents(ctx)
	if err == nil {
		status.KELEventsStored = kelCount
	}

	return status
}

// getTrustStatus calculates trust graph statistics
func (h *HealthHandler) getTrustStatus(ctx context.Context) *TrustStatus {
	builder := trust.NewBuilder(h.store, h.orgAID)
	graph, err := builder.Build(ctx)
	if err != nil {
		return nil
	}

	calculator := trust.NewDefaultCalculator()
	summary := calculator.CalculateSummary(graph)

	return &TrustStatus{
		TotalNodes:   summary.TotalNodes,
		TotalEdges:   summary.TotalEdges,
		AverageScore: summary.AverageScore,
	}
}
