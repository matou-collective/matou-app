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

	r, err := NewKERIAResolver(srv.URL+"/oobi/{aid}", time.Minute)
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
