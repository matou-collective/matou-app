// Package anysync provides any-sync integration for MATOU.
// state.go defines incremental change operations and state reconstruction,
// matching the anytype-heart pattern of StoreKeySet/StoreKeyUnset operations.
// Instead of storing full object replacements, changes are expressed as
// minimal field-level operations that can be replayed to reconstruct state.
package anysync

import (
	"encoding/json"
	"fmt"

	"github.com/anyproto/any-sync/commonspace/object/tree/objecttree"
)

// ChangeOp represents a single incremental field operation.
// Mirrors anytype-heart's Change.Content oneof (StoreKeySet/StoreKeyUnset).
type ChangeOp struct {
	Op    string          `json:"op"`              // "set" | "unset"
	Field string          `json:"field"`           // field name (e.g. "displayName", "bio")
	Value json.RawMessage `json:"value,omitempty"` // field value (for "set" ops only)
}

// ObjectChange is serialized as the Data bytes in SignableChangeContent.
// Mirrors anytype-heart's Change message containing an array of Content operations.
type ObjectChange struct {
	Ops []ChangeOp `json:"ops"`
}

// ObjectState represents the current state of an object, built by replaying changes.
type ObjectState struct {
	ObjectID   string                     `json:"id"`
	ObjectType string                     `json:"type"`
	Fields     map[string]json.RawMessage `json:"fields"`
	OwnerKey   string                     `json:"ownerKey"`  // from Change.Identity
	Version    int                        `json:"version"`   // number of changes applied
	HeadID     string                     `json:"headId"`    // latest change ID
	Timestamp  int64                      `json:"timestamp"` // latest change timestamp
}

// SnapshotInterval controls how many changes between automatic snapshots.
// After this many changes, a snapshot is created for faster state reconstruction.
const SnapshotInterval = 10

// BuildState iterates a tree's changes and replays ops to reconstruct current state.
// Starts from latest snapshot if one exists, otherwise from root.
func BuildState(tree objecttree.ReadableObjectTree, objectID, objectType string) (*ObjectState, error) {
	return BuildStateValidated(tree, objectID, objectType, nil)
}

// BuildStateValidated is BuildState with an optional peer-side write validator
// (see write_rules.go). When validator is non-nil, each change is checked before
// its ops are applied; a rejected change is skipped entirely — its ops are not
// applied and it does not advance the version — so a forged high-stakes change
// (e.g. a member-authored sign-off) cannot alter the reconstructed state. A nil
// validator reproduces BuildState's behaviour exactly.
func BuildStateValidated(tree objecttree.ReadableObjectTree, objectID, objectType string, validator ChangeValidator) (*ObjectState, error) {
	state := &ObjectState{
		ObjectID:   objectID,
		ObjectType: objectType,
		Fields:     make(map[string]json.RawMessage),
	}

	err := tree.IterateRoot(
		// convert: decrypted bytes → ObjectChange
		func(change *objecttree.Change, decrypted []byte) (any, error) {
			if len(decrypted) == 0 {
				return nil, nil
			}
			var oc ObjectChange
			if err := json.Unmarshal(decrypted, &oc); err != nil {
				return nil, nil // skip unparseable changes (e.g. root)
			}
			if len(oc.Ops) == 0 {
				return nil, nil
			}
			return &oc, nil
		},
		// iterate: replay each change's ops onto state
		func(change *objecttree.Change) bool {
			if change.Model == nil {
				return true
			}
			oc, ok := change.Model.(*ObjectChange)
			if !ok || oc == nil {
				return true
			}
			state.applyChange(change, oc, validator)
			return true
		},
	)
	if err != nil {
		return nil, fmt.Errorf("iterating tree for state: %w", err)
	}

	if state.Version == 0 {
		return nil, fmt.Errorf("no changes found in tree for object %s", objectID)
	}

	return state, nil
}

