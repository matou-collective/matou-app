package api

import (
	"encoding/json"
	"testing"

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
