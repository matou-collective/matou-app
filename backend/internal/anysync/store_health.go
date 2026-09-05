// Package anysync provides any-sync integration for MATOU.
// store_health.go implements boot-time detection and recovery for damaged
// any-sync space stores (anystore/SQLite databases under {dataDir}/spaces).
//
// Background: on real devices the app can be hard-killed mid-write (OOM,
// crash loop, force-stop). This can leave the SQLite file/WAL in a state
// where PRAGMA quick_check passes but every write transaction fails with
// "disk I/O error", followed by cascading "no such savepoint: spN" errors
// from any-store's nested-transaction (SAVEPOINT) machinery. Reads and
// appends to already-loaded trees keep working; only brand new tree
// creation (which needs a fresh write transaction) is affected — so new
// members' trees never persist and space membership looks permanently
// incomplete.
//
// Since all space content is re-syncable from the network, the fix is to
// detect this condition and quarantine the damaged store directory so a
// fresh one is recreated (and re-populated via HeadSync) on next boot,
// rather than leaving the space permanently broken.
package anysync

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	anystore "github.com/anyproto/any-store"
	"github.com/anyproto/any-store/anyenc"
)

const (
	// spaceDBFileName is the anystore database file name inside each space directory.
	// Must match sdkStorageProvider's dbPath construction in sdk_client.go.
	spaceDBFileName = "data.db"

	// quarantineInfix separates a space ID from the quarantine timestamp suffix,
	// e.g. "bafy...abc.corrupt-1735689600". Used both to build and to recognize
	// (and thus skip re-probing) already-quarantined directories.
	quarantineInfix = ".corrupt-"

	// recoveryMarkerSuffix names the dead-man's-latch marker file written next
	// to a space directory (as a sibling file, not inside it, so it survives
	// even if the space directory itself is renamed away).
	recoveryMarkerSuffix = ".needs-recovery"

	// healthProbeCollectionName is a scratch anystore collection used purely to
	// exercise a real write transaction (CREATE + INSERT via a SAVEPOINT) during
	// the health probe. The probe transaction is always rolled back.
	healthProbeCollectionName = "_matou_health_probe"

	// treeBuildFailureThreshold is how many distinct trees must fail to build/fetch
	// with a storage I/O-type error in a single run before the dead-man's latch
	// forces quarantine of that space's store on the next boot.
	treeBuildFailureThreshold = 5

	// probeTimeout bounds each per-space health probe so a wedged store can't
	// hang startup indefinitely.
	probeTimeout = 30 * time.Second
)

// RecoverDamagedSpaceStores scans spacesDir for space store directories,
// health-checks each one with a real (rolled-back) write transaction, and
// quarantines (renames aside) any that fail the probe or were flagged by a
// prior run's dead-man's latch marker. It must be called at boot BEFORE the
// storage provider or space service is registered/used, so recreated spaces
// start from a clean slate.
//
// Identity material (peer.key, identity.json, keys/, matou.db, etc.) lives
// outside spacesDir and is never touched here.
func RecoverDamagedSpaceStores(ctx context.Context, spacesDir string) (quarantined []string, err error) {
	entries, err := os.ReadDir(spacesDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("reading spaces dir %s: %w", spacesDir, err)
	}

	for _, entry := range entries {
		if !entry.IsDir() {
			continue // marker files, stray regular files, etc.
		}
		spaceID := entry.Name()
		if strings.Contains(spaceID, quarantineInfix) {
			continue // already quarantined in a previous run
		}

		forced := recoveryMarkerExists(spacesDir, spaceID)
		probeErr := probeSpaceStoreHealth(ctx, filepath.Join(spacesDir, spaceID, spaceDBFileName))

		if probeErr == nil && !forced {
			continue // healthy, nothing to do
		}

		reason := probeErr
		if reason == nil {
			reason = fmt.Errorf("forced by prior dead-man's-latch marker")
		}
		log.Printf("[anysync] WARNING: space store %s failed health check, quarantining for re-sync: %v", spaceID, reason)

		dst, qerr := quarantineSpaceDir(spacesDir, spaceID)
		if qerr != nil {
			log.Printf("[anysync] ERROR: failed to quarantine damaged space store %s: %v (leaving in place)", spaceID, qerr)
			continue
		}
		clearRecoveryMarker(spacesDir, spaceID)
		log.Printf("[anysync] quarantined damaged space store: %s -> %s", spaceID, dst)
		quarantined = append(quarantined, dst)
	}

	return quarantined, nil
}

