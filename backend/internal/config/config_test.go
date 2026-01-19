package config

import (
	"testing"
)

func TestLoadBootstrapConfig(t *testing.T) {
	// Load bootstrap configuration
	cfg, err := Load("", "../../config/bootstrap.yaml")
	if err != nil {
		t.Fatalf("Failed to load config: %v", err)
	}

	// Verify organization AID (required)
	if cfg.Bootstrap.Organization.AID == "" {
		t.Error("Organization AID should not be empty")
	}

	// Admin AID is optional at startup (set later when admin creates identity in frontend)
	// OrgSpace ID is optional at startup (created later)

	t.Logf("✅ Configuration loaded successfully")
	t.Logf("   Organization AID: %s", cfg.GetOrgAID())
	t.Logf("   Admin AID: %s (may be empty)", cfg.GetAdminAID())
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
