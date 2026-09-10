package api

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"
)

// SSEEvent represents a server-sent event.
type SSEEvent struct {
	Type string      `json:"type"`
	Data interface{} `json:"data"`
}

// EventBroker manages SSE connections and event broadcasting.
type EventBroker struct {
	mu      sync.RWMutex
	clients map[chan SSEEvent]struct{}
	sinks   []func(SSEEvent)
}

// NewEventBroker creates a new event broker.
func NewEventBroker() *EventBroker {
	return &EventBroker{
		clients: make(map[chan SSEEvent]struct{}),
	}
}

// AddSink registers a side-channel that receives every broadcast event beside
// the SSE clients (e.g. the push-notification relay sink). Sinks are invoked
// asynchronously so a slow sink — one doing network I/O — never blocks the
// write-path or the SSE fan-out. Call during setup before Broadcast traffic.
func (b *EventBroker) AddSink(fn func(SSEEvent)) {
	if fn == nil {
		return
	}
	b.mu.Lock()
	b.sinks = append(b.sinks, fn)
	b.mu.Unlock()
}

// Subscribe adds a new client channel.
func (b *EventBroker) Subscribe() chan SSEEvent {
	ch := make(chan SSEEvent, 16)
	b.mu.Lock()
	b.clients[ch] = struct{}{}
	b.mu.Unlock()
	return ch
}

// Unsubscribe removes a client channel.
func (b *EventBroker) Unsubscribe(ch chan SSEEvent) {
	b.mu.Lock()
	delete(b.clients, ch)
	b.mu.Unlock()
	close(ch)
}

// Broadcast sends an event to all connected clients and side-channel sinks.
func (b *EventBroker) Broadcast(event SSEEvent) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	for ch := range b.clients {
		select {
		case ch <- event:
		default:
			// Client is slow, skip
		}
	}
	for _, sink := range b.sinks {
		go b.runSink(sink, event)
	}
}

// runSink invokes one sink with its panic contained. Sinks do work well off the
// write-path — the push sink resolves ACL membership and calls the relay over
// the network — and an unrecovered panic in a bare goroutine takes the whole
// backend down with it, breaking the chat write-path a notification sink must
// never be able to break (docs/architecture/08-push-notifications.md §8). One
// bad sink is logged and skipped; the other sinks and the SSE fan-out are
// unaffected.
func (b *EventBroker) runSink(sink func(SSEEvent), event SSEEvent) {
	defer func() {
		if rec := recover(); rec != nil {
			log.Printf("[Events] broadcast sink panicked on %q event: %v", event.Type, rec)
		}
	}()
	sink(event)
}

// ClientCount returns the number of connected SSE clients.
func (b *EventBroker) ClientCount() int {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return len(b.clients)
}

// EventsHandler handles the SSE endpoint.
type EventsHandler struct {
	broker *EventBroker
}

// NewEventsHandler creates a new events handler.
func NewEventsHandler(broker *EventBroker) *EventsHandler {
	return &EventsHandler{broker: broker}
}

// HandleEvents handles GET /api/v1/events (SSE stream).
func (h *EventsHandler) HandleEvents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{
			"error": "Method not allowed",
		})
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "streaming not supported",
		})
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	ch := h.broker.Subscribe()
	defer h.broker.Unsubscribe(ch)

	// Send initial connection event
	data, _ := json.Marshal(map[string]string{"status": "connected"})
	_, _ = fmt.Fprintf(w, "event: connected\ndata: %s\n\n", data)
	flusher.Flush()

	// Keepalive ticker
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case event, ok := <-ch:
			if !ok {
				return
			}
			data, err := json.Marshal(event.Data)
			if err != nil {
				continue
			}
			_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event.Type, data)
			flusher.Flush()
		case <-ticker.C:
			_, _ = fmt.Fprintf(w, ": keepalive\n\n")
			flusher.Flush()
		}
	}
}

// RegisterRoutes registers the events route.
func (h *EventsHandler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/v1/events", h.HandleEvents)
}
