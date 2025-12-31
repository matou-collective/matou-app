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

	// Verify organization AID
	if cfg.Bootstrap.Organization.AID == "" {
		t.Error("Organization AID should not be empty")
	}

	// Verify admin AID
	if cfg.Bootstrap.Admin.AID == "" {
		t.Error("Admin AID should not be empty")
	}

	// Verify org space ID
	if cfg.Bootstrap.OrgSpace.SpaceID == "" {
		t.Error("Organization space ID should not be empty")
	}

	t.Logf("✅ Configuration loaded successfully")
	t.Logf("   Organization AID: %s", cfg.GetOrgAID())
	t.Logf("   Admin AID: %s", cfg.GetAdminAID())
	t.Logf("   Org Space ID: %s", cfg.GetOrgSpaceID())
}

func TestConfigValidation(t *testing.T) {
	// Test with empty config
	cfg := &Config{}
	if err := cfg.Validate(); err == nil {
		t.Error("Expected validation error for empty config")
	}

	// Test with valid config
	cfg = &Config{
		Bootstrap: BootstrapConfig{
			Organization: OrganizationConfig{
				Name: "MATOU",
				AID:  "ETestAID",
			},
			Admin: AdminConfig{
				AID: "ETestAdminAID",
			},
		},
		KERI: KERIConfig{
			AdminURL: "http://localhost:3901",
		},
	}

	if err := cfg.Validate(); err != nil {
		t.Errorf("Expected valid config, got error: %v", err)
	}
}
