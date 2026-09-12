package auth

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestValidAID(t *testing.T) {
	good := []string{
		testAID,
		"DAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", // 48-char two-char code
	}
	for _, s := range good {
		if !ValidAID(s) {
			t.Errorf("expected %q valid", s)
		}
	}
	bad := []string{
		"",
		"ETestChallengeAID",
		"EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/",  // slash
		"EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA?x", // 45 chars
		"../../etc/passwd",
		"EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA A",
	}
	for _, s := range bad {
		if ValidAID(s) {
			t.Errorf("expected %q invalid", s)
		}
	}
}

func TestNewKERIAResolverRefusesInsecureRemote(t *testing.T) {
	if _, err := NewKERIAResolver("http://keria.example.org/oobi/{aid}", 0); err == nil {
		t.Fatal("plain http to a non-loopback host must be refused")
	}
	if _, err := NewKERIAResolver("http://keria.example.org/oobi/{aid}", 0, AllowInsecureHTTP()); err != nil {
		t.Fatalf("AllowInsecureHTTP should permit it: %v", err)
	}
	for _, ok := range []string{
		"http://localhost:3902/oobi/{aid}",
		"http://127.0.0.1:3902/oobi/{aid}",
		"http://[::1]:3902/oobi/{aid}",
		"https://keria.example.org/oobi/{aid}",
	} {
		if _, err := NewKERIAResolver(ok, 0); err != nil {
			t.Errorf("%s should be accepted: %v", ok, err)
		}
	}
	if _, err := NewKERIAResolver("http://localhost:3902/oobi/", 0); err == nil {
		t.Fatal("template without {aid} must be refused")
	}
	if _, err := NewKERIAResolver("ftp://localhost/{aid}", 0); err == nil {
		t.Fatal("non-http scheme must be refused")
	}
}

func TestKERIAResolverCurrentKeys(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		aid := strings.TrimPrefix(r.URL.Path, "/oobi/")
		switch aid {
		case testAID:
			// Witness KEL first (higher seq), then the user's.
			_, _ = w.Write(makeEventFor(t, foreignAID, "rot", "5", "1", []string{"BwitnessKey"}))
			_, _ = w.Write([]byte("-AABAAsig"))
			_, _ = w.Write(makeEventFor(t, testAID, "icp", "0", "1", []string{"DuserKey"}))
		case "DAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA":
			_, _ = w.Write(makeEventFor(t, aid, "icp", "0", "2", []string{"Dk1", "Dk2"}))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	// Retry disabled here: this case exercises caching and the 404/multi-key
	// paths, not the receipting-window backoff (covered separately), and the
	// default budget would slow the unknown-AID assertion below.
	r, err := NewKERIAResolver(srv.URL+"/oobi/{aid}", time.Minute, WithNotFoundRetry(0, 0))
	if err != nil {
		t.Fatal(err)
	}
	keys, err := r.CurrentKeys(context.Background(), testAID)
	if err != nil {
		t.Fatalf("CurrentKeys: %v", err)
	}
	if len(keys) != 1 || keys[0] != "DuserKey" {
		t.Fatalf("expected user's key, got %v", keys)
	}
	if gotPath != "/oobi/"+testAID {
		t.Fatalf("unexpected request path %q", gotPath)
	}

	// Cached: the server going away does not matter.
	if keys2, err := r.CurrentKeys(context.Background(), testAID); err != nil || keys2[0] != "DuserKey" {
		t.Fatalf("cached lookup failed: %v %v", keys2, err)
	}

	// Malformed AID never reaches the network.
	gotPath = ""
	if _, err := r.CurrentKeys(context.Background(), "../../admin"); err == nil || gotPath != "" {
		t.Fatalf("invalid AID must be rejected before any request (path=%q err=%v)", gotPath, err)
	}

	// Multi-key AID → ErrUnsupportedKeyState.
	if _, err := r.CurrentKeys(context.Background(), "DAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"); !errors.Is(err, ErrUnsupportedKeyState) {
		t.Fatalf("expected ErrUnsupportedKeyState, got %v", err)
	}

	// Unknown AID → error (404).
	if _, err := r.CurrentKeys(context.Background(), "EBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"); err == nil {
		t.Fatal("expected error for unknown AID")
	}
}

// TestKERIAResolverRetriesTransientNotFound covers Manifestation 2 (#513): an
// AID's OOBI 404s in the window between a rotation and its witness receipts
// landing. The resolver must ride out that window with bounded retry rather than
// failing on the first 404 (which drops the login to unauthenticated).
func TestKERIAResolverRetriesTransientNotFound(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		if hits < 3 { // 404 the first two passes, then serve the KEL.
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(makeEventFor(t, testAID, "icp", "0", "1", []string{"DuserKey"}))
	}))
	defer srv.Close()

	r, err := NewKERIAResolver(srv.URL+"/oobi/{aid}", 0, WithNotFoundRetry(5, time.Millisecond))
	if err != nil {
		t.Fatal(err)
	}
	keys, err := r.CurrentKeys(context.Background(), testAID)
	if err != nil {
		t.Fatalf("CurrentKeys should have ridden out the 404 window: %v", err)
	}
	if len(keys) != 1 || keys[0] != "DuserKey" {
		t.Fatalf("expected DuserKey, got %v", keys)
	}
	if hits != 3 {
		t.Fatalf("expected 3 requests (two 404s then 200), got %d", hits)
	}

	// A persistent 404 still fails, and does so within the retry budget rather
	// than spinning forever.
	always404 := httptest.NewServer(http.HandlerFunc(http.NotFound))
	defer always404.Close()
	r2, err := NewKERIAResolver(always404.URL+"/oobi/{aid}", 0, WithNotFoundRetry(2, time.Millisecond))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r2.CurrentKeys(context.Background(), testAID); err == nil {
		t.Fatal("a persistently unavailable AID must still error")
	}

	// A cancelled context aborts the backoff promptly instead of sleeping out
	// the whole budget.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := r2.CurrentKeys(ctx, testAID); err == nil {
		t.Fatal("cancelled context must abort the retry")
	}
}

