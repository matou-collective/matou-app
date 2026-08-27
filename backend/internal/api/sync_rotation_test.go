package api

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

const kelBody = `{
	"userAid": "EUSER123",
	"kel": [{"type": "icp", "sequence": 0, "digest": "EDIGEST001", "data": {"k": ["Dattacker"]}, "timestamp": "2026-01-19T00:00:00Z"}]
}`

// The rotation hook is a session-revocation trigger; POST /api/v1/sync/kel is
// unauthenticated, so the hook must fire only when the caller holds a verified
// session for the very AID whose KEL it is syncing — never for a bare header
// or for another AID — and must receive only the AID, never body key material.
func TestHandleSyncKEL_RotationHookOnlyForVerifiedOwner(t *testing.T) {
	handler, _, cleanup := setupSyncTestHandler(t)
	defer cleanup()

	var fired []string
	handler.SetRotationHook(func(_ context.Context, aid string) { fired = append(fired, aid) })

	post := func(verified string) int {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/sync/kel", bytes.NewBufferString(kelBody))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-User-AID", "EUSER123") // client-supplied, untrusted
		if verified != "" {
			req = withVerifiedAID(req, verified)
		}
		w := httptest.NewRecorder()
		handler.HandleSyncKEL(w, req)
		return w.Code
	}

	if code := post(""); code != http.StatusOK {
		t.Fatalf("unauthenticated sync should still succeed, got %d", code)
	}
	if len(fired) != 0 {
		t.Fatalf("hook must not fire without a verified session, fired=%v", fired)
	}

	if code := post("EOTHER999"); code != http.StatusOK {
		t.Fatalf("sync should succeed, got %d", code)
	}
	if len(fired) != 0 {
		t.Fatalf("hook must not fire for a session of a different AID, fired=%v", fired)
	}

	if code := post("EUSER123"); code != http.StatusOK {
		t.Fatalf("sync should succeed, got %d", code)
	}
	if len(fired) != 1 || fired[0] != "EUSER123" {
		t.Fatalf("hook should fire once for the verified owner, fired=%v", fired)
	}
}
