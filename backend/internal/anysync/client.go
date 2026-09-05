// Package anysync provides any-sync integration for MATOU.
// This file contains shared types and utilities used by SDKClient.
package anysync

import (
	"fmt"
	"os"
	"time"

	"github.com/anyproto/any-sync/nodeconf"
	"gopkg.in/yaml.v3"
)

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

// ClientOptions holds configuration for the client
type ClientOptions struct {
	// DataDir is the directory for local storage
	DataDir string
	// PeerKeyPath is the path to store/load the peer key
	PeerKeyPath string
	// Mnemonic for deterministic key derivation (optional)
	Mnemonic string
	// KeyIndex for mnemonic derivation (default 0)
	KeyIndex uint32
	// EncryptionKey, when non-empty, seals the space read keys
	// ({dataDir}/keys/*.keys) and peer keys ({dataDir}/peer.key) at rest with
	// AES-256-GCM — the same shell-supplied key that protects identity.json
	// (issue #117). Empty keeps the legacy plaintext format for dev/test and
	// any not-yet-wired shell.
	EncryptionKey []byte
}

// SpaceCreateResult contains the result of space creation
type SpaceCreateResult struct {
	SpaceID   string       `json:"spaceId"`
	CreatedAt time.Time    `json:"createdAt"`
	OwnerAID  string       `json:"ownerAid"`
	SpaceType string       `json:"spaceType"`
	Keys      *SpaceKeySet `json:"-"` // In-memory only, not serialized
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

// findCoordinatorURL extracts the coordinator address from nodes
func findCoordinatorURL(nodes []Node) string {
	for _, node := range nodes {
		for _, nodeType := range node.Types {
			if nodeType == "coordinator" {
				if len(node.Addresses) > 0 {
					return node.Addresses[0]
				}
			}
		}
	}
	return ""
}

// nodeTypesToProto converts string node types to nodeconf.NodeType
func nodeTypesToProto(types []string) []nodeconf.NodeType {
	var result []nodeconf.NodeType
	for _, t := range types {
		switch t {
		case "tree":
			result = append(result, nodeconf.NodeTypeTree)
		case "coordinator":
			result = append(result, nodeconf.NodeTypeCoordinator)
		case "file":
			result = append(result, nodeconf.NodeTypeFile)
		case "consensus":
			result = append(result, nodeconf.NodeTypeConsensus)
		}
	}
	return result
}
