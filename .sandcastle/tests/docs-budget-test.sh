#!/usr/bin/env bash
# tests/docs-budget-test.sh — the read-first docs budget ratchet (#196).
#
# CLAUDE.md and the read-first enrichment tell every agent to read STATUS.md and
# the GOTCHAS index at session start. STATUS.md had grown to ~940 KB (one line
# ~300 KB) by accreting a full paragraph per state change, and GOTCHAS.md to
# ~140 KB — together they exceeded a context window BEFORE the ticket was even
# read. #196 split the history into docs/journal/ and the hazard bodies into
# docs/gotchas/, leaving STATUS.md a compact status surface and GOTCHAS.md an
# index. This test ratchets those budgets so neither can accrete back.
#
# Offline, no docker, no network — it only measures tracked files.
# Run: bash tests/docs-budget-test.sh
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"

# The repo root. Vendored, tests/ IS .sandcastle/tests/ in a consumer, so the
# repo's docs/ is one level up from there; here/.. covers both (#23). Resolve
# it so its basename is real (not the literal `..`) — that basename is the
# vendored signal below.
root="$(cd "$here/.." && pwd)"

# Vendored byte-identical into every consumer's `.sandcastle/` (and into this
# repo's own `.sandcastle/` self-copy), so there `root` IS `.sandcastle/` —
# which carries neither the factory-root STATUS.md nor docs/GOTCHAS.md (both
# vendor-excluded). An absent budgeted doc there is EXPECTED, so skip it
# visibly rather than red; in the factory core the same doc absent IS a
# regression and still reds (#294). The signal: the resolved root's basename
# is `.sandcastle` only in the vendored self-copy / a consumer.
vendored=0
[ "$(basename "$root")" = ".sandcastle" ] && vendored=1

STATUS_MAX=16384   # 16 KB
LINE_MAX=2048      #  2 KB — the ~300 KB host-capacity row was the worst offender
GOTCHAS_MAX=24576  # 24 KB — the index only; bodies live under docs/gotchas/

status="$root/STATUS.md"
gotchas="$root/docs/GOTCHAS.md"

if [ -f "$status" ]; then
  bytes="$(wc -c <"$status")"
  check "STATUS.md is under ${STATUS_MAX} bytes (is $bytes)" "[ $bytes -lt $STATUS_MAX ]"

  # longest line, in bytes — awk measures each line, LC_ALL=C so length is bytes
  longest="$(LC_ALL=C awk '{ if (length > m) m = length } END { print m+0 }' "$status")"
  check "no STATUS.md line exceeds ${LINE_MAX} bytes (longest is $longest)" \
    "[ $longest -le $LINE_MAX ]"

  # #230 → #287: STATUS.md must carry NO `**Last updated …` dated lead at all.
  # The per-change history belongs in docs/journal/ (append-only, one file per
  # ticket — so concurrent writers never collide), and STATUS.md stays the
  # compact surface: a stable subtitle + the tables + blockers + the journal
  # pointer. #230 split the history out but left ONE header line that every
  # state-changing commit still rewrote in full — a guaranteed concurrent-write
  # conflict that reded merge-to-head runs on a SyncError under LANDING=push,
  # where main IS the landing surface (GOTCHAS 72; reded run 22956, stranded
  # #240 — #285). #287 moved that dated lead fully into the newest journal
  # entry, so STATUS.md now changes only via table rows (writers touch different
  # rows) + blocker edits. This ratchet forbids any `**Last updated` line so the
  # rewritten-header-line collision cannot re-accrete.
  # grep -c already prints 0 on no match (and exits 1); `|| true` keeps that
  # single "0" without echo appending a second line (which would break -eq).
  updated="$(grep -c '^\*\*Last updated' "$status" 2>/dev/null || true)"
  check "STATUS.md carries NO '**Last updated' dated lead (has $updated — the what-changed head goes in docs/journal/)" \
    "[ ${updated:-0} -eq 0 ]"
elif [ "$vendored" -eq 1 ]; then
  echo "docs-budget-test: SKIPPING STATUS.md budget — absent in vendored copy (root $root)"
else
  fail "STATUS.md not found at $status"
fi

if [ -f "$gotchas" ]; then
  gbytes="$(wc -c <"$gotchas")"
  check "docs/GOTCHAS.md index is under ${GOTCHAS_MAX} bytes (is $gbytes)" \
    "[ $gbytes -lt $GOTCHAS_MAX ]"
elif [ "$vendored" -eq 1 ]; then
  echo "docs-budget-test: SKIPPING docs/GOTCHAS.md budget — absent in vendored copy (root $root)"
else
  fail "docs/GOTCHAS.md not found at $gotchas"
fi

summary docs-budget-test