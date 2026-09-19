// Command store-replay copies trees from one any-sync space store into a fresh
// one through the write path a device takes when it receives a tree from a peer
// (objecttree.CreateStorageWithDeferredCreation + AddAll), and reports which
// trees could be stored.
//
// It exists to reproduce #556 without a network or an identity: inside the
// Android app sandbox SQLite has no temp directory, and that write path spills a
// savepoint sub-journal to a temp file for any tree with more than a few changes.
// Run it inside the sandbox of a debuggable build:
//
//	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o store-replay ./cmd/store-replay   # arm64 for a phone
//	adb push store-replay <src>/data.db /data/local/tmp/
//	adb shell run-as nz.matou.app sh -c 'cp /data/local/tmp/store-replay /data/local/tmp/data.db . && cd / && \
//	    env -u TMPDIR $OLDPWD/store-replay -src $OLDPWD/data.db -dst $OLDPWD/files/replay -config nil'
//
// -config nil   opens the destination the way the backend did before #556
// -config store opens it with anysync.StoreConfig(), as the backend does now
//
// As the adb shell user (outside run-as) everything passes either way — the
// shell has a usable temp directory — which is why the failure cannot be seen
// from outside the app.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"

	anystore "github.com/anyproto/any-store"
	"github.com/anyproto/any-sync/commonspace/headsync/headstorage"
	"github.com/anyproto/any-sync/commonspace/object/tree/objecttree"

	"github.com/matou-dao/backend/internal/anysync"
)

func main() {
	src := flag.String("src", "", "path to the source space store (data.db); opened read-write by any-store, so pass a COPY")
	dst := flag.String("dst", "", "directory for the fresh destination store (its data.db is recreated)")
	config := flag.String("config", "store", `destination store config: "store" (anysync.StoreConfig) or "nil" (pre-#556)`)
	flag.Parse()
	if *src == "" || *dst == "" {
		flag.Usage()
		os.Exit(2)
	}
	if err := run(context.Background(), *src, *dst, *config); err != nil {
		fmt.Fprintln(os.Stderr, "store-replay:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, src, dstDir, config string) error {
	var dstCfg *anystore.Config
	switch config {
	case "store":
		dstCfg = anysync.StoreConfig()
	case "nil":
	default:
		return fmt.Errorf("unknown -config %q", config)
	}
	if err := os.MkdirAll(dstDir, 0o755); err != nil {
		return err
	}
	for _, f := range []string{"data.db", "data.db-wal", "data.db-shm"} {
		_ = os.Remove(filepath.Join(dstDir, f))
	}

	srcDB, err := anystore.Open(ctx, src, anysync.StoreConfig())
	if err != nil {
		return fmt.Errorf("opening source: %w", err)
	}
	defer func() { _ = srcDB.Close() }()
	dstDB, err := anystore.Open(ctx, filepath.Join(dstDir, "data.db"), dstCfg)
	if err != nil {
		return fmt.Errorf("opening destination: %w", err)
	}
	defer func() { _ = dstDB.Close() }()

	srcHeads, err := headstorage.New(ctx, srcDB)
	if err != nil {
		return fmt.Errorf("source head storage: %w", err)
	}
	dstHeads, err := headstorage.New(ctx, dstDB)
	if err != nil {
		return fmt.Errorf("destination head storage: %w", err)
	}

	var treeIDs []string
	err = srcHeads.IterateEntries(ctx, headstorage.IterOpts{}, func(e headstorage.HeadsEntry) (bool, error) {
		treeIDs = append(treeIDs, e.Id)
		return true, nil
	})
	if err != nil {
		return fmt.Errorf("listing source trees: %w", err)
	}

	okByN, failByN := map[int]int{}, map[int]int{}
	errs := map[string]int{}
	skipped := 0
	for _, id := range treeIDs {
		st, err := objecttree.NewStorage(ctx, id, srcHeads, srcDB)
		if err != nil {
			skipped++ // ACL / settings / key-value entries are not object trees
			continue
		}
		var all []objecttree.StorageChange
		if err := st.GetAfterOrder(ctx, "", func(_ context.Context, ch objecttree.StorageChange) (bool, error) {
			ch.RawChange = append([]byte(nil), ch.RawChange...)
			all = append(all, ch)
			return true, nil
		}); err != nil {
			skipped++
			continue
		}
		heads, _ := st.Heads(ctx)
		snapshot, _ := st.CommonSnapshot(ctx)
		root, _ := st.Root(ctx)

		target, err := objecttree.CreateStorageWithDeferredCreation(ctx, root.RawTreeChangeWithId(), dstHeads, dstDB)
		if err == nil {
			rest := make([]objecttree.StorageChange, 0, len(all))
			for _, ch := range all {
				if ch.Id != root.Id {
					rest = append(rest, ch)
				}
			}
			err = target.AddAll(ctx, rest, heads, snapshot)
		}
		if err != nil {
			failByN[len(all)]++
			errs[err.Error()]++
			continue
		}
		okByN[len(all)]++
	}

	fmt.Printf("config=%s TMPDIR=%q trees=%d skipped=%d\n", config, os.Getenv("TMPDIR"), len(treeIDs), skipped)
	report("stored", okByN)
	report("FAILED", failByN)
	for msg, n := range errs {
		if len(msg) > 200 {
			msg = msg[:200]
		}
		fmt.Printf("  x%d %q\n", n, msg)
	}
	if len(failByN) > 0 {
		return fmt.Errorf("%d tree(s) could not be stored", total(failByN))
	}
	return nil
}

func total(m map[int]int) (n int) {
	for _, v := range m {
		n += v
	}
	return n
}

func report(name string, byChanges map[int]int) {
	keys := make([]int, 0, len(byChanges))
	for k := range byChanges {
		keys = append(keys, k)
	}
	sort.Ints(keys)
	fmt.Printf("%s %d  (changes-per-tree:count)", name, total(byChanges))
	for _, k := range keys {
		fmt.Printf(" %d:%d", k, byChanges[k])
	}
	fmt.Println()
}
