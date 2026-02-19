package keri

import (
	"encoding/json"
	"fmt"
)

// Client provides KERI configuration and credential utilities.
// Note: Credential issuance is handled by the frontend via signify-ts.
// This client provides org info, role definitions, and credential validation.
type Client struct {
	orgAID   string
	orgAlias string
	orgName  string
}

// Config holds KERI client configuration
type Config struct {
	OrgAID   string
	OrgAlias string
	OrgName  string
}

// CredentialData contains ACDC credential attributes
type CredentialData struct {
	CommunityName      string   `json:"communityName"`
	Role               string   `json:"role"`
	VerificationStatus string   `json:"verificationStatus"`
	Permissions        []string `json:"permissions"`
	JoinedAt           string   `json:"joinedAt"`
	ExpiresAt          string   `json:"expiresAt,omitempty"`
}

// Credential represents an ACDC credential
type Credential struct {
	SAID      string         `json:"said"`
	Issuer    string         `json:"issuer"`
	Recipient string         `json:"recipient"`
	Schema    string         `json:"schema"`
	Data      CredentialData `json:"data"`
	Signature string         `json:"signature,omitempty"`
	Timestamp string         `json:"timestamp,omitempty"`
}

// OrgInfo contains organization information for the frontend
type OrgInfo struct {
	AID    string   `json:"aid"`
	Alias  string   `json:"alias"`
	Name   string   `json:"name"`
	Roles  []string `json:"roles"`
	Schema string   `json:"schema"`
}

// Schema SAIDs
const (
	MembershipSchemaSAID  = "EOVL3N0K_tYc9U-HXg7r2jDPo4Gnq3ebCjDqbJzl6fsT"
	EndorsementSchemaSAID = "EPIm7hiwSUt5css49iLXFPaPDFOJx0MmfNoB3PkSMXkh"
)

// EndorsementData contains endorsement credential attributes
type EndorsementData struct {
	EndorsementType string `json:"endorsementType"`
	Category        string `json:"category"`
	Claim           string `json:"claim"`
	Confidence      string `json:"confidence"`
	Evidence        string `json:"evidence,omitempty"`
	Relationship    string `json:"relationship,omitempty"`
}

// NewClient creates a new KERI client.
// OrgAID can be empty if org is not yet configured (will be set later via org config).
func NewClient(cfg *Config) (*Client, error) {
	if cfg == nil {
		return nil, fmt.Errorf("config is required")
	}
	// OrgAID is optional - allows server to start before org setup
	if cfg.OrgAlias == "" {
		cfg.OrgAlias = "matou-org"
	}
	if cfg.OrgName == "" {
		cfg.OrgName = "MATOU DAO"
	}

	return &Client{
		orgAID:   cfg.OrgAID,
		orgAlias: cfg.OrgAlias,
		orgName:  cfg.OrgName,
	}, nil
}

// GetOrgInfo returns organization information for the frontend
func (c *Client) GetOrgInfo() *OrgInfo {
	return &OrgInfo{
		AID:    c.orgAID,
		Alias:  c.orgAlias,
		Name:   c.orgName,
		Roles:  ValidRoles(),
		Schema: "EMatouMembershipSchemaV1",
	}
}

// GetOrgAID returns the organization AID
func (c *Client) GetOrgAID() string {
	return c.orgAID
}

// ValidateCredential performs basic validation on a credential
// Note: Cryptographic signature verification should be done by signify-ts
func (c *Client) ValidateCredential(cred *Credential) error {
	if cred == nil {
		return fmt.Errorf("credential is nil")
	}
	if cred.SAID == "" {
		return fmt.Errorf("credential SAID is required")
	}
	if cred.Issuer == "" {
		return fmt.Errorf("credential issuer is required")
	}
	if cred.Recipient == "" {
		return fmt.Errorf("credential recipient is required")
	}
	if cred.Schema == "" {
		return fmt.Errorf("credential schema is required")
	}
	if !IsValidRole(cred.Data.Role) {
		return fmt.Errorf("invalid role: %s", cred.Data.Role)
	}
	return nil
}

// ValidateCredentialJSON validates a credential from JSON
func (c *Client) ValidateCredentialJSON(credJSON string) (*Credential, error) {
	var cred Credential
	if err := json.Unmarshal([]byte(credJSON), &cred); err != nil {
		return nil, fmt.Errorf("invalid JSON: %w", err)
	}
	if err := c.ValidateCredential(&cred); err != nil {
		return nil, err
	}
	return &cred, nil
}

// IsOrgIssued checks if a credential was issued by this organization
func (c *Client) IsOrgIssued(cred *Credential) bool {
	return cred != nil && cred.Issuer == c.orgAID
}

// GetPermissionsForRole returns the permissions for a given role
func GetPermissionsForRole(role string) []string {
	permissions := map[string][]string{
		"Member":             {"read", "comment"},
		"Verified Member":    {"read", "comment", "vote"},
		"Trusted Member":     {"read", "comment", "vote", "propose"},
		"Expert Member":      {"read", "comment", "vote", "propose", "review"},
		"Contributor":        {"read", "comment", "vote", "contribute"},
		"Moderator":          {"read", "comment", "vote", "moderate"},
		"Admin":              {"read", "comment", "vote", "propose", "moderate", "admin"},
		"Operations Steward": {"read", "comment", "vote", "propose", "moderate", "admin", "issue_membership", "revoke_membership", "approve_registrations"},
	}

	if perms, ok := permissions[role]; ok {
		return perms
	}
	return []string{"read"}
}

// ValidRoles returns the list of valid membership roles
func ValidRoles() []string {
	return []string{
		"Member",
		"Verified Member",
		"Trusted Member",
		"Expert Member",
		"Contributor",
		"Moderator",
		"Admin",
		"Operations Steward",
	}
}

// IsValidRole checks if a role is valid
func IsValidRole(role string) bool {
	for _, r := range ValidRoles() {
		if r == role {
			return true
		}
	}
	return false
}
