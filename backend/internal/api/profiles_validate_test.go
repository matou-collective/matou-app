package api

import (
	"encoding/json"
	"testing"

	"github.com/matou-dao/backend/internal/types"
)

// TestValidateProfile_UnknownTypeSurfacesError guards against the fail-open
// bug from review: a registry error (here, a type the registry never loaded)
// must surface as a validation error, not silently skip validation.
func TestValidateProfile_UnknownTypeSurfacesError(t *testing.T) {
	reg := types.NewRegistry()
	h := &ProfilesHandler{registry: reg}

	errs := h.validateProfile("NoSuchType", json.RawMessage(`{}`))
	if len(errs) == 0 {
		t.Fatal("registry error was swallowed — validateProfile failed open")
	}

	// A nil registry still skips validation (environments without schema wiring).
	h = &ProfilesHandler{}
	if errs := h.validateProfile("NoSuchType", json.RawMessage(`{}`)); errs != nil {
		t.Fatalf("nil registry must skip validation, got %v", errs)
	}
}
