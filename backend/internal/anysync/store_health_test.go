package anysync

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	anystore "github.com/anyproto/any-store"
)

// createHealthySpaceStore opens (and closes) a real anystore database at the
// given path so it looks like a genuine any-sync space store on disk.
func createHealthySpaceStore(t *testing.T, dbPath string) {
	t.Helper()
	ctx := context.Background()
	store, err := anystore.Open(ctx, dbPath, nil)
	if err != nil {
		t.Fatalf("creating test store: %v", err)
	}
	if _, err := store.Collection(ctx, "some_collection"); err != nil {
		t.Fatalf("creating test collection: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("closing test store: %v", err)
	}
}

// corruptFileMidway deliberately damages a file by zeroing out the SQLite
// schema page (page 1, past the 100-byte file header) while leaving the
// header itself intact — simulating the kind of on-disk damage left by a
// hard process kill mid-write. The file still opens as *a* SQLite database
// (the header is fine) but its schema/b-tree structure is destroyed, so
// SQLite reliably reports "database disk image is malformed".
func corruptFileMidway(t *testing.T, path string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading file to corrupt: %v", err)
	}
	const sqliteHeaderSize = 100
	if len(data) < sqliteHeaderSize+64 {
		t.Fatalf("file too small to corrupt meaningfully: %d bytes", len(data))
	}
	pageSize := len(data)
	if pageSize > 4096 {
		pageSize = 4096 // default SQLite page size; page 1 ends here
	}
	for i := sqliteHeaderSize; i < pageSize; i++ {
		data[i] = 0
	}
	if err := os.WriteFile(path, data, 0644); err != nil {
		t.Fatalf("writing corrupted file: %v", err)
	}
}

// truncateFile cuts a file down to make it structurally invalid.
func truncateFile(t *testing.T, path string, size int64) {
	t.Helper()
	if err := os.Truncate(path, size); err != nil {
		t.Fatalf("truncating file: %v", err)
	}
}

func TestProbeSpaceStoreHealth_MissingIsHealthy(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "does-not-exist", "data.db")
	if err := probeSpaceStoreHealth(context.Background(), dbPath); err != nil {
		t.Errorf("expected nil error for missing store, got: %v", err)
	}
}

func TestProbeSpaceStoreHealth_HealthyStorePasses(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "data.db")
	createHealthySpaceStore(t, dbPath)

	if err := probeSpaceStoreHealth(context.Background(), dbPath); err != nil {
		t.Errorf("expected healthy store to pass probe, got: %v", err)
	}
}

func TestProbeSpaceStoreHealth_TruncatedFileFails(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "data.db")
	createHealthySpaceStore(t, dbPath)
	truncateFile(t, dbPath, 100) // well below a single SQLite page

	if err := probeSpaceStoreHealth(context.Background(), dbPath); err == nil {
		t.Error("expected truncated store to fail probe, got nil error")
	}
}

func TestProbeSpaceStoreHealth_CorruptedMidfileFails(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "data.db")
	createHealthySpaceStore(t, dbPath)
	corruptFileMidway(t, dbPath)

	if err := probeSpaceStoreHealth(context.Background(), dbPath); err == nil {
		t.Error("expected midfile-corrupted store to fail probe, got nil error")
	}
}

func TestRecoverDamagedSpaceStores_NoSpacesDir(t *testing.T) {
	dir := t.TempDir()
	quarantined, err := RecoverDamagedSpaceStores(context.Background(), filepath.Join(dir, "spaces"))
	if err != nil {
		t.Fatalf("expected nil error for missing spaces dir, got: %v", err)
	}
	if len(quarantined) != 0 {
		t.Errorf("expected no quarantined spaces, got: %v", quarantined)
	}
}