// probeSpaceStoreHealth opens the anystore database at dbPath (if present) and
// verifies it can actually service a write transaction. PRAGMA quick_check
// alone is not sufficient — a store can pass quick_check while every write
// transaction fails with a disk I/O error, so a real write-and-rollback probe
// is required in addition.
func probeSpaceStoreHealth(ctx context.Context, dbPath string) error {
	if _, statErr := os.Stat(dbPath); statErr != nil {
		if os.IsNotExist(statErr) {
			return nil // nothing to probe yet (e.g. bare directory)
		}
		return fmt.Errorf("stat %s: %w", dbPath, statErr)
	}

	probeCtx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()

	store, err := anystore.Open(probeCtx, dbPath, nil)
	if err != nil {
		return fmt.Errorf("open: %w", err)
	}
	defer func() { _ = store.Close() }()

	if err := store.QuickCheck(probeCtx); err != nil {
		return fmt.Errorf("quick_check: %w", err)
	}

	if err := writeProbe(probeCtx, store); err != nil {
		return fmt.Errorf("write probe: %w", err)
	}

	return nil
}

// writeProbe exercises the exact machinery that fails in production: opening
// a write transaction, creating/opening a collection (SAVEPOINT + write), and
// inserting a document. The transaction is always rolled back — this must
// never persist data into the store.
func writeProbe(ctx context.Context, store anystore.DB) error {
	tx, err := store.WriteTx(ctx)
	if err != nil {
		return fmt.Errorf("begin write tx: %w", err)
	}

	txCtx := tx.Context()
	coll, err := store.Collection(txCtx, healthProbeCollectionName)
	if err != nil {
		_ = tx.Rollback()
		return fmt.Errorf("open scratch collection: %w", err)
	}

	doc := anyenc.MustParseJson(fmt.Sprintf(`{"id":"probe-%d"}`, time.Now().UnixNano()))
	if err := coll.Insert(txCtx, doc); err != nil {
		_ = tx.Rollback()
		return fmt.Errorf("insert probe doc: %w", err)
	}

	if err := tx.Rollback(); err != nil {
		return fmt.Errorf("rollback probe tx: %w", err)
	}
	return nil
}

// quarantineSpaceDir renames a damaged space directory aside so a fresh one
// can be recreated and re-synced from the network. The quarantined directory
// is kept (not deleted) for forensics.
func quarantineSpaceDir(spacesDir, spaceID string) (string, error) {
	src := filepath.Join(spacesDir, spaceID)
	dst := filepath.Join(spacesDir, fmt.Sprintf("%s%s%d", spaceID, quarantineInfix, time.Now().Unix()))
	if err := os.Rename(src, dst); err != nil {
		return "", err
	}
	return dst, nil
}

// --- Dead-man's latch: marker file forcing quarantine on next boot ---

func recoveryMarkerPath(spacesDir, spaceID string) string {
	return filepath.Join(spacesDir, spaceID+recoveryMarkerSuffix)
}

// WriteRecoveryMarker records that spaceID's store should be force-quarantined
// on the next boot, even if the boot-time probe happens to pass (e.g. the
// underlying I/O fault is intermittent). Best-effort: errors are logged, not
// returned, since this is itself a fallback path.
func WriteRecoveryMarker(spacesDir, spaceID, reason string) {
	path := recoveryMarkerPath(spacesDir, spaceID)
	content := fmt.Sprintf("forced recovery requested at %s: %s\n", time.Now().UTC().Format(time.RFC3339), reason)
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		log.Printf("[anysync] WARNING: failed to write recovery marker for space %s: %v", spaceID, err)
	}
}

func recoveryMarkerExists(spacesDir, spaceID string) bool {
	_, err := os.Stat(recoveryMarkerPath(spacesDir, spaceID))
	return err == nil
}

func clearRecoveryMarker(spacesDir, spaceID string) {
	_ = os.Remove(recoveryMarkerPath(spacesDir, spaceID))
}

// isStoreIOError reports whether err looks like the SQLite/anystore I/O
// corruption signature seen in production: a disk I/O error on write, or one
// of the cascading errors (missing savepoint, malformed database) that follow
// once a write transaction has failed partway through.
func isStoreIOError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	for _, needle := range []string{
		"disk i/o error",
		"no such savepoint",
		"database disk image is malformed",
	} {
		if strings.Contains(msg, needle) {
			return true
		}
	}
	return false
}
