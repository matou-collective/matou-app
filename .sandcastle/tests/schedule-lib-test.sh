#!/usr/bin/env bash
# Offline test for schedule-lib.sh — the SCHEDULE seam of run-swarm.sh (#2),
# one of the two stages the 2026-08-15 factory-reengineering survey named as
# having no library of its own. It owns everything between "this tick fired"
# and "this run has a ready set, a debounce ruling and a model":
#
#   drive yield → janitor re-arm → list ready → debounce → per-run model
#
# Every decision here used to be inline in run-swarm.sh, and the debounce
# coalescer was pinned by a byte-for-byte COPY of the block in
# tests/debounce-test.sh — a copy that could (and did, for the nix-store block)
# drift from its original silently. The logic lives in one place now and this
# test drives the real functions.
#
# Run: bash .sandcastle/tests/schedule-lib-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sc="$here/.."

fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

# Pin every host-state path at a per-test tmp file BEFORE sourcing: a REAL
# rehearsal reservation can be live on the host running this suite (the #664
# lesson — session-runner-test.sh learned it the hard way).
export HOST_CAPACITY_DRIVE_WANTED="$tmp/drive-wanted"
. "$sc/host-capacity-lib.sh"
. "$sc/model-lib.sh"
. "$sc/schedule-lib.sh"

# ── 1. the drive-reservation yield (#663/#664/#30) ─────────────────────────
counter="$tmp/defer-count"
rm -f "$counter" "$HOST_CAPACITY_DRIVE_WANTED"

# no reservation → do NOT yield, and the consecutive-defer counter is reset
echo 9 > "$counter"
if out="$(schedule_drive_yield "$counter")"; then
  fail "no reservation must not yield (said: $out)"
fi
[ ! -f "$counter" ] || fail "proceeding must reset the defer counter (still: $(cat "$counter"))"
pass=$((pass+1))

# a FRESH reservation → yield, with the age and this consumer's own streak
: > "$HOST_CAPACITY_DRIVE_WANTED"
out="$(schedule_drive_yield "$counter")" || fail "a fresh reservation must yield (rc non-zero)"
grep -q "yielding this run to a ready drive" <<<"$out" || fail "the yield line must name the yield: $out"
grep -q "reservation age" <<<"$out" || fail "the yield line must carry the reservation's age: $out"
grep -q "skipped 1 consecutive tick(s)" <<<"$out" || fail "first defer must read skipped 1: $out"
[ "$(cat "$counter")" = 1 ] || fail "first defer must leave count 1, got $(cat "$counter" 2>/dev/null)"
out="$(schedule_drive_yield "$counter")" || fail "a second consecutive defer must still yield"
grep -q "skipped 2 consecutive tick(s)" <<<"$out" || fail "the streak must climb: $out"
pass=$((pass+1))

# an EXPIRED reservation (mtime past the TTL) does not yield
touch -d '@1' "$HOST_CAPACITY_DRIVE_WANTED"
if schedule_drive_yield "$counter" >/dev/null; then fail "an expired reservation must not yield"; fi
[ ! -f "$counter" ] || fail "an expired reservation must reset the defer counter"
rm -f "$HOST_CAPACITY_DRIVE_WANTED"
pass=$((pass+1))

# ── 2. the ready set ───────────────────────────────────────────────────────
# schedule_ready_tasks shells out to the lister (SCHEDULE_LIST_READY override so
# this test never needs a tracker).
cat > "$tmp/list-ready" <<'SH'
#!/usr/bin/env bash
printf '%s' '[{"number":7,"title":"seven","model":null},{"number":9,"title":"nine","model":"opus"}]'
SH
chmod +x "$tmp/list-ready"
SCHEDULE_LIST_READY="$tmp/list-ready"
ready="$(schedule_ready_tasks)"
[ "$(schedule_ready_count "$ready")" = 2 ] || fail "ready count should be 2"
[ "$(schedule_ready_nums "$ready")" = "7,9" ] || fail "ready nums should be '7,9', got '$(schedule_ready_nums "$ready")'"
[ "$(schedule_ready_count '[]')" = 0 ] || fail "an empty set counts 0"
[ -z "$(schedule_ready_nums '[]')" ] || fail "an empty set has no numbers"
pass=$((pass+1))

# the pickup listing that goes to the job log / Mattermost
listing="$(schedule_ready_listing "$ready")"
grep -q '#7 seven' <<<"$listing" || fail "the listing must name each ready ticket: $listing"
grep -q '#9 nine' <<<"$listing" || fail "the listing must name every ready ticket: $listing"
pass=$((pass+1))

