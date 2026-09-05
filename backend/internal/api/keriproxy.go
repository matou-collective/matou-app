package api

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
)

// Loopback reverse proxies for the KERI endpoints (issue #368).
//
// On Capacitor the WebView's cleartext-network policy only permits plain HTTP
// to 127.0.0.1/localhost (Android network_security_config; iOS ATS is the same
// wall). signify-ts runs in the WebView and dials KERIA's admin/boot ports —
// and the KEL-push path fetches CESR streams — at the plain-HTTP URLs in the
// client config, so on a device those requests are blocked before they reach
// the network. The embedded Go backend is not subject to the WebView policy
// (that is why the #99/#265 config fetch works), so it lends the WebView its
// network: one verbatim loopback reverse proxy per KERI endpoint, and the
// client config served over /api/v1/client-config points at them.
//
// The proxies preserve the request path and query untouched: signify-ts signs
// each request over the URL *pathname* and KERIA verifies that signature
// against the path it receives, so any path rewriting would 401 every signed
// call. Only scheme/host are swapped.
//
// cesr_url needs special care: the WebView fetches from it directly (KEL
// push), but it is also the base for OOBI URLs that KERIA resolves
// server-side — an OOBI pointing at the phone's 127.0.0.1 would be
// unresolvable. So the served config keeps the proxied cesr_url for fetches
// and adds cesr_public_url with the original, for OOBI construction.

// keriProxyURLKeys are the keri-section URLs that get a loopback proxy.
var keriProxyURLKeys = []string{"admin_url", "boot_url", "cesr_url"}

// startLoopbackProxy serves a verbatim reverse proxy for upstream on an
// ephemeral loopback port and returns its base URL plus a closer.
func startLoopbackProxy(upstream string) (string, func() error, error) {
	u, err := url.Parse(upstream)
	if err != nil {
		return "", nil, fmt.Errorf("parse upstream %q: %w", upstream, err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", nil, fmt.Errorf("upstream %q: unsupported scheme %q", upstream, u.Scheme)
	}
	if u.Host == "" {
		return "", nil, fmt.Errorf("upstream %q: no host", upstream)
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", nil, fmt.Errorf("listen loopback: %w", err)
	}

	proxy := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.Out.URL.Scheme = u.Scheme
			pr.Out.URL.Host = u.Host
			pr.Out.Host = u.Host
			// Path and query stay exactly as the client sent them — see the
			// signature note in the package comment above.
		},
		// KERIA responses are small; flush as they arrive rather than buffering.
		FlushInterval: -1,
	}
	srv := &http.Server{Handler: proxy}
	go func() { _ = srv.Serve(ln) }()

	return "http://" + ln.Addr().String(), srv.Close, nil
}

// StartKERIConfigProxies starts a loopback proxy for each keri URL in the raw
// client-config JSON and returns a rewritten copy for serving to the WebView:
// keri.admin_url / boot_url / cesr_url point at the proxies, and
// keri.cesr_public_url carries the original cesr_url for OOBI construction.
// Everything else in the body is preserved. The returned closers stop the
// proxies; on error nothing is left listening and the caller should serve the
// original body unchanged.
func StartKERIConfigProxies(raw []byte) ([]byte, []func() error, error) {
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.UseNumber() // re-marshal must not mangle numeric fields elsewhere in the config
	var cfg map[string]any
	if err := dec.Decode(&cfg); err != nil {
		return nil, nil, fmt.Errorf("parse client config: %w", err)
	}
	keri, ok := cfg["keri"].(map[string]any)
	if !ok {
		return nil, nil, fmt.Errorf("client config has no keri section")
	}

	var closers []func() error
	closeAll := func() {
		for _, c := range closers {
			_ = c()
		}
	}

	for _, key := range keriProxyURLKeys {
		upstream, ok := keri[key].(string)
		if !ok || upstream == "" {
			closeAll()
			return nil, nil, fmt.Errorf("client config keri.%s missing", key)
		}
		base, closer, err := startLoopbackProxy(upstream)
		if err != nil {
			closeAll()
			return nil, nil, fmt.Errorf("keri.%s: %w", key, err)
		}
		closers = append(closers, closer)
		if key == "cesr_url" {
			keri["cesr_public_url"] = upstream
		}
		keri[key] = base
	}

	// witnesses.urls is fetched from the WebView too (the KEL-push stream
	// sources in pushKelToAgent), so each entry gets a proxy as well.
	// witnesses.oobis stays untouched: those URLs are handed to KERIA for
	// server-side resolution and must remain reachable from KERIA, not from
	// the phone. A config without witnesses is fine.
	if wits, ok := cfg["witnesses"].(map[string]any); ok {
		if urls, ok := wits["urls"].([]any); ok {
			for i, v := range urls {
				upstream, ok := v.(string)
				if !ok || upstream == "" {
					continue
				}
				base, closer, err := startLoopbackProxy(upstream)
				if err != nil {
					closeAll()
					return nil, nil, fmt.Errorf("witnesses.urls[%d]: %w", i, err)
				}
				closers = append(closers, closer)
				urls[i] = base
			}
		}
	}

	rewritten, err := json.Marshal(cfg)
	if err != nil {
		closeAll()
		return nil, nil, fmt.Errorf("re-marshal client config: %w", err)
	}
	return rewritten, closers, nil
}
