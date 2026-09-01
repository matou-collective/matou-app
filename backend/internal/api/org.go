package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"gopkg.in/yaml.v3"

	"github.com/matou-dao/backend/internal/contributions"
)

// OrgConfigHandler handles organization configuration endpoints.
// This consolidates org config into the backend, replacing the separate config server.
// It is the single source of truth for organization identity.
type OrgConfigHandler struct {
	configPath string
	mu         sync.RWMutex
	cache      *OrgConfigData
	onUpdate   func(*OrgConfigData) // Callback when config is updated
	roleLookup RoleLookup           // nil = RBAC disabled (tests only)

	// Config-server fallback for a cache miss (issue #265). On a fresh mobile
	// install the WebView cannot reach the remote plain-http config server
	// (mixed content on both Android and iOS), so the embedded backend fetches
	// org config from the config server server-side and serves it here — the
	// same treatment #99 gave client config. Populated by SetConfigServerSource;
	// when csURL is empty the fallback is disabled and a cache miss stays a 404
	// (dev/test/desktop, where the frontend can reach the config server itself).
	csClient *http.Client
	csURL    string
	csIsTest bool
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

// AddOnUpdate chains an additional callback that fires when org config is updated.
func (h *OrgConfigHandler) AddOnUpdate(fn func(*OrgConfigData)) {
	prev := h.onUpdate
	h.onUpdate = func(data *OrgConfigData) {
		if prev != nil {
			prev(data)
		}
		fn(data)
	}
}

// NewOrgConfigHandler creates a new org config handler
func NewOrgConfigHandler(dataDir string, onUpdate func(*OrgConfigData)) *OrgConfigHandler {
	configPath := filepath.Join(dataDir, "org-config.yaml")
	h := &OrgConfigHandler{
		configPath: configPath,
		onUpdate:   onUpdate,
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
		log.Printf("[OrgConfig] Failed to parse config: %v\n", err)
		return
	}

	h.cache = &config
	log.Printf("[OrgConfig] Loaded config for: %s\n", config.Organization.Name)
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

// SetConfigServerSource configures the config-server fallback used on a cache
// miss (issue #265). An empty url disables the fallback. Safe to call before
// the server starts serving. A nil client falls back to http.DefaultClient.
func (h *OrgConfigHandler) SetConfigServerSource(client *http.Client, url string, isTest bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.csClient = client
	h.csURL = url
	h.csIsTest = isTest
}

// HandleGetConfig handles GET /api/v1/org/config
func (h *OrgConfigHandler) HandleGetConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{
			"error": "Method not allowed",
		})
		return
	}

	h.mu.RLock()
	config := h.cache
	csClient, csURL, csIsTest := h.csClient, h.csURL, h.csIsTest
	h.mu.RUnlock()

	// Cache miss: fetch org config from the config server server-side so the
	// WebView never has to reach the remote plain-http host directly (issue
	// #265; mirrors the #99 client-config flow). The result is cached in
	// memory; the config server remains the source of truth. A 404 from the
	// config server (org genuinely not configured yet) is not an error — the
	// handler stays a 404 so first-run org creation still bootstraps.
	if config == nil && csURL != "" {
		fetched, err := FetchFromConfigServer(csClient, csURL, csIsTest)
		if err != nil {
			log.Printf("[OrgConfig] config-server fallback fetch failed: %v", err)
		} else if fetched != nil {
			h.mu.Lock()
			h.cache = fetched
			h.mu.Unlock()
			config = fetched
			log.Printf("[OrgConfig] Sourced config from config server for: %s\n", fetched.Organization.Name)
		}
	}

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
			"error": "Method not allowed",
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
	onUpdate := h.onUpdate
	h.mu.Unlock()

	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to save config: %v", err),
		})
		return
	}

	// Notify listeners that config was updated
	if onUpdate != nil {
		onUpdate(&config)
	}

	log.Printf("[OrgConfig] Saved config for: %s\n", config.Organization.Name)
	writeJSON(w, http.StatusOK, map[string]string{
		"status": "saved",
	})
}

// HandleHealth handles GET /api/v1/org/health
func (h *OrgConfigHandler) HandleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{
			"error": "Method not allowed",
		})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{
		"status": "ok",
	})
}

// RegisterRoutes registers org config routes on the mux.
// roleLookup gates the mutating routes (POST/DELETE /api/v1/org/config) once
// an org is configured; pass nil to skip auth (tests only).
func (h *OrgConfigHandler) RegisterRoutes(mux *http.ServeMux, roleLookup RoleLookup) {
	requireRoleLookup("OrgConfigHandler", roleLookup)
	h.roleLookup = roleLookup
	mux.HandleFunc("/api/v1/org/config", CORSHandler(h.handleConfig))
	mux.HandleFunc("/api/v1/org/health", CORSHandler(h.HandleHealth))
}

