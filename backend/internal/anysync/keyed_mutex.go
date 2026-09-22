package anysync

import "sync"

// keyedMutex serializes work per string key. Concurrent callers holding
// different keys never block each other; concurrent callers holding the same
// key run one at a time.
//
// It exists to close the "Load-then-act on a sync.Map" open races in the space
// storage provider and the space resolver: two concurrent resolves of the same
// not-yet-open space would each open a fresh handle/instance over the same
// on-disk data.db, leaving a duplicate that Close (which only touches the one
// cached entry) leaks — a live second store handle whose HeadSync loop keeps
// querying the file. See #592.
//
// A mutex is retained per key for the process lifetime. Keys are space ids,
// which are bounded and few (one per open space), and the provider/resolver
// already hold a sync.Map entry per space, so this adds no unbounded growth.
type keyedMutex struct {
	mus sync.Map // key -> *sync.Mutex
}

// lock acquires the mutex for key and returns its unlock function. Typical use:
//
//	unlock := k.lock(id)
//	defer unlock()
func (k *keyedMutex) lock(key string) func() {
	m, _ := k.mus.LoadOrStore(key, &sync.Mutex{})
	mu := m.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}