// TestKERIAResolverFallsBackAcrossSources covers Manifestation 1 (#513): a
// group AID's bare KERIA OOBI is answered by a co-signer's agent that never
// collected the group's receipts, so it 404s a fully-receipted AID. A witness
// (which holds the receipted KEL) is configured as an additional, comma-
// separated source and must be consulted when the primary 404s.
func TestKERIAResolverFallsBackAcrossSources(t *testing.T) {
	primary := httptest.NewServer(http.HandlerFunc(http.NotFound)) // co-signer's agent
	defer primary.Close()
	var witnessHits int
	witness := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		witnessHits++
		_, _ = w.Write(makeEventFor(t, testAID, "icp", "0", "1", []string{"DwitnessServedKey"}))
	}))
	defer witness.Close()

	tmpl := primary.URL + "/oobi/{aid}," + witness.URL + "/oobi/{aid}"
	r, err := NewKERIAResolver(tmpl, 0, WithNotFoundRetry(0, time.Millisecond))
	if err != nil {
		t.Fatal(err)
	}
	keys, err := r.CurrentKeys(context.Background(), testAID)
	if err != nil {
		t.Fatalf("CurrentKeys should have fallen back to the witness: %v", err)
	}
	if len(keys) != 1 || keys[0] != "DwitnessServedKey" {
		t.Fatalf("expected the witness-served key, got %v", keys)
	}
	if witnessHits == 0 {
		t.Fatal("witness source was never consulted")
	}
}

// TestKERIAResolverMultiSourceTrustBoundary: every source in a comma-separated
// list is held to the same loopback/TLS trust boundary — one insecure remote
// entry rejects the whole resolver.
func TestKERIAResolverMultiSourceTrustBoundary(t *testing.T) {
	if _, err := NewKERIAResolver("http://localhost:3902/oobi/{aid},http://keria.example.org/oobi/{aid}", 0); err == nil {
		t.Fatal("a plain-http non-loopback source anywhere in the list must be refused")
	}
	if _, err := NewKERIAResolver("http://localhost:3902/oobi/{aid},http://127.0.0.1:6643/oobi/{aid}", 0); err != nil {
		t.Fatalf("two loopback sources should be accepted: %v", err)
	}
	if _, err := NewKERIAResolver("http://localhost:3902/oobi/{aid},http://localhost:6643/no-placeholder", 0); err == nil {
		t.Fatal("a source without the {aid} placeholder must be refused")
	}
}
