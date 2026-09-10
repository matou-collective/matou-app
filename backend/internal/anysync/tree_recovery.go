// Package anysync provides any-sync integration for MATOU.
// tree_recovery.go recovers an object tree whose FIRST persist failed, leaving
// orphan change rows in any-store with a missing/corrupt head-storage entry.
//
// Failure chain (any-sync v0.11.9, see #129): synctree.AddRawChanges →
// objectTree.AddRawChangesWithUpdater → our listener-as-updater returns nil →
// storage.AddAll fails inside any-store ("no such savepoint: spNNN") → the
// SDK's rollback() calls rebuildFromStorage → needs storage.CommonSnapshot →
// headStorage.GetEntry → "any-store: document not found", because for a tree
// persisted for the FIRST time (freshly fetched after an offline window) the
// head entry was written in the same transaction that just failed. The SDK's
// own recovery path is structurally unable to fix a tree whose first persist
// failed; it retries the same broken local state forever. This file detects
// that signature and clears the broken local state so a clean copy can be
// re-fetched from a peer, instead of looping.
package anysync

import (
	"context"
	"errors"
	"fmt"
	"strings"

	anystore "github.com/anyproto/any-store"
	"github.com/anyproto/any-store/query"
	"github.com/anyproto/any-sync/commonspace/headsync/headstorage"
	"github.com/anyproto/any-sync/commonspace/object/tree/objecttree"
)

// isFirstPersistCorruption reports whether err is the signature of a tree whose
// first persist failed — an orphan change set with a missing head entry that
// sends the SDK into a permanent rebuild loop (#129).
//
// This is the error that actually SURFACES to Matou from GetTree/SyncWithPeer:
// storage.CommonSnapshot → headStorage.GetEntry returns "document not found"
// during rebuildFromStorage, wrapped as "failed to get head entry for common
// snapshot: any-store: document not found" and passed up every hop with %w
// (verified through objecttreefactory → synctree → objecttreebuilder →
// UnifiedTreeManager.GetTree). So errors.Is(err, anystore.ErrDocNotFound) is
// reliable; the "common snapshot" / "head entry" context distinguishes it from
// the underlying anystore ErrDocNotFound used elsewhere.
//
// It matches deliberately narrowly so a healthy tree, or an ordinary
// unknown-tree miss (treestorage.ErrUnknownTreeId, which does NOT wrap
// anystore.ErrDocNotFound), never triggers a (recoverable but unnecessary)
// row drop. The "no such savepoint" any-store error that starts the chain is
// NOT matched here: it is a distinct transaction-misuse failure that can be
// transient and unrelated to a specific tree, and it is not what surfaces to
// the sync workers — the CommonSnapshot lookup it triggers is.
func isFirstPersistCorruption(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	if errors.Is(err, anystore.ErrDocNotFound) &&
		(strings.Contains(msg, "common snapshot") || strings.Contains(msg, "head entry")) {
		return true
	}
	// Defence in depth: if a hop ever re-wraps the chain without %w, still catch
	// the distinctive CommonSnapshot message by string.
	return strings.Contains(msg, "head entry for common snapshot")
}

// dropTreeRows removes a single tree's local persistence: every row in the
// "changes" collection tagged with its treeId, plus its head-storage entry.
// The blast radius is exactly one tree — the ACL, space settings and every
// other tree's rows are untouched (the delete is filtered on TreeKey).
//
// It is safe to call when the head entry is already missing (the
// first-persist-failure case): a not-found on DeleteEntry is ignored. After
// this runs the tree is absent locally, so the next HeadSync diff reports it
// as missing and the missing-tree worker re-fetches a clean copy from a peer.
func dropTreeRows(ctx context.Context, store anystore.DB, hs headstorage.HeadStorage, treeID string) error {
	coll, err := store.OpenCollection(ctx, objecttree.CollName)
	if err != nil {
		if errors.Is(err, anystore.ErrCollectionNotFound) {
			// No changes collection at all — nothing to drop but the head entry.
			if derr := hs.DeleteEntry(ctx, treeID); derr != nil && !errors.Is(derr, anystore.ErrDocNotFound) {
				return fmt.Errorf("delete head entry for tree %s: %w", treeID, derr)
			}
			return nil
		}
		return fmt.Errorf("open changes collection: %w", err)
	}
	if _, err := coll.Find(query.Key{
		Path:   []string{objecttree.TreeKey},
		Filter: query.NewComp(query.CompOpEq, treeID),
	}).Delete(ctx); err != nil {
		return fmt.Errorf("delete changes for tree %s: %w", treeID, err)
	}
	if err := hs.DeleteEntry(ctx, treeID); err != nil && !errors.Is(err, anystore.ErrDocNotFound) {
		return fmt.Errorf("delete head entry for tree %s: %w", treeID, err)
	}
	return nil
}
