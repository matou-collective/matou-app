package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/matou-dao/backend/internal/contributions"
	"github.com/matou-dao/backend/internal/types"
)

// TestRegistryStampVersionOnWrite verifies the write path's version stamping
// (#302): the SharedProfile write in HandleCreateProfile stamps the live schema
// version into the data before persisting, overwriting any stale client value,
// so the stored profile is never born stale.
func TestRegistryStampVersionOnWrite(t *testing.T) {
	reg := types.NewRegistry()
	reg.Bootstrap()

	// Simulate an org that has edited its SharedProfile schema up to v2.
	def, ok := reg.Get("SharedProfile")
	if !ok {
		t.Fatal("SharedProfile not registered")
	}
	def.Version = 2
	reg.Register(def)

	// A client saves a profile carrying a stale typeVersion.
	in, _ := json.Marshal(map[string]interface{}{
		"aid": "E", "status": "approved", "displayName": "Ada", "typeVersion": 1,
	})
	out, err := reg.StampVersion("SharedProfile", in)
	if err != nil {
		t.Fatalf("StampVersion: %v", err)
	}
	if got := types.SchemaVersion(out); got != 2 {
		t.Fatalf("write should stamp live version 2, got %d", got)
	}
}

// TestRegistryValidateForReadGrandfathers verifies the tolerant read validator
// is reachable via the registry and grandfathers a newly-required field, while
// strict Validate still asks for it.
func TestRegistryValidateForReadGrandfathers(t *testing.T) {
	reg := types.NewRegistry()
	reg.Bootstrap()

	// Admin adds a required field to the SharedProfile schema.
	def, _ := reg.Get("SharedProfile")
	def.Fields = append(def.Fields, types.FieldDef{Name: "iwi", Type: "string", Required: true})
	reg.Register(def)

	existing, _ := json.Marshal(map[string]interface{}{
		"aid": "E", "status": "approved", "displayName": "Ada",
	})

	readErrs, err := reg.ValidateForRead("SharedProfile", existing)
	if err != nil {
		t.Fatalf("ValidateForRead: %v", err)
	}
	if len(readErrs) != 0 {
		t.Fatalf("existing profile should load under the new schema, got %v", readErrs)
	}

	writeErrs, err := reg.Validate("SharedProfile", existing)
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if len(writeErrs) == 0 {
		t.Fatalf("next save should be asked for the new required field")
	}
}

// TestAuthorizeAndStampProfileWrite_EndorsementAfterSchemaBump is the
// regression test for stamping order (#302): the write policy must evaluate
// the data exactly as the client sent it. If the live typeVersion were
// stamped first, an ordinary member's endorsement append onto a profile
// written under an older schema version would no longer match the existing
// object field-for-field and be refused as "not your profile".
func TestAuthorizeAndStampProfileWrite_EndorsementAfterSchemaBump(t *testing.T) {
	reg := types.NewRegistry()
	reg.Bootstrap()
	def, _ := reg.Get("SharedProfile")
	def.Version = 2 // admin edited the schema since the profile was written
	reg.Register(def)

	h := &ProfilesHandler{registry: reg, roleLookup: &mockRoleLookup{}}

	existing, _ := json.Marshal(map[string]interface{}{
		"aid": "EOwner", "status": "approved", "displayName": "Owner", "typeVersion": 1,
		"endorsements": []interface{}{},
	})
	incoming, _ := json.Marshal(map[string]interface{}{
		"aid": "EOwner", "status": "approved", "displayName": "Owner", "typeVersion": 1,
		"endorsements": []interface{}{map[string]interface{}{"by": "EEndorser", "skill": "weaving"}},
	})

	r := httptest.NewRequest(http.MethodPost, "/api/v1/profiles", nil)
	ctx := context.WithValue(r.Context(), ctxUserAID, "EEndorser")
	ctx = context.WithValue(ctx, ctxUserRoles, []contributions.Role{contributions.RoleMember})
	r = r.WithContext(ctx)

	stamped, reason, err := h.authorizeAndStampProfileWrite(r, "SharedProfile", "SharedProfile-EOwner", incoming, existing)
	if err != nil {
		t.Fatalf("authorizeAndStampProfileWrite: %v", err)
	}
	if reason != "" {
		t.Fatalf("endorsement append must stay allowed after a schema bump, got denial: %q", reason)
	}
	if got := types.SchemaVersion(stamped); got != 2 {
		t.Fatalf("allowed write should be stamped at live version 2, got %d", got)
	}
}

