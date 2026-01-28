package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCORSMiddleware_AllowedOrigin(t *testing.T) {
	allowedOrigins := []string{
		"http://localhost:9000",
		"http://localhost:9300",
		"http://127.0.0.1:9000",
		"http://127.0.0.1:9300",
	}

	for _, origin := range allowedOrigins {
		t.Run(origin, func(t *testing.T) {
			handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusOK)
			})

			wrapped := CORSMiddleware(handler)

			req := httptest.NewRequest(http.MethodGet, "/test", nil)
			req.Header.Set("Origin", origin)
			w := httptest.NewRecorder()

			wrapped.ServeHTTP(w, req)

			corsHeader := w.Header().Get("Access-Control-Allow-Origin")
			if corsHeader != origin {
				t.Errorf("expected CORS header %s, got %s", origin, corsHeader)
			}
		})
	}
}

func TestCORSMiddleware_DisallowedOrigin(t *testing.T) {
	disallowedOrigins := []string{
		"http://example.com",
		"http://localhost:8080",
		"https://malicious-site.com",
		"",
	}

	for _, origin := range disallowedOrigins {
		t.Run(origin, func(t *testing.T) {
			handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusOK)
			})

			wrapped := CORSMiddleware(handler)

			req := httptest.NewRequest(http.MethodGet, "/test", nil)
			if origin != "" {
				req.Header.Set("Origin", origin)
			}
			w := httptest.NewRecorder()

			wrapped.ServeHTTP(w, req)

			corsHeader := w.Header().Get("Access-Control-Allow-Origin")
			if corsHeader == origin && origin != "" {
				t.Errorf("should not set CORS header for origin %s", origin)
			}
		})
	}
}

func TestCORSMiddleware_PreflightRequest(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("should not reach here"))
	})

	wrapped := CORSMiddleware(handler)

	req := httptest.NewRequest(http.MethodOptions, "/test", nil)
	req.Header.Set("Origin", "http://localhost:9000")
	w := httptest.NewRecorder()

	wrapped.ServeHTTP(w, req)

	// Should return 200 for OPTIONS
	if w.Code != http.StatusOK {
		t.Errorf("expected status 200 for preflight, got %d", w.Code)
	}

	// Should not have body (handler not called)
	if w.Body.Len() > 0 {
		t.Error("preflight response should not have body")
	}

	// Should have CORS headers
	if w.Header().Get("Access-Control-Allow-Methods") == "" {
		t.Error("should have Access-Control-Allow-Methods header")
	}

	if w.Header().Get("Access-Control-Allow-Headers") == "" {
		t.Error("should have Access-Control-Allow-Headers header")
	}
}

func TestCORSMiddleware_PassesToHandler(t *testing.T) {
	handlerCalled := false
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handlerCalled = true
		w.WriteHeader(http.StatusOK)
	})

	wrapped := CORSMiddleware(handler)

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	req.Header.Set("Origin", "http://localhost:9000")
	w := httptest.NewRecorder()

	wrapped.ServeHTTP(w, req)

	if !handlerCalled {
		t.Error("handler should have been called")
	}
}

func TestCORSHandler_AllowedOrigin(t *testing.T) {
	handler := func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}

	wrapped := CORSHandler(handler)

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	req.Header.Set("Origin", "http://localhost:9000")
	w := httptest.NewRecorder()

	wrapped(w, req)

	corsHeader := w.Header().Get("Access-Control-Allow-Origin")
	if corsHeader != "http://localhost:9000" {
		t.Errorf("expected CORS header http://localhost:9000, got %s", corsHeader)
	}
}

func TestCORSHandler_PreflightRequest(t *testing.T) {
	handlerCalled := false
	handler := func(w http.ResponseWriter, r *http.Request) {
		handlerCalled = true
		w.WriteHeader(http.StatusOK)
	}

	wrapped := CORSHandler(handler)

	req := httptest.NewRequest(http.MethodOptions, "/test", nil)
	req.Header.Set("Origin", "http://localhost:9000")
	w := httptest.NewRecorder()

	wrapped(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", w.Code)
	}

	if handlerCalled {
		t.Error("handler should not be called for OPTIONS")
	}
}

func TestNewCORSMux(t *testing.T) {
	mux := NewCORSMux()
	if mux == nil {
		t.Fatal("expected non-nil mux")
	}

	if mux.mux == nil {
		t.Error("expected non-nil inner mux")
	}
}