# ── 3. debounce / trigger coalescing ───────────────────────────────────────
# The decisions previously pinned by tests/debounce-test.sh's verbatim copy,
# now driven against the real function.
stamp="$tmp/lastready"; rm -f "$stamp"
SET_A='[{"number":162},{"number":165},{"number":171}]'
SET_B='[{"number":165},{"number":171}]'   # 162 closed — the set changed

[ "$(schedule_debounce_decide "$SET_A" "$stamp" 600)" = "run" ] || fail "a cold stamp must run"
pass=$((pass+1))

for i in 1 2 3 4; do
  d="$(schedule_debounce_decide "$SET_A" "$stamp" 600)"
  [ "${d%% *}" = "coalesce" ] || fail "duplicate trigger $i must coalesce (got $d)"
done
# the coalesce ruling carries the age so run-swarm can say "attempted Ns ago"
d="$(schedule_debounce_decide "$SET_A" "$stamp" 600)"
[ "$(wc -w <<<"$d")" = 2 ] || fail "a coalesce ruling must carry the age: '$d'"
case "${d#* }" in ''|*[!0-9]*) fail "the coalesce age must be an integer: '$d'";; esac
pass=$((pass+1))

# work landed → the set changed → the next trigger runs IMMEDIATELY
[ "$(schedule_debounce_decide "$SET_B" "$stamp" 600)" = "run" ] || fail "a changed ready set must run at once"
d="$(schedule_debounce_decide "$SET_B" "$stamp" 600)"; [ "${d%% *}" = coalesce ] || fail "the new set should debounce in turn"
[ "$(schedule_debounce_decide "$SET_A" "$stamp" 600)" = "run" ] || fail "reverting to an older set is a real change"
pass=$((pass+1))

# window expiry: a zero-second window never coalesces, so the cron backstop and
# a genuine retry are never blocked by this
[ "$(schedule_debounce_decide "$SET_A" "$stamp" 0)" = "run" ] || fail "an expired window must run"
[ "$(schedule_debounce_decide "$SET_A" "$stamp" 0)" = "run" ] || fail "debounce must not latch once expired"
# an empty ready set is still a set — but run-swarm exits before this point when
# n=0, so coalescing must not be what decides that case
[ "$(schedule_debounce_decide '[]' "$stamp" 600)" = "run" ] || fail "the empty set is just another change"
pass=$((pass+1))

# the per-repo stamp path (#238: a shared /tmp stamp let two repos overwrite
# each other's, defeating coalescing entirely)
[ "$(schedule_stamp_path Matou-idss)" != "$(schedule_stamp_path Matou-matou-app)" ] \
  || fail "two repos must not share a debounce stamp (#238)"
SWARM_DEBOUNCE_STAMP="$tmp/injected" schedule_stamp_path any | grep -qx "$tmp/injected" \
  || fail "SWARM_DEBOUNCE_STAMP must override the derived path"
pass=$((pass+1))

# ── 3b. #213: the head SHA re-arms the debounce on a landed fix ─────────────
# A fix lands on main while the ready-set is byte-identical (the fixed ticket is
# still open, still ready): the ready-set alone cannot tell "nothing landed"
# (coalesce) from "a fix just landed" (run now). Folding origin/main's head SHA
# into the digest makes the second case a genuine trigger.
hstamp="$tmp/headstamp"; rm -f "$hstamp"
SET_H='[{"number":213}]'
SHA1=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
SHA2=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
[ "$(schedule_debounce_decide "$SET_H" "$hstamp" 600 "$SHA1")" = "run" ] \
  || fail "a cold stamp must run (with a head SHA)"
d="$(schedule_debounce_decide "$SET_H" "$hstamp" 600 "$SHA1")"
[ "${d%% *}" = coalesce ] || fail "unchanged head + unchanged ready-set must still coalesce, got: $d"
[ "$(schedule_debounce_decide "$SET_H" "$hstamp" 600 "$SHA2")" = "run" ] \
  || fail "a changed head SHA on a byte-identical ready-set must RE-ARM (run), not coalesce"
d="$(schedule_debounce_decide "$SET_H" "$hstamp" 600 "$SHA2")"
[ "${d%% *}" = coalesce ] || fail "the new head should debounce in turn, got: $d"
pass=$((pass+1))

# the digest itself changes with the head SHA even on a byte-identical set, and
# an absent head keeps the historical ready-only shape (back-compatible).
[ "$(schedule_ready_hash "$SET_H" "$SHA1")" != "$(schedule_ready_hash "$SET_H" "$SHA2")" ] \
  || fail "the digest must change when the head SHA changes on a byte-identical set"