func TestRecoverDamagedSpaceStores_QuarantinesOnlyDamaged(t *testing.T) {
	spacesDir := filepath.Join(t.TempDir(), "spaces")
	if err := os.MkdirAll(spacesDir, 0755); err != nil {
		t.Fatal(err)
	}

	healthyID := "space-healthy"
	damagedID := "space-damaged"

	healthyDir := filepath.Join(spacesDir, healthyID)
	damagedDir := filepath.Join(spacesDir, damagedID)
	if err := os.MkdirAll(healthyDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(damagedDir, 0755); err != nil {
		t.Fatal(err)
	}

	createHealthySpaceStore(t, filepath.Join(healthyDir, spaceDBFileName))
	createHealthySpaceStore(t, filepath.Join(damagedDir, spaceDBFileName))
	corruptFileMidway(t, filepath.Join(damagedDir, spaceDBFileName))

	quarantined, err := RecoverDamagedSpaceStores(context.Background(), spacesDir)
	if err != nil {
		t.Fatalf("RecoverDamagedSpaceStores error: %v", err)
	}
	if len(quarantined) != 1 {
		t.Fatalf("expected exactly 1 quarantined space, got %d: %v", len(quarantined), quarantined)
	}

	// Healthy space untouched.
	if _, err := os.Stat(healthyDir); err != nil {
		t.Errorf("expected healthy space dir to remain at %s: %v", healthyDir, err)
	}

	// Damaged space renamed aside, original name gone.
	if _, err := os.Stat(damagedDir); !os.IsNotExist(err) {
		t.Errorf("expected damaged space dir %s to be renamed away, stat err: %v", damagedDir, err)
	}
	entries, err := os.ReadDir(spacesDir)
	if err != nil {
		t.Fatal(err)
	}
	var foundQuarantine bool
	for _, e := range entries {
		if e.IsDir() && e.Name() != healthyID && e.Name() != damagedID {
			foundQuarantine = true
		}
	}
	if !foundQuarantine {
		t.Errorf("expected a quarantined directory distinct from original names, entries: %v", entries)
	}
}

func TestRecoverDamagedSpaceStores_SkipsAlreadyQuarantined(t *testing.T) {
	spacesDir := filepath.Join(t.TempDir(), "spaces")
	quarantinedName := "space-abc" + quarantineInfix + "1700000000"
	dir := filepath.Join(spacesDir, quarantinedName)
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	// No data.db at all inside — if this were probed and treated as a live
	// space it would be "healthy" (missing db = nothing to probe), but it
	// must not even be considered.
	quarantined, err := RecoverDamagedSpaceStores(context.Background(), spacesDir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(quarantined) != 0 {
		t.Errorf("expected already-quarantined dir to be skipped, got: %v", quarantined)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Errorf("expected quarantined dir to remain untouched: %v", err)
	}
}

func TestRecoverDamagedSpaceStores_ForcedByMarkerEvenWhenHealthy(t *testing.T) {
	spacesDir := filepath.Join(t.TempDir(), "spaces")
	spaceID := "space-forced"
	spaceDir := filepath.Join(spacesDir, spaceID)
	if err := os.MkdirAll(spaceDir, 0755); err != nil {
		t.Fatal(err)
	}
	createHealthySpaceStore(t, filepath.Join(spaceDir, spaceDBFileName))

	// Store is healthy, but a prior run's dead-man's latch flagged it.
	WriteRecoveryMarker(spacesDir, spaceID, "test-forced")
	if !recoveryMarkerExists(spacesDir, spaceID) {
		t.Fatal("expected recovery marker to exist after WriteRecoveryMarker")
	}

	quarantined, err := RecoverDamagedSpaceStores(context.Background(), spacesDir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(quarantined) != 1 {
		t.Fatalf("expected forced quarantine despite healthy probe, got %d: %v", len(quarantined), quarantined)
	}
	if _, err := os.Stat(spaceDir); !os.IsNotExist(err) {
		t.Errorf("expected original space dir to be renamed away")
	}
	if recoveryMarkerExists(spacesDir, spaceID) {
		t.Error("expected recovery marker to be cleared after quarantine")
	}
}

func TestWriteRecoveryMarker_RoundTrip(t *testing.T) {
	spacesDir := t.TempDir()
	spaceID := "space-xyz"

	if recoveryMarkerExists(spacesDir, spaceID) {
		t.Fatal("marker should not exist before it is written")
	}
	WriteRecoveryMarker(spacesDir, spaceID, "some reason")
	if !recoveryMarkerExists(spacesDir, spaceID) {
		t.Fatal("marker should exist after WriteRecoveryMarker")
	}
	clearRecoveryMarker(spacesDir, spaceID)
	if recoveryMarkerExists(spacesDir, spaceID) {
		t.Fatal("marker should not exist after clearRecoveryMarker")
	}
}

func TestIsStoreIOError(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"nil error", nil, false},
		{"disk io error", errors.New("sqlite: step: disk I/O error"), true},
		{"missing savepoint cascade", fmt.Errorf("SQL logic error: no such savepoint: sp3"), true},
		{"malformed database", errors.New("database disk image is malformed"), true},
		{"unrelated not-found error", errors.New("collection not found"), false},
		{"context canceled", context.Canceled, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := isStoreIOError(c.err); got != c.want {
				t.Errorf("isStoreIOError(%v) = %v, want %v", c.err, got, c.want)
			}
		})
	}
}

