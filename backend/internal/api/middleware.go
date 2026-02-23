package api

import (
	"log"
	"net"
	"net/http"
	"os"
	"strings"
)

// isBundledOrigin returns true if the origin is a valid bundled-app origin
// (Electron file://, Capacitor, or any localhost/127.0.0.1).
func isBundledOrigin(origin string) bool {
	if origin == "" {
		return false
	}
	if strings.HasPrefix(origin, "file://") ||
		strings.HasPrefix(origin, "capacitor://") ||
		strings.HasPrefix(origin, "app://") ||
		strings.HasPrefix(origin, "http://localhost:") ||
		strings.HasPrefix(origin, "http://127.0.0.1:") {
		return true
	}
	return false
}

// isAllowedOrigin checks whether the origin should get CORS headers,
// respecting the MATOU_CORS_MODE env var ("bundled" or default "dev").
func isAllowedOrigin(origin string) bool {
	mode := os.Getenv("MATOU_CORS_MODE")
	if mode == "bundled" {
		return isBundledOrigin(origin)
	}

	// Default dev mode: fixed list
	devOrigins := []string{
		"http://localhost:9000",  // Quasar dev server
		"http://localhost:9300",  // Electron dev server
		"http://127.0.0.1:9000",
		"http://127.0.0.1:9300",
	}
	for _, allowed := range devOrigins {
		if origin == allowed {
			return true
		}
	}

	// Also allow any localhost in dev (convenient for dynamic ports)
	if strings.HasPrefix(origin, "http://localhost:") || strings.HasPrefix(origin, "http://127.0.0.1:") {
		return true
	}

	return false
}

// CORSMiddleware adds CORS headers for frontend development and bundled apps.
// Controlled by MATOU_CORS_MODE env var: "dev" (default) or "bundled".
func CORSMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")

		if isAllowedOrigin(origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
		}

		// Allow common headers and methods
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Accept, Content-Type, Content-Length, Accept-Encoding, Authorization, X-Requested-With")
		w.Header().Set("Access-Control-Max-Age", "86400")

		// Handle preflight requests
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}

		// Limit request body size to prevent memory exhaustion attacks.
		if r.Body != nil {
			r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodySize)
		}

		next.ServeHTTP(w, r)
	})
}

// maxRequestBodySize limits request body size to prevent memory exhaustion (10 MB).
const maxRequestBodySize = 10 << 20

// CORSHandler wraps a handler function with CORS support and body size limits.
func CORSHandler(handler http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")

		if isAllowedOrigin(origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
		}

		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Accept, Content-Type, Content-Length, Accept-Encoding, Authorization, X-Requested-With")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}

		// Limit request body size to prevent memory exhaustion attacks.
		if r.Body != nil {
			r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodySize)
		}

		handler(w, r)
	}
}

// NewCORSMux creates a new ServeMux wrapped with CORS middleware
func NewCORSMux() *CORSMux {
	return &CORSMux{
		mux: http.NewServeMux(),
	}
}

// CORSMux is a ServeMux wrapper that adds CORS headers
type CORSMux struct {
	mux *http.ServeMux
}

// HandleFunc registers a handler with CORS support
func (m *CORSMux) HandleFunc(pattern string, handler http.HandlerFunc) {
	m.mux.HandleFunc(pattern, CORSHandler(handler))
}

// Handle registers a handler with CORS support
func (m *CORSMux) Handle(pattern string, handler http.Handler) {
	m.mux.Handle(pattern, CORSMiddleware(handler))
}

// ServeHTTP implements http.Handler
func (m *CORSMux) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Add CORS headers to all responses
	origin := r.Header.Get("Origin")
	if isAllowedOrigin(origin) {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Accept, Content-Type, Content-Length, Accept-Encoding, Authorization, X-Requested-With")
	}

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	// Limit request body size to prevent memory exhaustion attacks.
	if r.Body != nil {
		r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodySize)
	}

	m.mux.ServeHTTP(w, r)
}

// LocalhostGuard rejects non-loopback requests when MATOU_CORS_MODE=bundled.
// The Matou backend is designed to run as a local child process of the Electron
// app and has no authentication layer. This middleware ensures that in production
// (bundled) mode, only requests originating from localhost are accepted.
// In dev/test mode this middleware is a no-op.
func LocalhostGuard(next http.Handler) http.Handler {
	mode := os.Getenv("MATOU_CORS_MODE")
	if mode != "bundled" {
		return next // no-op in dev/test
	}

	log.Println("[Security] Localhost guard ACTIVE (MATOU_CORS_MODE=bundled)")

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			http.Error(w, "Forbidden", http.StatusForbidden)
			return
		}

		ip := net.ParseIP(host)
		if ip == nil || !ip.IsLoopback() {
			http.Error(w, "Forbidden", http.StatusForbidden)
			return
		}

		next.ServeHTTP(w, r)
	})
}
