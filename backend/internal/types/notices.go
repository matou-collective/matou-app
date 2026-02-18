package types

// NoticeTypeDefinitions returns the built-in notice type definitions.
func NoticeTypeDefinitions() []*TypeDefinition {
	return []*TypeDefinition{
		NoticeType(),
		NoticeAckType(),
		NoticeRSVPType(),
		NoticeSaveType(),
		NoticeCommentType(),
		NoticeReactionType(),
	}
}

// NoticeType returns the Notice type definition.
// Stored in the community space — stewards/admins write, all members read.
func NoticeType() *TypeDefinition {
	maxTitle := 200
	maxSummary := 500
	maxBody := 5000
	maxText := 500
	maxURL := 1000
	maxDisplayName := 100

	return &TypeDefinition{
		Name:        "Notice",
		Version:     1,
		Description: "Community notice board entry (event, update, or announcement)",
		Space:       "community",
		Fields: []FieldDef{
			// Core fields
			{Name: "type", Type: "string", Required: true,
				Validation: &Validation{Enum: []string{"event", "update", "announcement"}},
				UIHints:    &UIHints{Label: "Notice Type", Section: "core"}},
			{Name: "subtype", Type: "string",
				UIHints: &UIHints{Label: "Subtype", Section: "core"}},
			{Name: "title", Type: "string", Required: true,
				Validation: &Validation{MaxLength: &maxTitle},
				UIHints:    &UIHints{InputType: "text", Label: "Title", Placeholder: "Notice title", Section: "core"}},
			{Name: "summary", Type: "string", Required: true,
				Validation: &Validation{MaxLength: &maxSummary},
				UIHints:    &UIHints{InputType: "textarea", Label: "Summary", Placeholder: "Brief summary...", Section: "core"}},
			{Name: "body", Type: "string",
				Validation: &Validation{MaxLength: &maxBody},
				UIHints:    &UIHints{InputType: "textarea", Label: "Body", Section: "core"}},
			{Name: "links", Type: "array",
				UIHints: &UIHints{Label: "Links", Section: "core"}},

			// Media
			{Name: "images", Type: "array",
				UIHints: &UIHints{Label: "Images", Section: "media"}},
			{Name: "attachments", Type: "array",
				UIHints: &UIHints{Label: "Attachments", Section: "media"}},

			// Issuer
			{Name: "issuerType", Type: "string", Required: true,
				Validation: &Validation{Enum: []string{"person", "role", "org", "system"}},
				UIHints:    &UIHints{Label: "Issuer Type", Section: "issuer"}},
			{Name: "issuerId", Type: "string", Required: true,
				UIHints: &UIHints{Label: "Issuer ID", Section: "issuer"}},
			{Name: "issuerDisplayName", Type: "string",
				Validation: &Validation{MaxLength: &maxDisplayName},
				UIHints:    &UIHints{Label: "Issuer Name", Section: "issuer"}},

			// Audience
			{Name: "audienceMode", Type: "string",
				Validation: &Validation{Enum: []string{"space", "role", "community"}},
				UIHints:    &UIHints{Label: "Audience Mode", Section: "audience"}},
			{Name: "audienceRoleIds", Type: "array",
				UIHints: &UIHints{Label: "Audience Roles", Section: "audience"}},

			// Time fields
			{Name: "publishAt", Type: "datetime",
				UIHints: &UIHints{Label: "Publish At", Section: "time"}},
			{Name: "activeFrom", Type: "datetime",
				UIHints: &UIHints{Label: "Active From", Section: "time"}},
			{Name: "activeUntil", Type: "datetime",
				UIHints: &UIHints{Label: "Active Until", Section: "time"}},
			{Name: "eventStart", Type: "datetime",
				UIHints: &UIHints{Label: "Event Start", Section: "time"}},
			{Name: "eventEnd", Type: "datetime",
				UIHints: &UIHints{Label: "Event End", Section: "time"}},
			{Name: "timezone", Type: "string",
				UIHints: &UIHints{Label: "Timezone", Section: "time"}},

			// Location (for events)
			{Name: "locationMode", Type: "string",
				Validation: &Validation{Enum: []string{"physical", "online", "hybrid"}},
				UIHints:    &UIHints{Label: "Location Mode", Section: "location"}},
			{Name: "locationText", Type: "string",
				Validation: &Validation{MaxLength: &maxText},
				UIHints:    &UIHints{InputType: "text", Label: "Location", Placeholder: "Where is this event?", Section: "location"}},
			{Name: "locationUrl", Type: "string",
				Validation: &Validation{MaxLength: &maxURL},
				UIHints:    &UIHints{InputType: "text", Label: "Location URL", Placeholder: "https://...", Section: "location"}},

			// RSVP config
			{Name: "rsvpEnabled", Type: "boolean",
				UIHints: &UIHints{Label: "RSVP Enabled", Section: "rsvp"}},
			{Name: "rsvpRequired", Type: "boolean",
				UIHints: &UIHints{Label: "RSVP Required", Section: "rsvp"}},
			{Name: "rsvpCapacity", Type: "number",
				UIHints: &UIHints{Label: "Capacity", Section: "rsvp"}},

			// Ack config
			{Name: "ackRequired", Type: "boolean",
				UIHints: &UIHints{Label: "Acknowledgment Required", Section: "ack"}},
			{Name: "ackDueAt", Type: "datetime",
				UIHints: &UIHints{Label: "Ack Due Date", Section: "ack"}},

			// Lifecycle
			{Name: "pinned", Type: "boolean",
				UIHints: &UIHints{Label: "Pinned", Section: "lifecycle"}},
			{Name: "state", Type: "string", Required: true,
				Validation: &Validation{Enum: []string{"draft", "published", "archived"}},
				UIHints:    &UIHints{DisplayFormat: "badge", Label: "State", Section: "lifecycle"}},
			{Name: "createdAt", Type: "datetime", ReadOnly: true,
				UIHints: &UIHints{DisplayFormat: "relative-date", Label: "Created", Section: "lifecycle"}},
			{Name: "createdBy", Type: "string", ReadOnly: true,
				UIHints: &UIHints{Label: "Created By", Section: "lifecycle"}},
			{Name: "publishedAt", Type: "datetime", ReadOnly: true,
				UIHints: &UIHints{DisplayFormat: "relative-date", Label: "Published", Section: "lifecycle"}},
			{Name: "archivedAt", Type: "datetime", ReadOnly: true,
				UIHints: &UIHints{DisplayFormat: "relative-date", Label: "Archived", Section: "lifecycle"}},

			// Amendment
			{Name: "amendsNoticeId", Type: "string",
				UIHints: &UIHints{Label: "Amends Notice", Section: "amendment"}},
		},
		Layouts: map[string]Layout{
			"card":   {Fields: []string{"title", "summary", "type", "state", "eventStart", "locationText"}},
			"detail": {Fields: []string{"title", "summary", "body", "type", "subtype", "links", "issuerDisplayName", "issuerType", "audienceMode", "publishAt", "activeFrom", "activeUntil", "eventStart", "eventEnd", "timezone", "locationMode", "locationText", "locationUrl", "rsvpEnabled", "rsvpCapacity", "ackRequired", "ackDueAt", "state", "createdAt", "createdBy", "publishedAt", "archivedAt", "amendsNoticeId"}},
			"form":   {Fields: []string{"type", "title", "summary", "body", "links", "eventStart", "eventEnd", "timezone", "locationMode", "locationText", "locationUrl", "rsvpEnabled", "rsvpRequired", "rsvpCapacity", "ackRequired", "ackDueAt", "activeFrom", "activeUntil"}},
		},
		Permissions: TypePermissions{
			Read:  "community",
			Write: "admin",
		},
	}
}