// withBootstrapRBAC applies the bootstrap rule for org-config writes:
//
//   - No org configured yet (first-run setup): the request is allowed
//     without X-User-AID — there are no roles to check against, and the
//     admin AID that will resolve to Founding Member is defined by this very
//     write.
//   - Org configured: the caller must authenticate and hold
//     ActionSaveOrgConfig (Operations Steward / Founding Member). The admins
//     list in the config is a role grant (OrgConfigAdminLookup maps it to
//     Founding Member), so rewriting it is treated like a role change.
//
// The configured/not-configured check is evaluated per request so the gate
// closes the moment the first config is saved.
func (h *OrgConfigHandler) withBootstrapRBAC(handler http.HandlerFunc) http.HandlerFunc {
	if h.roleLookup == nil {
		return handler
	}
	return func(w http.ResponseWriter, r *http.Request) {
		if !h.IsConfigured() {
			log.Printf("[OrgConfig] bootstrap: accepting %s %s without RBAC (no org configured yet)", r.Method, r.URL.Path)
			handler(w, r)
			return
		}
		RBACMiddleware(h.roleLookup, RequireAction(contributions.ActionSaveOrgConfig, handler))(w, r)
	}
}

// handleConfig routes to Get (GET), Save (POST), or Delete (DELETE)
func (h *OrgConfigHandler) handleConfig(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.HandleGetConfig(w, r)
	case http.MethodPost:
		h.withBootstrapRBAC(h.HandleSaveConfig)(w, r)
	case http.MethodDelete:
		h.withBootstrapRBAC(h.HandleDeleteConfig)(w, r)
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{
			"error": "Method not allowed",
		})
	}
}

// HandleDeleteConfig handles DELETE /api/v1/org/config
// Used by tests to clear org config for fresh setup
func (h *OrgConfigHandler) HandleDeleteConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{
			"error": "Method not allowed",
		})
		return
	}

	h.mu.Lock()
	h.cache = nil
	// Remove config file
	err := os.Remove(h.configPath)
	h.mu.Unlock()

	if err != nil && !os.IsNotExist(err) {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to delete config: %v", err),
		})
		return
	}

	log.Println("[OrgConfig] Deleted org config")
	writeJSON(w, http.StatusOK, map[string]string{
		"status": "deleted",
	})
}

// GetConfig returns the current config (for use by other handlers)
func (h *OrgConfigHandler) GetConfig() *OrgConfigData {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.cache
}

// IsConfigured returns true if organization is configured
func (h *OrgConfigHandler) IsConfigured() bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.cache != nil && h.cache.Organization.AID != ""
}

// GetOrgAID returns the organization AID, or empty string if not configured
func (h *OrgConfigHandler) GetOrgAID() string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if h.cache == nil {
		return ""
	}
	return h.cache.Organization.AID
}

// GetOrgName returns the organization name, or empty string if not configured
func (h *OrgConfigHandler) GetOrgName() string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if h.cache == nil {
		return ""
	}
	return h.cache.Organization.Name
}

// GetAdminAID returns the first admin's AID, or empty string if not configured
func (h *OrgConfigHandler) GetAdminAID() string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if h.cache == nil || len(h.cache.Admins) == 0 {
		return ""
	}
	return h.cache.Admins[0].AID
}

// GetCommunitySpaceID returns the community space ID, or empty string if not configured
func (h *OrgConfigHandler) GetCommunitySpaceID() string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if h.cache == nil {
		return ""
	}
	return h.cache.CommunitySpaceID
}

// MirrorToConfigServer POSTs orgData to the legacy config server's
// /api/config endpoint, authenticated with its admin bearer token. This
// exists for backward compatibility with clients that still read the config
// server directly (e.g. multi-session dev) - OrgConfigHandler, not the
// config server, is the source of truth for org config.
//
// A conflict response (config server already holds a config, e.g. from
// before this backend existed) is treated as success: there is nothing to
// reconcile automatically. An empty token means mirroring is disabled and
// this is a no-op.
func MirrorToConfigServer(httpClient *http.Client, configServerURL, token string, isTest bool, orgData *OrgConfigData) error {
	if token == "" {
		return nil
	}

	body, err := json.Marshal(orgData)
	if err != nil {
		return fmt.Errorf("marshaling org config: %w", err)
	}

	req, err := http.NewRequest(http.MethodPost, strings.TrimRight(configServerURL, "/")+"/api/config", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("building request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	if isTest {
		req.Header.Set("X-Test-Config", "true")
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("request: %w", err)
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusOK, http.StatusConflict:
		return nil
	default:
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("config server returned %d: %s", resp.StatusCode, respBody)
	}
}

// FetchFromConfigServer GETs org config from the legacy config server's
// /api/config endpoint and decodes it. It is the read counterpart to
// MirrorToConfigServer, used by HandleGetConfig on a cache miss so the WebView
// never has to reach the plain-http config server directly (issue #265).
//
// A 404 (config server reachable but no org configured yet) returns (nil, nil)
// — a valid "no config" answer, not an error. Any other non-200 or a transport
// failure returns an error. A nil client uses http.DefaultClient.
func FetchFromConfigServer(httpClient *http.Client, configServerURL string, isTest bool) (*OrgConfigData, error) {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}

	req, err := http.NewRequest(http.MethodGet, strings.TrimRight(configServerURL, "/")+"/api/config", nil)
	if err != nil {
		return nil, fmt.Errorf("building request: %w", err)
	}
	if isTest {
		req.Header.Set("X-Test-Config", "true")
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request: %w", err)
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusOK:
		var orgData OrgConfigData
		if err := json.NewDecoder(resp.Body).Decode(&orgData); err != nil {
			return nil, fmt.Errorf("decoding org config: %w", err)
		}
		return &orgData, nil
	case http.StatusNotFound:
		return nil, nil
	default:
		respBody, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("config server returned %d: %s", resp.StatusCode, respBody)
	}
}