// TestAuthorizeAndStampProfileWrite_DeniedIsNotStamped: a refused write
// returns the policy reason and no data.
func TestAuthorizeAndStampProfileWrite_DeniedIsNotStamped(t *testing.T) {
	reg := types.NewRegistry()
	reg.Bootstrap()
	h := &ProfilesHandler{registry: reg, roleLookup: &mockRoleLookup{}}

	existing, _ := json.Marshal(map[string]interface{}{"aid": "EOwner", "status": "approved", "displayName": "Owner"})
	incoming, _ := json.Marshal(map[string]interface{}{"aid": "EOwner", "status": "approved", "displayName": "Hijacked"})

	r := httptest.NewRequest(http.MethodPost, "/api/v1/profiles", nil)
	ctx := context.WithValue(r.Context(), ctxUserAID, "EStranger")
	ctx = context.WithValue(ctx, ctxUserRoles, []contributions.Role{contributions.RoleMember})
	r = r.WithContext(ctx)

	stamped, reason, err := h.authorizeAndStampProfileWrite(r, "SharedProfile", "SharedProfile-EOwner", incoming, existing)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if reason == "" || stamped != nil {
		t.Fatalf("stranger's rewrite must be refused with a reason and no data; reason=%q data=%s", reason, stamped)
	}
}

// TestInitMemberSeedStampsLiveSharedProfileVersion: a freshly seeded member
// SharedProfile is stamped at the org's registered schema version, not a
// hardcoded 1, so it is never born stale (#302).
func TestInitMemberSeedStampsLiveSharedProfileVersion(t *testing.T) {
	sharedDef := types.SharedProfileType()
	sharedDef.Version = 3
	req := baseRequest()
	merged, err := req.mergedProfileData()
	if err != nil {
		t.Fatalf("mergedProfileData: %v", err)
	}
	_, shared, _ := buildMemberProfileData(types.CommunityProfileType(), sharedDef, req, merged, "2026-09-04T00:00:00Z")
	if shared["typeVersion"] != 3 {
		t.Fatalf("seeded typeVersion = %v, want live version 3", shared["typeVersion"])
	}
	data, _ := json.Marshal(shared)
	if sharedDef.IsStale(data) {
		t.Fatalf("freshly seeded profile must not be stale")
	}
}

// TestUpdateType_ReportsSchemaChanged: the PUT /types/{name} response carries an
// advisory schemaChanged flag (types.SchemaChanged, #302) alongside the
// unconditionally bumped Version (#405's optimistic lock). A substantive edit
// reports true; a cosmetic relabel reports false but still bumps the version.
func TestUpdateType_ReportsSchemaChanged(t *testing.T) {
	h, _ := newSchemaTestHandler()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/types/", h.handleTypeByName)

	decode := func(rec *httptest.ResponseRecorder) (int, bool) {
		t.Helper()
		if rec.Code != http.StatusOK {
			t.Fatalf("PUT = %d, want 200; body %s", rec.Code, rec.Body.String())
		}
		var got struct {
			Version       int   `json:"version"`
			SchemaChanged *bool `json:"schemaChanged"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if got.SchemaChanged == nil {
			t.Fatalf("response lacks schemaChanged: %s", rec.Body.String())
		}
		return got.Version, *got.SchemaChanged
	}

	// Substantive: add a field.
	v, changed := decode(putType(t, mux, "SharedProfile", "", sharedProfileWithCustom()))
	if v != 2 || !changed {
		t.Errorf("adding a field: version=%d schemaChanged=%v, want 2/true", v, changed)
	}

	// Cosmetic: relabel a field on the now-current (v2) definition.
	cosmetic := sharedProfileWithCustom()
	cosmetic.Version = 2
	for i := range cosmetic.Fields {
		if cosmetic.Fields[i].Name == "bio" {
			cosmetic.Fields[i].UIHints.Label = "Bio (renamed)"
		}
	}
	v, changed = decode(putType(t, mux, "SharedProfile", "", cosmetic))
	if v != 3 || changed {
		t.Errorf("relabel: version=%d schemaChanged=%v, want 3/false (version bumps for the lock, schema did not change)", v, changed)
	}
}
