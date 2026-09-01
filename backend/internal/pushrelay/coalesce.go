package pushrelay

import (
	"sync"
	"time"
)

// coalescer suppresses duplicate wake signals for the same recipient+channel
// within a short window (§3/§5): a burst of N messages in one channel should
// produce one push, not N. It is a best-effort in-memory dedupe keyed by
// AID+channel with last-fired timestamps, swept lazily.
type coalescer struct {
	window time.Duration
	mu     sync.Mutex
	last   map[string]time.Time
	now    func() time.Time
}

func newCoalescer(window time.Duration) *coalescer {
	return &coalescer{window: window, last: make(map[string]time.Time), now: time.Now}
}

// maxCoalesceKeys bounds the dedupe map; when full it is swept of expired
// entries before a new key is admitted.
const maxCoalesceKeys = 100_000

// allow reports whether a push for (aid, channel) should be dispatched now, or
// suppressed because an identical one fired within the window. A zero window
// disables coalescing (always allow).
func (c *coalescer) allow(aid, channel string) bool {
	if c.window <= 0 {
		return true
	}
	key := aid + "\x00" + channel
	now := c.now()
	c.mu.Lock()
	defer c.mu.Unlock()
	if last, ok := c.last[key]; ok && now.Sub(last) < c.window {
		return false
	}
	if len(c.last) >= maxCoalesceKeys {
		c.sweepLocked(now)
	}
	c.last[key] = now
	return true
}

// sweepLocked drops entries older than the window. Caller holds c.mu.
func (c *coalescer) sweepLocked(now time.Time) {
	for k, t := range c.last {
		if now.Sub(t) >= c.window {
			delete(c.last, k)
		}
	}
}
