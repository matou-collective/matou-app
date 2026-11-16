// Package anysync provides any-sync integration for MATOU.
// state.go defines incremental change operations and state reconstruction,
// matching the anytype-heart pattern of StoreKeySet/StoreKeyUnset operations.
// Instead of storing full object replacements, changes are expressed as
// minimal field-level operations that can be replayed to reconstruct state.
package anysync

import (
	"encoding/json"
	"errors"
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

// ErrUnknownObjectType is returned by BuildStateValidated when a validator is
// supplied but the object's type is unknown (empty), which would otherwise
// bypass the write rules.
var ErrUnknownObjectType = errors.New("cannot validate object of unknown type")

// ErrNoChangesInTree is returned by BuildStateValidated when a tree carries no
// content changes at all — only its root — so no state can be reconstructed.
// For an object the local index knows about this is the signature of an
// incomplete local copy: the tree's content changes never arrived (or never
// persisted) on this device, yet a head-storage entry was written, so HeadSync
// never classifies it as "missing" and it never self-heals. A read for it fails
// forever (#808). Callers on the read path match this with errors.Is to drop the
// stuck local copy and let HeadSync re-fetch a clean one from a peer. It is kept
// distinct from ErrAllChangesRejected so only the genuinely-empty case triggers
// that (destructive-looking but reversible) re-fetch.
var ErrNoChangesInTree = errors.New("no changes found in tree")

// ErrAllChangesRejected is returned when a tree DOES carry content changes but
// none survived validation (every change was excluded by the write-rule
// validator), so the reconstructed version is still 0. Unlike
// ErrNoChangesInTree this is not a missing-data condition — the changes are
// present locally — so re-fetching cannot help and the read path must NOT drop
// the tree.
var ErrAllChangesRejected = errors.New("all changes rejected by validator")

// SnapshotInterval controls how many changes between automatic snapshots.
// After this many changes, a snapshot is created for faster state reconstruction.
const SnapshotInterval = 10

// BuildState iterates a tree's changes and replays ops to reconstruct current state.
// Starts from latest snapshot if one exists, otherwise from root.
func BuildState(tree objecttree.ReadableObjectTree, objectID, objectType string) (*ObjectState, error) {
	return BuildStateValidated(tree, "", objectID, objectType, nil)
}

// BuildStateValidated is BuildState with an optional peer-side write validator
// (see write_rules.go). When validator is non-nil, each change is checked before
// its ops are applied; a rejected change is skipped entirely — its ops are not
// applied and it does not advance the version — so a forged high-stakes change
// (e.g. a member-authored sign-off) cannot alter the reconstructed state. A nil
// validator reproduces BuildState's behaviour exactly. spaceID is the any-sync
// space the tree lives in; it is passed to the validator so proof-backed
// transitions can be bound to their space (anti-cross-space-replay). Pass "" on
// a path that cannot determine the space (the space check is then skipped).
func BuildStateValidated(tree objecttree.ReadableObjectTree, spaceID, objectID, objectType string, validator ChangeValidator) (*ObjectState, error) {
	if validator != nil && objectType == "" {
		// An unknown object type cannot be matched against the write rules, so
		// validating it would silently treat a guarded object (e.g. one that is
		// missing from the local index) as unguarded. Fail loudly instead.
		return nil, fmt.Errorf("%w: object %s", ErrUnknownObjectType, objectID)
	}
	state := &ObjectState{
		ObjectID:   objectID,
		ObjectType: objectType,
		Fields:     make(map[string]json.RawMessage),
	}

	// seen counts ops-bearing content changes actually present in the tree,
	// before validation. It distinguishes a genuinely empty/incomplete tree
	// (seen == 0 → ErrNoChangesInTree) from one whose changes are all present
	// but excluded by the validator (seen > 0, version 0 → ErrAllChangesRejected).
	seen := 0
	err := tree.IterateRoot(
		// convert: decrypted bytes → ObjectChange
		func(_ *objecttree.Change, decrypted []byte) (any, error) {
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
			seen++
			state.applyChange(spaceID, change, oc, validator)
			return true
		},
	)
	if err != nil {
		return nil, fmt.Errorf("iterating tree for state: %w", err)
	}

	if state.Version == 0 {
		if seen > 0 {
			// Content changes exist locally but none survived validation.
			// Re-fetching the same bytes cannot change that, so this must not
			// be mistaken for the missing-data case that triggers a re-fetch.
			return nil, fmt.Errorf("%w for object %s", ErrAllChangesRejected, objectID)
		}
		return nil, fmt.Errorf("%w for object %s", ErrNoChangesInTree, objectID)
	}

	return state, nil
}

// applyChange replays one decoded change onto the state. When validator is
// supplied and rejects the change, the state is left untouched (the change is
// treated as if it were never authored). The validator sees the field state as
// it stands immediately before this change, so it can distinguish a genuine
// high-stakes transition from a value merely carried forward by a snapshot.
func (s *ObjectState) applyChange(spaceID string, change *objecttree.Change, oc *ObjectChange, validator ChangeValidator) {
	if validator != nil {
		author := ""
		if change.Identity != nil {
			author = change.Identity.Account()
		}
		if !validator.ValidateChange(spaceID, s.ObjectType, s.ObjectID, change.Id, author, change.Timestamp, oc.Ops, s.Fields, change.IsSnapshot) {
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