// NoticeAckType returns the NoticeAck type definition.
// Stored in the community space alongside the notice.
func NoticeAckType() *TypeDefinition {
	return &TypeDefinition{
		Name:        "NoticeAck",
		Version:     1,
		Description: "Acknowledgment of a notice by a community member",
		Space:       "community",
		Fields: []FieldDef{
			{Name: "noticeId", Type: "string", Required: true,
				UIHints: &UIHints{Label: "Notice ID", Section: "ack"}},
			{Name: "userId", Type: "string", Required: true,
				UIHints: &UIHints{Label: "User ID", Section: "ack"}},
			{Name: "ackAt", Type: "datetime", Required: true, ReadOnly: true,
				UIHints: &UIHints{DisplayFormat: "relative-date", Label: "Acknowledged At", Section: "ack"}},
			{Name: "method", Type: "string", Required: true,
				Validation: &Validation{Enum: []string{"open", "explicit"}},
				UIHints:    &UIHints{Label: "Method", Section: "ack"}},
		},
		Permissions: TypePermissions{
			Read:  "community",
			Write: "community",
		},
	}
}

// NoticeRSVPType returns the NoticeRSVP type definition.
// Stored in the community space. One RSVP per (noticeId, userId) — last-write-wins.
func NoticeRSVPType() *TypeDefinition {
	return &TypeDefinition{
		Name:        "NoticeRSVP",
		Version:     1,
		Description: "RSVP response to an event notice",
		Space:       "community",
		Fields: []FieldDef{
			{Name: "noticeId", Type: "string", Required: true,
				UIHints: &UIHints{Label: "Notice ID", Section: "rsvp"}},
			{Name: "userId", Type: "string", Required: true,
				UIHints: &UIHints{Label: "User ID", Section: "rsvp"}},
			{Name: "status", Type: "string", Required: true,
				Validation: &Validation{Enum: []string{"going", "maybe", "not_going"}},
				UIHints:    &UIHints{DisplayFormat: "badge", Label: "Status", Section: "rsvp"}},
			{Name: "updatedAt", Type: "datetime", Required: true, ReadOnly: true,
				UIHints: &UIHints{DisplayFormat: "relative-date", Label: "Updated At", Section: "rsvp"}},
		},
		Permissions: TypePermissions{
			Read:  "community",
			Write: "community",
		},
	}
}

