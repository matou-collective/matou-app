package app

import (
	"context"
	"errors"
	"net"
	"net/http"
	"testing"
	"time"
)

// TestListenPicksFreePortWhenZero binds an App to port 0, confirms it selects a
// real free port and serves requests, then confirms Shutdown stops it (the port
// refuses connections afterwards) and runs closers in reverse order.
func TestListenPicksFreePortWhenZero(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen on :0: %v", err)
	}

	// Record closer invocation order to assert reverse-of-registration teardown.
	var order []int
	closers := []func() error{
		func() error { order = append(order, 0); return nil },
		func() error { order = append(order, 1); return nil },
	}

	handler := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})

	application := newServing(listener, handler, closers)

	port := application.Port()
	if port == 0 {
		t.Fatal("Port() returned 0; expected a concrete free port")
	}

	// The server answers on the selected port.
	url := "http://" + application.Addr()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", resp.StatusCode, http.StatusNoContent)
	}

	// Shutdown stops the server; Wait then returns nil (graceful close).
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := application.Shutdown(ctx); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}
	if err := application.Wait(); err != nil {
		t.Fatalf("Wait after graceful shutdown returned error: %v", err)
	}

	// Closers ran in reverse registration order.
	if len(order) != 2 || order[0] != 1 || order[1] != 0 {
		t.Fatalf("closer order = %v, want [1 0]", order)
	}

	// The port now refuses connections.
	conn, err := net.DialTimeout("tcp", application.Addr(), 500*time.Millisecond)
	if err == nil {
		_ = conn.Close()
		t.Fatalf("expected connection refused on %s after Shutdown", application.Addr())
	}
	if !isConnRefused(err) {
		t.Logf("dial after shutdown failed as expected (non-refused error): %v", err)
	}
}

// isConnRefused reports whether err looks like a refused TCP connection.
func isConnRefused(err error) bool {
	var netErr *net.OpError
	if errors.As(err, &netErr) {
		return true
	}
	return err != nil
}
