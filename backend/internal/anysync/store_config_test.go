package anysync

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
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
//
// The check parses the source rather than grepping it, so a call wrapped over
// several lines or made through an aliased import is still seen. It cannot see a
// nil that arrives in a variable; opening a store with anything but
// StoreConfig() (or a value built from it) is a review matter.
func TestNoStoreIsOpenedWithoutStoreConfig(t *testing.T) {
	root := filepath.Join("..", "..") // backend/
	var opens int
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
			found, nilOpens, err := nilConfigStoreOpens(path, src)
			if err != nil {
				return err
			}
			opens += found
			for _, pos := range nilOpens {
				t.Errorf("%s opens a store with a nil config — use anysync.StoreConfig() (#556)", pos)
			}
			return nil
		})
		if err != nil {
			t.Fatalf("walking %s: %v", dir, err)
		}
	}
	// If this drops to zero the scan has stopped seeing the opens at all (moved
	// package, renamed API) and is no longer guarding anything.
	if opens == 0 {
		t.Fatal("found no any-store Open calls to check — the scan is looking in the wrong place")
	}
}

func TestNilConfigStoreOpens_SeesWrappedAndAliasedCalls(t *testing.T) {
	cases := map[string]struct {
		src      string
		wantNil  int
		wantOpen int
	}{
		"single line nil": {`package x
import anystore "github.com/anyproto/any-store"
func f() { anystore.Open(ctx, p, nil) }`, 1, 1},
		"wrapped over lines": {`package x
import anystore "github.com/anyproto/any-store"
func f() {
	anystore.Open(
		ctx, p, nil,
	)
}`, 1, 1},
		"aliased import": {`package x
import st "github.com/anyproto/any-store"
func f() { st.Open(ctx, p, nil) }`, 1, 1},
		"with config": {`package x
import anystore "github.com/anyproto/any-store"
func f() { anystore.Open(ctx, p, StoreConfig()) }`, 0, 1},
		"someone else's Open": {`package x
import "os"
func f() { os.Open("x"); other.Open(ctx, p, nil) }`, 0, 0},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			opens, nilOpens, err := nilConfigStoreOpens("x.go", []byte(tc.src))
			if err != nil {
				t.Fatal(err)
			}
			if opens != tc.wantOpen || len(nilOpens) != tc.wantNil {
				t.Errorf("opens=%d nil=%d, want opens=%d nil=%d", opens, len(nilOpens), tc.wantOpen, tc.wantNil)
			}
		})
	}
}

// nilConfigStoreOpens parses one Go source file and returns how many calls to
// any-store's Open it contains and the positions of those passing a literal nil
// config.
func nilConfigStoreOpens(path string, src []byte) (opens int, nilOpens []string, err error) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, path, src, parser.SkipObjectResolution)
	if err != nil {
		return 0, nil, err
	}
	alias := ""
	for _, imp := range file.Imports {
		if strings.Trim(imp.Path.Value, `"`) != "github.com/anyproto/any-store" {
			continue
		}
		alias = "anystore" // the package's own name
		if imp.Name != nil {
			alias = imp.Name.Name
		}
	}
	if alias == "" {
		return 0, nil, nil
	}
	ast.Inspect(file, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok || sel.Sel.Name != "Open" {
			return true
		}
		if pkg, ok := sel.X.(*ast.Ident); !ok || pkg.Name != alias {
			return true
		}
		opens++
		if len(call.Args) == 3 {
			if id, ok := call.Args[2].(*ast.Ident); ok && id.Name == "nil" {
				nilOpens = append(nilOpens, fset.Position(call.Pos()).String())
			}
		}
		return true
	})
	return opens, nilOpens, nil
}
