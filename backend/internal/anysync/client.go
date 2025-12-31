package anysync

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"

	"gopkg.in/yaml.v3"
)

// Client provides access to any-sync infrastructure
type Client struct {
	coordinatorURL string
	networkID      string
	httpClient     *http.Client
}

// ClientConfig represents the any-sync client.yml structure
type ClientConfig struct {
	ID        string `yaml:"id"`
	NetworkID string `yaml:"networkId"`
	Nodes     []Node `yaml:"nodes"`
}

// Node represents a node in the any-sync network
type Node struct {
	PeerID    string   `yaml:"peerId"`
	Addresses []string `yaml:"addresses"`
	Types     []string `yaml:"types"`
}

// NewClient creates a new any-sync client
func NewClient(clientConfigPath string) (*Client, error) {
	// Load client configuration
	config, err := loadClientConfig(clientConfigPath)
	if err != nil {
		return nil, fmt.Errorf("loading client config: %w", err)
	}

	// Find coordinator URL
	coordinatorURL := findCoordinatorURL(config.Nodes)
	if coordinatorURL == "" {
		return nil, fmt.Errorf("coordinator not found in client config")
	}

	return &Client{
		coordinatorURL: coordinatorURL,
		networkID:      config.NetworkID,
		httpClient:     &http.Client{},
	}, nil
}

// loadClientConfig loads the any-sync client.yml file
func loadClientConfig(path string) (*ClientConfig, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading client config: %w", err)
	}

	var config ClientConfig
	if err := yaml.Unmarshal(data, &config); err != nil {
		return nil, fmt.Errorf("parsing client config: %w", err)
	}

	return &config, nil
}

// findCoordinatorURL extracts the coordinator HTTP URL from nodes
func findCoordinatorURL(nodes []Node) string {
	for _, node := range nodes {
		for _, nodeType := range node.Types {
			if nodeType == "coordinator" {
				// Find localhost/127.0.0.1 address first (for external access)
				for _, addr := range node.Addresses {
					if len(addr) > 4 && addr[:4] != "quic" {
						// Prefer localhost addresses for external access
						if len(addr) > 9 && (addr[:9] == "127.0.0.1" || addr[:9] == "localhost") {
							return "http://" + addr
						}
					}
				}
				// Fallback to any HTTP address
				for _, addr := range node.Addresses {
					if len(addr) > 4 && addr[:4] != "quic" {
						if addr[:4] == "http" {
							return addr
						}
						return "http://" + addr
					}
				}
			}
		}
	}
	return ""
}

// CreateSpaceRequest represents a space creation request
type CreateSpaceRequest struct {
	OwnerAID  string `json:"ownerAID"`
	SpaceType string `json:"spaceType"`
	SpaceName string `json:"spaceName"`
	Encrypted bool   `json:"encrypted"`
}

// CreateSpaceResponse represents a space creation response
type CreateSpaceResponse struct {
	SpaceID string `json:"spaceId"`
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
}

// CreateSpace creates a new space in any-sync
// Note: This is a placeholder implementation. The actual any-sync API
// requires proper SDK integration which will be completed in Week 2.
func (c *Client) CreateSpace(ownerAID, spaceType, spaceName string) (string, error) {
	req := CreateSpaceRequest{
		OwnerAID:  ownerAID,
		SpaceType: spaceType,
		SpaceName: spaceName,
		Encrypted: true,
	}

	body, err := json.Marshal(req)
	if err != nil {
		return "", fmt.Errorf("marshaling request: %w", err)
	}

	// Note: This endpoint may not exist in the current any-sync version
	// Actual implementation requires proper any-sync SDK
	resp, err := c.httpClient.Post(
		c.coordinatorURL+"/space/create",
		"application/json",
		bytes.NewReader(body),
	)
	if err != nil {
		return "", fmt.Errorf("creating space: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("reading response: %w", err)
	}

	var spaceResp CreateSpaceResponse
	if err := json.Unmarshal(respBody, &spaceResp); err != nil {
		// If response is not JSON, return raw response
		return "", fmt.Errorf("space creation response: %s (status: %d)", string(respBody), resp.StatusCode)
	}

	if !spaceResp.Success {
		return "", fmt.Errorf("space creation failed: %s", spaceResp.Error)
	}

	return spaceResp.SpaceID, nil
}

// GetNetworkID returns the any-sync network ID
func (c *Client) GetNetworkID() string {
	return c.networkID
}

// GetCoordinatorURL returns the coordinator URL
func (c *Client) GetCoordinatorURL() string {
	return c.coordinatorURL
}

// Ping tests connectivity to the coordinator
func (c *Client) Ping() error {
	resp, err := c.httpClient.Get(c.coordinatorURL + "/health")
	if err != nil {
		return fmt.Errorf("pinging coordinator: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		return fmt.Errorf("coordinator returned status %d", resp.StatusCode)
	}

	return nil
}
