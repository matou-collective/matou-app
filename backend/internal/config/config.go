package config

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

// Config represents the complete application configuration
type Config struct {
	Server    ServerConfig    `yaml:"server"`
	KERI      KERIConfig      `yaml:"keri"`
	AnySync   AnySyncConfig   `yaml:"anysync"`
	Bootstrap BootstrapConfig `yaml:"bootstrap"`
}

// ServerConfig holds HTTP server configuration
type ServerConfig struct {
	Host string `yaml:"host"`
	Port int    `yaml:"port"`
}

// KERIConfig holds KERI/KERIA connection configuration
type KERIConfig struct {
	AdminURL string `yaml:"adminUrl"`
	BootURL  string `yaml:"bootUrl"`
	CESRURL  string `yaml:"cesrUrl"`
}

// AnySyncConfig holds any-sync connection configuration
type AnySyncConfig struct {
	ClientConfigPath string `yaml:"clientConfigPath"`
	NetworkID        string `yaml:"networkId"`
}

// BootstrapConfig holds bootstrap identity information
type BootstrapConfig struct {
	Organization OrganizationConfig `yaml:"organization"`
	Admin        AdminConfig        `yaml:"admin"`
	OrgSpace     OrgSpaceConfig     `yaml:"orgSpace"`
}

// OrganizationConfig holds organization AID information
type OrganizationConfig struct {
	Name             string   `yaml:"name"`
	AID              string   `yaml:"aid"`
	Alias            string   `yaml:"alias"`
	Witnesses        []string `yaml:"witnesses"`
	WitnessThreshold int      `yaml:"witnessThreshold"`
}

// AdminConfig holds admin AID information
type AdminConfig struct {
	AID          string            `yaml:"aid"`
	Alias        string            `yaml:"alias"`
	DelegatedBy  string            `yaml:"delegatedBy"`
	Credentials  CredentialsConfig `yaml:"credentials"`
}

// CredentialsConfig holds credential SAIDs
type CredentialsConfig struct {
	Membership string `yaml:"membership"`
	Steward    string `yaml:"steward"`
}

// OrgSpaceConfig holds organization space configuration
type OrgSpaceConfig struct {
	SpaceID       string              `yaml:"spaceId"`
	AccessControl AccessControlConfig `yaml:"accessControl"`
}

// AccessControlConfig holds ACL configuration
type AccessControlConfig struct {
	Type   string `yaml:"type"`
	Schema string `yaml:"schema"`
	Issuer string `yaml:"issuer"`
}

// Load reads configuration from files and environment
func Load(configPath, bootstrapPath string) (*Config, error) {
	cfg := &Config{
		// Default values
		Server: ServerConfig{
			Host: "localhost",
			Port: 8080,
		},
		KERI: KERIConfig{
			AdminURL: "http://localhost:3901",
			BootURL:  "http://localhost:3903",
			CESRURL:  "http://localhost:3902",
		},
		AnySync: AnySyncConfig{
			ClientConfigPath: "../infrastructure/any-sync/etc/client.yml",
		},
	}

	// Load main config if exists
	if configPath != "" {
		if err := loadYAML(configPath, cfg); err != nil {
			// Config file is optional, just use defaults
			fmt.Printf("Using default config (no config file at %s)\n", configPath)
		}
	}

	// Load bootstrap config (required)
	if bootstrapPath == "" {
		bootstrapPath = "config/bootstrap.yaml"
	}

	if err := loadYAML(bootstrapPath, &cfg.Bootstrap); err != nil {
		return nil, fmt.Errorf("loading bootstrap config: %w", err)
	}

	// Validate required fields
	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("validating config: %w", err)
	}

	return cfg, nil
}

// loadYAML loads a YAML file into a struct
func loadYAML(path string, target interface{}) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("reading file %s: %w", path, err)
	}

	if err := yaml.Unmarshal(data, target); err != nil {
		return fmt.Errorf("parsing YAML %s: %w", path, err)
	}

	return nil
}

// Validate checks that all required configuration is present
func (c *Config) Validate() error {
	// Validate organization
	if c.Bootstrap.Organization.AID == "" {
		return fmt.Errorf("organization AID is required")
	}
	if c.Bootstrap.Organization.Name == "" {
		return fmt.Errorf("organization name is required")
	}

	// Admin AID is optional at startup (set later when admin creates identity in frontend)

	// Validate KERI URLs
	if c.KERI.AdminURL == "" {
		return fmt.Errorf("KERI admin URL is required")
	}

	return nil
}

// GetOrgAID returns the organization AID
func (c *Config) GetOrgAID() string {
	return c.Bootstrap.Organization.AID
}

// GetAdminAID returns the admin AID
func (c *Config) GetAdminAID() string {
	return c.Bootstrap.Admin.AID
}

// GetOrgSpaceID returns the organization space ID
func (c *Config) GetOrgSpaceID() string {
	return c.Bootstrap.OrgSpace.SpaceID
}
