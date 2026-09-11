package api

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/anyproto/any-sync/commonspace"
	"github.com/matou-dao/backend/internal/anysync"
)

// fakeSpaceResolver is a test double for the space operations used by
// resolvePrivateSpace / getSpaceWithBackoff. It records calls so tests can
// assert that link mode never creates.
type fakeSpaceResolver struct {
	derivedID string

	// getSpaceErrs is consumed one per GetSpace call; a nil entry means the
	// space opened. When exhausted, the last behaviour repeats.
	getSpaceErrs []error
	getSpaceIdx  int

	getSpaceCalls int
	createCalls   int
	createID      string
	createErr     error
}

func (f *fakeSpaceResolver) DeriveSpaceIDWithKeys(_ context.Context, _, _ string, _ *anysync.SpaceKeySet) (string, error) {
	return f.derivedID, nil
}

func (f *fakeSpaceResolver) GetSpace(_ context.Context, _ string) (commonspace.Space, error) {
	f.getSpaceCalls++
	if len(f.getSpaceErrs) == 0 {
		return nil, nil
	}
	i := f.getSpaceIdx
	if i >= len(f.getSpaceErrs) {
		i = len(f.getSpaceErrs) - 1
	}
	f.getSpaceIdx++
	return nil, f.getSpaceErrs[i]
}

func (f *fakeSpaceResolver) CreateSpaceWithKeys(_ context.Context, _, _ string, _ *anysync.SpaceKeySet) (*anysync.SpaceCreateResult, error) {
	f.createCalls++
	if f.createErr != nil {
		return nil, f.createErr
	}
	return &anysync.SpaceCreateResult{SpaceID: f.createID}, nil
}

// shrinkLinkBackoff makes the link-mode backoff finish in milliseconds so an
// "unreachable" test does not wait the full 60s budget. Returns a restore func.
func shrinkLinkBackoff(t *testing.T) {
	t.Helper()
	oldBudget, oldInitial, oldMax := linkGetSpaceBudget, linkGetSpaceInitial, linkGetSpaceMax
	oldRecover := recoverGetSpaceTimeout
	linkGetSpaceBudget = 40 * time.Millisecond
	linkGetSpaceInitial = 5 * time.Millisecond
	linkGetSpaceMax = 10 * time.Millisecond
	recoverGetSpaceTimeout = 10 * time.Millisecond
	t.Cleanup(func() {
		linkGetSpaceBudget, linkGetSpaceInitial, linkGetSpaceMax = oldBudget, oldInitial, oldMax
		recoverGetSpaceTimeout = oldRecover
	})
}

// TestLinkBudgetReconcilesWithClientAbort pins #506 defect B: the backend's
// worst-case link budget across all four spaces (private + community +
// read-only + admin) must stay comfortably under the client's identity/set
// abort, or a per-space 503 can never reach the client. With the abort at 65s
// this proves that even the last space's 503 (community/read-only/admin) is
// reachable — not just the private one.
func TestLinkBudgetReconcilesWithClientAbort(t *testing.T) {
	const spaces = 4 // private + community + read-only + admin
	worstCase := time.Duration(spaces) * linkGetSpaceBudget
	// Leave generous headroom for the non-backoff work in identity/set
	// (SDK reinit, key derivation, persistence, seeding) before the abort.
	const headroom = 20 * time.Second
	if worstCase+headroom >= clientSetIdentityAbort {
		t.Fatalf("worst-case link budget %s (4×%s) + %s headroom must stay under client abort %s; "+
			"lower linkGetSpaceBudget so every space's 503 is reachable (#506)",
			worstCase, linkGetSpaceBudget, headroom, clientSetIdentityAbort)
	}
	if linkGetSpaceMax > linkGetSpaceBudget {
		t.Errorf("per-attempt timeout %s must not exceed the per-space budget %s", linkGetSpaceMax, linkGetSpaceBudget)
	}
}

func TestResolvePrivateSpace_Claim_CreatesDirectly(t *testing.T) {
	f := &fakeSpaceResolver{derivedID: "Sderived", createID: "Screated"}
	out, err := resolvePrivateSpace(context.Background(), f, "Eaid", &anysync.SpaceKeySet{}, modeClaim)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.unreachable {
		t.Fatal("claim must never be unreachable")
	}
	if out.spaceID != "Screated" {
		t.Errorf("claim should use created ID, got %q", out.spaceID)
	}
	if f.createCalls != 1 {
		t.Errorf("claim should create exactly once, got %d", f.createCalls)
	}
	if f.getSpaceCalls != 0 {
		t.Errorf("claim must not probe GetSpace, got %d calls", f.getSpaceCalls)
	}
}

