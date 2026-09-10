package pairing

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"time"
)

// memMailbox is an in-memory stand-in for the config-server rendezvous mailbox,
// implementing the PUT / GET-long-poll(single-read) / DELETE semantics the
// pairing protocol depends on (spec §2). It lets the unit tests exercise the
// full handshake without live infrastructure.
type memMailbox struct {
	mu      sync.Mutex
	slots   map[string][]byte    // "id/slot" -> blob
	created map[string]time.Time // id -> first-write time
	ttl     time.Duration
	now     func() time.Time
}

func newMemMailbox(ttl time.Duration) *memMailbox {
	return &memMailbox{
		slots:   map[string][]byte{},
		created: map[string]time.Time{},
		ttl:     ttl,
		now:     time.Now,
	}
}

func (m *memMailbox) server() *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(m.handle))
}

// idExpired reports whether id has passed its TTL. Caller holds mu.
func (m *memMailbox) idExpired(id string) bool {
	c, ok := m.created[id]
	if !ok {
		return false
	}
	return m.now().Sub(c) > m.ttl
}

func (m *memMailbox) handle(w http.ResponseWriter, r *http.Request) {
	// /api/pair/{id}[/{slot}]
	rest := strings.TrimPrefix(r.URL.Path, "/api/pair/")
	parts := strings.SplitN(rest, "/", 2)
	id := parts[0]
	slot := ""
	if len(parts) == 2 {
		slot = parts[1]
	}
	key := id + "/" + slot

	switch r.Method {
	case http.MethodPut:
		body, _ := io.ReadAll(r.Body)
		m.mu.Lock()
		defer m.mu.Unlock()
		if m.idExpired(id) {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if _, filled := m.slots[key]; filled {
			w.WriteHeader(http.StatusConflict)
			return
		}
		if _, ok := m.created[id]; !ok {
			m.created[id] = m.now()
		}
		m.slots[key] = body
		w.WriteHeader(http.StatusOK)

	case http.MethodGet:
		wait := 0
		if s := r.URL.Query().Get("wait"); s != "" {
			wait, _ = strconv.Atoi(s)
		}
		deadline := time.Now().Add(time.Duration(wait) * time.Second)
		for {
			m.mu.Lock()
			if m.idExpired(id) {
				m.mu.Unlock()
				w.WriteHeader(http.StatusNotFound)
				return
			}
			if blob, ok := m.slots[key]; ok {
				delete(m.slots, key) // single read
				m.mu.Unlock()
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write(blob)
				return
			}
			m.mu.Unlock()
			if time.Now().After(deadline) {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			time.Sleep(5 * time.Millisecond)
		}

	case http.MethodDelete:
		m.mu.Lock()
		for k := range m.slots {
			if strings.HasPrefix(k, id+"/") {
				delete(m.slots, k)
			}
		}
		delete(m.created, id)
		m.mu.Unlock()
		w.WriteHeader(http.StatusOK)

	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}
