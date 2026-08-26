package app

import (
	"path/filepath"
	"testing"

	"github.com/matou-dao/backend/internal/api"
)

// clearEnv resets every environment variable OptionsFromEnv (and the API token
// resolver it calls) reads, so each case starts from a known-empty baseline.
// t.Setenv restores the prior values when the (sub)test finishes.
func clearEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{
		"MATOU_ENV",
		"MATOU_CONFIG_SERVER_URL",
		"MATOU_CONFIG_SERVER_TOKEN",
		"MATOU_DATA_DIR",
		"MATOU_SERVER_PORT",
		"MATOU_ANYSYNC_CONFIG",
		"MATOU_API_TOKEN",
		"MATOU_CORS_MODE",
	} {
		t.Setenv(k, "")
	}
}

func TestOptionsFromEnv_Defaults(t *testing.T) {
	clearEnv(t)

	o, err := OptionsFromEnv()
	if err != nil {
		t.Fatalf("OptionsFromEnv() unexpected error: %v", err)
	}

	if o.IsTest() || o.IsProd() {
		t.Errorf("dev env: IsTest=%v IsProd=%v, want both false", o.IsTest(), o.IsProd())
	}
	if o.Env != "" {
		t.Errorf("Env = %q, want empty", o.Env)
	}
	if o.DataDir != "./data" {
		t.Errorf("DataDir = %q, want ./data", o.DataDir)
	}
	if o.Port != 8080 {
		t.Errorf("Port = %d, want 8080", o.Port)
	}
	if o.Host != "localhost" {
		t.Errorf("Host = %q, want localhost", o.Host)
	}
	if o.ConfigServerURL != "http://localhost:3904" {
		t.Errorf("ConfigServerURL = %q, want http://localhost:3904", o.ConfigServerURL)
	}
	if o.ConfigServerToken != "dev-insecure-local-only" {
		t.Errorf("ConfigServerToken = %q, want dev-insecure-local-only", o.ConfigServerToken)
	}
	if o.AnysyncConfigPath != "config/client-dev.yml" {
		t.Errorf("AnysyncConfigPath = %q, want config/client-dev.yml", o.AnysyncConfigPath)
	}
	if !o.PrintBanner {
		t.Errorf("PrintBanner = false, want true")
	}
	if o.APIToken != api.DevAPIToken {
		t.Errorf("APIToken = %q, want dev constant %q", o.APIToken, api.DevAPIToken)
	}
}

func TestOptionsFromEnv_TestMode(t *testing.T) {
	clearEnv(t)
	t.Setenv("MATOU_ENV", "test")

	o, err := OptionsFromEnv()
	if err != nil {
		t.Fatalf("OptionsFromEnv() unexpected error: %v", err)
	}

	if !o.IsTest() || o.IsProd() {
		t.Errorf("test env: IsTest=%v IsProd=%v, want true/false", o.IsTest(), o.IsProd())
	}
	if o.Port != 9080 {
		t.Errorf("Port = %d, want 9080", o.Port)
	}
	if o.ConfigServerURL != "http://localhost:4904" {
		t.Errorf("ConfigServerURL = %q, want http://localhost:4904", o.ConfigServerURL)
	}
	if o.DataDir != "./data-test" {
		t.Errorf("DataDir = %q, want ./data-test", o.DataDir)
	}
	if o.AnysyncConfigPath != "config/client-test.yml" {
		t.Errorf("AnysyncConfigPath = %q, want config/client-test.yml", o.AnysyncConfigPath)
	}
	if o.ConfigServerToken != "dev-insecure-local-only" {
		t.Errorf("ConfigServerToken = %q, want dev-insecure-local-only", o.ConfigServerToken)
	}
}

func TestOptionsFromEnv_ProductionRequiresConfigServer(t *testing.T) {
	clearEnv(t)
	t.Setenv("MATOU_ENV", "production")

	if _, err := OptionsFromEnv(); err == nil {
		t.Fatal("OptionsFromEnv() in production without MATOU_CONFIG_SERVER_URL: got nil error, want error")
	}
}

func TestOptionsFromEnv_Production(t *testing.T) {
	clearEnv(t)
	t.Setenv("MATOU_ENV", "production")
	t.Setenv("MATOU_CONFIG_SERVER_URL", "https://config.example.org")

	o, err := OptionsFromEnv()
	if err != nil {
		t.Fatalf("OptionsFromEnv() unexpected error: %v", err)
	}

	if o.IsTest() || !o.IsProd() {
		t.Errorf("prod env: IsTest=%v IsProd=%v, want false/true", o.IsTest(), o.IsProd())
	}
	if o.ConfigServerURL != "https://config.example.org" {
		t.Errorf("ConfigServerURL = %q, want the override", o.ConfigServerURL)
	}
	// Production never falls back to the dev placeholder token.
	if o.ConfigServerToken != "" {
		t.Errorf("ConfigServerToken = %q, want empty in production", o.ConfigServerToken)
	}
	if o.Port != 8080 {
		t.Errorf("Port = %d, want 8080", o.Port)
	}
	wantAny := filepath.Join("./data", "client-production.yml")
	if o.AnysyncConfigPath != wantAny {
		t.Errorf("AnysyncConfigPath = %q, want %q", o.AnysyncConfigPath, wantAny)
	}
	// No MATOU_API_TOKEN supplied: production generates a random token, never
	// the publicly known dev constant.
	if o.APIToken == "" || o.APIToken == api.DevAPIToken {
		t.Errorf("APIToken = %q, want a random non-dev token", o.APIToken)
	}
}

func TestOptionsFromEnv_Overrides(t *testing.T) {
	clearEnv(t)
	t.Setenv("MATOU_DATA_DIR", "/tmp/matou-data")
	t.Setenv("MATOU_SERVER_PORT", "12345")
	t.Setenv("MATOU_CONFIG_SERVER_URL", "http://cfg.local:9999")
	t.Setenv("MATOU_CONFIG_SERVER_TOKEN", "override-token")
	t.Setenv("MATOU_ANYSYNC_CONFIG", "/tmp/custom-anysync.yml")
	t.Setenv("MATOU_API_TOKEN", "supplied-token")

	o, err := OptionsFromEnv()
	if err != nil {
		t.Fatalf("OptionsFromEnv() unexpected error: %v", err)
	}

	if o.DataDir != "/tmp/matou-data" {
		t.Errorf("DataDir = %q, want /tmp/matou-data", o.DataDir)
	}
	if o.Port != 12345 {
		t.Errorf("Port = %d, want 12345", o.Port)
	}
	if o.ConfigServerURL != "http://cfg.local:9999" {
		t.Errorf("ConfigServerURL = %q, want the override", o.ConfigServerURL)
	}
	if o.ConfigServerToken != "override-token" {
		t.Errorf("ConfigServerToken = %q, want override-token", o.ConfigServerToken)
	}
	if o.AnysyncConfigPath != "/tmp/custom-anysync.yml" {
		t.Errorf("AnysyncConfigPath = %q, want the override", o.AnysyncConfigPath)
	}
	if o.APIToken != "supplied-token" {
		t.Errorf("APIToken = %q, want supplied-token", o.APIToken)
	}
}

func TestOptionsFromEnv_InvalidPort(t *testing.T) {
	clearEnv(t)
	t.Setenv("MATOU_SERVER_PORT", "not-a-number")

	if _, err := OptionsFromEnv(); err == nil {
		t.Fatal("OptionsFromEnv() with unparseable MATOU_SERVER_PORT: got nil error, want error")
	}
}
