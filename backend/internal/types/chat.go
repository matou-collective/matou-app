package types

// ChatTypeDefinitions returns the chat-related type definitions.
func ChatTypeDefinitions() []*TypeDefinition {
	return []*TypeDefinition{
		ChatChannelType(),
		ChatMessageType(),
		MessageReactionType(),
	}
}

// ChatChannelType returns the ChatChannel type definition.
// Stored in community-readonly space — admin creates, members read.
func ChatChannelType() *TypeDefinition {
	maxName := 100
	maxDescription := 500
	maxIcon := 10
	maxPhoto := 200

	return &TypeDefinition{
		Name:        "ChatChannel",
		Version:     1,
		Description: "Chat channel for community discussions",
		Space:       "community-readonly",
		Fields: []FieldDef{
			{Name: "name", Type: "string", Required: true,
				Validation: &Validation{MaxLength: &maxName},
				UIHints:    &UIHints{InputType: "text", Label: "Channel Name", Placeholder: "general"}},
			{Name: "description", Type: "string",
				Validation: &Validation{MaxLength: &maxDescription},
				UIHints:    &UIHints{InputType: "textarea", Label: "Description", Placeholder: "What is this channel about?"}},
			{Name: "icon", Type: "string",
				Validation: &Validation{MaxLength: &maxIcon},
				UIHints:    &UIHints{InputType: "text", Label: "Icon (Emoji)", Placeholder: "💬"}},
			{Name: "photo", Type: "string",
				Validation: &Validation{MaxLength: &maxPhoto},
				UIHints:    &UIHints{InputType: "text", Label: "Photo", Placeholder: "FileRef from FileManager"}},
			{Name: "createdAt", Type: "datetime", ReadOnly: true,
				UIHints: &UIHints{DisplayFormat: "relative-date", Label: "Created"}},
			{Name: "createdBy", Type: "string", ReadOnly: true,
				UIHints: &UIHints{Label: "Created By"}},
			{Name: "isArchived", Type: "boolean",
				UIHints: &UIHints{Label: "Archived"}},
			{Name: "allowedRoles", Type: "array",
				UIHints: &UIHints{InputType: "tags", DisplayFormat: "chip-list", Label: "Allowed Roles", Placeholder: "Empty = all members"}},
		},
		Layouts: map[string]Layout{
			"card":   {Fields: []string{"icon", "name"}},
			"detail": {Fields: []string{"icon", "name", "description", "createdAt", "createdBy", "isArchived", "allowedRoles"}},
			"form":   {Fields: []string{"name", "description", "icon", "photo", "allowedRoles"}},
		},
		Permissions: TypePermissions{
			Read:  "community",
			Write: "admin",
		},
	}
}

// ChatMessageType returns the ChatMessage type definition.
// Stored in community space — all members can write.
func ChatMessageType() *TypeDefinition {
	maxContent := 4000
	maxSenderName := 100

	return &TypeDefinition{
		Name:        "ChatMessage",
		Version:     1,
		Description: "Chat message in a channel",
		Space:       "community",
		Fields: []FieldDef{
			{Name: "channelId", Type: "string", Required: true,
				UIHints: &UIHints{Label: "Channel ID"}},
			{Name: "senderAid", Type: "string", Required: true, ReadOnly: true,
				UIHints: &UIHints{Label: "Sender AID"}},
			{Name: "senderName", Type: "string", Required: true,
				Validation: &Validation{MaxLength: &maxSenderName},
				UIHints:    &UIHints{Label: "Sender Name"}},
			{Name: "content", Type: "string", Required: true,
				Validation: &Validation{MaxLength: &maxContent},
				UIHints:    &UIHints{InputType: "textarea", Label: "Message Content"}},
			{Name: "attachments", Type: "array",
				UIHints: &UIHints{Label: "Attachments"}},
			{Name: "replyTo", Type: "string",
				UIHints: &UIHints{Label: "Reply To Message ID"}},
			{Name: "sentAt", Type: "datetime", ReadOnly: true,
				UIHints: &UIHints{DisplayFormat: "relative-date", Label: "Sent At"}},
			{Name: "editedAt", Type: "datetime",
				UIHints: &UIHints{DisplayFormat: "relative-date", Label: "Edited At"}},
			{Name: "deletedAt", Type: "datetime",
				UIHints: &UIHints{DisplayFormat: "relative-date", Label: "Deleted At"}},
		},
		Layouts: map[string]Layout{
			"list":   {Fields: []string{"senderName", "content", "sentAt"}},
			"detail": {Fields: []string{"senderName", "content", "attachments", "replyTo", "sentAt", "editedAt"}},
		},
		Permissions: TypePermissions{
			Read:  "community",
			Write: "community",
		},
	}
}

// MessageReactionType returns the MessageReaction type definition.
// Stored in community space — all members can react.
func MessageReactionType() *TypeDefinition {
	maxEmoji := 10

	return &TypeDefinition{
		Name:        "MessageReaction",
		Version:     1,
		Description: "Reaction to a chat message",
		Space:       "community",
		Fields: []FieldDef{
			{Name: "messageId", Type: "string", Required: true,
				UIHints: &UIHints{Label: "Message ID"}},
			{Name: "emoji", Type: "string", Required: true,
				Validation: &Validation{MaxLength: &maxEmoji},
				UIHints:    &UIHints{Label: "Emoji"}},
			{Name: "reactorAids", Type: "array", Required: true,
				UIHints: &UIHints{Label: "Reactor AIDs"}},
		},
		Layouts: map[string]Layout{
			"list": {Fields: []string{"emoji", "reactorAids"}},
		},
		Permissions: TypePermissions{
			Read:  "community",
			Write: "community",
		},
	}
}
