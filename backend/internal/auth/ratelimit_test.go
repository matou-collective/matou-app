package auth

import (
	"testing"
	"time"
)

func TestRateLimiterBurstAndRefill(t *testing.T) {
	l := NewRateLimiter(1, 3)
	base := time.Unix(4_000_000, 0)
	now := base
	l.now = func() time.Time { return now }

	for i := 0; i < 3; i++ {
		if !l.Allow("ip1") {
			t.Fatalf("burst request %d should be allowed", i)
		}
	}
	if l.Allow("ip1") {
		t.Fatal("4th request within burst window must be refused")
	}
	if !l.Allow("ip2") {
		t.Fatal("another key has its own bucket")
	}
	now = base.Add(2 * time.Second)
	if !l.Allow("ip1") {
		t.Fatal("after 2s at 1/s, ip1 should have refilled")
	}
	if !l.Allow("ip1") {
		t.Fatal("second refilled token")
	}
	if l.Allow("ip1") {
		t.Fatal("only 2 tokens refilled in 2s")
	}
}

func TestRateLimiterEvictsIdleAtCap(t *testing.T) {
	l := NewRateLimiter(1, 1)
	l.max = 2
	base := time.Unix(4_000_000, 0)
	now := base
	l.now = func() time.Time { return now }
	l.Allow("a")
	l.Allow("b")
	now = base.Add(10 * time.Second) // a and b are fully refilled → idle
	if !l.Allow("c") {
		t.Fatal("new key should be admitted after idle eviction")
	}
	if len(l.m) > 2 {
		t.Fatalf("expected idle buckets evicted, have %d", len(l.m))
	}
}