// applyChange replays one decoded change onto the state. When validator is
// supplied and rejects the change, the state is left untouched (the change is
// treated as if it were never authored). The validator sees the field state as
// it stands immediately before this change, so it can distinguish a genuine
// high-stakes transition from a value merely carried forward by a snapshot.
func (s *ObjectState) applyChange(change *objecttree.Change, oc *ObjectChange, validator ChangeValidator) {
	if validator != nil && s.ObjectType != "" {
		author := ""
		if change.Identity != nil {
			author = change.Identity.Account()
		}
		if !validator.ValidateChange(s.ObjectType, s.ObjectID, change.Id, author, oc.Ops, s.Fields) {
			return
		}
	}

	// If this is a snapshot, reset fields and replay from here
	if change.IsSnapshot {
		s.Fields = make(map[string]json.RawMessage)
	}

	// Apply ops
	for _, op := range oc.Ops {
		switch op.Op {
		case "set":
			s.Fields[op.Field] = op.Value
		case "unset":
			delete(s.Fields, op.Field)
		}
	}

	s.Version++
	s.HeadID = change.Id
	if change.Timestamp > s.Timestamp {
		s.Timestamp = change.Timestamp
	}
}

// DiffState computes minimal ChangeOps to go from current state to desired fields.
// Returns nil if no changes detected.
func DiffState(current *ObjectState, newFields map[string]json.RawMessage) *ObjectChange {
	var ops []ChangeOp

	// Check for new or changed fields
	for field, newVal := range newFields {
		if oldVal, exists := current.Fields[field]; !exists {
			ops = append(ops, ChangeOp{Op: "set", Field: field, Value: newVal})
		} else if string(oldVal) != string(newVal) {
			ops = append(ops, ChangeOp{Op: "set", Field: field, Value: newVal})
		}
	}

	// Check for removed fields
	for field := range current.Fields {
		if _, exists := newFields[field]; !exists {
			ops = append(ops, ChangeOp{Op: "unset", Field: field})
		}
	}

	if len(ops) == 0 {
		return nil
	}

	return &ObjectChange{Ops: ops}
}

// InitChange creates the first change for a new object (all fields as "set" ops).
func InitChange(fields map[string]json.RawMessage) *ObjectChange {
	ops := make([]ChangeOp, 0, len(fields))
	for field, val := range fields {
		ops = append(ops, ChangeOp{Op: "set", Field: field, Value: val})
	}
	return &ObjectChange{Ops: ops}
}

// SnapshotChange creates a snapshot containing all current fields from state.
// Used with IsSnapshot=true in SignableChangeContent.
func SnapshotChange(state *ObjectState) *ObjectChange {
	ops := make([]ChangeOp, 0, len(state.Fields))
	for field, val := range state.Fields {
		ops = append(ops, ChangeOp{Op: "set", Field: field, Value: val})
	}
	return &ObjectChange{Ops: ops}
}

// ToJSON converts ObjectState.Fields back to a flat JSON object for API responses.
// This provides backward compatibility with the current ObjectPayload.Data format.
func (s *ObjectState) ToJSON() json.RawMessage {
	flat := make(map[string]json.RawMessage, len(s.Fields))
	for k, v := range s.Fields {
		flat[k] = v
	}
	data, err := json.Marshal(flat)
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return data
}

// FieldsFromJSON converts a flat JSON object (like ObjectPayload.Data) into
// a map[string]json.RawMessage suitable for InitChange or DiffState.
func FieldsFromJSON(data json.RawMessage) (map[string]json.RawMessage, error) {
	var flat map[string]json.RawMessage
	if err := json.Unmarshal(data, &flat); err != nil {
		return nil, fmt.Errorf("parsing JSON fields: %w", err)
	}
	return flat, nil
}

// NeedsSnapshot returns true if the state's version is at a snapshot interval.
func NeedsSnapshot(state *ObjectState) bool {
	return state.Version > 0 && state.Version%SnapshotInterval == 0
}
