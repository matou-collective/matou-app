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

func TestEventBroker_AddSink_NilIgnored(t *testing.T) {
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
