// backend/internal/contributions/evidence_decode_test.go
package contributions

import (
	"encoding/json"
	"testing"
)

// TestSubmitEvidenceRequest_AcceptsFractionalHours guards the fix for the
// "invalid request body" error team members hit when logging fractional hours
// worked (e.g. 6.0158). ActualDuration must decode a non-integer JSON number,
// matching ActualCost which is already a float.
func TestSubmitEvidenceRequest_AcceptsFractionalHours(t *testing.T) {
	body := []byte(`{"completion_notes":"done","actual_duration":6.0158,"actual_cost":391.03}`)

	var req SubmitEvidenceRequest
	if err := json.Unmarshal(body, &req); err != nil {
		t.Fatalf("decoding fractional actual_duration should succeed, got: %v", err)
	}
	if req.ActualDuration != 6.0158 {
		t.Errorf("ActualDuration = %v, want 6.0158", req.ActualDuration)
	}
	if req.ActualCost != 391.03 {
		t.Errorf("ActualCost = %v, want 391.03", req.ActualCost)
	}
}
