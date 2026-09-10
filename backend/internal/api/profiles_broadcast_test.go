package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/matou-dao/backend/internal/contributions"
	"github.com/matou-dao/backend/internal/types"
)

// Issue #383: POST /api/v1/profiles must emit a client-recognised
// `profile:updated` SSE event on a successful SharedProfile / CommunityProfile
// write so the local client converges on the admin-approval writes (role +
// real credential SAID, status pending→approved) without a manual reload.
// The local any-sync AddContent path never fires the tree listener (only
// peer-delivered AddRawChanges does), so this handler-level broadcast is the
// only local refresh signal for those writes.
//
// The event is deliberately scoped to the two profile types the frontend's
// profile:updated listener reloads (mirroring tree_listener.go) — every other
// type routed through this generic write endpoint stays silent so unrelated
// writes don't trigger a reload of both community-profile stores.

func setupProfilesBroadcastEnv(t *testing.T) (*chatTestEnv, *http.ServeMux) {
	t.Helper()
	env := setupChatTestEnv(t)
	reg := types.NewRegistry()
	reg.Bootstrap()
	h := NewProfilesHandler(env.spaceManager, env.userIdentity, reg, nil, env.eventBroker)
	mux := http.NewServeMux()
	h.RegisterRoutes(mux, &mockRoleLookup{roles: map[string][]contributions.Role{
		"ETEST_CHAT_USER01": {contributions.RoleFoundingMember},
	}})
	return env, mux
}

func postProfile(t *testing.T, mux *http.ServeMux, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/profiles", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-User-AID", "ETEST_CHAT_USER01")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("POST /profiles failed: %d %s", w.Code, w.Body.String())
	}
	return w
}

func drainProfileUpdated(ch chan SSEEvent) []SSEEvent {
	var got []SSEEvent
	for {
		select {
		case ev := <-ch:
			if ev.Type == "profile:updated" {
				got = append(got, ev)
			}
		case <-time.After(200 * time.Millisecond):
			return got
		}
	}
}

func TestCreateProfile_BroadcastsProfileUpdatedForMemberProfiles(t *testing.T) {
	env, mux := setupProfilesBroadcastEnv(t)
	defer env.cleanup()

	ch := env.eventBroker.Subscribe()
	defer env.eventBroker.Unsubscribe(ch)

	cases := []struct {
		name string
		body string
		id   string
	}{
		{
			name: "SharedProfile (community space)",
			id:   "SharedProfile-EApplicant",
			body: `{"type":"SharedProfile","id":"SharedProfile-EApplicant","data":{"aid":"EApplicant","displayName":"Aroha","status":"approved"}}`,
		},
		{
			name: "CommunityProfile (read-only space)",
			id:   "CommunityProfile-EApplicant",
			body: `{"type":"CommunityProfile","id":"CommunityProfile-EApplicant","data":{"userAID":"EApplicant","credential":"ESAID","role":"Member"}}`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := postProfile(t, mux, tc.body)
			var resp map[string]interface{}
			_ = json.NewDecoder(w.Body).Decode(&resp)
			if resp["success"] != true {
				t.Fatalf("expected success, got %v", resp)
			}

			events := drainProfileUpdated(ch)
			if len(events) != 1 {
				t.Fatalf("expected exactly 1 profile:updated event, got %d: %+v", len(events), events)
			}
			data, _ := events[0].Data.(map[string]interface{})
			if data["profileId"] != tc.id {
				t.Errorf("profileId = %v, want %s", data["profileId"], tc.id)
			}
		})
	}
}

func TestCreateProfile_NoBroadcastForNonProfileTypes(t *testing.T) {
	env, mux := setupProfilesBroadcastEnv(t)
	defer env.cleanup()

	ch := env.eventBroker.Subscribe()
	defer env.eventBroker.Unsubscribe(ch)

	// MessageReaction lives in the community space and is accepted by the
	// generic write endpoint, but the frontend's profile:updated listener has
	// nothing to reload for it.
	postProfile(t, mux, `{"type":"MessageReaction","id":"MessageReaction-1","data":{"messageId":"m1","emoji":"👍","reactorAids":["EA"]}}`)

	if events := drainProfileUpdated(ch); len(events) != 0 {
		t.Fatalf("expected no profile:updated event for a MessageReaction write, got %d: %+v", len(events), events)
	}
}
