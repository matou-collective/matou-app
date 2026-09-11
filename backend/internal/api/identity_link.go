package api

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/anyproto/any-sync/commonspace"
	"github.com/matou-dao/backend/internal/anysync"
)

// identity/set modes. The zero value ("") is recovery mode.
const (
	modeClaim = "claim"
	modeLink  = "link"
)

// recoverGetSpaceTimeout bounds a single GetSpace probe in recovery mode (and
// the per-poll GetSpace in shared-space recovery) before falling back / giving
// up. Package var so tests can shrink it.
var recoverGetSpaceTimeout = 10 * time.Second

// clientSetIdentityAbort is the client's AbortSignal.timeout on the
// POST /api/v1/identity/set request (frontend/src/lib/api/client.ts). The
// backend's worst-case link budget across all four spaces must stay
// comfortably under it, or a per-space 503 is unreachable by construction
// (#506): the client aborts the request and turns the abort into a
// non-retryable "Network error", so the auto-retry gate never sees the 503.
// Pinned here so TestLinkBudgetReconcilesWithClientAbort fails loudly if the
// two drift apart.
const clientSetIdentityAbort = 65 * time.Second

// Link-mode GetSpace backoff parameters. A linked device must never turn a slow
// network into a freshly-created (forked) space, so link mode polls GetSpace
// with exponential backoff up to a total budget and never creates. Package vars
// so tests can shrink them.
//
// linkGetSpaceBudget is per space and identity/set applies it across up to four
// spaces (private + community + read-only + admin), so 4 × budget is the
// worst-case wall time inside one request. It is kept well under
// clientSetIdentityAbort so every space's retryable 503 can actually reach the
// client and drive the sync-wait auto-retry (#506); do NOT raise the client
// abort to accommodate a larger budget — a multi-minute hanging POST is the
// wrong shape, cheap retries are what the "waiting for your data" screen is for.
var (
	linkGetSpaceBudget  = 10 * time.Second
	linkGetSpaceInitial = 1 * time.Second
	linkGetSpaceMax     = 8 * time.Second
)

// spaceResolver is the subset of *anysync.SDKClient needed to resolve (adopt or
// create) a space during identity/set. Declared as an interface so the
// mode-decision logic is unit-testable without a live any-sync network.
type spaceResolver interface {
	DeriveSpaceIDWithKeys(ctx context.Context, ownerAID, spaceType string, keys *anysync.SpaceKeySet) (string, error)
	GetSpace(ctx context.Context, spaceID string) (commonspace.Space, error)
	CreateSpaceWithKeys(ctx context.Context, ownerAID, spaceType string, keys *anysync.SpaceKeySet) (*anysync.SpaceCreateResult, error)
}

// getSpaceWithBackoff polls GetSpace with exponential backoff until the space
// opens or the budget elapses. It never creates. Used by link mode so a slow
// or briefly-unreachable network becomes a retry, never a second space with the
// same deterministic ID.
func getSpaceWithBackoff(ctx context.Context, client spaceResolver, spaceID string) error {
	deadline := time.Now().Add(linkGetSpaceBudget)
	delay := linkGetSpaceInitial
	var lastErr error

	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			if lastErr == nil {
				lastErr = context.DeadlineExceeded
			}
			return fmt.Errorf("space %s not reachable within %s: %w", spaceID, linkGetSpaceBudget, lastErr)
		}

		attemptTimeout := linkGetSpaceMax
		if attemptTimeout > remaining {
			attemptTimeout = remaining
		}
		attemptCtx, cancel := context.WithTimeout(ctx, attemptTimeout)
		_, err := client.GetSpace(attemptCtx, spaceID)
		cancel()
		if err == nil {
			return nil
		}
		lastErr = err

		if err := ctx.Err(); err != nil {
			return err
		}

		sleep := delay
		if rem := time.Until(deadline); sleep > rem {
			sleep = rem
		}
		if sleep <= 0 {
			continue
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(sleep):
		}
		if delay < linkGetSpaceMax {
			delay *= 2
			if delay > linkGetSpaceMax {
				delay = linkGetSpaceMax
			}
		}
	}
}

// privateSpaceOutcome is the result of resolving the user's private space.
type privateSpaceOutcome struct {
	spaceID string
	// unreachable is set only in link mode: the deterministic private space
	// never opened within the backoff budget, so nothing was created and the
	// handler must 503 (retryable) rather than fork a new space.
	unreachable bool
}

// resolvePrivateSpace applies the mode-specific policy for the user's private
// space:
//
//	claim:    create the space directly.
//	link:     GetSpace with bounded backoff; never create. Unreachable => 503.
//	recovery: one short GetSpace probe, then fall back to creating (unchanged).
func resolvePrivateSpace(ctx context.Context, client spaceResolver, aid string, keys *anysync.SpaceKeySet, mode string) (privateSpaceOutcome, error) {
	derivedID, err := client.DeriveSpaceIDWithKeys(ctx, aid, anysync.SpaceTypePrivate, keys)
	if err != nil {
		return privateSpaceOutcome{}, fmt.Errorf("deriving private space ID: %w", err)
	}

	switch mode {
	case modeClaim:
		res, err := client.CreateSpaceWithKeys(ctx, aid, anysync.SpaceTypePrivate, keys)
		if err != nil {
			return privateSpaceOutcome{}, err
		}
		return privateSpaceOutcome{spaceID: res.SpaceID}, nil

	case modeLink:
		if err := getSpaceWithBackoff(ctx, client, derivedID); err != nil {
			return privateSpaceOutcome{unreachable: true}, nil
		}
		return privateSpaceOutcome{spaceID: derivedID}, nil

	default: // recovery
		rctx, cancel := context.WithTimeout(ctx, recoverGetSpaceTimeout)
		_, gErr := client.GetSpace(rctx, derivedID)
		cancel()
		if gErr != nil {
			res, cErr := client.CreateSpaceWithKeys(ctx, aid, anysync.SpaceTypePrivate, keys)
			if cErr != nil {
				return privateSpaceOutcome{}, cErr
			}
			return privateSpaceOutcome{spaceID: res.SpaceID}, nil
		}
		return privateSpaceOutcome{spaceID: derivedID}, nil
	}
}