func TestResolvePrivateSpace_LinkReachable_AdoptsNeverCreates(t *testing.T) {
	shrinkLinkBackoff(t)
	f := &fakeSpaceResolver{derivedID: "Sderived", getSpaceErrs: []error{nil}}
	out, err := resolvePrivateSpace(context.Background(), f, "Eaid", &anysync.SpaceKeySet{}, modeLink)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.unreachable {
		t.Fatal("reachable link should not be unreachable")
	}
	if out.spaceID != "Sderived" {
		t.Errorf("link should adopt the deterministic ID, got %q", out.spaceID)
	}
	if f.createCalls != 0 {
		t.Errorf("link must NEVER create, got %d create calls", f.createCalls)
	}
}

func TestResolvePrivateSpace_LinkUnreachable_NeverCreates(t *testing.T) {
	shrinkLinkBackoff(t)
	f := &fakeSpaceResolver{derivedID: "Sderived", getSpaceErrs: []error{errors.New("no route")}}
	out, err := resolvePrivateSpace(context.Background(), f, "Eaid", &anysync.SpaceKeySet{}, modeLink)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !out.unreachable {
		t.Fatal("unreachable link must report unreachable")
	}
	if out.spaceID != "" {
		t.Errorf("unreachable link must not resolve a space ID, got %q", out.spaceID)
	}
	if f.createCalls != 0 {
		t.Errorf("link must NEVER create, got %d create calls", f.createCalls)
	}
	if f.getSpaceCalls < 2 {
		t.Errorf("link should retry GetSpace, got only %d calls", f.getSpaceCalls)
	}
}

func TestResolvePrivateSpace_RecoveryReachable_AdoptsNeverCreates(t *testing.T) {
	shrinkLinkBackoff(t)
	f := &fakeSpaceResolver{derivedID: "Sderived", getSpaceErrs: []error{nil}}
	out, err := resolvePrivateSpace(context.Background(), f, "Eaid", &anysync.SpaceKeySet{}, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.spaceID != "Sderived" {
		t.Errorf("recovery should adopt the deterministic ID, got %q", out.spaceID)
	}
	if f.createCalls != 0 {
		t.Errorf("reachable recovery must not create, got %d", f.createCalls)
	}
}

func TestResolvePrivateSpace_RecoveryUnreachable_FallsBackToCreate(t *testing.T) {
	shrinkLinkBackoff(t)
	f := &fakeSpaceResolver{derivedID: "Sderived", createID: "Screated", getSpaceErrs: []error{errors.New("miss")}}
	out, err := resolvePrivateSpace(context.Background(), f, "Eaid", &anysync.SpaceKeySet{}, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.spaceID != "Screated" {
		t.Errorf("recovery miss should create, got %q", out.spaceID)
	}
	if f.createCalls != 1 {
		t.Errorf("recovery miss should create once, got %d", f.createCalls)
	}
	if f.getSpaceCalls != 1 {
		t.Errorf("recovery should probe GetSpace exactly once, got %d", f.getSpaceCalls)
	}
}

func TestGetSpaceWithBackoff_SucceedsAfterRetries(t *testing.T) {
	shrinkLinkBackoff(t)
	// Fail twice, then succeed.
	f := &fakeSpaceResolver{getSpaceErrs: []error{errors.New("x"), errors.New("y"), nil}}
	if err := getSpaceWithBackoff(context.Background(), f, "S"); err != nil {
		t.Fatalf("expected success after retries, got %v", err)
	}
	if f.getSpaceCalls != 3 {
		t.Errorf("expected 3 GetSpace calls, got %d", f.getSpaceCalls)
	}
}

func TestGetSpaceWithBackoff_RespectsContextCancel(t *testing.T) {
	shrinkLinkBackoff(t)
	linkGetSpaceBudget = 10 * time.Second // long budget; cancel should win
	f := &fakeSpaceResolver{getSpaceErrs: []error{errors.New("x")}}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := getSpaceWithBackoff(ctx, f, "S"); err == nil {
		t.Fatal("expected error on cancelled context")
	}
}

// TestSharedSpacesToAdopt_OnlyCommunityIsRequired pins the #290 policy: a
// definitive "not in the ACL" answer is fatal (409) only for the community
// space. An ordinary member is never in the admin ACL, so treating a miss there
// as fatal would block every member's mnemonic recovery.
func TestSharedSpacesToAdopt_OnlyCommunityIsRequired(t *testing.T) {
	got := sharedSpacesToAdopt("cs", "ro", "adm")
	want := []sharedSpace{
		{id: "cs", mnemonicIx: 1, label: "community", required: true},
		{id: "ro", mnemonicIx: 2, label: "read-only", required: false},
		{id: "adm", mnemonicIx: 3, label: "admin", required: false},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d spaces, want %d: %+v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("space %d: got %+v, want %+v", i, got[i], want[i])
		}
	}
	// Empty IDs keep their slot so mnemonic indices never shift per space type.
	if s := sharedSpacesToAdopt("cs", "", ""); len(s) != 3 || s[2].mnemonicIx != 3 {
		t.Errorf("empty IDs must keep their slots, got %+v", s)
	}
}
