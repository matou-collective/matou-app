package types

// ProfileTypeDefinitions returns the built-in profile type definitions.
func ProfileTypeDefinitions() []*TypeDefinition {
	return []*TypeDefinition{
		PrivateProfileType(),
		SharedProfileType(),
		CommunityProfileType(),
		AdminOnlyProfileType(),
		OrgProfileType(),
	}
}

// PrivateProfileType returns the PrivateProfile type definition.
// Stored in the user's personal space — owner-only read/write.
func PrivateProfileType() *TypeDefinition {
	return &TypeDefinition{
		Name:        "PrivateProfile",
		Version:     1,
		Description: "Private user preferences and settings, visible only to the owner",
		Space:       "private",
		Fields: []FieldDef{
			{Name: "membershipCredentialSAID", Type: "string", Required: true, ReadOnly: true,
				UIHints: &UIHints{Label: "Membership Credential", Section: "membership"}},
			{Name: "privacySettings", Type: "object",
				UIHints: &UIHints{Label: "Privacy Settings", Section: "privacy"}},
			{Name: "appPreferences", Type: "object",
				UIHints: &UIHints{Label: "App Preferences", Section: "preferences"}},
		},
		Layouts: map[string]Layout{
			"form": {Fields: []string{"privacySettings", "appPreferences"}},
		},
		Permissions: TypePermissions{
			Read:  "owner",
			Write: "owner",
		},
	}
}

