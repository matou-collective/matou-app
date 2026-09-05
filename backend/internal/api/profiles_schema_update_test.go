package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/matou-dao/backend/internal/types"
)

// fakeSchemaWriter records the definitions written to it, standing in for the
// community-space persistence in unit tests.
type fakeSchemaWriter struct {
	written []*types.TypeDefinition
	fail    bool
}

func (f *fakeSchemaWriter) WriteTypeDefinition(_ context.Context, def *types.TypeDefinition) error {
	if f.fail {
		return http.ErrHandlerTimeout
	}
	f.written = append(f.written, def)
	return nil
}

// newSchemaTestHandler builds a ProfilesHandler with a bootstrapped registry
// and a fake schema writer, no RBAC (roleLookup nil → withRBAC bypasses).
func newSchemaTestHandler() (*ProfilesHandler, *fakeSchemaWriter) {
	reg := types.NewRegistry()
	reg.Bootstrap()
	fw := &fakeSchemaWriter{}
	return &ProfilesHandler{registry: reg, schemaWriter: fw}, fw
}

func putType(t *testing.T, mux *http.ServeMux, name, aid string, body interface{}) *httptest.ResponseRecorder {
	t.Helper()
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPut, "/api/v1/types/"+name, bytes.NewReader(b))
	if aid != "" {
		req.Header.Set("X-User-AID", aid)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

// sharedProfileWithCustom returns the SharedProfile built-in with a custom
// field appended — a valid edit that preserves every core field.
func sharedProfileWithCustom() *types.TypeDefinition {
	def := types.SharedProfileType()
	def.Fields = append(def.Fields, types.FieldDef{Name: "iwi", Type: "string"})
	return def
}

// TestUpdateType_HappyPath: a valid edit bumps the version, persists, and
// updates the in-memory registry.
func TestUpdateType_HappyPath(t *testing.T) {
	h, fw := newSchemaTestHandler()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/types/", h.handleTypeByName)

	rec := putType(t, mux, "SharedProfile", "", sharedProfileWithCustom())
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT = %d, want 200; body %s", rec.Code, rec.Body.String())
	}

	var got types.TypeDefinition
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Version != 2 { // built-in SharedProfile is version 1
		t.Errorf("response version = %d, want 2", got.Version)
	}
	if _, ok := got.Field("iwi"); !ok {
		t.Error("custom field iwi missing from response")
	}

	// Persisted once, at the bumped version.
	if len(fw.written) != 1 || fw.written[0].Version != 2 {
		t.Fatalf("expected one persisted def at version 2, got %+v", fw.written)
	}
	// Registry now carries the new version.
	if reg, _ := h.registry.Get("SharedProfile"); reg == nil || reg.Version != 2 {
		t.Errorf("registry not updated to version 2, got %+v", reg)
	}
}

// TestUpdateType_CoreFieldRejection: removing a core field is a 400 and nothing
// is persisted.
func TestUpdateType_CoreFieldRejection(t *testing.T) {
	h, fw := newSchemaTestHandler()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/types/", h.handleTypeByName)

	def := types.SharedProfileType()
	kept := def.Fields[:0]
	for _, f := range def.Fields {
		if f.Name == "aid" { // core
			continue
		}
		kept = append(kept, f)
	}
	def.Fields = kept

	rec := putType(t, mux, "SharedProfile", "", def)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("core-field removal PUT = %d, want 400; body %s", rec.Code, rec.Body.String())
	}
	if len(fw.written) != 0 {
		t.Errorf("nothing should be persisted on a rejected update, got %+v", fw.written)
	}
	if reg, _ := h.registry.Get("SharedProfile"); reg.Version != 1 {
		t.Errorf("registry version changed on rejected update: %d", reg.Version)
	}
}

// TestUpdateType_UnknownType: an unknown type name is 404.
func TestUpdateType_UnknownType(t *testing.T) {
	h, _ := newSchemaTestHandler()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/types/", h.handleTypeByName)

	rec := putType(t, mux, "NoSuchType", "", &types.TypeDefinition{Name: "NoSuchType"})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown type PUT = %d, want 404; body %s", rec.Code, rec.Body.String())
	}
}