[ "$(schedule_ready_hash "$SET_H")" = "$(schedule_ready_hash "$SET_H" "")" ] \
  || fail "an omitted head must equal an empty head (the historical ready-only digest)"
pass=$((pass+1))

# ── 4. the per-run model (#448) ────────────────────────────────────────────
# The swarm works the FIRST ready ticket, so the run's model follows THAT
# ticket's model-<name> label; an unknown one fails LOUD here, never a silent
# fall back to the default.
m="$(schedule_resolve_run_model '[{"number":9,"model":"opus"}]')" || fail "a known model label must resolve"
[ "$m" = "$(swarm_resolve_model opus)" ] || fail "the resolved id must be model-lib's, got $m"
d="$(schedule_resolve_run_model '[{"number":9,"model":null}]')" || fail "an unlabelled first ticket must fall back to the default"
[ "$d" = "$(swarm_resolve_model '')" ] || fail "the default must be SWARM_MODEL's, got $d"
if schedule_resolve_run_model '[{"number":9,"model":"nope"}]' >/dev/null 2>&1; then
  fail "an unknown model label must fail LOUD, not silently default"
fi
[ "$(schedule_first_model '[{"number":9,"model":"opus"}]')" = opus ] || fail "first_model should read the label"
[ -z "$(schedule_first_model '[{"number":9,"model":null}]')" ] || fail "an unlabelled ticket has no first_model"
pass=$((pass+1))

# the note run-swarm logs — names the label + ticket when there is one, and is
# bare when the run took the default
note="$(schedule_model_note '[{"number":9,"model":"opus"}]' some-model-id)"
grep -q 'from label model-opus on #9' <<<"$note" || fail "the note must cite the label and ticket: $note"
note="$(schedule_model_note '[{"number":9,"model":null}]' some-model-id)"
grep -q 'from label' <<<"$note" && fail "an unlabelled run's note must not invent a label: $note"
grep -q 'some-model-id' <<<"$note" || fail "the note must name the model: $note"
pass=$((pass+1))

# ── 5. the janitor re-arm line (spec D4) ───────────────────────────────────
# janitor_sweep is claim-lib's (tested there); schedule-lib only reports it, and
# must stay silent — never printing an empty "re-armed:" line — when nothing was
# stale, and must never fail the run when the sweep itself errors.
janitor_sweep() { printf '41\n42\n'; }
grep -q 'janitor re-armed stale-claimed issue(s): 41 42' <<<"$(schedule_janitor_rearm)" \
  || fail "a re-arm must be reported with the issue numbers"
janitor_sweep() { return 0; }
[ -z "$(schedule_janitor_rearm)" ] || fail "nothing stale must print nothing"
janitor_sweep() { return 7; }
schedule_janitor_rearm >/dev/null || fail "a failing sweep must never fail the run"
pass=$((pass+1))

# ── 6. a failing ready-list re-keys the death to THIS stage (#52 / GOTCHAS #7) ──
# The ready-list read runs on run-swarm's happy path, after preflight; a
# transient 5xx that outlives list-ready-tasks.sh's retries used to die under
# `set -e` while VERDICT_STAGE was still the preflight marker, mis-keying the
# healer with an EMPTY error block. schedule_list_ready_or_verdict re-keys the
# stage and captures the failure as the verdict's error line.
. "$sc/verdict-lib.sh"
# #142: the lister now names the failing endpoint + last HTTP status on stderr.
cat > "$tmp/list-fail" <<'SH'
#!/usr/bin/env bash
echo "list-ready-tasks: GET /issues failed after 3 attempts (last http=503)" >&2
exit 22
SH
chmod +x "$tmp/list-fail"
vp="$tmp/verdict.txt"; of="$tmp/ready.json"

verdict_begin "$vp"
verdict_stage "preflight self-tests (#446)"    # the last stage set before listing
SCHEDULE_LIST_READY="$tmp/list-fail"
rc=0; schedule_list_ready_or_verdict "$of" || rc=$?
[ "$rc" -ne 0 ] || fail "a lister that exits non-zero must propagate"
verdict_write "$rc"                             # run-swarm's EXIT trap does this
grep -q '^stage=list ready tasks$' "$vp" || fail "the death must re-key to the list stage, not preflight:
$(cat "$vp")"
err="$(sed -n '/^--- error lines ---$/,$p' "$vp" | sed '1d' | grep -E '[^[:space:]]' || true)"
[ -n "$err" ] || fail "the verdict must carry a non-empty error line, got empty:
$(cat "$vp")"
# #142: a 5xx is worded transient AND carries the observed status + endpoint.
grep -q 'transient' "$vp" || fail "a 5xx read must be worded transient:
$(cat "$vp")"
grep -q 'http=503' "$vp" || fail "the verdict must carry the observed status (503):
$(cat "$vp")"
grep -q '/issues' "$vp" || fail "the verdict must carry the failing endpoint:
$(cat "$vp")"
# the runlog reason derivation (verbatim from run-swarm's on_exit): SWARM_EXIT_REASON
# is unset on this path, so the reason falls back to died-in:<stage>.
reason="died-in:${VERDICT_STAGE:-unknown}"
[ "$reason" = "died-in:list ready tasks" ] || fail "runlog reason mis-keyed: $reason"
pass=$((pass+1))

