package keri

import (
	"testing"
)

func TestGetPermissionsForRole(t *testing.T) {
	tests := []struct {
		role            string
		expectedMinPerm int
		hasPermission   string
	}{
		{"Member", 2, "read"},
		{"Verified Member", 3, "vote"},
		{"Admin", 6, "admin"},
		{"Operations Steward", 9, "issue_membership"},
		{"Unknown", 1, "read"},
	}

	for _, tt := range tests {
		t.Run(tt.role, func(t *testing.T) {
			perms := GetPermissionsForRole(tt.role)
			if len(perms) < tt.expectedMinPerm {
				t.Errorf("expected at least %d permissions, got %d", tt.expectedMinPerm, len(perms))
			}

			found := false
			for _, p := range perms {
				if p == tt.hasPermission {
					found = true
					break
				}
			}
			if !found {
				t.Errorf("expected permission %s not found in %v", tt.hasPermission, perms)
			}
		})
	}
}

func TestValidRoles(t *testing.T) {
	roles := ValidRoles()
	if len(roles) != 8 {
		t.Errorf("expected 8 roles, got %d", len(roles))
	}

	expected := []string{
		"Member",
		"Verified Member",
		"Operations Steward",
	}

	for _, e := range expected {
		found := false
		for _, r := range roles {
			if r == e {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("expected role %s not found", e)
		}
	}
}

func TestIsValidRole(t *testing.T) {
	tests := []struct {
		role  string
		valid bool
	}{
		{"Member", true},
		{"Admin", true},
		{"Operations Steward", true},
		{"SuperAdmin", false},
		{"", false},
		{"member", false}, // case sensitive
	}

	for _, tt := range tests {
		t.Run(tt.role, func(t *testing.T) {
			if got := IsValidRole(tt.role); got != tt.valid {
				t.Errorf("IsValidRole(%s) = %v, want %v", tt.role, got, tt.valid)
			}
		})
	}
}

func TestNewClient(t *testing.T) {
	tests := []struct {
		name    string
		cfg     *Config
		wantErr bool
	}{
		{
			name:    "nil config",
			cfg:     nil,
			wantErr: true,
		},
		{
			name: "missing org AID",
			cfg: &Config{
				OrgAlias: "test-alias",
			},
			wantErr: false,
		},
		{
			name: "valid config with AID only",
			cfg: &Config{
				OrgAID: "EAID123456789",
			},
			wantErr: false,
		},
		{
			name: "valid config with all fields",
			cfg: &Config{
				OrgAID:   "EAID123456789",
				OrgAlias: "custom-alias",
				OrgName:  "Custom Org",
			},
			wantErr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client, err := NewClient(tt.cfg)
			if (err != nil) != tt.wantErr {
				t.Errorf("NewClient() error = %v, wantErr %v", err, tt.wantErr)
				return
			}
			if !tt.wantErr && client == nil {
				t.Error("NewClient() returned nil client without error")
			}
		})
	}
}

func TestGetOrgInfo(t *testing.T) {
	client, err := NewClient(&Config{
		OrgAID:   "EAID123456789",
		OrgAlias: "test-org",
		OrgName:  "Test Organization",
	})
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	info := client.GetOrgInfo()
	if info.AID != "EAID123456789" {
		t.Errorf("expected AID EAID123456789, got %s", info.AID)
	}
	if info.Alias != "test-org" {
		t.Errorf("expected alias test-org, got %s", info.Alias)
	}
	if info.Name != "Test Organization" {
		t.Errorf("expected name Test Organization, got %s", info.Name)
	}
	if len(info.Roles) != 8 {
		t.Errorf("expected 8 roles, got %d", len(info.Roles))
	}
}

func TestValidateCredential(t *testing.T) {
	client, _ := NewClient(&Config{OrgAID: "EAID123456789"})

	tests := []struct {
		name    string
		cred    *Credential
		wantErr bool
	}{
		{
			name:    "nil credential",
			cred:    nil,
			wantErr: true,
		},
		{
			name:    "empty credential",
			cred:    &Credential{},
			wantErr: true,
		},
		{
			name: "missing SAID",
			cred: &Credential{
				Issuer:    "issuer",
				Recipient: "recipient",
				Schema:    "schema",
				Data:      CredentialData{Role: "Member"},
			},
			wantErr: true,
		},
		{
			name: "invalid role",
			cred: &Credential{
				SAID:      "said",
				Issuer:    "issuer",
				Recipient: "recipient",
				Schema:    "schema",
				Data:      CredentialData{Role: "InvalidRole"},
			},
			wantErr: true,
		},
		{
			name: "valid credential",
			cred: &Credential{
				SAID:      "ESAID123",
				Issuer:    "EAID123456789",
				Recipient: "ERECIPIENT123",
				Schema:    "EMatouMembershipSchemaV1",
				Data: CredentialData{
					CommunityName:      "MATOU",
					Role:               "Member",
					VerificationStatus: "unverified",
					Permissions:        []string{"read", "comment"},
					JoinedAt:           "2026-01-18T00:00:00Z",
				},
			},
			wantErr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := client.ValidateCredential(tt.cred)
			if (err != nil) != tt.wantErr {
				t.Errorf("ValidateCredential() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestIsOrgIssued(t *testing.T) {
	client, _ := NewClient(&Config{OrgAID: "EAID123456789"})

	tests := []struct {
		name     string
		cred     *Credential
		expected bool
	}{
		{
			name:     "nil credential",
			cred:     nil,
			expected: false,
		},
		{
			name: "different issuer",
			cred: &Credential{
				Issuer: "OTHER_AID",
			},
			expected: false,
		},
		{
			name: "matching issuer",
			cred: &Credential{
				Issuer: "EAID123456789",
			},
			expected: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := client.IsOrgIssued(tt.cred); got != tt.expected {
				t.Errorf("IsOrgIssued() = %v, want %v", got, tt.expected)
			}
		})
	}
}

func TestValidateCredentialJSON(t *testing.T) {
	client, _ := NewClient(&Config{OrgAID: "EAID123456789"})

	validJSON := `{
		"said": "ESAID123",
		"issuer": "EAID123456789",
		"recipient": "ERECIPIENT123",
		"schema": "EMatouMembershipSchemaV1",
		"data": {
			"communityName": "MATOU",
			"role": "Member",
			"verificationStatus": "unverified",
			"permissions": ["read", "comment"],
			"joinedAt": "2026-01-18T00:00:00Z"
		}
	}`

	cred, err := client.ValidateCredentialJSON(validJSON)
	if err != nil {
		t.Fatalf("ValidateCredentialJSON() error = %v", err)
	}
	if cred.SAID != "ESAID123" {
		t.Errorf("expected SAID ESAID123, got %s", cred.SAID)
	}

	// Test invalid JSON
	_, err = client.ValidateCredentialJSON("{invalid}")
	if err == nil {
		t.Error("expected error for invalid JSON")
	}
}