// TestUpdateType_StaleVersion: a stale definition version is a 409.
func TestUpdateType_StaleVersion(t *testing.T) {
	h, _ := newSchemaTestHandler()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/types/", h.handleTypeByName)

	// First edit lands (version 1 → 2).
	if rec := putType(t, mux, "SharedProfile", "", sharedProfileWithCustom()); rec.Code != http.StatusOK {
		t.Fatalf("first PUT = %d, want 200; body %s", rec.Code, rec.Body.String())
	}
	// Second edit still claims version 1 → conflict (current is now 2).
	rec := putType(t, mux, "SharedProfile", "", sharedProfileWithCustom())
	if rec.Code != http.StatusConflict {
		t.Fatalf("stale PUT = %d, want 409; body %s", rec.Code, rec.Body.String())
	}
	var body map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body["currentVersion"] != float64(2) {
		t.Errorf("409 should report currentVersion 2, got %v", body["currentVersion"])
	}
}

// TestUpdateType_NameMismatch: a body name that disagrees with the path is 400.
func TestUpdateType_NameMismatch(t *testing.T) {
	h, _ := newSchemaTestHandler()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/types/", h.handleTypeByName)

	def := sharedProfileWithCustom()
	def.Name = "SomethingElse"
	rec := putType(t, mux, "SharedProfile", "", def)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("name mismatch PUT = %d, want 400; body %s", rec.Code, rec.Body.String())
	}
}

// TestUpdateType_RBAC: with RBAC wired, a member is 403 and a founder is 200.
func TestUpdateType_RBAC(t *testing.T) {
	reg := types.NewRegistry()
	reg.Bootstrap()
	h := &ProfilesHandler{registry: reg, schemaWriter: &fakeSchemaWriter{}}
	mux := http.NewServeMux()
	h.RegisterRoutes(mux, lookupForTests())

	// No AID → 401 (RBACMiddleware requires the header).
	if rec := putType(t, mux, "SharedProfile", "", sharedProfileWithCustom()); rec.Code != http.StatusUnauthorized {
		t.Errorf("no AID: %d, want 401", rec.Code)
	}
	// Member holds no manage_community_settings → 403.
	if rec := putType(t, mux, "SharedProfile", "EMemberAID", sharedProfileWithCustom()); rec.Code != http.StatusForbidden {
		t.Errorf("member: %d, want 403", rec.Code)
	}
	// Operations steward does NOT hold manage_community_settings (#318) → 403.
	if rec := putType(t, mux, "SharedProfile", "EOpsAID", sharedProfileWithCustom()); rec.Code != http.StatusForbidden {
		t.Errorf("ops steward: %d, want 403", rec.Code)
	}
	// Founding member holds manage_community_settings by default → 200.
	if rec := putType(t, mux, "SharedProfile", "EFounderAID", sharedProfileWithCustom()); rec.Code != http.StatusOK {
		t.Errorf("founder: %d, want 200; body %s", rec.Code, rec.Body.String())
	}
}

// TestUpdateType_PersistFailureIsServerError: a storage failure is a 500 and the
// registry is not advanced ahead of the durable copy.
func TestUpdateType_PersistFailureIsServerError(t *testing.T) {
	reg := types.NewRegistry()
	reg.Bootstrap()
	fw := &fakeSchemaWriter{fail: true}
	h := &ProfilesHandler{registry: reg, schemaWriter: fw}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/types/", h.handleTypeByName)

	rec := putType(t, mux, "SharedProfile", "", sharedProfileWithCustom())
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("persist failure PUT = %d, want 500; body %s", rec.Code, rec.Body.String())
	}
	if regDef, _ := h.registry.Get("SharedProfile"); regDef.Version != 1 {
		t.Errorf("registry advanced despite persist failure: version %d", regDef.Version)
	}
}
