package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sync"

	"gopkg.in/yaml.v3"
)

// OrgConfigHandler handles organization configuration endpoints.
// This consolidates org config into the backend, replacing the separate config server.
type OrgConfigHandler struct {
	configPath string
	mu         sync.RWMutex
	cache      *OrgConfigData
}

// OrgConfigData represents the organization configuration
type OrgConfigData struct {
	Organization OrgInfo     `json:"organization" yaml:"organization"`
	Admins       []AdminData `json:"admins" yaml:"admins,omitempty"`
	Registry     *Registry   `json:"registry,omitempty" yaml:"registry,omitempty"`

	// any-sync space IDs
	CommunitySpaceID string `json:"communitySpaceId,omitempty" yaml:"communitySpaceId,omitempty"`
	ReadOnlySpaceID  string `json:"readOnlySpaceId,omitempty" yaml:"readOnlySpaceId,omitempty"`
	AdminSpaceID     string `json:"adminSpaceId,omitempty" yaml:"adminSpaceId,omitempty"`

	Generated string `json:"generated,omitempty" yaml:"generated,omitempty"`
}

// OrgInfo holds organization identity info
type OrgInfo struct {
	AID  string `json:"aid" yaml:"aid"`
	Name string `json:"name" yaml:"name"`
	OOBI string `json:"oobi,omitempty" yaml:"oobi,omitempty"`
}

// AdminData holds admin identity info
type AdminData struct {
	AID  string `json:"aid" yaml:"aid"`
	Name string `json:"name" yaml:"name"`
	OOBI string `json:"oobi,omitempty" yaml:"oobi,omitempty"`
}

// Registry holds credential registry info
type Registry struct {
	ID   string `json:"id" yaml:"id"`
	Name string `json:"name" yaml:"name"`
}

// NewOrgConfigHandler creates a new org config handler
func NewOrgConfigHandler(dataDir string) *OrgConfigHandler {
	configPath := filepath.Join(dataDir, "org-config.yaml")
	h := &OrgConfigHandler{
		configPath: configPath,
	}
	// Try to load existing config
	h.loadFromDisk()
	return h
}

// loadFromDisk loads config from disk into cache
func (h *OrgConfigHandler) loadFromDisk() {
	h.mu.Lock()
	defer h.mu.Unlock()

	data, err := os.ReadFile(h.configPath)
	if err != nil {
		// No config file yet
		return
	}

	var config OrgConfigData
	if err := yaml.Unmarshal(data, &config); err != nil {
		fmt.Printf("[OrgConfig] Failed to parse config: %v\n", err)
		return
	}

	h.cache = &config
	fmt.Printf("[OrgConfig] Loaded config for: %s\n", config.Organization.Name)
}

// saveToDisk writes config to disk
func (h *OrgConfigHandler) saveToDisk() error {
	// Ensure directory exists
	dir := filepath.Dir(h.configPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("creating config directory: %w", err)
	}

	data, err := yaml.Marshal(h.cache)
	if err != nil {
		return fmt.Errorf("marshaling config: %w", err)
	}

	if err := os.WriteFile(h.configPath, data, 0644); err != nil {
		return fmt.Errorf("writing config file: %w", err)
	}

	return nil
}

// HandleGetConfig handles GET /api/v1/org/config
func (h *OrgConfigHandler) HandleGetConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{
			"error": "method not allowed",
		})
		return
	}

	h.mu.RLock()
	config := h.cache
	h.mu.RUnlock()

	if config == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{
			"error": "organization not configured",
		})
		return
	}

	writeJSON(w, http.StatusOK, config)
}

// HandleSaveConfig handles POST /api/v1/org/config
func (h *OrgConfigHandler) HandleSaveConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{
			"error": "method not allowed",
		})
		return
	}

	var config OrgConfigData
	if err := json.NewDecoder(r.Body).Decode(&config); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf("invalid request: %v", err),
		})
		return
	}

	// Validate required fields
	if config.Organization.AID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "organization.aid is required",
		})
		return
	}
	if config.Organization.Name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "organization.name is required",
		})
		return
	}

	h.mu.Lock()
	h.cache = &config
	err := h.saveToDisk()
	h.mu.Unlock()

	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to save config: %v", err),
		})
		return
	}

	fmt.Printf("[OrgConfig] Saved config for: %s\n", config.Organization.Name)
	writeJSON(w, http.StatusOK, map[string]string{
		"status": "saved",
	})
}

// HandleHealth handles GET /api/v1/org/health
func (h *OrgConfigHandler) HandleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{
			"error": "method not allowed",
		})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{
		"status": "ok",
	})
}

// RegisterRoutes registers org config routes on the mux
func (h *OrgConfigHandler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/v1/org/config", CORSHandler(h.handleConfig))
	mux.HandleFunc("/api/v1/org/health", CORSHandler(h.HandleHealth))
}

// handleConfig routes to Get (GET) or Save (POST)
func (h *OrgConfigHandler) handleConfig(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.HandleGetConfig(w, r)
	case http.MethodPost:
		h.HandleSaveConfig(w, r)
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{
			"error": "method not allowed",
		})
	}
}

// GetConfig returns the current config (for use by other handlers)
func (h *OrgConfigHandler) GetConfig() *OrgConfigData {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.cache
}