# ── 6b (#142). a 4xx read is NOT worded transient ──────────────────────────
# An expired token (401) or a renamed/lost repo (404/403) is a rejection the
# swarm cannot self-heal — asserting "transient" there had the healer take no
# action and report self-healing forever while the swarm was permanently
# wedged. The verdict must say REJECTED, name the status, and never say
# "transient".
cat > "$tmp/list-401" <<'SH'
#!/usr/bin/env bash
echo "list-ready-tasks: GET /issues failed after 3 attempts (last http=401)" >&2
exit 22
SH
chmod +x "$tmp/list-401"
verdict_begin "$vp"
verdict_stage "list ready tasks"
SCHEDULE_LIST_READY="$tmp/list-401"
rc=0; schedule_list_ready_or_verdict "$of" || rc=$?
verdict_write "$rc"
grep -q 'http=401' "$vp" || fail "a 401 verdict must carry the observed status:
$(cat "$vp")"
grep -qi 'REJECTED' "$vp" || fail "a 401 must be worded as a rejection, not a guess:
$(cat "$vp")"
if grep -q 'transient' "$vp"; then fail "a 4xx read must NOT be called transient:
$(cat "$vp")"; fi
pass=$((pass+1))

# ── 6c (#142). the dependency fan-out's xargs-123 reaches the verdict with the
# endpoint named. Its child exits 1 and xargs maps that to 123; the endpoint is
# the ONLY signal that separates it from any other 123, so it must survive.
cat > "$tmp/list-123" <<'SH'
#!/usr/bin/env bash
echo "list-ready-tasks: GET /issues/141/dependencies failed after 3 attempts (last http=503)" >&2
exit 123
SH
chmod +x "$tmp/list-123"
verdict_begin "$vp"
verdict_stage "list ready tasks"
SCHEDULE_LIST_READY="$tmp/list-123"
rc=0; schedule_list_ready_or_verdict "$of" || rc=$?
[ "$rc" -eq 123 ] || fail "the xargs-123 must propagate as the verdict rc, got $rc"
verdict_write "$rc"
grep -q '/issues/141/dependencies' "$vp" || fail "the xargs-123 verdict must name the failing endpoint:
$(cat "$vp")"
grep -q 'rc=123' "$vp" || fail "the verdict must carry the raw rc (123) for the healer:
$(cat "$vp")"
pass=$((pass+1))

# a HEALTHY lister leaves no verdict and returns the JSON in the out-file
verdict_begin "$vp"
verdict_stage "list ready tasks"
SCHEDULE_LIST_READY="$tmp/list-ready"
schedule_list_ready_or_verdict "$of" || fail "a healthy lister must succeed"
verdict_write 0
[ ! -f "$vp" ] || fail "a healthy list must leave no verdict behind"
[ "$(jq 'length' "$of")" = 2 ] || fail "the ready JSON must land in the out-file"
pass=$((pass+1))

# ── 7. the fleet pick (#301) ───────────────────────────────────────────────
# Three ways a leg learns its ticket, in precedence order, plus the legacy
# fall-through; every host path pinned at tmp.
export FLEET_QUEUE_CACHE="$tmp/fleet-queue.json" FLEET_QUEUE_RECENT_CLOSES="$tmp/recent-closes"
FLEET_QUEUE_TICK="$tmp/fleet-queue-tick.sh"
READY='[{"number":7,"title":"seven"},{"number":9,"title":"nine"}]'
pf="$tmp/pick.json"
unset SWARM_TICKET SWARM_CLOSED_ISSUE

