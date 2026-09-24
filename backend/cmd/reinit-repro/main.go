// Command reinit-repro reproduces #567 on the local any-sync test network: a
// backend with no identity yet opens a space holding contribution trees it
// cannot decrypt, and tree fetching stops for the life of the process —
// SDKClient.Reinitialize (POST /api/v1/identity/set) does not revive it.
//
//	reinit-repro -seed -n 60 -data <dir> -mnemonic "<12 words>"      → prints "SPACE <id>"
//	reinit-repro -data <empty dir> -space <id> -mnemonic "<12 words>" -n 60
//	reinit-repro -data <empty dir> -space <id>[,<id>] -pre-only -n 60
//
// The second form opens the space with throwaway keys, waits -warm,
// reinitialises with the mnemonic and reopens the space; -pre-only never
// reinitialises. Both report the indexed tree count once a second, and dump
// every goroutine to -dump if the count stops moving for 20 s (exit 2).
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"runtime/pprof"
	"strings"
	"time"

	"github.com/matou-dao/backend/internal/anysync"
)

func main() {
	cfg := flag.String("config", "config/client-test.yml", "any-sync client config")
	data := flag.String("data", "", "data directory")
	spaceID := flag.String("space", "", "space to open (comma separated with -pre-only)")
	mnemonic := flag.String("mnemonic", "", "mnemonic")
	seed := flag.Bool("seed", false, "create a space with -n contribution objects, print its id, stay up")
	n := flag.Int("n", 40, "objects to seed / tree count that means done")
	late := flag.Int("late", 0, "seed: objects to add after -late-after")
	lateAfter := flag.Duration("late-after", 25*time.Second, "seed: delay before the late objects")
	listener := flag.Bool("listener", true, "wire the tree listener the way app.go does")
	preOnly := flag.Bool("pre-only", false, "never reinitialise")
	warm := flag.Duration("warm", 3*time.Second, "how long the space syncs before Reinitialize")
	watch := flag.Duration("watch", 60*time.Second, "how long to watch")
	dump := flag.String("dump", "goroutines.txt", "goroutine dump path on stall")
	flag.Parse()
	ctx := context.Background()

	if *seed {
		seedSpace(ctx, *cfg, *data, *mnemonic, *n, *late, *lateAfter)
		return
	}

	client, err := anysync.NewSDKClient(*cfg, &anysync.ClientOptions{DataDir: *data})
	if err != nil {
		log.Fatalf("new client: %v", err)
	}
	utm := client.GetTreeManager()
	if *listener {
		l := anysync.NewTreeUpdateListener(nil, nil)
		l.SetSpaceResolver(utm.SpaceForTree)
		l.SetFreshTreeReader(utm.FreshTreeForListener) // as internal/app/app.go
		utm.SetListener(l)
	}

	// What a fresh install does before sign-in: open the org's spaces with
	// throwaway keys and let HeadSync pull them.
	ids := strings.Split(*spaceID, ",")
	for _, id := range ids {
		if _, err := client.GetSpace(ctx, id); err != nil {
			log.Fatalf("pre-identity open %s: %v", id, err)
		}
	}
	if *preOnly {
		os.Exit(watchTrees(utm, ids, *n, *watch, *dump))
	}

	time.Sleep(*warm)
	fmt.Printf("REPRO before reinit: %d trees\n", utm.TreeCount(ids[0]))
	if err := client.Reinitialize(*mnemonic); err != nil {
		log.Fatalf("reinitialize: %v", err)
	}
	utm.ClearTreeCache()
	go func() {
		if _, err := client.GetSpace(ctx, ids[0]); err != nil {
			log.Printf("open after reinit: %v", err)
		}
	}()
	os.Exit(watchTrees(utm, ids[:1], *n, *watch, *dump))
}

// watchTrees reports the indexed tree count once a second. It returns 0 once
// want trees are indexed, 2 (after dumping goroutines) when the count has not
// moved for 20 s, and 3 on timeout.
func watchTrees(utm *anysync.UnifiedTreeManager, ids []string, want int, watch time.Duration, dump string) int {
	t0, last, lastMove := time.Now(), -1, time.Now()
	for time.Since(t0) < watch {
		c := 0
		for _, id := range ids {
			c += utm.TreeCount(id)
		}
		if c != last {
			last, lastMove = c, time.Now()
		}
		fmt.Printf("REPRO t=%2.0fs trees=%d\n", time.Since(t0).Seconds(), c)
		if c >= want {
			fmt.Printf("REPRO DONE in %.1fs\n", time.Since(t0).Seconds())
			return 0
		}
		if time.Since(lastMove) > 20*time.Second {
			if err := dumpGoroutines(dump); err != nil {
				log.Printf("goroutine dump: %v", err)
			}
			fmt.Printf("REPRO STALLED at %d/%d trees; goroutines in %s\n", c, want, dump)
			return 2
		}
		time.Sleep(time.Second)
	}
	fmt.Printf("REPRO TIMEOUT at %d/%d trees\n", last, want)
	return 3
}

func dumpGoroutines(path string) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	if err := pprof.Lookup("goroutine").WriteTo(f, 2); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}

func seedSpace(ctx context.Context, cfg, data, mnemonic string, n, late int, lateAfter time.Duration) {
	client, err := anysync.NewSDKClient(cfg, &anysync.ClientOptions{DataDir: data, Mnemonic: mnemonic})
	if err != nil {
		log.Fatalf("new client: %v", err)
	}
	res, err := client.CreateSpace(ctx, "ERepro567", "community", nil)
	if err != nil {
		log.Fatalf("create space: %v", err)
	}
	otm := anysync.NewObjectTreeManager(client, client.GetPeerKeyManager(), client.GetTreeManager())
	add := func(from, to int) {
		for i := from; i < to; i++ {
			body, _ := json.Marshal(map[string]any{"title": fmt.Sprintf("contribution %d", i)})
			if _, err := otm.AddObject(ctx, res.SpaceID, &anysync.ObjectPayload{
				ID: fmt.Sprintf("ctr_%04d", i), Type: anysync.TypeContribution, Data: body,
			}, client.GetSigningKey()); err != nil {
				log.Fatalf("add object %d: %v", i, err)
			}
		}
	}
	add(0, n)
	// A tree the index skips (unknown change type), as real spaces hold.
	if _, _, err := client.GetTreeManager().CreateObjectTree(ctx, res.SpaceID, "odd-1", "Odd", "matou.odd.v1", client.GetSigningKey()); err != nil {
		log.Fatalf("odd tree: %v", err)
	}
	time.Sleep(10 * time.Second) // let HeadSync push to the nodes
	fmt.Printf("SPACE %s\n", res.SpaceID)
	if late > 0 {
		time.Sleep(lateAfter)
		add(n, n+late)
		fmt.Printf("LATE %d\n", late)
	}
	time.Sleep(10 * time.Minute) // stay up as a peer until killed
}