func TestCORSMux_HandleFunc(t *testing.T) {
	mux := NewCORSMux()

	handlerCalled := false
	mux.HandleFunc("/test", func(w http.ResponseWriter, r *http.Request) {
		handlerCalled = true
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	req.Header.Set("Origin", "http://localhost:9000")
	w := httptest.NewRecorder()

	mux.ServeHTTP(w, req)

	if !handlerCalled {
		t.Error("handler should have been called")
	}

	corsHeader := w.Header().Get("Access-Control-Allow-Origin")
	if corsHeader != "http://localhost:9000" {
		t.Errorf("expected CORS header, got %s", corsHeader)
	}
}

func TestCORSMux_Handle(t *testing.T) {
	mux := NewCORSMux()

	handlerCalled := false
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handlerCalled = true
		w.WriteHeader(http.StatusOK)
	})

	mux.Handle("/test", handler)

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	req.Header.Set("Origin", "http://localhost:9000")
	w := httptest.NewRecorder()

	mux.ServeHTTP(w, req)

	if !handlerCalled {
		t.Error("handler should have been called")
	}
}

func TestCORSMux_ServeHTTP_PreflightOptions(t *testing.T) {
	mux := NewCORSMux()

	mux.HandleFunc("/test", func(w http.ResponseWriter, r *http.Request) {
		t.Error("handler should not be called for OPTIONS")
	})

	req := httptest.NewRequest(http.MethodOptions, "/test", nil)
	req.Header.Set("Origin", "http://localhost:9000")
	w := httptest.NewRecorder()

	mux.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", w.Code)
	}
}

func TestCORSMux_ServeHTTP_AllowsLocalhost(t *testing.T) {
	mux := NewCORSMux()

	mux.HandleFunc("/test", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	testCases := []struct {
		origin   string
		expected bool
	}{
		{"http://localhost:9000", true},
		{"http://localhost:9300", true},
		{"http://localhost:8080", true}, // CORSMux allows any localhost
		{"http://127.0.0.1:9000", true},
		{"http://example.com", false},
	}

	for _, tc := range testCases {
		t.Run(tc.origin, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/test", nil)
			req.Header.Set("Origin", tc.origin)
			w := httptest.NewRecorder()

			mux.ServeHTTP(w, req)

			corsHeader := w.Header().Get("Access-Control-Allow-Origin")
			hasHeader := corsHeader == tc.origin

			if tc.expected && !hasHeader {
				t.Errorf("expected CORS header for %s", tc.origin)
			}
			if !tc.expected && hasHeader {
				t.Errorf("should not have CORS header for %s", tc.origin)
			}
		})
	}
}

func TestCORSMiddleware_MaxAge(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	wrapped := CORSMiddleware(handler)

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	req.Header.Set("Origin", "http://localhost:9000")
	w := httptest.NewRecorder()

	wrapped.ServeHTTP(w, req)

	maxAge := w.Header().Get("Access-Control-Max-Age")
	if maxAge != "86400" {
		t.Errorf("expected max-age 86400, got %s", maxAge)
	}
}

func TestCORSMiddleware_AllowedMethods(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	wrapped := CORSMiddleware(handler)

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	req.Header.Set("Origin", "http://localhost:9000")
	w := httptest.NewRecorder()

	wrapped.ServeHTTP(w, req)

	methods := w.Header().Get("Access-Control-Allow-Methods")
	expectedMethods := []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"}

	for _, method := range expectedMethods {
		if !containsMethod(methods, method) {
			t.Errorf("expected %s in allowed methods", method)
		}
	}
}

func TestCORSMiddleware_AllowedHeaders(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	wrapped := CORSMiddleware(handler)

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	req.Header.Set("Origin", "http://localhost:9000")
	w := httptest.NewRecorder()

	wrapped.ServeHTTP(w, req)

	headers := w.Header().Get("Access-Control-Allow-Headers")
	expectedHeaders := []string{"Accept", "Content-Type", "Authorization"}

	for _, header := range expectedHeaders {
		if !containsMethod(headers, header) {
			t.Errorf("expected %s in allowed headers", header)
		}
	}
}

// Helper function to check if a comma-separated string contains a value
func containsMethod(list, value string) bool {
	// Simple contains check - in production would parse properly
	return len(list) > 0 && (list == value || contains(list, value))
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > len(substr) && (s[:len(substr)] == substr || s[len(s)-len(substr):] == substr || containsMiddle(s, substr)))
}

func containsMiddle(s, substr string) bool {
	for i := 1; i < len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