// SharedProfileType returns the SharedProfile type definition.
// Stored in the community space — owner writes, all members read.
func SharedProfileType() *TypeDefinition {
	maxBio := 500
	maxJoinReason := 500
	maxCustomInterests := 300
	maxIndigenousCommunity := 200
	minDisplayName := 2
	maxDisplayName := 100
	maxSocialLink := 500

	return &TypeDefinition{
		Name:        "SharedProfile",
		Version:     1,
		Description: "Public profile visible to all community members",
		Space:       "community",
		Fields: []FieldDef{
			{Name: "aid", Type: "string", Required: true, ReadOnly: true,
				UIHints: &UIHints{Label: "AID", Section: "identity"}},
			{Name: "publicPeerSignkey", Type: "string", ReadOnly: true,
				UIHints: &UIHints{Label: "Public Signing Key", Section: "identity"}},
			{Name: "displayName", Type: "string", Required: true,
				Validation: &Validation{MinLength: &minDisplayName, MaxLength: &maxDisplayName},
				UIHints:    &UIHints{InputType: "text", Label: "Display Name", Placeholder: "Your display name", Section: "profile"}},
			{Name: "bio", Type: "string",
				Validation: &Validation{MaxLength: &maxBio},
				UIHints:    &UIHints{InputType: "textarea", Label: "About You", Placeholder: "Tell us a bit about yourself...", Section: "profile"}},
			{Name: "avatar", Type: "string",
				UIHints: &UIHints{InputType: "image-upload", DisplayFormat: "avatar", Label: "Profile Photo", Section: "profile"}},
			{Name: "location", Type: "string",
				UIHints: &UIHints{InputType: "text", Label: "Location", Placeholder: "City, Country", Section: "profile"}},
			{Name: "joinReason", Type: "string",
				Validation: &Validation{MaxLength: &maxJoinReason},
				UIHints:    &UIHints{InputType: "textarea", Label: "Why do you want to join?", Placeholder: "Share what brings you to Matou and what you hope to contribute...", Section: "profile"}},
			{Name: "indigenousCommunity", Type: "string",
				Validation: &Validation{MaxLength: &maxIndigenousCommunity},
				UIHints:    &UIHints{InputType: "text", Label: "Indigenous Community", Placeholder: "Indigenous community you connect to", Section: "profile"}},
			{Name: "participationInterests", Type: "array",
				UIHints: &UIHints{InputType: "tags", DisplayFormat: "chip-list", Label: "Participation Interests", Section: "interests"}},
			{Name: "customInterests", Type: "string",
				Validation: &Validation{MaxLength: &maxCustomInterests},
				UIHints:    &UIHints{InputType: "textarea", Label: "Custom Interests", Section: "interests"}},
			{Name: "skills", Type: "array",
				UIHints: &UIHints{InputType: "tags", DisplayFormat: "chip-list", Label: "Skills", Section: "interests"}},
			{Name: "languages", Type: "array",
				UIHints: &UIHints{InputType: "tags", DisplayFormat: "chip-list", Label: "Languages", Section: "interests"}},
			{Name: "publicEmail", Type: "string",
				UIHints: &UIHints{InputType: "text", Label: "Public Email", Placeholder: "email@example.com", Section: "contact"}},
			{Name: "publicLinks", Type: "array",
				UIHints: &UIHints{InputType: "tags", DisplayFormat: "link", Label: "Public Links", Section: "contact"}},
			{Name: "facebookUrl", Type: "string",
				Validation: &Validation{MaxLength: &maxSocialLink},
				UIHints:    &UIHints{InputType: "text", Label: "Facebook", Placeholder: "https://facebook.com/username", Section: "social"}},
			{Name: "linkedinUrl", Type: "string",
				Validation: &Validation{MaxLength: &maxSocialLink},
				UIHints:    &UIHints{InputType: "text", Label: "LinkedIn", Placeholder: "https://linkedin.com/in/username", Section: "social"}},
			{Name: "twitterUrl", Type: "string",
				Validation: &Validation{MaxLength: &maxSocialLink},
				UIHints:    &UIHints{InputType: "text", Label: "X (Twitter)", Placeholder: "https://x.com/username", Section: "social"}},
			{Name: "instagramUrl", Type: "string",
				Validation: &Validation{MaxLength: &maxSocialLink},
				UIHints:    &UIHints{InputType: "text", Label: "Instagram", Placeholder: "https://instagram.com/username", Section: "social"}},
			{Name: "githubUrl", Type: "string",
				Validation: &Validation{MaxLength: &maxSocialLink},
				UIHints:    &UIHints{InputType: "text", Label: "GitHub", Placeholder: "https://github.com/username", Section: "social"}},
			{Name: "gitlabUrl", Type: "string",
				Validation: &Validation{MaxLength: &maxSocialLink},
				UIHints:    &UIHints{InputType: "text", Label: "GitLab", Placeholder: "https://gitlab.com/username", Section: "social"}},
			{Name: "lastActiveAt", Type: "datetime", ReadOnly: true,
				UIHints: &UIHints{DisplayFormat: "relative-date", Label: "Last Active"}},
			{Name: "createdAt", Type: "datetime", ReadOnly: true,
				UIHints: &UIHints{DisplayFormat: "relative-date", Label: "Created"}},
			{Name: "updatedAt", Type: "datetime", ReadOnly: true,
				UIHints: &UIHints{DisplayFormat: "relative-date", Label: "Updated"}},
			{Name: "typeVersion", Type: "number", ReadOnly: true},
		},
		Layouts: map[string]Layout{
			"card":   {Fields: []string{"avatar", "displayName"}},
			"detail": {Fields: []string{"avatar", "displayName", "bio", "location", "indigenousCommunity", "joinReason", "participationInterests", "customInterests", "skills", "languages", "publicEmail", "publicLinks", "facebookUrl", "linkedinUrl", "twitterUrl", "instagramUrl", "githubUrl", "gitlabUrl", "lastActiveAt", "createdAt"}},
			"form":   {Fields: []string{"displayName", "bio", "avatar", "location", "indigenousCommunity", "joinReason", "participationInterests", "customInterests", "skills", "languages", "publicEmail", "publicLinks", "facebookUrl", "linkedinUrl", "twitterUrl", "instagramUrl", "githubUrl", "gitlabUrl"}},
		},
		Permissions: TypePermissions{
			Read:  "community",
			Write: "owner",
		},
	}
}

