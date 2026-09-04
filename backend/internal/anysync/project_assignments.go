// Package anysync provides any-sync integration for MATOU.
// project_assignments.go implements the ProjectAssignmentResolver used by the
// project-scoped peer-side write rules (write_rules.go, issue #166). It maps a
// project ID to that project's role assignments — its lead/steward AIDs and the
// AIDs assigned as a contributor on any of its contributions — from synced
// state, so a Contribution or Plan sign-off can be gated on the signer's role on
// the OWNING project rather than community-globally.
//
// Like the role resolver, it is served from an in-memory snapshot rebuilt off
// the state-reconstruction hot path (internal/app refresher), never by a
// synchronous read triggered from inside ValidateChange (which runs under an
// object-tree lock). A project not yet present in the snapshot resolves
// known=false, and the write rule then falls back to the community-role gate —
// eventual consistency, never a false rejection of a legitimate transition.
package anysync

import (
	"sync"

	"github.com/matou-dao/backend/internal/contributions"
)

// ProjectAssignment captures one project's role assignments for the peer-side
// write rules.
type ProjectAssignment struct {
	LeadAID      string
	StewardAID   string
	Contributors map[string]bool
}

// ProjectAssignmentStore is a concurrency-safe ProjectAssignmentResolver backed
// by a snapshot replaced atomically by the write-rule refresher.
type ProjectAssignmentStore struct {
	mu   sync.RWMutex
	byID map[string]ProjectAssignment
}

// NewProjectAssignmentStore creates an empty store. Until Replace is called
// every project resolves known=false (validator falls back to the role gate).
func NewProjectAssignmentStore() *ProjectAssignmentStore {
	return &ProjectAssignmentStore{byID: map[string]ProjectAssignment{}}
}

// Replace atomically swaps in a fresh snapshot.
func (s *ProjectAssignmentStore) Replace(byID map[string]ProjectAssignment) {
	if byID == nil {
		byID = map[string]ProjectAssignment{}
	}
	s.mu.Lock()
	s.byID = byID
	s.mu.Unlock()
}

// ProjectRolesForAID implements ProjectAssignmentResolver. It returns the
// per-project roles aid holds on projectID; known is false when the project is
// not in the current snapshot.
func (s *ProjectAssignmentStore) ProjectRolesForAID(projectID, aid string) ([]contributions.Role, bool) {
	if projectID == "" {
		return nil, false
	}
	s.mu.RLock()
	a, ok := s.byID[projectID]
	s.mu.RUnlock()
	if !ok {
		return nil, false
	}
	if aid == "" {
		return nil, true
	}
	var roles []contributions.Role
	if aid == a.LeadAID {
		roles = append(roles, contributions.RoleProjectLead)
	}
	if aid == a.StewardAID {
		roles = append(roles, contributions.RoleProjectSteward)
	}
	if a.Contributors[aid] {
		roles = append(roles, contributions.RoleContributor)
	}
	return roles, true
}
