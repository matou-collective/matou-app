// Package app holds the fully-resolved runtime configuration shared by every
// backend entrypoint. cmd/server resolves it from the process environment via
// OptionsFromEnv; cmd/mobile constructs Options in-process (no env vars, no
// log.Fatalf) so the same backend can boot inside a mobile host.
package app

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/matou-dao/backend/internal/api"
)

// Network and config-server defaults mirror config.Load's ServerConfig defaults
// and main.go's per-environment fallbacks. They live here so Options can be
// resolved without loading the on-disk config (cmd/mobile has neither the env
// nor the config files main.go relies on).
const (
	defaultHost = "localhost"
	defaultPort = 8080
	testPort    = 9080

	devConfigServerURL  = "http://localhost:3904"
	testConfigServerURL = "http://localhost:4904"

	// devConfigServerToken matches matou-infrastructure/keri's generate-env.sh
	// dev/test placeholder.
	devConfigServerToken = "dev-insecure-local-only"
)

// Options is the fully-resolved runtime configuration for the backend, holding
// every value main.go previously read directly from environment variables. It
// is a plain struct with no I/O so cmd/mobile can build it in-process while
// cmd/server keeps using OptionsFromEnv. OptionsFromEnv reproduces main.go's
// exact precedence and defaults, so desktop (Electron) behaviour is unchanged.
type Options struct {
	// Env is the raw MATOU_ENV value: "", "test", or "production".
	Env string
	// DataDir is the on-disk root for identity, org config and the api-token file.
	DataDir string
	// Port is the HTTP listen port.
	Port int
	// Host is the HTTP listen host.
	Host string
	// APIToken is the token TokenGuard requires on mutating requests.
	APIToken string
	// ConfigServerURL is the base URL used to fetch any-sync config and to
	// mirror org config / relay email.
	ConfigServerURL string
	// ConfigServerToken is the admin bearer token for authenticated config
	// server writes; empty in production when unset (writes then fail closed).
	ConfigServerToken string
	// AnysyncConfigPath is the any-sync client config file to load or fetch into.
	AnysyncConfigPath string
	// PrintBanner controls whether the startup banner is written to stdout.
	PrintBanner bool
	// KeyStateURL is the URL template (containing "{aid}") the signed-auth
	// key-state resolver fetches an AID's KEL from. Empty means derive it from
	// the KERI CESR URL in the loaded config ("{cesrUrl}/oobi/{aid}").
	KeyStateURL string
	// SessionTTL is the lifetime of a signed-auth session token; zero uses
	// auth.DefaultSessionTTL (30m). MATOU_AUTH_SESSION_TTL overrides it (a Go
	// duration, e.g. "4h") — the e2e harness lengthens it for long specs.
	SessionTTL time.Duration
}

// IsTest reports whether the backend is running in the isolated test env.
func (o Options) IsTest() bool { return o.Env == "test" }

// IsProd reports whether the backend is running in production (Electron bundle).
func (o Options) IsProd() bool { return o.Env == "production" }

// DefaultAnysyncConfigPath returns the any-sync client config path implied by
// the environment when MATOU_ANYSYNC_CONFIG is unset. Production caches the
// server-fetched config under the data dir; dev/test use the checked-in files.
func (o Options) DefaultAnysyncConfigPath() string {
	switch {
	case o.IsTest():
		return "config/client-test.yml"
	case o.IsProd():
		return filepath.Join(o.DataDir, "client-production.yml")
	default:
		return "config/client-dev.yml"
	}
}

// OptionsFromEnv resolves Options from the process environment, reproducing the
// precedence main.go used. It returns an error — rather than main.go's
// log.Fatalf — when production is missing MATOU_CONFIG_SERVER_URL or when
// MATOU_SERVER_PORT is unparseable, so callers (including cmd/mobile) decide how
// to surface it.
func OptionsFromEnv() (Options, error) {
	o := Options{
		Env:         os.Getenv("MATOU_ENV"),
		Host:        defaultHost,
		PrintBanner: true,
	}

	// Config server URL: explicit override wins; otherwise a per-env default,
	// except production which must be told explicitly.
	o.ConfigServerURL = os.Getenv("MATOU_CONFIG_SERVER_URL")
	if o.ConfigServerURL == "" {
		switch {
		case o.IsTest():
			o.ConfigServerURL = testConfigServerURL
		case o.IsProd():
			return Options{}, fmt.Errorf("MATOU_CONFIG_SERVER_URL is not set for production")
		default:
			o.ConfigServerURL = devConfigServerURL
		}
	}

	// Config server token: dev/test fall back to the shared placeholder;
	// production leaves it empty (main.go warns and degrades gracefully).
	o.ConfigServerToken = os.Getenv("MATOU_CONFIG_SERVER_TOKEN")
	if o.ConfigServerToken == "" && !o.IsProd() {
		o.ConfigServerToken = devConfigServerToken
	}

	// Data dir: explicit override wins; test uses an isolated directory.
	o.DataDir = os.Getenv("MATOU_DATA_DIR")
	if o.DataDir == "" {
		if o.IsTest() {
			o.DataDir = "./data-test"
		} else {
			o.DataDir = "./data"
		}
	}

	// Port: default mirrors config.Load; test shifts to 9080; MATOU_SERVER_PORT
	// overrides both (Electron allocates a dynamic port).
	o.Port = defaultPort
	if o.IsTest() {
		o.Port = testPort
	}
	if portStr := os.Getenv("MATOU_SERVER_PORT"); portStr != "" {
		port, err := strconv.Atoi(portStr)
		if err != nil {
			return Options{}, fmt.Errorf("invalid MATOU_SERVER_PORT %q: %w", portStr, err)
		}
		o.Port = port
	}

	// API token: MATOU_API_TOKEN, else a random token in bundled/production,
	// else the fixed dev constant (see api.ResolveAPIToken).
	o.APIToken = api.ResolveAPIToken()

	// Signed-auth key-state URL template (issue #18); empty derives from config.
	o.KeyStateURL = os.Getenv("MATOU_KERIA_KEYSTATE_URL")
	if ttlStr := os.Getenv("MATOU_AUTH_SESSION_TTL"); ttlStr != "" {
		ttl, err := time.ParseDuration(ttlStr)
		if err != nil || ttl <= 0 {
			return Options{}, fmt.Errorf("invalid MATOU_AUTH_SESSION_TTL %q: %v", ttlStr, err)
		}
		o.SessionTTL = ttl
	}

	// Any-sync config path: explicit override wins; otherwise the per-env default.
	o.AnysyncConfigPath = os.Getenv("MATOU_ANYSYNC_CONFIG")
	if o.AnysyncConfigPath == "" {
		o.AnysyncConfigPath = o.DefaultAnysyncConfigPath()
	}

	return o, nil
}
