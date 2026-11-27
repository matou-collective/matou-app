package app

import (
	"context"
	"testing"
	"time"
)

// readOnlyResolverHarness wires a readOnlySpaceResolver to in-memory fakes so a
// test states the identity / org-config / network situation and reads back the
// resolved ID, the probes made and the ID persisted (issue #719).
type readOnlyResolverHarness struct {
	identityID string
	orgID      string
	live       map[string]bool
	probes     int
	persisted  []string
	now        time.Time
	resolver   *readOnlySpaceResolver
}

func newReadOnlyHarness(identityID, orgID string, live ...string) *readOnlyResolverHarness {
	h := &readOnlyResolverHarness{
		identityID: identityID,
		orgID:      orgID,
		live:       map[string]bool{},
		now:        time.Unix(1_700_000_000, 0),
	}
	for _, id := range live {
		h.live[id] = true
	}
	h.resolver = newReadOnlySpaceResolver(readOnlySpaceSources{
		identityID: func() string { return h.identityID },
		orgID:      func() string { return h.orgID },
		exists: func(_ context.Context, id string) bool {
			h.probes++
			return h.live[id]
		},
		persist: func(id string) error {
			h.persisted = append(h.persisted, id)
			h.identityID = id
			return nil
		},
		now: func() time.Time { return h.now },
	})
	return h
}

func TestReadOnlyResolver_EmptyIdentityFallsBackToOrgConfig(t *testing.T) {
	h := newReadOnlyHarness("", "org-ro", "org-ro")
	if got := h.resolver.Resolve(); got != "org-ro" {
		t.Fatalf("got %q, want org-ro", got)
	}
}

func TestReadOnlyResolver_ReachableIdentityIDIsKeptEvenWhenOrgDiffers(t *testing.T) {
	h := newReadOnlyHarness("mine", "org-ro", "mine", "org-ro")
	if got := h.resolver.Resolve(); got != "mine" {
		t.Fatalf("got %q, want mine", got)
	}
	if len(h.persisted) != 0 {
		t.Fatalf("persisted %v, want nothing", h.persisted)
	}
}

// The #719 case: v0.6.9 re-setup left a non-empty identity ID that points at a
// space that never propagated, while org config holds the working one.
func TestReadOnlyResolver_DeadIdentityIDHealsToLiveOrgConfigID(t *testing.T) {
	h := newReadOnlyHarness("phantom", "org-ro", "org-ro")
	if got := h.resolver.Resolve(); got != "org-ro" {
		t.Fatalf("got %q, want org-ro", got)
	}
	if len(h.persisted) != 1 || h.persisted[0] != "org-ro" {
		t.Fatalf("persisted %v, want [org-ro]", h.persisted)
	}
}

func TestReadOnlyResolver_BothDeadKeepsIdentityIDAndPersistsNothing(t *testing.T) {
	h := newReadOnlyHarness("phantom", "org-ro")
	if got := h.resolver.Resolve(); got != "phantom" {
		t.Fatalf("got %q, want phantom", got)
	}
	if len(h.persisted) != 0 {
		t.Fatalf("persisted %v, want nothing", h.persisted)
	}
}

func TestReadOnlyResolver_DeadIdentityIDWithNoOrgConfigIDIsKept(t *testing.T) {
	h := newReadOnlyHarness("phantom", "")
	if got := h.resolver.Resolve(); got != "phantom" {
		t.Fatalf("got %q, want phantom", got)
	}
}

func TestReadOnlyResolver_MatchingIDsAreNotProbed(t *testing.T) {
	h := newReadOnlyHarness("same", "same", "same")
	if got := h.resolver.Resolve(); got != "same" {
		t.Fatalf("got %q, want same", got)
	}
	if h.probes != 0 {
		t.Fatalf("probes = %d, want 0 when identity and org agree", h.probes)
	}
}

// Resolve runs on every role / profile / policy request; it must not hit the
// coordinator each time.
func TestReadOnlyResolver_ProbesAreCachedWithinTTL(t *testing.T) {
	h := newReadOnlyHarness("mine", "org-ro", "mine", "org-ro")
	h.resolver.Resolve()
	first := h.probes
	h.resolver.Resolve()
	h.resolver.Resolve()
	if h.probes != first {
		t.Fatalf("probes grew from %d to %d within the TTL", first, h.probes)
	}
}

// An unreachable verdict must not stick: the coordinator may simply have been
// down at boot, and org config's ID can come good later.
func TestReadOnlyResolver_VerdictIsRecheckedAfterTTL(t *testing.T) {
	h := newReadOnlyHarness("phantom", "org-ro")
	if got := h.resolver.Resolve(); got != "phantom" {
		t.Fatalf("got %q, want phantom while org-ro is unreachable", got)
	}
	h.live["org-ro"] = true
	h.now = h.now.Add(readOnlyProbeTTL + time.Second)
	if got := h.resolver.Resolve(); got != "org-ro" {
		t.Fatalf("got %q, want org-ro once reachable after the TTL", got)
	}
}
