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
}

// FieldDef describes a single field in a type definition.
type FieldDef struct {
	Name     string `json:"name"`
	Type     string `json:"type"` // "string", "boolean", "array", "object", "number", "datetime", "enum"
	Required bool   `json:"required"`
	ReadOnly bool   `json:"readOnly"`
	// Core marks a field that backend handlers depend on structurally (e.g.
	// id, status, timestamps, voting/decision fields). Core fields are always
	// present in every org's schema and may not be removed by admin schema
	// edits. Non-core fields are optional and removable per org.
	Core       bool        `json:"core,omitempty"`
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
	// Filterable marks a field that list/search endpoints accept as a
	// query-parameter filter. The set of filterable fields is derived from the
	// schema rather than a hardcoded list, so orgs control it via their schema.
	Filterable bool `json:"filterable,omitempty"`
}

// Layout defines which fields to show and in what order for a given view.
type Layout struct {
	Fields []string `json:"fields"`
}

// Field returns the field definition with the given name, if present.
func (d *TypeDefinition) Field(name string) (FieldDef, bool) {
	for _, f := range d.Fields {
		if f.Name == name {
			return f, true
		}
	}
	return FieldDef{}, false
}

// CoreFieldNames returns the names of fields marked core:true. These are the
// fields backend handlers depend on and which admin schema edits may not remove.
func (d *TypeDefinition) CoreFieldNames() []string {
	var names []string
	for _, f := range d.Fields {
		if f.Core {
			names = append(names, f.Name)
		}
	}
	return names
}

// FilterableFieldNames returns the names of fields whose uiHints mark them
// filterable. List/search endpoints derive their accepted filter parameters
// from this set rather than a hardcoded list.
func (d *TypeDefinition) FilterableFieldNames() []string {
	var names []string
	for _, f := range d.Fields {
		if f.UIHints != nil && f.UIHints.Filterable {
			names = append(names, f.Name)
		}
	}
	return names
}

// TypePermissions defines who can read and write objects of this type.
type TypePermissions struct {
	Read  string `json:"read"`  // "owner", "community", "admin"
	Write string `json:"write"` // "owner", "admin"
}