func TestUnifiedTreeManager_RecordBuildFailure_WritesMarkerAtThreshold(t *testing.T) {
	spacesDir := t.TempDir()
	utm := NewUnifiedTreeManager()
	utm.SetSpacesDir(spacesDir)

	spaceID := "space-latch"
	ioErr := errors.New("building tree X: add all: sqlite: step: disk I/O error")

	// Below threshold: distinct trees, but not yet enough of them.
	for i := 0; i < treeBuildFailureThreshold-1; i++ {
		utm.recordBuildFailure(spaceID, fmt.Sprintf("tree-%d", i), ioErr)
	}
	if recoveryMarkerExists(spacesDir, spaceID) {
		t.Fatal("marker should not exist before threshold is reached")
	}

	// Reaching the threshold with one more distinct tree should write the marker.
	utm.recordBuildFailure(spaceID, fmt.Sprintf("tree-%d", treeBuildFailureThreshold-1), ioErr)
	if !recoveryMarkerExists(spacesDir, spaceID) {
		t.Fatal("expected marker to be written once threshold is reached")
	}
}

func TestUnifiedTreeManager_RecordBuildFailure_IgnoresNonIOErrors(t *testing.T) {
	spacesDir := t.TempDir()
	utm := NewUnifiedTreeManager()
	utm.SetSpacesDir(spacesDir)

	spaceID := "space-other"
	notIOErr := errors.New("no read key available")

	for i := 0; i < treeBuildFailureThreshold+5; i++ {
		utm.recordBuildFailure(spaceID, fmt.Sprintf("tree-%d", i), notIOErr)
	}
	if recoveryMarkerExists(spacesDir, spaceID) {
		t.Error("non-I/O errors must never trigger the dead-man's latch")
	}
}

func TestUnifiedTreeManager_RecordBuildFailure_SameTreeDoesNotDoubleCount(t *testing.T) {
	spacesDir := t.TempDir()
	utm := NewUnifiedTreeManager()
	utm.SetSpacesDir(spacesDir)

	spaceID := "space-repeat"
	ioErr := errors.New("disk I/O error")

	// Repeatedly failing the SAME tree should never reach the distinct-tree
	// threshold, no matter how many times it happens.
	for i := 0; i < treeBuildFailureThreshold*3; i++ {
		utm.recordBuildFailure(spaceID, "same-tree-id", ioErr)
	}
	if recoveryMarkerExists(spacesDir, spaceID) {
		t.Error("repeated failures of a single tree must not trigger the latch")
	}
}

func TestUnifiedTreeManager_RecordBuildFailure_NoopWithoutSpacesDir(t *testing.T) {
	utm := NewUnifiedTreeManager() // SetSpacesDir never called
	ioErr := errors.New("disk I/O error")
	for i := 0; i < treeBuildFailureThreshold+1; i++ {
		// Must not panic even though spacesDir is empty.
		utm.recordBuildFailure("space-none", fmt.Sprintf("tree-%d", i), ioErr)
	}
}