# 1. inputs.ticket names a ready ticket → exactly that ticket is the run
SWARM_TICKET=9 schedule_fleet_pick "$READY" Acme/widget "$pf" || fail "a ready fleet pick must proceed"
[ "$(jq -c 'map(.number)' "$pf")" = "[9]" ] || fail "the run must be filtered to the pick (got $(cat "$pf"))"
[ "$SCHEDULE_FLEET_PICK" = 9 ] || fail "SCHEDULE_FLEET_PICK must be the pick"
grep -q "fleet pick #9" <<<"$SCHEDULE_FLEET_NOTE" || fail "the note must name the pick: $SCHEDULE_FLEET_NOTE"
# 1b. inputs.ticket names a ticket that is GONE → stand down, never the next one
if SWARM_TICKET=42 schedule_fleet_pick "$READY" Acme/widget "$pf"; then fail "a gone fleet pick must stand down"; fi
[ "$SCHEDULE_FLEET_REASON" = fleet-pick-gone ] || fail "reason must be fleet-pick-gone (got $SCHEDULE_FLEET_REASON)"
grep -q "#42 is no longer ready" <<<"$SCHEDULE_FLEET_NOTE" || fail "the note must name the gone pick: $SCHEDULE_FLEET_NOTE"
pass=$((pass+1))

# 2. the host cache: head elsewhere → stand down; head here → the pick
fleet_queue_cache_write '[{"repo":"Acme/other","number":3},{"repo":"Acme/widget","number":9}]'
if schedule_fleet_pick "$READY" Acme/widget "$pf"; then fail "a fleet head in another repo must stand this leg down"; fi
[ "$SCHEDULE_FLEET_REASON" = fleet-head-elsewhere ] || fail "reason must be fleet-head-elsewhere (got $SCHEDULE_FLEET_REASON)"
grep -q "Acme/other#3" <<<"$SCHEDULE_FLEET_NOTE" || fail "the note must name the head: $SCHEDULE_FLEET_NOTE"
fleet_queue_cache_write '[{"repo":"Acme/widget","number":9},{"repo":"Acme/other","number":3}]'
schedule_fleet_pick "$READY" Acme/widget "$pf" || fail "a fleet head in this repo must proceed"
[ "$(jq -c 'map(.number)' "$pf")" = "[9]" ] && [ "$SCHEDULE_FLEET_PICK" = 9 ] || fail "the head here must be the pick (got $(cat "$pf"))"
# 2b. head here but no longer in the ready set → legacy order, no pick
fleet_queue_cache_write '[{"repo":"Acme/widget","number":99}]'
schedule_fleet_pick "$READY" Acme/widget "$pf" || fail "a stale head must fall through, not stand down"
[ "$(jq -c 'map(.number)' "$pf")" = "[7,9]" ] && [ -z "$SCHEDULE_FLEET_PICK" ] || fail "a head not in the ready set must leave the repo order"
# 2c. a stale cache → legacy order, no pick, and the note says so
touch -d '-1 hour' "$FLEET_QUEUE_CACHE"
schedule_fleet_pick "$READY" Acme/widget "$pf" || fail "a stale cache must fall through"
[ "$(jq -c 'map(.number)' "$pf")" = "[7,9]" ] && [ -z "$SCHEDULE_FLEET_PICK" ] || fail "a stale cache must leave the repo order"
grep -q "no fleet view" <<<"$SCHEDULE_FLEET_NOTE" || fail "the legacy note must say there is no fleet view: $SCHEDULE_FLEET_NOTE"
pass=$((pass+1))

# 3. a `closed` leg records the close for the host's ticks — only when the host runs the tick
rm -f "$FLEET_QUEUE_CACHE" "$FLEET_QUEUE_RECENT_CLOSES"
SWARM_CLOSED_ISSUE=5 schedule_fleet_pick "$READY" Acme/widget "$pf" || fail "a closed leg with no cache must fall through"
[ ! -f "$FLEET_QUEUE_RECENT_CLOSES" ] || fail "no tick on this host → no close record"
: > "$FLEET_QUEUE_TICK"
SWARM_CLOSED_ISSUE=5 schedule_fleet_pick "$READY" Acme/widget "$pf" || fail "a closed leg must fall through with no cache"
grep -q " Acme/widget 5$" "$FLEET_QUEUE_RECENT_CLOSES" || fail "a closed leg must record the close for the host's ticks"
# the mirror: a pick lands as <signals-dir>/fleet-pick, no pick leaves nothing
SCHEDULE_FLEET_PICK=9 schedule_fleet_pick_signal "$tmp/sig"
[ "$(cat "$tmp/sig/fleet-pick")" = 9 ] || fail "the pick must be mirrored into the host-signals dir"
rm -rf "$tmp/sig"; SCHEDULE_FLEET_PICK="" schedule_fleet_pick_signal "$tmp/sig"
[ ! -e "$tmp/sig/fleet-pick" ] || fail "no pick must leave no signal"
pass=$((pass+1))

echo "schedule-lib: $pass groups passed"
