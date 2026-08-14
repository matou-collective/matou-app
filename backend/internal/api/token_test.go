package api

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestBearerToken(t *testing.T) {
	cases := []struct {
		header string
		want   string
	}{
		{"Bearer abc123", "abc123"},
		{"bearer abc123", "abc123"}, // case-insensitive scheme
		{"Bearer   spaced  ", "spaced"},
		{"", ""},
		{"abc123", ""},       // no scheme
		{"Basic abc123", ""}, // wrong scheme
		{"Bearer", ""},       // no token
		{"Bearer ", ""},      // empty token
	}
	for _, c := range cases {
		if got := bearerToken(c.header); got != c.want {
			t.Errorf("bearerToken(%q) = %q, want %q", c.header, got, c.want)
		}
	}
}

func TestResolveAPIToken(t *testing.T) {
	t.Run("explicit env wins", func(t *testing.T) {
		t.Setenv("MATOU_API_TOKEN", "supplied-token")
		t.Setenv("MATOU_CORS_MODE", "bundled")
		if got := ResolveAPIToken(); got != "supplied-token" {
			t.Errorf("got %q, want supplied-token", got)
		}
	})

	t.Run("dev/test falls back to constant", func(t *testing.T) {
		t.Setenv("MATOU_API_TOKEN", "")
		t.Setenv("MATOU_CORS_MODE", "")
		t.Setenv("MATOU_ENV", "test")
		if got := ResolveAPIToken(); got != DevAPIToken {
			t.Errorf("got %q, want %q", got, DevAPIToken)
		}
	})

	t.Run("production generates random", func(t *testing.T) {
		t.Setenv("MATOU_API_TOKEN", "")
		t.Setenv("MATOU_CORS_MODE", "")
		t.Setenv("MATOU_ENV", "production")
		if got := ResolveAPIToken(); got == DevAPIToken || len(got) != 64 {
			t.Errorf("production should generate a random 64-char token, got %q", got)
		}
	})

	t.Run("bundled generates random", func(t *testing.T) {
		t.Setenv("MATOU_API_TOKEN", "")
		t.Setenv("MATOU_CORS_MODE", "bundled")
		a := ResolveAPIToken()
		b := ResolveAPIToken()
		if a == DevAPIToken || b == DevAPIToken {
			t.Errorf("bundled mode should not use dev constant: %q %q", a, b)
		}
		if a == b {
			t.Errorf("bundled tokens should be random and unique, got identical %q", a)
		}
		if len(a) != 64 { // 32 bytes hex-encoded
			t.Errorf("expected 64-char hex token, got %d chars", len(a))
		}
	})
}

func TestWriteTokenFile(t *testing.T) {
	dir := t.TempDir()
	path, err := WriteTokenFile(dir, "tok-xyz")
	if err != nil {
		t.Fatalf("WriteTokenFile error: %v", err)
	}
	if path != filepath.Join(dir, "api-token") {
		t.Errorf("unexpected path %q", path)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back error: %v", err)
	}
	if string(data) != "tok-xyz" {
		t.Errorf("file content = %q, want tok-xyz", string(data))
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat error: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0600 {
		t.Errorf("token file perms = %o, want 600", perm)
	}
}

func TestTokenGuard(t *testing.T) {
	const token = "secret-token"
	handlerCalled := false
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handlerCalled = true
		w.WriteHeader(http.StatusOK)
	})
	guard := TokenGuard(token, next)

	t.Run("GET passes without token", func(t *testing.T) {
		handlerCalled = false
		req := httptest.NewRequest(http.MethodGet, "/api/v1/projects", nil)
		w := httptest.NewRecorder()
		guard.ServeHTTP(w, req)
		if !handlerCalled {
			t.Error("GET should reach handler without token")
		}
		if w.Code != http.StatusOK {
			t.Errorf("GET status = %d, want 200", w.Code)
		}
	})

	mutating := []string{http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete}

	for _, method := range mutating {
		t.Run(method+" rejected without token", func(t *testing.T) {
			handlerCalled = false
			req := httptest.NewRequest(method, "/api/v1/members/EABC/role", nil)
			w := httptest.NewRecorder()
			guard.ServeHTTP(w, req)
			if handlerCalled {
				t.Errorf("%s without token should not reach handler", method)
			}
			if w.Code != http.StatusUnauthorized {
				t.Errorf("%s status = %d, want 401", method, w.Code)
			}
		})

		t.Run(method+" rejected with wrong token", func(t *testing.T) {
			handlerCalled = false
			req := httptest.NewRequest(method, "/api/v1/members/EABC/role", nil)
			req.Header.Set("Authorization", "Bearer wrong-token")
			w := httptest.NewRecorder()
			guard.ServeHTTP(w, req)
			if handlerCalled {
				t.Errorf("%s with wrong token should not reach handler", method)
			}
			if w.Code != http.StatusUnauthorized {
				t.Errorf("%s status = %d, want 401", method, w.Code)
			}
		})

		t.Run(method+" passes with correct token", func(t *testing.T) {
			handlerCalled = false
			req := httptest.NewRequest(method, "/api/v1/members/EABC/role", nil)
			req.Header.Set("Authorization", "Bearer "+token)
			w := httptest.NewRecorder()
			guard.ServeHTTP(w, req)
			if !handlerCalled {
				t.Errorf("%s with correct token should reach handler", method)
			}
			if w.Code != http.StatusOK {
				t.Errorf("%s status = %d, want 200", method, w.Code)
			}
		})
	}
}

func TestLocalhostGuard(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	t.Run("loopback allowed", func(t *testing.T) {
		t.Setenv("MATOU_ALLOW_REMOTE", "")
		guard := LocalhostGuard(next)
		req := httptest.NewRequest(http.MethodGet, "/health", nil)
		req.RemoteAddr = "127.0.0.1:54321"
		w := httptest.NewRecorder()
		guard.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Errorf("loopback status = %d, want 200", w.Code)
		}
	})

	t.Run("non-loopback rejected in all modes", func(t *testing.T) {
		t.Setenv("MATOU_ALLOW_REMOTE", "")
		guard := LocalhostGuard(next)
		req := httptest.NewRequest(http.MethodGet, "/health", nil)
		req.RemoteAddr = "10.0.0.5:44444"
		w := httptest.NewRecorder()
		guard.ServeHTTP(w, req)
		if w.Code != http.StatusForbidden {
			t.Errorf("remote status = %d, want 403", w.Code)
		}
	})

	t.Run("opt-out allows remote", func(t *testing.T) {
		t.Setenv("MATOU_ALLOW_REMOTE", "1")
		guard := LocalhostGuard(next)
		req := httptest.NewRequest(http.MethodGet, "/health", nil)
		req.RemoteAddr = "10.0.0.5:44444"
		w := httptest.NewRecorder()
		guard.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Errorf("opt-out remote status = %d, want 200", w.Code)
		}
	})
}
