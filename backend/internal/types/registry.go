package types

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
)

// ObjectReader is the interface needed by the registry to load type definitions
// from an any-sync space. This matches ObjectTreeManager.ReadObjectsByType.
type ObjectReader interface {
	ReadObjectsByType(ctx context.Context, spaceID string, typeName string) ([]ObjectEntry, error)
}

// ObjectEntry is a minimal representation of a stored object for registry loading.
type ObjectEntry struct {
	ID      string          `json:"id"`
	Type    string          `json:"type"`
	Data    json.RawMessage `json:"data"`
	Version int             `json:"version"`
}

// Registry is an in-memory registry of type definitions.
// It is populated at startup from the community space tree and can be
// queried by profile handlers and frontend clients.
type Registry struct {
	mu    sync.RWMutex
	types map[string]*TypeDefinition
}

// NewRegistry creates a new empty type registry.
func NewRegistry() *Registry {
	return &Registry{
		types: make(map[string]*TypeDefinition),
	}
}

// Bootstrap registers the hardcoded meta-type (type_definition) and all
// built-in type definitions (profiles, notices). Call this during org setup.
func (r *Registry) Bootstrap() {
	r.Register(MetaTypeDefinition())
	for _, def := range ProfileTypeDefinitions() {
		r.Register(def)
	}
	for _, def := range NoticeTypeDefinitions() {
		r.Register(def)
	}
}

// Register adds or replaces a type definition in the registry.
func (r *Registry) Register(def *TypeDefinition) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.types[def.Name] = def
}

// Get retrieves a type definition by name.
func (r *Registry) Get(name string) (*TypeDefinition, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	def, ok := r.types[name]
	return def, ok
}

// All returns all registered type definitions.
func (r *Registry) All() []*TypeDefinition {
	r.mu.RLock()
	defer r.mu.RUnlock()
	result := make([]*TypeDefinition, 0, len(r.types))
	for _, def := range r.types {
		result = append(result, def)
	}
	return result
}

// Validate validates data against a named type's field definitions.
func (r *Registry) Validate(typeName string, data json.RawMessage) ([]string, error) {
	def, ok := r.Get(typeName)
	if !ok {
		return nil, fmt.Errorf("unknown type: %s", typeName)
	}
	return ValidateData(def, data), nil
}

// LoadFromSpace reads type_definition objects from a space and registers them.
// This is called on backend startup to hydrate the registry from persisted data.
func (r *Registry) LoadFromSpace(ctx context.Context, reader ObjectReader, spaceID string) error {
	entries, err := reader.ReadObjectsByType(ctx, spaceID, "type_definition")
	if err != nil {
		return fmt.Errorf("reading type definitions from space %s: %w", spaceID, err)
	}

	for _, entry := range entries {
		var def TypeDefinition
		if err := json.Unmarshal(entry.Data, &def); err != nil {
			fmt.Printf("Warning: skipping invalid type definition %s: %v\n", entry.ID, err)
			continue
		}
		r.Register(&def)
	}

	fmt.Printf("[Types] Loaded %d type definitions from space %s\n", len(entries), spaceID)
	return nil
}

// MetaTypeDefinition returns the type_definition meta-type used to store
// type definitions themselves as objects in the community space tree.
func MetaTypeDefinition() *TypeDefinition {
	return &TypeDefinition{
		Name:        "type_definition",
		Version:     1,
		Description: "Meta-type for storing type definitions as objects",
		Space:       "community",
		Fields: []FieldDef{
			{Name: "name", Type: "string", Required: true},
			{Name: "version", Type: "number", Required: true},
			{Name: "description", Type: "string"},
			{Name: "space", Type: "string", Required: true},
			{Name: "fields", Type: "array", Required: true},
			{Name: "layouts", Type: "object"},
			{Name: "permissions", Type: "object", Required: true},
		},
		Layouts: map[string]Layout{
			"detail": {Fields: []string{"name", "version", "description", "space", "fields", "permissions"}},
		},
		Permissions: TypePermissions{
			Read:  "community",
			Write: "admin",
		},
	}
}

// TypeDefinitionsAsJSON returns all registered type definitions serialized
// for writing to the community space as ObjectPayload data.
func (r *Registry) TypeDefinitionsAsJSON() ([]json.RawMessage, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	var result []json.RawMessage
	for _, def := range r.types {
		data, err := json.Marshal(def)
		if err != nil {
			return nil, fmt.Errorf("marshaling type %s: %w", def.Name, err)
		}
		result = append(result, data)
	}
	return result, nil
}
