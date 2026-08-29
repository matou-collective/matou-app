// Package types provides a type system for MATOU's generic objects.
// Type definitions describe the schema, layout, and permissions for objects
// stored in any-sync ObjectTrees.
package types

// TypeDefinition describes a type of object that can be stored in a space.
type TypeDefinition struct {
	Name        string            `json:"name"`
	Version     int               `json:"version"`
	Description string            `json:"description"`
	Space       string            `json:"space"` // "private", "community", "community-readonly", "admin"
	Fields      []FieldDef        `json:"fields"`
	Layouts     map[string]Layout `json:"layouts"` // "card", "detail", "form"
	Permissions TypePermissions   `json:"permissions"`

	// VariantField, when set, names the field whose value selects a variant
	// (e.g. "subtype"). Variants let one type carry per-subtype field sets.
	VariantField string             `json:"variantField,omitempty"`
	Variants     map[string]Variant `json:"variants,omitempty"`
}

// Variant defines a subtype-specific extension to a type: extra fields that
// apply (and are validated) only when the object's VariantField value matches
// the variant key.
type Variant struct {
	Fields []FieldDef `json:"fields"`
}

// FieldDef describes a single field in a type definition.
type FieldDef struct {
	Name     string `json:"name"`
	Type     string `json:"type"` // "string", "boolean", "array", "object", "number", "datetime", "enum"
	Required bool   `json:"required"`
	ReadOnly bool   `json:"readOnly"`
	// Core marks a field the backend handlers and state machines depend on.
	// Core fields live in the fixed Go struct; non-core (custom) fields defined
	// by an org's schema round-trip through the object's data map.
	Core bool `json:"core,omitempty"`
	// Filterable marks a field that list endpoints may filter or sort on.
	Filterable bool        `json:"filterable,omitempty"`
	Default    interface{} `json:"default,omitempty"`
	Validation *Validation `json:"validation,omitempty"`
	UIHints    *UIHints    `json:"uiHints,omitempty"`
}

// Validation defines constraints for a field value.
type Validation struct {
	MinLength *int     `json:"minLength,omitempty"`
	MaxLength *int     `json:"maxLength,omitempty"`
	Min       *float64 `json:"min,omitempty"`
	Max       *float64 `json:"max,omitempty"`
	Pattern   string   `json:"pattern,omitempty"`
	Enum      []string `json:"enum,omitempty"`
}

// UIHints provides rendering hints for frontend components.
type UIHints struct {
	InputType     string `json:"inputType,omitempty"`     // "text", "textarea", "select", "toggle", "tags", "image-upload"
	DisplayFormat string `json:"displayFormat,omitempty"` // "avatar", "badge", "chip-list", "relative-date", "link"
	Placeholder   string `json:"placeholder,omitempty"`
	Label         string `json:"label,omitempty"`
	Section       string `json:"section,omitempty"`
}

// Layout defines which fields to show and in what order for a given view.
type Layout struct {
	Fields []string `json:"fields"`
}

// TypePermissions defines who can read and write objects of this type.
type TypePermissions struct {
	Read  string `json:"read"`  // "owner", "community", "admin"
	Write string `json:"write"` // "owner", "admin"
}
