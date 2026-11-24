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
# STATUS_HEADROOM_MIN — the budget FLOOR (#374). STATUS.md is deliberately NOT
# `merge=union` (unlike docs/GOTCHAS.md): the whole #287 concurrency contract is
# that a state-changing commit touches only ITS OWN row, so two concurrent
# writers edit different rows and the 3-way merge resolves cleanly. At the byte
# ceiling that invariant is UNREACHABLE — a writer cannot extend its own row
# without trimming someone else's, so every state commit is forced onto a shared
# anchor and divergent one-line edits park on a rescue branch + page (run 28910,
# #374; all four of that day's rescues touched STATUS.md). Fix for STATUS.md is
# the OPPOSITE of #331's GOTCHAS raise: do NOT lift the ceiling (that just lets
# journal-prose re-accrete into rows, the #196 anti-pattern on an update-in-place
# surface) — keep the ceiling, compact rows back to surface level, and enforce a
# floor so the surface can never silently re-reach the no-headroom state. The
# floor is LINE_MAX: headroom >= the largest a single row may be guarantees any
# ONE writer can rewrite its own row to the full per-line budget without touching
# another's — the #287 invariant, stated as the acceptance test.
STATUS_HEADROOM_MIN=$LINE_MAX   # >= 2 KB spare under the ceiling (#374)
# GOTCHAS_MAX — the index only; the full Symptom→Cause→Rule bodies live under
# docs/gotchas/<id>-slug.md and are NOT budgeted here. Raised 24576 → 32768 by
# #331 (ruled by agent under ADR 0174 — two-way door, revertible by a later
# commit, proven by this test). Why this is NOT the accretion #196 fought:
#   * #196 split a ~140 KB GOTCHAS that had accreted full prose bodies inline;
#     the bodies now live under docs/gotchas/, so the index grows O(hazard
#     count) at a BOUNDED per-row size, not O(prose). The ratchet still caps
#     per-row bloat — it just caps higher.
#   * The index is APPEND-ONLY + `.gitattributes merge=union` (#300), the whole
#     point of its concurrency contract. The alternative (compacting old rows)
#     REWRITES existing lines, which under merge=union racing a concurrent
#     tail-append resolves by keeping BOTH the old long line and the short one
#     — a duplicated row. An autonomous push-mode worker cannot safely sequence
#     a rewrite against concurrent appends (the HOST owns the rebase), so #331
#     took the append-only path: raise the ceiling, add the deferred rows, never
#     rewrite a line. The invariant is preserved exactly.
#   * The 24576 ceiling had ~131 B of headroom and had already forced FIVE
#     hazards (#320/#321/#325/#328/#329) to defer their index rows into the
#     journal. 32768 lands those five rows (~27.1 KB) and leaves ~5.5 KB — room
#     for ~10 more tightened rows before this ticket's successor is needed.
#   * #359 is that successor: the 32768 ceiling reached ~21 B of headroom (every
#     one of #331's forecast rows had landed), so this ticket's one compact
#     hazard row would not fit. Same ADR 0174 two-way-door ruling, same
#     append-only invariant — raise 32768 → 40960 (32 KB → 40 KB), add the row,
#     never rewrite a line. Leaves ~7.2 KB — room for ~14 more tightened rows.
#   * #388 is the next successor: #359's ~7.2 KB had been consumed by the rows
#     since (through #384), leaving the 40960 ceiling ~366 B of headroom — this
#     ticket's one compact hazard row would not fit. Same ADR 0174 two-way-door
#     ruling, same append-only invariant — raise 40960 → 49152 (40 KB → 48 KB),
#     add the row, never rewrite a line. Leaves ~7.5 KB — room for ~14 more.
GOTCHAS_MAX=49152  # 48 KB — see rationale above (#388, was 40960 under #359, 32768 under #331, 24576 under #196)

status="$root/STATUS.md"
gotchas="$root/docs/GOTCHAS.md"

if [ -f "$status" ]; then
  bytes="$(wc -c <"$status")"
  check "STATUS.md is under ${STATUS_MAX} bytes (is $bytes)" "[ $bytes -lt $STATUS_MAX ]"

  # #374 — the budget FLOOR: STATUS.md must leave >= STATUS_HEADROOM_MIN bytes
  # under the ceiling, so a single writer can extend its own row to the full
  # per-line budget without trimming another's (the #287 invariant). Fail here
  # LOUD, with "compact the blocker rows into docs/journal/", long BEFORE the
  # surface silently reaches the state where concurrent state commits park.
  headroom=$((STATUS_MAX - bytes))
  check "STATUS.md leaves >= ${STATUS_HEADROOM_MIN} bytes of headroom (has $headroom) — compact blocker rows into docs/journal/ so a writer can update its own row without trimming another's (#287/#374)" \
    "[ $headroom -ge $STATUS_HEADROOM_MIN ]"

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