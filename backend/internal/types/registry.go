package types

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
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
// built-in type definitions (profiles, notices, chat, proposals). Call this
// during org setup.
func (r *Registry) Bootstrap() {
	r.Register(MetaTypeDefinition())
	for _, def := range ProfileTypeDefinitions() {
		r.Register(def)
	}
	for _, def := range NoticeTypeDefinitions() {
		r.Register(def)
	}
	for _, def := range ChatTypeDefinitions() {
		r.Register(def)
	}
	for _, def := range ProposalTypeDefinitions() {
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

// IsFilterable reports whether a named type declares the given field as
// filterable. Unknown types or fields are not filterable.
func (r *Registry) IsFilterable(typeName, field string) bool {
	def, ok := r.Get(typeName)
	if !ok {
		return false
	}
	for _, f := range def.Fields {
		if f.Name == field {
			return f.IsFilterable()
		}
	}
	// A variant field may also be filterable.
	for _, variant := range def.Variants {
		for _, f := range variant.Fields {
			if f.Name == field {
				return f.IsFilterable()
			}
		}
	}
	return false
}

// CoreFieldNames returns the set of field names a type marks as core.
func (r *Registry) CoreFieldNames(typeName string) map[string]bool {
	def, ok := r.Get(typeName)
	if !ok {
		return nil
	}
	core := make(map[string]bool)
	for _, f := range def.Fields {
		if f.Core {
			core[f.Name] = true
		}
	}
	return core
}

// LoadFromSpace reads persisted type_definition objects from a space and merges
// them over the built-in definitions already registered by Bootstrap. Call it
// once the community space is available at boot, after Bootstrap.
//
// Merge semantics: a persisted definition wins for its type, but every field the
// matching built-in marks core is re-asserted from the built-in — defense in
// depth against a corrupted or hand-edited stored definition dropping or
// redefining a field backend handlers depend on (the same invariant the schema
// PUT handler enforces). A definition with no matching built-in is registered
// as-is (an org may persist entirely new types).
//
// An unparseable or nameless stored definition is skipped, never fatal: the
// built-in stays in force. A read error is returned so the caller can log and
// fall back to the built-ins (the same never-fatal posture the boot path uses).
func (r *Registry) LoadFromSpace(ctx context.Context, reader ObjectReader, spaceID string) error {
	entries, err := reader.ReadObjectsByType(ctx, spaceID, "type_definition")
	if err != nil {
		return fmt.Errorf("reading type definitions from space %s: %w", spaceID, err)
	}

	loaded := 0
	for _, entry := range entries {
		var def TypeDefinition
		if err := json.Unmarshal(entry.Data, &def); err != nil {
			log.Printf("[Types] skipping invalid type definition %s: %v", entry.ID, err)
			continue
		}
		if def.Name == "" {
			log.Printf("[Types] skipping type definition %s: empty name", entry.ID)
			continue
		}
		if builtin, ok := r.Get(def.Name); ok {
			reassertCoreFields(builtin, &def)
		}
		r.Register(&def)
		loaded++
	}

	log.Printf("[Types] Loaded %d of %d persisted type definitions from space %s", loaded, len(entries), spaceID)
	return nil
}

// reassertCoreFields overwrites, in persisted, every field the built-in marks
// core with the built-in's own field definition, and appends any core field the
// persisted definition dropped (preserving built-in order for the appended
// ones). Non-core fields — and the ordering of the fields the persisted
// definition kept — are left untouched, so an org can still extend or reshape
// the customisable part of its schema. Core fields are the ones backend handlers
// depend on structurally; they can never be removed or redefined by a stored
// definition, corrupted or otherwise.
func reassertCoreFields(builtin, persisted *TypeDefinition) {
	if builtin == nil || persisted == nil {
		return
	}
	coreOrder := make([]FieldDef, 0)
	coreByName := make(map[string]FieldDef)
	for _, f := range builtin.Fields {
		if f.Core {
			coreOrder = append(coreOrder, f)
			coreByName[f.Name] = f
		}
	}
	if len(coreByName) == 0 {
		return
	}

	merged := make([]FieldDef, 0, len(persisted.Fields)+len(coreOrder))
	seen := make(map[string]bool, len(coreByName))
	for _, f := range persisted.Fields {
		if core, ok := coreByName[f.Name]; ok {
			merged = append(merged, core) // re-assert the built-in definition
			seen[f.Name] = true
			continue
		}
		merged = append(merged, f)
	}
	for _, core := range coreOrder {
		if !seen[core.Name] {
			merged = append(merged, core)
		}
	}
	persisted.Fields = merged
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