// CommunityProfileType returns the CommunityProfile type definition.
// Stored in the community read-only space — admins write, all members read.
func CommunityProfileType() *TypeDefinition {
	return &TypeDefinition{
		Name:        "CommunityProfile",
		Version:     1,
		Description: "Admin-managed community membership profile",
		Space:       "community-readonly",
		Fields: []FieldDef{
			{Name: "userAID", Type: "string",
				UIHints: &UIHints{Label: "User AID", Section: "identity"}},
			{Name: "credential", Type: "string", Required: true, ReadOnly: true,
				UIHints: &UIHints{Label: "Membership Credential SAID", Section: "membership"}},
			{Name: "role", Type: "string", Required: true,
				Validation: &Validation{Enum: []string{"Member", "Operations Steward", "Moderator", "Elder"}},
				UIHints:    &UIHints{DisplayFormat: "badge", Label: "Role", Section: "membership"}},
			{Name: "memberSince", Type: "datetime", ReadOnly: true,
				UIHints: &UIHints{DisplayFormat: "relative-date", Label: "Member Since", Section: "membership"}},
			{Name: "lastActiveAt", Type: "datetime", ReadOnly: true,
				UIHints: &UIHints{DisplayFormat: "relative-date", Label: "Last Active"}},
			{Name: "credentials", Type: "array",
				UIHints: &UIHints{DisplayFormat: "chip-list", Label: "Community Credentials", Section: "credentials"}},
			{Name: "adminNotes", Type: "string",
				UIHints: &UIHints{InputType: "textarea", Label: "Admin Notes", Section: "admin"}},
			{Name: "flags", Type: "array",
				UIHints: &UIHints{DisplayFormat: "chip-list", Label: "Flags", Section: "admin"}},
			{Name: "permissions", Type: "array",
				UIHints: &UIHints{DisplayFormat: "chip-list", Label: "Permissions", Section: "admin"}},
			{Name: "communityCredentials", Type: "array",
				UIHints: &UIHints{DisplayFormat: "chip-list", Label: "Community Credentials", Section: "credentials"}},
		},
		Layouts: map[string]Layout{
			"card":   {Fields: []string{"role", "memberSince"}},
			"detail": {Fields: []string{"role", "memberSince", "lastActiveAt", "credentials", "permissions"}},
		},
		Permissions: TypePermissions{
			Read:  "community",
			Write: "admin",
		},
	}
}

// AdminOnlyProfileType returns the AdminOnlyProfile type definition.
// Stored in the admin space — admin-only read/write.
func AdminOnlyProfileType() *TypeDefinition {
	return &TypeDefinition{
		Name:        "AdminOnlyProfile",
		Version:     1,
		Description: "Admin-only profile data for moderation and audit purposes",
		Space:       "admin",
		Fields: []FieldDef{
			{Name: "userAID", Type: "string", Required: true,
				UIHints: &UIHints{Label: "User AID", Section: "identity"}},
			{Name: "moderationHistory", Type: "array",
				UIHints: &UIHints{Label: "Moderation History", Section: "moderation"}},
			{Name: "riskIndicators", Type: "array",
				UIHints: &UIHints{DisplayFormat: "chip-list", Label: "Risk Indicators", Section: "moderation"}},
			{Name: "auditLog", Type: "array",
				UIHints: &UIHints{Label: "Audit Log", Section: "audit"}},
		},
		Layouts: map[string]Layout{
			"detail": {Fields: []string{"userAID", "moderationHistory", "riskIndicators", "auditLog"}},
		},
		Permissions: TypePermissions{
			Read:  "admin",
			Write: "admin",
		},
	}
}

// OrgProfileType returns the OrgProfile type definition.
// Stored in the community read-only space — visible to all members, writable by admins.
func OrgProfileType() *TypeDefinition {
	return &TypeDefinition{
		Name:        "OrgProfile",
		Version:     1,
		Description: "Community organization profile, visible to all members",
		Space:       "community-readonly",
		Fields: []FieldDef{
			{Name: "communityName", Type: "string", Required: true,
				UIHints: &UIHints{Label: "Community Name", Section: "identity"}},
			{Name: "description", Type: "string",
				UIHints: &UIHints{InputType: "textarea", Label: "Description", Section: "identity"}},
			{Name: "logo", Type: "string",
				UIHints: &UIHints{InputType: "image-upload", DisplayFormat: "avatar", Label: "Logo", Section: "identity"}},
			{Name: "contactEmail", Type: "string",
				UIHints: &UIHints{InputType: "text", Label: "Contact Email", Section: "contact"}},
			{Name: "website", Type: "string",
				UIHints: &UIHints{InputType: "text", Label: "Website", Section: "contact"}},
			{Name: "createdAt", Type: "datetime", ReadOnly: true,
				UIHints: &UIHints{DisplayFormat: "relative-date", Label: "Founded"}},
		},
		Layouts: map[string]Layout{
			"card":   {Fields: []string{"logo", "communityName"}},
			"detail": {Fields: []string{"logo", "communityName", "description", "contactEmail", "website", "createdAt"}},
		},
		Permissions: TypePermissions{
			Read:  "community",
			Write: "admin",
		},
	}
}
