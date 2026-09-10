package anysync

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	anystore "github.com/anyproto/any-store"
	"github.com/anyproto/any-sync/commonspace/spacepayloads"
)

// createTestSpace derives a fresh space and creates its storage through the
// provider, returning the space id and the underlying anystore.DB handle so the
// test can probe the handle's state after the provider is closed.
func createTestSpace(ctx context.Context, t *testing.T, p *sdkStorageProvider) (string, anystore.DB) {
	t.Helper()

	keys, err := GenerateSpaceKeySet()
	if err != nil {
		t.Fatalf("generating space keys: %v", err)
	}

	payload, err := spacepayloads.StoragePayloadForSpaceDerive(spacepayloads.SpaceDerivePayload{
		SigningKey: keys.SigningKey,
		MasterKey:  keys.MasterKey,
	})
	if err != nil {
		t.Fatalf("building space storage payload: %v", err)
	}

	storage, err := p.CreateSpaceStorage(ctx, payload)
	if err != nil {
		t.Fatalf("creating space storage: %v", err)
	}
	return storage.Id(), storage.AnyStore()
}

// TestStorageProviderCloseClosesHandles verifies that Close closes every cached
// per-space anystore handle (previously leaked as a no-op) and clears the cache,
// so the sqlite connections/fds do not accumulate on every app.Close.
func TestStorageProviderCloseClosesHandles(t *testing.T) {
	ctx := context.Background()
	p := newSDKStorageProvider(t.TempDir())

	type space struct {
		id string
		db anystore.DB
	}
	var spaces []space
	for i := 0; i < 3; i++ {
		id, db := createTestSpace(ctx, t, p)
		spaces = append(spaces, space{id: id, db: db})
	}

	if err := p.Close(ctx); err != nil {
		t.Fatalf("Close returned error: %v", err)
	}

	// The cache must be empty after Close.
	p.spaces.Range(func(key, _ any) bool {
		t.Errorf("space %v still cached after Close", key)
		return true
	})

	// Each underlying handle must be closed: a subsequent write errors as closed.
	for _, s := range spaces {
		if _, err := s.db.WriteTx(ctx); !errors.Is(err, anystore.ErrDBIsClosed) {
			t.Errorf("space %s: expected ErrDBIsClosed on write after Close, got %v", s.id, err)
		}
	}
}

// TestStorageProviderCloseAllowsImmediateReopen verifies the close-then-reopen
// ordering Reinitialize depends on: after Close, the same data.db files can be
// reopened immediately without a sqlite lock error (which a leaked handle would
// cause).
func TestStorageProviderCloseAllowsImmediateReopen(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	p := newSDKStorageProvider(root)

	var ids []string
	for i := 0; i < 3; i++ {
		id, _ := createTestSpace(ctx, t, p)
		ids = append(ids, id)
		// The db file must exist on disk for the reopen path.
		if _, err := os.Stat(filepath.Join(root, id, "data.db")); err != nil {
			t.Fatalf("space db missing: %v", err)
		}
	}

	if err := p.Close(ctx); err != nil {
		t.Fatalf("Close returned error: %v", err)
	}

	// A fresh provider over the same root (as initFullSDK builds after app.Close)
	// must reopen each db immediately without a lock error.
	p2 := newSDKStorageProvider(root)
	for _, id := range ids {
		storage, err := p2.WaitSpaceStorage(ctx, id)
		if err != nil {
			t.Fatalf("reopening space %s after Close: %v", id, err)
		}
		if storage.Id() != id {
			t.Errorf("reopened space id mismatch: got %s want %s", storage.Id(), id)
		}
	}
	if err := p2.Close(ctx); err != nil {
		t.Fatalf("second Close returned error: %v", err)
	}
}

// TestStorageProviderCloseEmpty verifies Close is a safe no-op when no space has
// been opened (the state of the failed first Mobile.start in #129, where Ping()
// ran before any space existed).
func TestStorageProviderCloseEmpty(t *testing.T) {
	p := newSDKStorageProvider(t.TempDir())
	if err := p.Close(context.Background()); err != nil {
		t.Fatalf("Close on empty provider returned error: %v", err)
	}
	// Idempotent: closing twice is still safe.
	if err := p.Close(context.Background()); err != nil {
		t.Fatalf("second Close on empty provider returned error: %v", err)
	}
}
