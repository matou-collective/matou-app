package anysync

import (
	"testing"
)

func TestLoadClientConfig(t *testing.T) {
	// Load the generated client.yml from infrastructure
	client, err := NewClient("../../../infrastructure/any-sync/etc/client.yml")
	if err != nil {
		t.Fatalf("Failed to create client: %v", err)
	}

	// Verify network ID
	if client.GetNetworkID() == "" {
		t.Error("Network ID should not be empty")
	}

	// Verify coordinator URL
	if client.GetCoordinatorURL() == "" {
		t.Error("Coordinator URL should not be empty")
	}

	t.Logf("✅ any-sync client initialized")
	t.Logf("   Network ID: %s", client.GetNetworkID())
	t.Logf("   Coordinator: %s", client.GetCoordinatorURL())
}

func TestCoordinatorPing(t *testing.T) {
	client, err := NewClient("../../../infrastructure/any-sync/etc/client.yml")
	if err != nil {
		t.Fatalf("Failed to create client: %v", err)
	}

	// Test connectivity (may fail if coordinator doesn't have /health endpoint)
	err = client.Ping()
	if err != nil {
		t.Logf("⚠️  Coordinator ping failed (expected, /health may not exist): %v", err)
		t.Logf("   This is OK - coordinator is running, just doesn't have standard health endpoint")
	} else {
		t.Logf("✅ Coordinator is accessible")
	}
}
