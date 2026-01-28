// Package testnet provides utilities for managing the any-sync test network
// for integration testing. The test network runs on different ports from the
// dev network to provide complete isolation.
//
// Test Network Ports:
//   - Coordinator: 2004
//   - Sync Nodes: 2001-2003
//   - Consensus: 2006
//   - MongoDB: 28017
//   - Redis: 7379
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
	"runtime"
	"strings"
	"sync"
	"time"
)

// Network represents a running any-sync test network
type Network struct {
	ConfigPath    string
	CoordinatorURL string
	mu            sync.Mutex
	started       bool
	keepRunning   bool
}

// Config holds test network configuration
type Config struct {
	// KeepRunning prevents network shutdown after tests (env: KEEP_TEST_NETWORK=1)
	KeepRunning bool
	// StartupTimeout is the maximum time to wait for network to be ready
	StartupTimeout time.Duration
	// Verbose enables verbose logging
	Verbose bool
}

// DefaultConfig returns the default test network configuration
func DefaultConfig() *Config {
	return &Config{
		KeepRunning:    os.Getenv("KEEP_TEST_NETWORK") == "1",
		StartupTimeout: 120 * time.Second,
		Verbose:        os.Getenv("TEST_VERBOSE") == "1",
	}
}

// getInfrastructurePath returns the path to the test network infrastructure
func getInfrastructurePath() (string, error) {
	// Get the directory of this source file
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		return "", fmt.Errorf("failed to get caller info")
	}

	// Navigate from backend/internal/anysync/testnet to infrastructure/any-sync-test
	// backend/internal/anysync/testnet -> backend/internal/anysync -> backend/internal -> backend -> project root
	projectRoot := filepath.Join(filepath.Dir(filename), "..", "..", "..", "..")
	infraPath := filepath.Join(projectRoot, "infrastructure", "any-sync-test")

	// Verify it exists
	if _, err := os.Stat(infraPath); os.IsNotExist(err) {
		return "", fmt.Errorf("test network infrastructure not found at %s", infraPath)
	}

	return filepath.Abs(infraPath)
}

// Setup starts the test network and returns a Network handle.
// Call Teardown() when tests are complete (typically in TestMain).
func Setup() *Network {
	return SetupWithConfig(DefaultConfig())
}

// SetupWithConfig starts the test network with custom configuration
func SetupWithConfig(cfg *Config) *Network {
	infraPath, err := getInfrastructurePath()
	if err != nil {
		panic(fmt.Sprintf("testnet: %v", err))
	}

	network := &Network{
		ConfigPath:     filepath.Join(infraPath, "client-host.yml"),
		CoordinatorURL: "localhost:2004",
		keepRunning:    cfg.KeepRunning,
	}

	// Check if already running
	if network.isRunning(infraPath) {
		if cfg.Verbose {
			fmt.Println("testnet: network already running")
		}
		network.started = false // We didn't start it, so don't stop it
		return network
	}

	// Start the network
	if cfg.Verbose {
		fmt.Println("testnet: starting network...")
	}

	ctx, cancel := context.WithTimeout(context.Background(), cfg.StartupTimeout)
	defer cancel()

	if err := network.start(ctx, infraPath, cfg.Verbose); err != nil {
		panic(fmt.Sprintf("testnet: failed to start network: %v", err))
	}

	network.started = true
	if cfg.Verbose {
		fmt.Println("testnet: network ready")
	}

	return network
}

// isRunning checks if the test network is already running
func (n *Network) isRunning(infraPath string) bool {
	cmd := exec.Command("make", "-s", "is-running")
	cmd.Dir = infraPath
	output, err := cmd.Output()
	if err != nil {
		return false
	}
	return strings.TrimSpace(string(output)) == "true"
}

// start starts the test network and waits for it to be ready
func (n *Network) start(ctx context.Context, infraPath string, verbose bool) error {
	n.mu.Lock()
	defer n.mu.Unlock()

	// Run make start-and-wait
	cmd := exec.CommandContext(ctx, "make", "start-and-wait")
	cmd.Dir = infraPath

	if verbose {
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
	}

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to start network: %w", err)
	}

	// Verify config file exists
	if _, err := os.Stat(n.ConfigPath); os.IsNotExist(err) {
		return fmt.Errorf("config file not generated at %s", n.ConfigPath)
	}

	return nil
}

// Teardown stops the test network unless KeepRunning was set or
// the network was already running when Setup was called.
func (n *Network) Teardown() {
	if !n.started {
		// We didn't start it, so don't stop it
		return
	}

	if n.keepRunning {
		fmt.Println("testnet: keeping network running (KEEP_TEST_NETWORK=1)")
		return
	}

	infraPath, err := getInfrastructurePath()
	if err != nil {
		fmt.Printf("testnet: warning: could not get infrastructure path: %v\n", err)
		return
	}

	n.mu.Lock()
	defer n.mu.Unlock()

	fmt.Println("testnet: stopping network...")
	cmd := exec.Command("make", "down")
	cmd.Dir = infraPath
	if err := cmd.Run(); err != nil {
		fmt.Printf("testnet: warning: failed to stop network: %v\n", err)
	}
}

// Clean stops the network and removes all data (for fresh test runs)
func (n *Network) Clean() error {
	infraPath, err := getInfrastructurePath()
	if err != nil {
		return err
	}

	n.mu.Lock()
	defer n.mu.Unlock()

	cmd := exec.Command("make", "clean")
	cmd.Dir = infraPath
	return cmd.Run()
}

// GetHostConfigPath returns the path to client config with localhost addresses
func (n *Network) GetHostConfigPath() string {
	return n.ConfigPath
}

// GetCoordinatorURL returns the test network coordinator URL
func (n *Network) GetCoordinatorURL() string {
	return n.CoordinatorURL
}

// NetworkID returns the test network ID (read from config)
func (n *Network) NetworkID() (string, error) {
	// The network ID is generated during config generation
	// For now, return a placeholder - in production, parse from client.yml
	return "test-network", nil
}

// WaitForReady waits for the network to be ready
func (n *Network) WaitForReady(ctx context.Context) error {
	infraPath, err := getInfrastructurePath()
	if err != nil {
		return err
	}

	cmd := exec.CommandContext(ctx, "make", "wait")
	cmd.Dir = infraPath
	return cmd.Run()
}

// IsHealthy checks if the network is healthy
func (n *Network) IsHealthy() bool {
	infraPath, err := getInfrastructurePath()
	if err != nil {
		return false
	}

	cmd := exec.Command("make", "-s", "ready")
	cmd.Dir = infraPath
	output, err := cmd.Output()
	if err != nil {
		return false
	}
	return strings.TrimSpace(string(output)) == "ready"
}

// RequireNetwork is a helper that panics if network is not healthy
// Use at the start of integration tests
func (n *Network) RequireNetwork() {
	if !n.IsHealthy() {
		panic("testnet: network is not healthy")
	}
}
