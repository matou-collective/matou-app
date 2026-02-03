// Package testnet provides utilities for managing the KERIA test infrastructure
// for integration testing. It auto-starts/stops the KERI infrastructure
// (KERIA, witnesses, schema server, config server) using the existing
// infrastructure/keri/ Docker Compose setup (test targets).
//
// Test Network Ports (offset +1000 from dev):
//   - KERIA Admin: 4901
//   - KERIA CESR:  4902
//   - KERIA Boot:  4903
//   - Config Server: 4904
//   - Witnesses: 6643, 6645, 6647
//   - Schema Server: 8723
//
// Usage:
//
//	func TestMain(m *testing.M) {
//	    network := testnet.Setup()
//	    code := m.Run()
//	    network.Teardown()
//	    os.Exit(code)
//	}
package testnet

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Network represents a running KERIA test infrastructure
type Network struct {
	AdminURL    string // http://localhost:4901
	BootURL     string // http://localhost:4903
	CESRURL     string // http://localhost:4902
	ConfigURL   string // http://localhost:4904
	SchemaURL   string // http://localhost:8723
	mu          sync.Mutex
	started     bool
	keepRunning bool
}

// Config holds test network configuration
type Config struct {
	// KeepRunning prevents network shutdown after tests (env: KEEP_KERIA_NETWORK=1)
	KeepRunning bool
	// StartupTimeout is the maximum time to wait for network to be ready
	StartupTimeout time.Duration
	// Verbose enables verbose logging
	Verbose bool
}

// DefaultConfig returns the default test network configuration
func DefaultConfig() *Config {
	return &Config{
		KeepRunning:    os.Getenv("KEEP_KERIA_NETWORK") == "1",
		StartupTimeout: 120 * time.Second,
		Verbose:        os.Getenv("TEST_VERBOSE") == "1",
	}
}

// getInfrastructurePath returns the path to the KERI infrastructure directory
func getInfrastructurePath() (string, error) {
	p := os.Getenv("MATOU_KERI_INFRA_DIR")
	if p == "" {
		return "", fmt.Errorf("MATOU_KERI_INFRA_DIR not set (path to KERI infrastructure)")
	}
	if _, err := os.Stat(p); os.IsNotExist(err) {
		return "", fmt.Errorf("KERI infrastructure not found at %s", p)
	}
	return filepath.Abs(p)
}

// Setup starts the KERI infrastructure and returns a Network handle.
// Call Teardown() when tests are complete (typically in TestMain).
func Setup() *Network {
	return SetupWithConfig(DefaultConfig())
}

// SetupWithConfig starts the KERI infrastructure with custom configuration
func SetupWithConfig(cfg *Config) *Network {
	infraPath, err := getInfrastructurePath()
	if err != nil {
		panic(fmt.Sprintf("testnet: %v", err))
	}

	network := &Network{
		AdminURL:    "http://localhost:4901",
		BootURL:     "http://localhost:4903",
		CESRURL:     "http://localhost:4902",
		ConfigURL:   "http://localhost:4904",
		SchemaURL:   "http://localhost:8723",
		keepRunning: cfg.KeepRunning,
	}

	// Check if already running
	if network.isRunning(infraPath) {
		if cfg.Verbose {
			fmt.Println("testnet: KERI infrastructure already running")
		}
		network.started = false // We didn't start it, so don't stop it
		return network
	}

	// Start the infrastructure
	if cfg.Verbose {
		fmt.Println("testnet: starting KERI infrastructure...")
	}

	ctx, cancel := context.WithTimeout(context.Background(), cfg.StartupTimeout)
	defer cancel()

	if err := network.start(ctx, infraPath, cfg.Verbose); err != nil {
		panic(fmt.Sprintf("testnet: failed to start KERI infrastructure: %v", err))
	}

	network.started = true
	if cfg.Verbose {
		fmt.Println("testnet: KERI infrastructure ready")
	}

	return network
}

// isRunning checks if the KERI infrastructure is already running
func (n *Network) isRunning(infraPath string) bool {
	cmd := exec.Command("make", "-s", "is-running-test")
	cmd.Dir = infraPath
	output, err := cmd.Output()
	if err != nil {
		return false
	}
	return strings.TrimSpace(string(output)) == "true"
}

// start starts the KERI infrastructure and waits for it to be ready
func (n *Network) start(ctx context.Context, infraPath string, verbose bool) error {
	n.mu.Lock()
	defer n.mu.Unlock()

	cmd := exec.CommandContext(ctx, "make", "start-and-wait-test")
	cmd.Dir = infraPath

	if verbose {
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
	}

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to start KERI infrastructure: %w", err)
	}

	return nil
}

// Teardown stops the KERI infrastructure unless KeepRunning was set or
// the infrastructure was already running when Setup was called.
func (n *Network) Teardown() {
	if !n.started {
		return
	}

	if n.keepRunning {
		fmt.Println("testnet: keeping KERI infrastructure running (KEEP_KERIA_NETWORK=1)")
		return
	}

	infraPath, err := getInfrastructurePath()
	if err != nil {
		fmt.Printf("testnet: warning: could not get infrastructure path: %v\n", err)
		return
	}

	n.mu.Lock()
	defer n.mu.Unlock()

	fmt.Println("testnet: stopping KERI infrastructure...")
	cmd := exec.Command("make", "down-test")
	cmd.Dir = infraPath
	if err := cmd.Run(); err != nil {
		fmt.Printf("testnet: warning: failed to stop KERI infrastructure: %v\n", err)
	}
}

// Clean stops the infrastructure and removes all data (for fresh test runs)
func (n *Network) Clean() error {
	infraPath, err := getInfrastructurePath()
	if err != nil {
		return err
	}

	n.mu.Lock()
	defer n.mu.Unlock()

	cmd := exec.Command("make", "clean-test")
	cmd.Dir = infraPath
	return cmd.Run()
}

// IsHealthy checks if the KERI infrastructure is healthy
func (n *Network) IsHealthy() bool {
	infraPath, err := getInfrastructurePath()
	if err != nil {
		return false
	}

	cmd := exec.Command("make", "-s", "ready-test")
	cmd.Dir = infraPath
	output, err := cmd.Output()
	if err != nil {
		return false
	}
	return strings.TrimSpace(string(output)) == "ready"
}

// RequireNetwork panics if the KERI infrastructure is not healthy.
// Use at the start of integration tests.
func (n *Network) RequireNetwork() {
	if !n.IsHealthy() {
		panic("testnet: KERI infrastructure is not healthy")
	}
}

// WaitForReady waits for the KERI infrastructure to be ready
func (n *Network) WaitForReady(ctx context.Context) error {
	infraPath, err := getInfrastructurePath()
	if err != nil {
		return err
	}

	cmd := exec.CommandContext(ctx, "make", "wait-test")
	cmd.Dir = infraPath
	return cmd.Run()
}

// GetAdminURL returns the KERIA admin API URL
func (n *Network) GetAdminURL() string {
	return n.AdminURL
}

// GetBootURL returns the KERIA boot API URL
func (n *Network) GetBootURL() string {
	return n.BootURL
}

// GetCESRURL returns the KERIA CESR API URL
func (n *Network) GetCESRURL() string {
	return n.CESRURL
}

// GetConfigURL returns the config server URL
func (n *Network) GetConfigURL() string {
	return n.ConfigURL
}

// GetSchemaURL returns the schema server URL
func (n *Network) GetSchemaURL() string {
	return n.SchemaURL
}
