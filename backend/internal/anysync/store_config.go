package anysync

import (
	anystore "github.com/anyproto/any-store"
)

// StoreConfig returns the any-store configuration every store the backend opens
// must start from. Callers may add to the returned value; each call returns a
// fresh one.
//
// temp_store=MEMORY is not a tuning knob. SQLite spills statement journals,
// savepoint sub-journals, sorters and transient tables to temp FILES, and
// inside the Android app sandbox it has no usable temp directory: TMPDIR is
// unset, /var/tmp, /usr/tmp and /tmp do not exist, and "." is "/". Any spill
// then fails with SQLITE_IOERR_GETTEMPPATH, which surfaces only as
// "sqlite: step: disk I/O error" followed by "no such savepoint: spN" once
// SQLite has rolled the transaction back underneath any-store (#556).
//
// any-sync hits it as soon as it stores a tree it is receiving from a peer:
// creation is deferred so root + changes land in one transaction
// (objecttree.storageDeferredCreation), so storage.AddAll runs inside an OUTER
// savepoint that stays open while every change is inserted under its own inner
// savepoint. The sub-journal therefore never resets between inserts, passes its
// 64 KiB in-memory limit after a handful of changes, and spills. On a phone that
// meant any object edited about four or more times — contributions, milestones,
// SharedProfiles (the members list), plans, projects — could never be stored,
// deterministically, on a brand-new store too. It looked like corruption and was
// first treated as such (#414).
//
// Desktop and iOS have a temp directory and never hit it; keeping the setting
// everywhere keeps the platforms identical. The cost is that those spills are
// held in RAM — bounded by the size of one transaction.
func StoreConfig() *anystore.Config {
	return &anystore.Config{
		SQLiteConnectionOptions: map[string]string{
			"temp_store": "MEMORY",
		},
	}
}
