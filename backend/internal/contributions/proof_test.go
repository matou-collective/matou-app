package contributions

import (
	"strings"
	"testing"
)

func validProof() *Proof {
	return &Proof{
		V:       "matou-proof/v1",
		Action:  "contribution_signoff",
		Subject: "ctr_1",
		Space:   "space-1",
		Value:   "signed_off",
		Dt:      "2026-08-15T00:00:00Z",
		AID:     "Eactor",
		Sig:     "0Bsig",
	}
}

func TestValidateConsistency(t *testing.T) {
	cases := []struct {
		name    string
		mutate  func(*Proof)
		wantErr string
	}{
		{"matching proof passes", func(p *Proof) {}, ""},
		{"wrong version", func(p *Proof) { p.V = "matou-proof/v2" }, "version"},
		{"wrong action", func(p *Proof) { p.Action = "contribution_reward" }, "action"},
		{"wrong subject", func(p *Proof) { p.Subject = "ctr_other" }, "subject"},
		{"wrong space", func(p *Proof) { p.Space = "space-2" }, "space"},
		{"wrong value", func(p *Proof) { p.Value = "rewarded" }, "value"},
		{"signer is not the actor", func(p *Proof) { p.AID = "Esomeoneelse" }, "signer AID"},
		{"empty sig", func(p *Proof) { p.Sig = "" }, "sig and dt"},
		{"empty dt", func(p *Proof) { p.Dt = "" }, "sig and dt"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := validProof()
			tc.mutate(p)
			err := p.ValidateConsistency("contribution_signoff", "ctr_1", "space-1", "signed_off", "Eactor")
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("expected pass, got %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("expected error containing %q, got %v", tc.wantErr, err)
			}
		})
	}

	t.Run("nil proof passes (proof is optional writer-side)", func(t *testing.T) {
		var p *Proof
		if err := p.ValidateConsistency("x", "y", "z", "v", "a"); err != nil {
			t.Fatalf("nil proof must pass: %v", err)
		}
	})

	t.Run("empty actorAID skips only the signer check", func(t *testing.T) {
		p := validProof()
		p.AID = "Eanyone"
		if err := p.ValidateConsistency("contribution_signoff", "ctr_1", "space-1", "signed_off", ""); err != nil {
			t.Fatalf("expected pass with empty actor, got %v", err)
		}
	})
}
