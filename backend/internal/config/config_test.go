package config

import (
	"testing"
)

// TestLoadKERIURLDefaults asserts that the KERI URL defaults are
// environment-aware: dev keeps the 3901-3903 ports while MATOU_ENV=test shifts
// to the isolated test KERIA ports 4901-4903, so the signed-auth key-state URL
// derived from cfg.KERI.CESRURL targets the running KERIA in each env (#517).
func TestLoadKERIURLDefaults(t *testing.T) {
	cases := []struct {
		name      string
		env       string
		wantAdmin string
		wantBoot  string
		wantCESR  string
	}{
		{
			name:      "dev default",
			env:       "",
			wantAdmin: "http://localhost:3901",
			wantBoot:  "http://localhost:3903",
			wantCESR:  "http://localhost:3902",
		},
		{
			name:      "test shifts to 4900-range KERIA ports",
			env:       "test",
			wantAdmin: "http://localhost:4901",
			wantBoot:  "http://localhost:4903",
			wantCESR:  "http://localhost:4902",
		},
		{
			name:      "production keeps dev-style defaults",
			env:       "production",
			wantAdmin: "http://localhost:3901",
			wantBoot:  "http://localhost:3903",
			wantCESR:  "http://localhost:3902",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("MATOU_ENV", tc.env)

			cfg, err := Load("", "")
			if err != nil {
				t.Fatalf("Load returned error: %v", err)
			}
			if cfg.KERI.AdminURL != tc.wantAdmin {
				t.Errorf("AdminURL = %q, want %q", cfg.KERI.AdminURL, tc.wantAdmin)
			}
			if cfg.KERI.BootURL != tc.wantBoot {
				t.Errorf("BootURL = %q, want %q", cfg.KERI.BootURL, tc.wantBoot)
			}
			if cfg.KERI.CESRURL != tc.wantCESR {
				t.Errorf("CESRURL = %q, want %q", cfg.KERI.CESRURL, tc.wantCESR)
			}
		})
	}
}

func TestConfigValidation(t *testing.T) {
	// Test with empty config
	cfg := &Config{}
	if err := cfg.Validate(); err == nil {
		t.Error("Expected validation error for empty config")
	}

	// Test with valid config (admin AID optional)
	cfg = &Config{
		Bootstrap: BootstrapConfig{
			Organization: OrganizationConfig{
				Name: "MATOU",
				AID:  "ETestAID",
			},
			// Admin AID is optional - set later when admin creates identity
		},
		KERI: KERIConfig{
			AdminURL: "http://localhost:3901",
		},
	}

	if err := cfg.Validate(); err != nil {
		t.Errorf("Expected valid config, got error: %v", err)
	}
}
