package api

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// DevAPIToken is the fixed fallback token used in dev/test (non-bundled) mode.
// It removes all setup friction for `make run` + `npm run dev` and the e2e
// suite, which inject it centrally. Its residual risk is acceptable because
// dev is loopback-restricted by the (now unconditional) LocalhostGuard.
// Bundled/production launches never use it — they generate a random per-launch
// token (see ResolveAPIToken).
const DevAPIToken = "matou-dev"

// apiTokenFileName is the basename of the token file written under the data
// dir with 0600 perms so same-OS-user local tooling (matou-mcp, scripts) can
// read the live token while other users' processes cannot.
const apiTokenFileName = "api-token"

// ResolveAPIToken determines the per-launch API token:
//   - MATOU_API_TOKEN if set (Electron generates a random one and passes it here);
//   - a random token in bundled/production mode when none was supplied;
//   - the fixed DevAPIToken constant in dev/test.
func ResolveAPIToken() string {
	if t := os.Getenv("MATOU_API_TOKEN"); t != "" {
		return t
	}
	if os.Getenv("MATOU_CORS_MODE") == "bundled" || os.Getenv("MATOU_ENV") == "production" {
		return randomToken()
	}
	return DevAPIToken
}

// randomToken returns a 32-byte hex-encoded random token. If the OS RNG fails
// (should never happen), the backend refuses to start: silently downgrading
// production to the publicly known dev constant would be worse than crashing.
func randomToken() string {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		log.Fatalf("[Security] failed to generate random API token: %v", err)
	}
	return hex.EncodeToString(buf)
}

// WriteTokenFile writes the token to {dataDir}/api-token with 0600 perms so
// legitimate same-user local tooling can read it. Returns the file path.
func WriteTokenFile(dataDir, token string) (string, error) {
	path := filepath.Join(dataDir, apiTokenFileName)
	if err := os.WriteFile(path, []byte(token), 0600); err != nil {
		return "", err
	}
	// os.WriteFile applies the mode only on creation; tighten a pre-existing
	// file left behind with wider permissions.
	if err := os.Chmod(path, 0600); err != nil {
		return "", err
	}
	return path, nil
}

// bearerToken extracts the token from an "Authorization: Bearer <token>" header.
// Returns "" when the header is absent or malformed.
func bearerToken(authHeader string) string {
	const prefix = "Bearer "
	if len(authHeader) <= len(prefix) || !strings.EqualFold(authHeader[:len(prefix)], prefix) {
		return ""
	}
	return strings.TrimSpace(authHeader[len(prefix):])
}

// TokenGuard rejects mutating requests (POST/PUT/PATCH/DELETE) that do not
// carry the correct "Authorization: Bearer <token>" header. Read requests
// (GET/HEAD/OPTIONS) pass through untouched so health checks and read-only
// tooling keep working with zero setup. This defends against other local
// processes on the same host — not against the user themselves.
func TokenGuard(token string, next http.Handler) http.Handler {
	return TokenGuardWithSessions(token, nil, next)
}

// SessionValidator is the subset of auth.SessionStore TokenGuardWithSessions
// needs: it reports whether a bearer token is a live signed-auth session.
type SessionValidator interface {
	Validate(token string) (aid string, ok bool)
}

// TokenGuardWithSessions is TokenGuard extended to also accept a live
// signed-challenge session token (issue #18) in the Authorization header. Both
// tokens travel in the same header, so a client holding a session sends that
// instead of the per-launch API token.
//
// Accepting a session here does not weaken TokenGuard: the login endpoints that
// mint sessions are themselves mutating requests guarded by the API token, so
// every session holder already proved possession of it. sessions may be nil.
func TokenGuardWithSessions(token string, sessions SessionValidator, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			next.ServeHTTP(w, r)
			return
		}

		got := bearerToken(r.Header.Get("Authorization"))
		if got == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid or missing API token"})
			return
		}
		if subtle.ConstantTimeCompare([]byte(got), []byte(token)) == 1 {
			next.ServeHTTP(w, r)
			return
		}
		if sessions != nil {
			if _, ok := sessions.Validate(got); ok {
				next.ServeHTTP(w, r)
				return
			}
		}
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid or missing API token"})
	})
}
