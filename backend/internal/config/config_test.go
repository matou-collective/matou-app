package config

import (
	"testing"
)

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
