package anysync

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// #556: inside the Android app sandbox SQLite has no usable temp directory, so
// anything it spills to a temp file fails with SQLITE_IOERR_GETTEMPPATH ("disk
// I/O error"). Every store the backend opens must keep SQLite's temp storage in
// memory.
func TestStoreConfig_KeepsSQLiteTempStorageInMemory(t *testing.T) {
	cfg := StoreConfig()
	if cfg == nil {
		t.Fatal("StoreConfig returned nil")
	}
	if got := cfg.SQLiteConnectionOptions["temp_store"]; !strings.EqualFold(got, "MEMORY") {
		t.Errorf(`temp_store = %q, want "MEMORY"`, got)
	}

	// Callers add their own settings to the returned value; it must not be shared.
	cfg.SQLiteConnectionOptions["temp_store"] = "FILE"
	if got := StoreConfig().SQLiteConnectionOptions["temp_store"]; !strings.EqualFold(got, "MEMORY") {
		t.Errorf("StoreConfig must return a fresh config each call, got temp_store=%q after a caller mutated one", got)
	}
}

// A store opened with a nil config silently gets SQLite's default (temp files),
// which works everywhere except on a phone. Keep every non-test open going
// through StoreConfig.
func TestNoStoreIsOpenedWithoutStoreConfig(t *testing.T) {
	nilConfigOpen := regexp.MustCompile(`anystore\.Open\([^)]*,\s*nil\s*\)`)
	root := filepath.Join("..", "..") // backend/
	for _, dir := range []string{"internal", "cmd"} {
		err := filepath.WalkDir(filepath.Join(root, dir), func(path string, d os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			src, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			for i, line := range strings.Split(string(src), "\n") {
				if nilConfigOpen.MatchString(line) {
					t.Errorf("%s:%d opens a store with a nil config — use anysync.StoreConfig() (#556)", path, i+1)
				}
			}
			return nil
		})
		if err != nil {
			t.Fatalf("walking %s: %v", dir, err)
		}
	}
}
