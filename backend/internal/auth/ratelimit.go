package auth

import (
	"sync"
	"time"
)

// RateLimiter is a keyed token bucket: each key (a client IP, an AID) gets
// burst tokens refilled at rate per second. It bounds how fast the public
// challenge/login endpoints can be hit per source, so a looping client can
// neither brute-force nor exhaust the challenge store.
type RateLimiter struct {
	rate  float64 // tokens per second
	burst float64
	max   int // cap on tracked keys
	mu    sync.Mutex
	m     map[string]*bucket
	now   func() time.Time
}

type bucket struct {
	tokens float64
	last   time.Time
}

// DefaultMaxRateLimitKeys caps how many distinct keys a limiter tracks; idle
// buckets are evicted when the cap is reached.
const DefaultMaxRateLimitKeys = 10_000

// NewRateLimiter creates a limiter allowing burst requests immediately and
// rate requests per second sustained, per key.
func NewRateLimiter(rate float64, burst int) *RateLimiter {
	return &RateLimiter{
		rate:  rate,
		burst: float64(burst),
		max:   DefaultMaxRateLimitKeys,
		m:     make(map[string]*bucket),
		now:   time.Now,
	}
}

// Allow reports whether a request for key may proceed, consuming a token if so.
func (l *RateLimiter) Allow(key string) bool {
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()
	b, ok := l.m[key]
	if !ok {
		if len(l.m) >= l.max {
			l.evictIdleLocked(now)
		}
		b = &bucket{tokens: l.burst, last: now}
		l.m[key] = b
	}
	elapsed := now.Sub(b.last).Seconds()
	if elapsed > 0 {
		b.tokens += elapsed * l.rate
		if b.tokens > l.burst {
			b.tokens = l.burst
		}
		b.last = now
	}
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// evictIdleLocked drops buckets that have refilled to full (i.e. idle long
// enough that forgetting them changes nothing). Caller must hold l.mu.
func (l *RateLimiter) evictIdleLocked(now time.Time) {
	for k, b := range l.m {
		if b.tokens+now.Sub(b.last).Seconds()*l.rate >= l.burst {
			delete(l.m, k)
		}
	}
}
