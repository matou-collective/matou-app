package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestLoopbackProxyPreservesRequestVerbatim matters because signify-ts signs
// requests over the URL pathname and KERIA verifies against the path it
// receives — any rewrite of path, query, method, headers or body breaks the
// signed-auth contract (#368).
func TestLoopbackProxyPreservesRequestVerbatim(t *testing.T) {
	var got *http.Request
	var gotBody string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Clone(r.Context())
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Signify-Resource", "EABC")
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	base, closer, err := startLoopbackProxy(upstream.URL)
	if err != nil {
		t.Fatalf("startLoopbackProxy: %v", err)
	}
	defer func() { _ = closer() }()
	if !strings.HasPrefix(base, "http://127.0.0.1:") {
		t.Fatalf("proxy base not loopback: %s", base)
	}

	req, _ := http.NewRequest(http.MethodPut, base+"/identifiers/aid1?type=ixn", strings.NewReader(`{"n":1}`))
	req.Header.Set("Signify-Resource", "EXYZ")
	req.Header.Set("Signature", "indexed=\"?0\"")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request through proxy: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if got == nil {
		t.Fatal("upstream never called")
	}
	if got.URL.Path != "/identifiers/aid1" || got.URL.RawQuery != "type=ixn" {
		t.Errorf("path/query rewritten: %s?%s", got.URL.Path, got.URL.RawQuery)
	}
	if got.Method != http.MethodPut {
		t.Errorf("method changed: %s", got.Method)
	}
	if got.Header.Get("Signify-Resource") != "EXYZ" || got.Header.Get("Signature") == "" {
		t.Errorf("auth headers not preserved: %v", got.Header)
	}
	if gotBody != `{"n":1}` {
		t.Errorf("body not preserved: %q", gotBody)
	}
	if resp.StatusCode != http.StatusAccepted || string(body) != `{"ok":true}` {
		t.Errorf("response not relayed: %d %q", resp.StatusCode, body)
	}
	if resp.Header.Get("Signify-Resource") != "EABC" {
		t.Errorf("response headers not relayed: %v", resp.Header)
	}
}

func TestStartKERIConfigProxiesRewritesAndRoutes(t *testing.T) {
	mark := func(name string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("X-Upstream", name)
			_, _ = w.Write([]byte(name))
		}))
	}
	admin, boot, cesr := mark("admin"), mark("boot"), mark("cesr")
	defer admin.Close()
	defer boot.Close()
	defer cesr.Close()

	witness := mark("witness")
	defer witness.Close()

	raw := []byte(`{"version":"1.0","mode":"prod","keri":{"admin_url":"` + admin.URL +
		`","boot_url":"` + boot.URL + `","cesr_url":"` + cesr.URL +
		`"},"witnesses":{"urls":["` + witness.URL + `"],"oobis":["http://wan:5642/oobi/W/controller"]},"anysync":{"id":42},"push_relay_url":"https://push.example"}`)

	rewritten, closers, err := StartKERIConfigProxies(raw)
	if err != nil {
		t.Fatalf("StartKERIConfigProxies: %v", err)
	}
	defer func() {
		for _, c := range closers {
			_ = c()
		}
	}()

	var cfg struct {
		Keri      map[string]string `json:"keri"`
		Witnesses struct {
			URLs  []string `json:"urls"`
			Oobis []string `json:"oobis"`
		} `json:"witnesses"`
		Any  map[string]any `json:"anysync"`
		Push string         `json:"push_relay_url"`
	}
	if err := json.Unmarshal(rewritten, &cfg); err != nil {
		t.Fatalf("rewritten config not JSON: %v", err)
	}

	// Original cesr_url survives for OOBI construction; the fetch URLs are loopback.
	if cfg.Keri["cesr_public_url"] != cesr.URL {
		t.Errorf("cesr_public_url = %q, want %q", cfg.Keri["cesr_public_url"], cesr.URL)
	}
	for key, want := range map[string]string{"admin_url": "admin", "boot_url": "boot", "cesr_url": "cesr"} {
		u := cfg.Keri[key]
		if !strings.HasPrefix(u, "http://127.0.0.1:") {
			t.Fatalf("keri.%s not rewritten to loopback: %q", key, u)
		}
		resp, err := http.Get(u + "/ping")
		if err != nil {
			t.Fatalf("GET via %s proxy: %v", key, err)
		}
		resp.Body.Close()
		if got := resp.Header.Get("X-Upstream"); got != want {
			t.Errorf("keri.%s routed to %q, want %q", key, got, want)
		}
	}

	// Witness fetch URLs are proxied; witness OOBIs (server-side resolved) are not.
	if len(cfg.Witnesses.URLs) != 1 || !strings.HasPrefix(cfg.Witnesses.URLs[0], "http://127.0.0.1:") {
		t.Fatalf("witnesses.urls not rewritten: %v", cfg.Witnesses.URLs)
	}
	if resp, err := http.Get(cfg.Witnesses.URLs[0] + "/oobi/W"); err != nil {
		t.Fatalf("GET via witness proxy: %v", err)
	} else {
		resp.Body.Close()
		if got := resp.Header.Get("X-Upstream"); got != "witness" {
			t.Errorf("witness proxy routed to %q", got)
		}
	}
	if len(cfg.Witnesses.Oobis) != 1 || cfg.Witnesses.Oobis[0] != "http://wan:5642/oobi/W/controller" {
		t.Errorf("witnesses.oobis must stay untouched: %v", cfg.Witnesses.Oobis)
	}

	// The rest of the body is preserved, numbers unmangled.
	if n, ok := cfg.Any["id"].(float64); !ok || n != 42 {
		t.Errorf("anysync.id mangled: %#v", cfg.Any["id"])
	}
	if cfg.Push != "https://push.example" {
		t.Errorf("push_relay_url mangled: %q", cfg.Push)
	}

	// Closers actually stop the listeners.
	adminProxy := cfg.Keri["admin_url"]
	for _, c := range closers {
		_ = c()
	}
	if _, err := http.Get(adminProxy + "/ping"); err == nil {
		t.Error("proxy still serving after close")
	}
}

func TestStartKERIConfigProxiesErrors(t *testing.T) {
	for name, raw := range map[string]string{
		"not json":     `nope`,
		"no keri":      `{"mode":"prod"}`,
		"missing boot": `{"keri":{"admin_url":"http://a:1","cesr_url":"http://c:3"}}`,
		"bad scheme":   `{"keri":{"admin_url":"ftp://a:1","boot_url":"http://b:2","cesr_url":"http://c:3"}}`,
	} {
		if _, _, err := StartKERIConfigProxies([]byte(raw)); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
}