// sharedSpace is one shared any-sync space identity/set adopts after the
// private space: the community space, the community read-only space and the
// admin space. mnemonicIx is the mnemonic derivation index of its key set.
//
// required marks the space whose ACL membership identity/set cannot do
// without: a definitive "not in the ACL" answer there is a 409 (#290). The
// read-only and admin spaces are optional — an ordinary member is never in the
// admin ACL, so a miss there only skips adoption.
type sharedSpace struct {
	id         string
	mnemonicIx uint32
	label      string
	required   bool
}

// sharedSpacesToAdopt lists the shared spaces identity/set adopts in recovery
// and link mode, in adoption order. Empty IDs are kept (callers skip them) so
// the mnemonic indices stay fixed per space type.
func sharedSpacesToAdopt(communityID, readOnlyID, adminID string) []sharedSpace {
	return []sharedSpace{
		{id: communityID, mnemonicIx: 1, label: "community", required: true},
		{id: readOnlyID, mnemonicIx: 2, label: "read-only", required: false},
		{id: adminID, mnemonicIx: 3, label: "admin", required: false},
	}
}

// recoverSharedSpace re-derives (when missing) and persists the mnemonic-derived
// key set for a known shared space (community / read-only / admin), then adopts
// it. It never creates.
//
// In link mode it adopts with bounded backoff and persists nothing when the
// space stays unreachable (returning unreachable=true so the handler 503s). In
// recovery mode it persists keys first and then does a single bounded GetSpace,
// tolerating a miss — the original behaviour. A successful link run therefore
// writes exactly the same key files as a recovery run.
func (h *IdentityHandler) recoverSharedSpace(ctx context.Context, spaceID, mnemonic string, mnemonicIndex uint32, label string, isLink bool) (unreachable bool, notInACL bool) {
	client := h.sdkClient
	dataDir := client.GetDataDir()

	// persistKeys re-derives and persists the key set if it is not already on
	// disk. The read key is random and differs from the original; any-sync
	// recovers the real read key from ACL state during tree sync.
	persistKeys := func() {
		if _, err := anysync.LoadSpaceKeySet(dataDir, spaceID); err == nil {
			return
		}
		keys, err := anysync.DeriveSpaceKeySet(mnemonic, mnemonicIndex)
		if err != nil {
			log.Printf("[Identity] Failed to derive %s space keys: %v\n", label, err)
			return
		}
		keys.SigningKey = client.GetSigningKey()
		_ = anysync.PersistSpaceKeySet(dataDir, spaceID, keys)
		log.Printf("[Identity] Re-derived %s space keys for %s\n", label, spaceID)
	}

	if isLink {
		if err := getSpaceWithBackoff(ctx, client, spaceID); err != nil {
			return true, false
		}
		persistKeys()
		log.Printf("[Identity] Link: adopted %s space: %s\n", label, spaceID)
		return false, false
	}

	// Recovery mode. When no key set is on disk yet we are about to derive keys
	// from the current mnemonic. Before doing so, confirm this identity is
	// actually in the space's ACL. A fresh admin re-adopting a previous attempt's
	// shared space (issue #290) is NOT in that ACL, so the derived read key is
	// simply wrong and any-sync can never recover the real one — readKeysFromAclState
	// skips identities absent from the ACL. Persisting it silently yields
	// unreadable SharedProfile trees and a storm of 500s, so fail loudly instead.
	// We only refuse on a DEFINITIVE "not in ACL" answer: a lookup error (ACL not
	// yet synced) falls through to the existing best-effort recovery.
	if _, keyErr := anysync.LoadSpaceKeySet(dataDir, spaceID); keyErr != nil {
		if aclMgr, signingKey := h.spaceManager.ACLManager(), client.GetSigningKey(); aclMgr != nil && signingKey != nil {
			pctx, cancel := context.WithTimeout(ctx, recoverGetSpaceTimeout)
			perms, permErr := aclMgr.GetPermissions(pctx, spaceID, signingKey.GetPublic())
			cancel()
			if permErr == nil && perms.NoPermissions() {
				log.Printf("[Identity] Cannot recover %s space %s: identity is not in its ACL (no read key)\n", label, spaceID)
				return false, true
			}
		}
	}

	persistKeys()
	if _, err := anysync.LoadSpaceKeySet(dataDir, spaceID); err == nil {
		rctx, cancel := context.WithTimeout(ctx, recoverGetSpaceTimeout)
		_, err := client.GetSpace(rctx, spaceID)
		cancel()
		if err != nil {
			log.Printf("[Identity] Failed to sync %s space %s: %v\n", label, spaceID, err)
		} else {
			log.Printf("[Identity] Recovered %s space: %s\n", label, spaceID)
		}
	}
	return false, false
}
