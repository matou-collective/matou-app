package api

import (
	"sync"
	"testing"
	"time"
)

func TestEventBroker_AddSink_ReceivesBroadcasts(t *testing.T) {
	b := NewEventBroker()

	var mu sync.Mutex
	var got []SSEEvent
	done := make(chan struct{}, 1)
	b.AddSink(func(e SSEEvent) {
		mu.Lock()
		got = append(got, e)
		mu.Unlock()
		done <- struct{}{}
	})

	b.Broadcast(SSEEvent{Type: "chat:message:new", Data: map[string]interface{}{"channelId": "c1"}})

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("sink was not invoked within 1s")
	}

	mu.Lock()
	defer mu.Unlock()
	if len(got) != 1 || got[0].Type != "chat:message:new" {
		t.Fatalf("sink received %v, want one chat:message:new", got)
	}
}

func TestEventBroker_AddSink_NilIgnored(_ *testing.T) {
	b := NewEventBroker()
	b.AddSink(nil) // must not panic
	b.Broadcast(SSEEvent{Type: "noop"})
}

func TestEventBroker_Broadcast_StillReachesSSEClients(t *testing.T) {
	b := NewEventBroker()
	ch := b.Subscribe()
	defer b.Unsubscribe(ch)
	b.AddSink(func(SSEEvent) {})

	b.Broadcast(SSEEvent{Type: "hello"})
	select {
	case e := <-ch:
		if e.Type != "hello" {
			t.Fatalf("client got %q, want hello", e.Type)
		}
	case <-time.After(time.Second):
		t.Fatal("SSE client did not receive the broadcast")
	}
}

// TestEventBroker_Broadcast_SurvivesPanickingSink asserts a panicking sink does
// not take the process down: without the recover in runSink this test crashes
// the whole test binary (an unrecovered panic in a bare goroutine is fatal), so
// a green run proves the containment. It also proves the other sinks and the
// SSE fan-out still run.
func TestEventBroker_Broadcast_SurvivesPanickingSink(t *testing.T) {
	b := NewEventBroker()
	ch := b.Subscribe()
	defer b.Unsubscribe(ch)

	b.AddSink(func(SSEEvent) {
		panic("sink blew up: nil ACL manager")
	})

	healthy := make(chan SSEEvent, 1)
	b.AddSink(func(e SSEEvent) { healthy <- e })

	b.Broadcast(SSEEvent{Type: "chat:message:new", Data: map[string]interface{}{"channelId": "c1"}})

	select {
	case e := <-healthy:
		if e.Type != "chat:message:new" {
			t.Fatalf("healthy sink got %q, want chat:message:new", e.Type)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("healthy sink was not invoked after a sibling sink panicked")
	}

	select {
	case e := <-ch:
		if e.Type != "chat:message:new" {
			t.Fatalf("SSE client got %q, want chat:message:new", e.Type)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("SSE client did not receive the broadcast")
	}

	// The broker is still usable for subsequent broadcasts.
	b.Broadcast(SSEEvent{Type: "chat:message:new", Data: map[string]interface{}{"channelId": "c2"}})
	select {
	case <-healthy:
	case <-time.After(2 * time.Second):
		t.Fatal("broker stopped delivering to sinks after a panic")
	}
}
