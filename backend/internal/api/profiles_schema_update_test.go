package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sort"
	"sync"
	"testing"
	"time"

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

// blockingSchemaWriter parks its first write until released, so a second PUT
// can be issued while the first is mid-flight inside the handler.
type blockingSchemaWriter struct {
	mu      sync.Mutex
	calls   int
	entered chan struct{}
	release chan struct{}
}

func (b *blockingSchemaWriter) WriteTypeDefinition(_ context.Context, _ *types.TypeDefinition) error {
	b.mu.Lock()
	b.calls++
	first := b.calls == 1
	b.mu.Unlock()
	if first {
		close(b.entered)
		<-b.release
	}
	return nil
}

// TestUpdateType_ConcurrentSameVersion: two PUTs claiming the same Version must
// resolve to exactly one 200 and one 409. The handler serialises Get → validate
// → persist → Register under schemaMu, so the second PUT cannot read the
// pre-bump version while the first is still in flight.
func TestUpdateType_ConcurrentSameVersion(t *testing.T) {
	reg := types.NewRegistry()
	reg.Bootstrap()
	bw := &blockingSchemaWriter{entered: make(chan struct{}), release: make(chan struct{})}
	h := &ProfilesHandler{registry: reg, schemaWriter: bw}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/types/", h.handleTypeByName)

	codes := make(chan int, 2)
	go func() { codes <- putType(t, mux, "SharedProfile", "", sharedProfileWithCustom()).Code }()
	<-bw.entered // first PUT is inside the critical section, parked in persist

	go func() { codes <- putType(t, mux, "SharedProfile", "", sharedProfileWithCustom()).Code }()
	// Without the lock the second PUT reads Version 1, passes the check, writes
	// and returns while the first is still parked; with it, it waits.
	select {
	case c := <-codes:
		t.Fatalf("second PUT completed (%d) while the first was still in flight", c)
	case <-time.After(150 * time.Millisecond):
	}

	close(bw.release)
	got := []int{<-codes, <-codes}
	sort.Ints(got)
	if got[0] != http.StatusOK || got[1] != http.StatusConflict {
		t.Fatalf("concurrent same-version PUTs = %v, want [200 409]", got)
	}
	if def, _ := h.registry.Get("SharedProfile"); def.Version != 2 {
		t.Errorf("registry version = %d, want exactly one bump to 2", def.Version)
	}
}

// TestUpdateType_CoreFieldFlagsReasserted: a PUT that keeps a core field's name
// and type but flips its core/required/readOnly/validation flags is accepted,
// and the served, registered and persisted definition all carry the built-in
// core FieldDef verbatim — so a PUT and the next boot (LoadFromSpace, which
// re-asserts the same way) agree.
func TestUpdateType_CoreFieldFlagsReasserted(t *testing.T) {
	h, fw := newSchemaTestHandler()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/types/", h.handleTypeByName)

	builtinAID, _ := types.SharedProfileType().Field("aid")
	if !builtinAID.Core || !builtinAID.Required || !builtinAID.ReadOnly {
		t.Fatalf("test premise: built-in aid should be core+required+readOnly, got %+v", builtinAID)
	}

	def := sharedProfileWithCustom()
	for i := range def.Fields {
		if def.Fields[i].Name == "aid" {
			def.Fields[i].Core = false
			def.Fields[i].Required = false
			def.Fields[i].ReadOnly = false
			def.Fields[i].Validation = &types.Validation{Pattern: "^x$"}
		}
	}

	rec := putType(t, mux, "SharedProfile", "", def)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT = %d, want 200; body %s", rec.Code, rec.Body.String())
	}

	var served types.TypeDefinition
	if err := json.Unmarshal(rec.Body.Bytes(), &served); err != nil {
		t.Fatal(err)
	}
	check := func(label string, d *types.TypeDefinition) {
		t.Helper()
		got, ok := d.Field("aid")
		if !ok {
			t.Fatalf("%s: aid missing", label)
		}
		if !reflect.DeepEqual(got, builtinAID) {
			t.Errorf("%s: aid = %+v, want built-in %+v", label, got, builtinAID)
		}
		if _, ok := d.Field("iwi"); !ok {
			t.Errorf("%s: custom field iwi lost", label)
		}
	}
	check("response", &served)
	if reg, _ := h.registry.Get("SharedProfile"); reg != nil {
		check("registry", reg)
	}
	if len(fw.written) != 1 {
		t.Fatalf("expected one persisted definition, got %d", len(fw.written))
	}
	check("persisted", fw.written[0])
}

// TestUpdateType_SpaceIsPinned: a PUT may not move a type to another space —
// resolveSpaceForType reads def.Space to decide where objects of the type are
// written and listed, so flipping SharedProfile to "private" would re-route
// community profiles. An empty space inherits the current one.
func TestUpdateType_SpaceIsPinned(t *testing.T) {
	h, fw := newSchemaTestHandler()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/types/", h.handleTypeByName)

	moved := sharedProfileWithCustom()
	moved.Space = "private"
	rec := putType(t, mux, "SharedProfile", "", moved)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("space change PUT = %d, want 400; body %s", rec.Code, rec.Body.String())
	}
	if len(fw.written) != 0 {
		t.Errorf("nothing should be persisted on a rejected space change, got %+v", fw.written)
	}

	inherit := sharedProfileWithCustom()
	inherit.Space = ""
	rec = putType(t, mux, "SharedProfile", "", inherit)
	if rec.Code != http.StatusOK {
		t.Fatalf("empty-space PUT = %d, want 200; body %s", rec.Code, rec.Body.String())
	}
	var got types.TypeDefinition
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	if got.Space != "community" {
		t.Errorf("empty space should inherit %q, got %q", "community", got.Space)
	}
	if reg, _ := h.registry.Get("SharedProfile"); reg.Space != "community" {
		t.Errorf("registry space = %q, want community", reg.Space)
	}
}
