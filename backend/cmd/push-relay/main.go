// Command push-relay runs the standalone push-relay service described in
// docs/architecture/08-push-notifications.md (topology C, slice 2 of #177). It
// is the only holder of the FCM server credential and of the AID→device-token
// map. Members' embedded backends register device tokens with it over
// KERI-signed requests; senders' backends call /notify with content-free wake
// signals which it dispatches as data-only FCM messages. It never sees message
// content.
//
// Configuration is entirely from the environment:
//
//	MATOU_PUSH_RELAY_ADDR              listen address              (default ":8090")
//	MATOU_PUSH_RELAY_STORE             token-store file path       (default "" = in-memory)
//	MATOU_PUSH_RELAY_TOKEN_TTL         untouched-token expiry      (default "720h" = 30d)
//	MATOU_PUSH_RELAY_COALESCE_WINDOW   burst-coalesce window       (default "10s")
//	MATOU_PUSH_RELAY_FCM_CREDENTIALS   Google service-account JSON (required unless MATOU_PUSH_RELAY_FCM_DISABLED)
//	MATOU_PUSH_RELAY_FCM_DISABLED      truthy → dispatch is a no-op (dry-run/dev)
//	MATOU_PUSH_RELAY_KEYSTATE_URL      key-state URL template with {aid}   (required)
//	MATOU_KERIA_KEYSTATE_ALLOW_HTTP    truthy → allow plain-http key-state URL to a non-loopback host
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/matou-dao/backend/internal/auth"
	"github.com/matou-dao/backend/internal/pushrelay"
)

const shutdownGrace = 10 * time.Second

func main() {
	addr := envOr("MATOU_PUSH_RELAY_ADDR", ":8090")
	storePath := os.Getenv("MATOU_PUSH_RELAY_STORE")
	tokenTTL := envDuration("MATOU_PUSH_RELAY_TOKEN_TTL", 720*time.Hour)
	coalesceWindow := envDuration("MATOU_PUSH_RELAY_COALESCE_WINDOW", 10*time.Second)

	keystateURL := os.Getenv("MATOU_PUSH_RELAY_KEYSTATE_URL")
	if keystateURL == "" {
		log.Fatal("MATOU_PUSH_RELAY_KEYSTATE_URL is required (key-state URL template containing {aid})")
	}
	var resolverOpts []auth.ResolverOption
	if truthy(os.Getenv("MATOU_KERIA_KEYSTATE_ALLOW_HTTP")) {
		resolverOpts = append(resolverOpts, auth.AllowInsecureHTTP())
	}
	resolver, err := auth.NewKERIAResolver(keystateURL, 5*time.Minute, resolverOpts...)
	if err != nil {
		log.Fatalf("key-state resolver: %v", err)
	}

	store, err := pushrelay.NewStore(storePath, tokenTTL)
	if err != nil {
		log.Fatalf("open token store: %v", err)
	}

	fcm, err := resolveFCM()
	if err != nil {
		log.Fatalf("FCM: %v", err)
	}

	srv := pushrelay.NewServer(pushrelay.Config{
		Verifier:       auth.NewVerifier(resolver, nil, nil),
		Store:          store,
		FCM:            fcm,
		CoalesceWindow: coalesceWindow,
	})

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Periodically prune tokens untouched past the TTL to bound the map.
	go func() {
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if n := store.ExpireStale(); n > 0 {
					log.Printf("[push-relay] expired %d stale token(s)", n)
				}
			}
		}
	}()

	httpSrv := &http.Server{
		Addr:              addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutCtx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
		defer cancel()
		_ = httpSrv.Shutdown(shutCtx)
	}()

	log.Printf("[push-relay] listening on %s (store=%q ttl=%s coalesce=%s)", addr, storePath, tokenTTL, coalesceWindow)
	if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("server: %v", err)
	}
	log.Println("[push-relay] stopped")
}

// resolveFCM builds the FCM sender from the credential path, or a no-op sender
// when explicitly disabled (dry-run/dev so the relay can run without the
// secret).
func resolveFCM() (pushrelay.FCMSender, error) {
	if truthy(os.Getenv("MATOU_PUSH_RELAY_FCM_DISABLED")) {
		log.Println("[push-relay] FCM dispatch DISABLED (MATOU_PUSH_RELAY_FCM_DISABLED set) — running as a no-op")
		return pushrelay.NoopFCM{}, nil
	}
	credPath := os.Getenv("MATOU_PUSH_RELAY_FCM_CREDENTIALS")
	if credPath == "" {
		log.Fatal("MATOU_PUSH_RELAY_FCM_CREDENTIALS is required (path to the Google service-account JSON); set MATOU_PUSH_RELAY_FCM_DISABLED=1 to run without dispatch")
	}
	return pushrelay.NewFCMClient(credPath)
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envDuration(key string, def time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
		log.Printf("[push-relay] invalid %s=%q, using %s", key, v, def)
	}
	return def
}

func truthy(s string) bool {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}
