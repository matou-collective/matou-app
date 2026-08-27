package api

import (
	"net/http"
	"sync"
)

// ClientConfigHandler serves the full client config the embedded backend
// fetched from the config server, over the local loopback API.
//
// On Capacitor (Android) the WebView's cleartext-network policy only permits
// plain HTTP to 127.0.0.1/localhost, so the frontend cannot reach the
// plain-HTTP config server directly. The embedded Go backend is not subject to
// that policy and already fetches the same config at startup, so on Capacitor
// the frontend sources client config from this loopback endpoint instead of
// hitting the remote config server. See issue #99.
//
// The endpoint is a GET, so it is protected the same way as the rest of the
// read API: LocalhostGuard restricts it to loopback callers (TokenGuard only
// gates mutations). Non-Capacitor platforms (Electron, browser) never call it.
type ClientConfigHandler struct {
	mu  sync.RWMutex
	raw []byte // raw JSON body as fetched from the config server; nil until set
}

// NewClientConfigHandler creates a handler with no config retained yet. Call
// SetRaw once the backend has fetched the client config from the config server.
func NewClientConfigHandler() *ClientConfigHandler {
	return &ClientConfigHandler{}
}

// SetRaw stores the raw client-config JSON body fetched from the config server.
// Safe to call concurrently with request handling.
func (h *ClientConfigHandler) SetRaw(body []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.raw = body
}

// RegisterRoutes wires the client-config route onto the mux.
func (h *ClientConfigHandler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/v1/client-config", CORSHandler(h.handleGet))
}

func (h *ClientConfigHandler) handleGet(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	h.mu.RLock()
	raw := h.raw
	h.mu.RUnlock()

	if len(raw) == 0 {
		// The backend hasn't fetched (or failed to fetch) the client config —
		// e.g. dev/test where the anysync file already existed on disk so the
		// startup fetch was skipped. The frontend falls back to its own cache.
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "client config not available"})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(raw)
}