// NoticeSaveType returns the NoticeSave type definition.
// Stored in the user's personal space (not replicated to community).
func NoticeSaveType() *TypeDefinition {
	return &TypeDefinition{
		Name:        "NoticeSave",
		Version:     1,
		Description: "Saved/pinned notice bookmark in personal space",
		Space:       "private",
		Fields: []FieldDef{
			{Name: "noticeId", Type: "string", Required: true,
				UIHints: &UIHints{Label: "Notice ID", Section: "save"}},
			{Name: "userId", Type: "string", Required: true,
				UIHints: &UIHints{Label: "User ID", Section: "save"}},
			{Name: "savedAt", Type: "datetime", Required: true, ReadOnly: true,
				UIHints: &UIHints{DisplayFormat: "relative-date", Label: "Saved At", Section: "save"}},
			{Name: "pinned", Type: "boolean",
				UIHints: &UIHints{Label: "Pinned", Section: "save"}},
		},
		Permissions: TypePermissions{
			Read:  "owner",
			Write: "owner",
		},
	}
}

// NoticeCommentType returns the NoticeComment type definition.
// Stored in the community space. One tree per comment.
func NoticeCommentType() *TypeDefinition {
	maxText := 2000
	maxDisplayName := 100
	return &TypeDefinition{
		Name:        "NoticeComment",
		Version:     1,
		Description: "Comment on a community notice",
		Space:       "community",
		Fields: []FieldDef{
			{Name: "noticeId", Type: "string", Required: true,
				UIHints: &UIHints{Label: "Notice ID", Section: "comment"}},
			{Name: "userId", Type: "string", Required: true,
				UIHints: &UIHints{Label: "User ID", Section: "comment"}},
			{Name: "userDisplayName", Type: "string",
				Validation: &Validation{MaxLength: &maxDisplayName},
				UIHints:    &UIHints{Label: "User Display Name", Section: "comment"}},
			{Name: "text", Type: "string", Required: true,
				Validation: &Validation{MaxLength: &maxText},
				UIHints:    &UIHints{InputType: "textarea", Label: "Text", Section: "comment"}},
			{Name: "createdAt", Type: "datetime", Required: true, ReadOnly: true,
				UIHints: &UIHints{DisplayFormat: "relative-date", Label: "Created At", Section: "comment"}},
		},
		Permissions: TypePermissions{
			Read:  "community",
			Write: "community",
		},
	}
}

// NoticeReactionType returns the NoticeReaction type definition.
// Stored in the community space. One tree per (noticeId, userId, emoji) — last-write-wins.
func NoticeReactionType() *TypeDefinition {
	return &TypeDefinition{
		Name:        "NoticeReaction",
		Version:     1,
		Description: "Emoji reaction on a community notice",
		Space:       "community",
		Fields: []FieldDef{
			{Name: "noticeId", Type: "string", Required: true,
				UIHints: &UIHints{Label: "Notice ID", Section: "reaction"}},
			{Name: "userId", Type: "string", Required: true,
				UIHints: &UIHints{Label: "User ID", Section: "reaction"}},
			{Name: "emoji", Type: "string", Required: true,
				Validation: &Validation{Enum: ValidEmojis},
				UIHints:    &UIHints{Label: "Emoji", Section: "reaction"}},
			{Name: "active", Type: "boolean", Required: true,
				UIHints: &UIHints{Label: "Active", Section: "reaction"}},
			{Name: "createdAt", Type: "datetime", Required: true, ReadOnly: true,
				UIHints: &UIHints{DisplayFormat: "relative-date", Label: "Created At", Section: "reaction"}},
		},
		Permissions: TypePermissions{
			Read:  "community",
			Write: "community",
		},
	}
}

// ValidEmojis are the allowed reaction emoji values.
var ValidEmojis = []string{"\U0001F44D", "\u2764\uFE0F", "\u2728", "\U0001F389"}

// IsValidEmoji checks if an emoji is in the allowed set.
func IsValidEmoji(emoji string) bool {
	for _, e := range ValidEmojis {
		if e == emoji {
			return true
		}
	}
	return false
}

// ValidNoticeStates are the allowed lifecycle states for a notice.
var ValidNoticeStates = []string{"draft", "published", "archived"}

// ValidNoticeTransitions maps current state to allowed next states.
var ValidNoticeTransitions = map[string][]string{
	"draft":     {"published"},
	"published": {"archived"},
	"archived":  {}, // terminal state
}

// IsValidNoticeTransition checks if a state transition is allowed.
func IsValidNoticeTransition(from, to string) bool {
	allowed, ok := ValidNoticeTransitions[from]
	if !ok {
		return false
	}
	for _, s := range allowed {
		if s == to {
			return true
		}
	}
	return false
}
