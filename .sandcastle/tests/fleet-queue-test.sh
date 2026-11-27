#!/usr/bin/env bash
# Offline test for fleet-queue.sh — the fleet queue watcher's three modes
# (#301): tick (gated, dispatches the fleet head to THIS host), after-close
# (the closed ticket's dependants first, no slot gate), pick (print, dispatch
# nothing). Fake checkouts with fake listers, a shimmed curl, tmp host state.
# Run: bash tests/fleet-queue-test.sh
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"
sc="$here/.."

tmp="$(tmpdir)"
export HOST_CAPACITY_STATE_DIR="$tmp/state"
export HOST_CAPACITY_SLOTS="$tmp/state/slot-1.lock $tmp/state/slot-2.lock"
export HOST_CAPACITY_DRIVE_WANTED="$tmp/state/drive-wanted"
export FLEET_QUEUE_CACHE="$tmp/state/fleet-queue.json"
export FLEET_QUEUE_STAMP="$tmp/state/fleet-queue-dispatched"
export FLEET_QUEUE_RECENT_CLOSES="$tmp/state/fleet-recent-closes"
export FLEET_QUEUE_STRIKES="$tmp/state/fleet-queue-strikes"
export FLEET_QUEUE_MARKS="$tmp/state/fleet-queue-marks"
export FLEET_DISPATCH_ACK_STATE="$tmp/state/fleet-dispatch-ack"
export COMMENTS_DIR="$tmp/comments"
export FORGEJO_TOKEN=t HOST_NAME=box-07 CURL_LOG="$tmp/curl.log" LISTER_LOG="$tmp/listers.log"
# Hermeticity (#368): neutralise any host-env dispatcher config so the acting-ack
# cases exercise only the crafted ack. On the dispatcher host FLEET_DISPATCHER_URL
# is set, which makes fleet_slot_report_emit POST (via the curl shim) and record a
# dead ack, overwriting the crafted "true true" and reddening the stand-down check.
export FLEET_DISPATCHER_URL="" FLEET_DISPATCHER_TOKEN=""
mkdir -p "$tmp/state"

mk_checkout() { # <dir> <slug> <lister-json>
  mkdir -p "$1/.sandcastle"
  printf ': "${FORGEJO_API:=https://forge.test/api/v1/repos/%s}"\n' "$2" >"$1/.sandcastle/swarm-identity.sh"
  printf '#!/usr/bin/env bash\necho "%s" >>"$LISTER_LOG"\ncat <<'"'"'JSON'"'"'\n%s\nJSON\n' "$2" "$3" >"$1/.sandcastle/list-ready-tasks.sh"
}
mk_checkout "$tmp/alpha" Acme/alpha '[{"number":10,"title":"alpha oldest","body":"","url":"u","created_at":"2026-10-01T00:00:00Z","priority":false,"blocker":false},{"number":12,"title":"alpha newer","body":"","url":"u","created_at":"2026-10-20T00:00:00Z","priority":false,"blocker":false}]'
mk_checkout "$tmp/beta"  Acme/beta  '[{"number":5,"title":"beta mid","body":"","url":"u","created_at":"2026-10-10T00:00:00Z","priority":false,"blocker":false}]'
mk_checkout "$tmp/empty" Acme/empty '[]'
export FLEET_QUEUE_REPOS="$tmp/alpha:Acme/alpha $tmp/beta:Acme/beta"

shim curl <<'SH'
url=""; method=GET; data=""
while [ $# -gt 0 ]; do
  case "$1" in -X) method="$2"; shift 2 ;; -H|-d|--max-time|-o|-w) [ "$1" = -d ] && data="$2"; shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac
done
[ "$data" = "@-" ] && data="$(cat)"
printf '%s %s %s\n' "$method" "$url" "$data" >>"${CURL_LOG:?}"
# A tiny tracker: one JSON array of comments per issue under $COMMENTS_DIR, ids
# strictly increasing across the whole forge (the property arbitration rests on).
store="${COMMENTS_DIR:?}"; mkdir -p "$store"
cfile() { local k="${url#*/repos/}"; k="${k%/comments}"; printf '%s/%s.json' "$store" "${k//\//_}"; }
nextid() { local i; i=$(( $(cat "$store/seq" 2>/dev/null || echo 100) + 1 )); echo "$i" >"$store/seq"; echo "$i"; }
put() { # <file> <host-or-empty> <body> -> the stored comment
  local f="$1" id c; id="$(nextid)"; [ -f "$f" ] || echo '[]' >"$f"
  c="$(jq -cn --argjson id "$id" --arg b "$3" --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{id: $id, body: $b, created_at: $t}')"
  jq -c --argjson c "$c" '. + [$c]' "$f" >"$f.tmp" && mv "$f.tmp" "$f"; printf '%s' "$c"
}
case "$method $url" in
  "GET "*/issues/*/comments)
    [ -n "${COMMENTS_GET_FAIL:-}" ] && exit 22
    f="$(cfile)"; if [ -f "$f" ]; then cat "$f"; else printf '[]'; fi ;;
  "POST "*/issues/*/comments)
    [ -n "${COMMENTS_POST_FAIL:-}" ] && exit 22
    f="$(cfile)"
    # RACE_FIRST=<host>: a peer's marker lands just BEFORE ours (lower id);
    # RACE_AFTER=<host>: just after (higher id) — two ticks in the same second.
    # RACE_ONLY=<n> confines the peer to that one issue.
    case "$url" in */issues/${RACE_ONLY:-*}/comments) ;; *) RACE_FIRST=""; RACE_AFTER="" ;; esac
    if [ -n "${RACE_FIRST:-}" ]; then put "$f" x "fleet-dispatch host=$RACE_FIRST" >/dev/null; fi
    put "$f" x "$(jq -r .body <<<"$data")"
    if [ -n "${RACE_AFTER:-}" ]; then put "$f" x "fleet-dispatch host=$RACE_AFTER" >/dev/null; fi ;;
  "DELETE "*/issues/comments/*)
    [ -n "${COMMENTS_DELETE_FAIL:-}" ] && { printf '500'; exit 0; }
    id="${url##*/}"; hit=404
    for f in "$store"/*.json; do
      [ -f "$f" ] || continue
      if jq -e --argjson id "$id" 'any(.[]; .id == $id)' "$f" >/dev/null; then
        jq -c --argjson id "$id" 'map(select(.id != $id))' "$f" >"$f.tmp" && mv "$f.tmp" "$f"; hit=204
      fi
    done
    printf '%s' "$hit" ;;
  *)
    case "$url" in
      *actions/runs?status=waiting*) [ -n "${WAITING_FAIL:-}" ] && exit 22; printf '%s' "${WAITING_RUNS:-}" ;;
      */repos/Acme/alpha/issues/10/blocks*) printf '[{"number":5,"state":"open","repository":{"full_name":"Acme/beta"}}]' ;;
      */blocks*) printf '[]' ;;
      */dispatches) [ -n "${DISPATCH_FAIL:-}" ] && { printf '500'; exit 0; }; printf '204' ;;
      *) printf '[]' ;;
    esac ;;
esac
SH

reset() { : >"$CURL_LOG"; : >"$LISTER_LOG"; rm -f "$FLEET_QUEUE_STAMP" "$FLEET_QUEUE_CACHE" "$FLEET_QUEUE_RECENT_CLOSES" "$FLEET_QUEUE_STRIKES" "$FLEET_QUEUE_MARKS" "$FLEET_DISPATCH_ACK_STATE" "$HOST_CAPACITY_DRIVE_WANTED"; rm -rf "$COMMENTS_DIR"; }
run() { bash "$sc/fleet-queue.sh" "$@" 2>&1; }
dispatched() { local n; n="$(grep -c "POST .*dispatches" "$CURL_LOG" 2>/dev/null)" || true; echo "${n:-0}"; }
dispatch_body() { grep "dispatches" "$CURL_LOG" | tail -1 | cut -d' ' -f3-; }

# ── tick: the gates come BEFORE any lister runs ────────────────────────────
reset
( exec 7>"$tmp/state/slot-1.lock"; flock 7; sleep 30 ) & h1=$!
( exec 7>"$tmp/state/slot-2.lock"; flock 7; sleep 30 ) & h2=$!
sleep 0.3
out="$(run tick)"; rc=$?
check "tick with both slots held runs NO lister and dispatches nothing (rc 0)" \
  '[ "$rc" -eq 0 ] && [ ! -s "$LISTER_LOG" ] && [ "$(dispatched)" -eq 0 ]'
kill "$h1" "$h2" 2>/dev/null; wait "$h1" "$h2" 2>/dev/null

reset; touch "$HOST_CAPACITY_DRIVE_WANTED"
out="$(run tick)"
check "tick under a fresh drive reservation says so, lists nothing, dispatches nothing" \
  'grep -q "rehearsal drive has reserved" <<<"$out" && [ ! -s "$LISTER_LOG" ] && [ "$(dispatched)" -eq 0 ]'

reset; printf '%s Acme/beta 5\n' "$(date +%s)" >"$FLEET_QUEUE_STAMP"
out="$(run tick)"
check "tick with a fresh dispatch stamp waits for that leg (no lister, no dispatch)" \
  'grep -q "dispatched Acme/beta#5 .*waiting for that leg" <<<"$out" && [ ! -s "$LISTER_LOG" ] && [ "$(dispatched)" -eq 0 ]'

# ── tick: the fleet head wins across repos, dispatched to THIS host ─────────
reset
out="$(run tick)"
check "tick lists every registered repo" \
  'grep -q "^Acme/alpha$" "$LISTER_LOG" && grep -q "^Acme/beta$" "$LISTER_LOG"'
check "tick dispatches the OLDEST ticket fleet-wide (alpha#10 over beta#5)" \
  '[ "$(dispatched)" -eq 1 ] && grep -q "POST https://forge.test/api/v1/repos/Acme/alpha/actions/workflows/swarm.yml/dispatches" "$CURL_LOG"'
check "tick's dispatch carries inputs.ticket=10 and inputs.host=box-07" \
  'b="$(dispatch_body)" && [ "$(jq -r .inputs.ticket <<<"$b")" = 10 ] && [ "$(jq -r .inputs.host <<<"$b")" = box-07 ]'
check "tick says what it did and why" \
  'grep -q "fleet-queue: dispatched Acme/alpha#10 to box-07 (fleet head; 3 ready fleet-wide)" <<<"$out"'
check "tick stamps the dispatch" \
  '[ "$(cut -d" " -f2,3 "$FLEET_QUEUE_STAMP")" = "Acme/alpha 10" ]'
check "tick writes the host cache in fleet order" \
  '[ "$(jq -c "map(\"\(.repo)#\(.number)\")" "$FLEET_QUEUE_CACHE")" = "[\"Acme/alpha#10\",\"Acme/beta#5\",\"Acme/alpha#12\"]" ]'

# ── a priority ticket filed last jumps the fleet line ──────────────────────
reset
mk_checkout "$tmp/prio" Acme/prio '[{"number":1,"title":"prio last","body":"","url":"u","created_at":"2026-10-22T00:00:00Z","priority":true,"blocker":false}]'
out="$(FLEET_QUEUE_REPOS="$FLEET_QUEUE_REPOS $tmp/prio:Acme/prio" run tick)"
check "a priority ticket filed last is dispatched first" \
  'grep -q "repos/Acme/prio/actions/workflows" "$CURL_LOG" && [ "$(jq -r .inputs.ticket <<<"$(dispatch_body)")" = 1 ]'

# ── after-close: dependants first, no slot gate, the close is recorded ──────
reset
( exec 7>"$tmp/state/slot-1.lock"; flock 7; sleep 30 ) & h1=$!
( exec 7>"$tmp/state/slot-2.lock"; flock 7; sleep 30 ) & h2=$!
sleep 0.3
out="$(run after-close Acme/alpha 10)"
check "after-close reads what the closed ticket blocks" \
  'grep -q "GET https://forge.test/api/v1/repos/Acme/alpha/issues/10/blocks" "$CURL_LOG"'
check "after-close dispatches the DEPENDANT (beta#5) ahead of the older alpha#10, slots held or not" \
  '[ "$(dispatched)" -eq 1 ] && grep -q "repos/Acme/beta/actions/workflows" "$CURL_LOG" && [ "$(jq -r .inputs.ticket <<<"$(dispatch_body)")" = 5 ]'
check "after-close names the dependant relation" \
  'grep -q "dispatched Acme/beta#5 to box-07 (dependant of Acme/alpha#10" <<<"$out"'
check "after-close records the close for later ticks on this host" \
  'grep -q " Acme/alpha 10$" "$FLEET_QUEUE_RECENT_CLOSES"'
kill "$h1" "$h2" 2>/dev/null; wait "$h1" "$h2" 2>/dev/null

# ── rearm: a run that closed nothing still hands its slot to the fleet head ─
reset
( exec 7>"$tmp/state/slot-1.lock"; flock 7; sleep 30 ) & h1=$!
( exec 7>"$tmp/state/slot-2.lock"; flock 7; sleep 30 ) & h2=$!
sleep 0.3
out="$(run rearm)"
check "rearm dispatches the fleet head to this host with no slot gate and records no close" \
  '[ "$(dispatched)" -eq 1 ] && [ "$(jq -r .inputs.ticket <<<"$(dispatch_body)")" = 10 ] && [ ! -f "$FLEET_QUEUE_RECENT_CLOSES" ]'
kill "$h1" "$h2" 2>/dev/null; wait "$h1" "$h2" 2>/dev/null

# ── a recorded close promotes on a LATER tick too (a human's close) ─────────
reset; printf '%s Acme/alpha 10\n' "$(date +%s)" >"$FLEET_QUEUE_RECENT_CLOSES"
out="$(run tick)"
check "tick promotes the dependants of a recent recorded close" \
  'grep -q "repos/Acme/beta/actions/workflows" "$CURL_LOG" && grep -q "dependant of Acme/alpha#10" <<<"$out"'

# ── disk-headroom gate (#315): a host under its floor reports no free slot ──
reset
shim df <<'SH'
echo "Filesystem 1024-blocks Used Available Capacity Mounted"
echo "/dev/fake 999999999 0 ${FAKE_DF_AVAIL_KB:-999999999} 1% /"
SH
out="$(FLEET_QUEUE_MIN_FREE_GB=5 FLEET_QUEUE_ACT_CACHE="$tmp/state" FAKE_DF_AVAIL_KB=$((2 * 1024 * 1024)) run tick)"
check "tick below the disk floor runs NO lister and dispatches nothing" \
  '[ ! -s "$LISTER_LOG" ] && [ "$(dispatched)" -eq 0 ]'
out="$(FLEET_QUEUE_MIN_FREE_GB=5 FLEET_QUEUE_ACT_CACHE="$tmp/state" FAKE_DF_AVAIL_KB=$((9 * 1024 * 1024)) run tick)"
check "tick above the disk floor proceeds and dispatches" \
  '[ -s "$LISTER_LOG" ] && [ "$(dispatched)" -eq 1 ]'

# ── strikes + stand-down (#315): a host whose dispatches never claim backs off ─
reset
printf '%s Acme/alpha 10\n' "$(( $(date +%s) - 99999 ))" >"$FLEET_QUEUE_STAMP"
out="$(run tick)"
check "a re-dispatch of the SAME unclaimed head (still the fleet head) counts a strike" \
  '[ "$(cut -d" " -f1 "$FLEET_QUEUE_STRIKES")" -eq 1 ] && grep -q "never claimed (strike 1)" <<<"$out"'

reset
printf '2 %s\n' "$(date +%s)" >"$FLEET_QUEUE_STRIKES"
printf '%s Acme/beta 5\n' "$(( $(date +%s) - 99999 ))" >"$FLEET_QUEUE_STAMP"
out="$(run tick)"
check "a tick whose head differs from the last dispatch resets the strikes and dispatches" \
  '[ ! -f "$FLEET_QUEUE_STRIKES" ] && [ "$(dispatched)" -eq 1 ]'

reset
printf '2 %s\n' "$(date +%s)" >"$FLEET_QUEUE_STRIKES"
printf '%s Acme/alpha 10\n' "$(( $(date +%s) - 99999 ))" >"$FLEET_QUEUE_STAMP"
out="$(run tick)"
check "the strike that REACHES the threshold stands down WITHOUT one more dispatch" \
  '[ "$(cut -d" " -f1 "$FLEET_QUEUE_STRIKES")" -eq 3 ] && [ "$(dispatched)" -eq 0 ] && grep -q "backing off" <<<"$out"'

reset
printf '3 %s\n' "$(date +%s)" >"$FLEET_QUEUE_STRIKES"
out="$(run tick)"
check "once stood down, tick lists nothing and dispatches nothing until the backoff lapses" \
  'grep -q "consecutive unclaimed dispatch" <<<"$out" && [ ! -s "$LISTER_LOG" ] && [ "$(dispatched)" -eq 0 ]'

reset
printf '5 %s\n' "$(date +%s)" >"$FLEET_QUEUE_STRIKES"
out="$(run rearm)"
check "a rearm (a run that just finished on this host) clears the strikes" \
  '[ ! -f "$FLEET_QUEUE_STRIKES" ] && [ "$(dispatched)" -eq 1 ]'

# ── dispatcher stand-down (ADR 0009 / #356): an acknowledged host defers ────
# The ack state is "<at> <ok> <acting>"; a fresh ok=true acting=true line is a
# LIVE dispatcher saying it allocates this host's slot (fleet-slot-report-lib.sh
# writes it on a 2xx; here we craft it, since the push is a no-op with no
# FLEET_DISPATCHER_URL). Fresh acting-ack → stand the tick down.
reset
printf '%s true true\n' "$(date +%s)" >"$FLEET_DISPATCH_ACK_STATE"
out="$(run tick)"
check "a tick with a fresh LIVE ack stands down: no lister, no dispatch, names the dispatcher" \
  '[ ! -s "$LISTER_LOG" ] && [ "$(dispatched)" -eq 0 ] && grep -q "live dispatcher acknowledged" <<<"$out"'

# a not-acting ack (the dispatcher is only shadowing) never stands the tick down
reset
printf '%s true false\n' "$(date +%s)" >"$FLEET_DISPATCH_ACK_STATE"
out="$(run tick)"
check "a not-acting ack (shadow) does NOT stand down — the head is dispatched as today" \
  '[ "$(dispatched)" -eq 1 ] && [ "$(jq -r .inputs.ticket <<<"$(dispatch_body)")" = 10 ]'

# a STALE acting-ack → the dispatcher went quiet → today's tick resumes at once
reset
printf '%s true true\n' "$(( $(date +%s) - 99999 ))" >"$FLEET_DISPATCH_ACK_STATE"
out="$(run tick)"
check "a stale acting-ack resumes the host's own tick within one heartbeat (dispatches the head)" \
  '[ "$(dispatched)" -eq 1 ] && [ "$(jq -r .inputs.ticket <<<"$(dispatch_body)")" = 10 ]'

# the stand-down is tick-only: a finishing run's rearm still self-rearms (the
# retirement of that seam is a later slice, not #356).
reset
printf '%s true true\n' "$(date +%s)" >"$FLEET_DISPATCH_ACK_STATE"
( exec 7>"$tmp/state/slot-1.lock"; flock 7; sleep 30 ) & h1=$!
( exec 7>"$tmp/state/slot-2.lock"; flock 7; sleep 30 ) & h2=$!
sleep 0.3
out="$(run rearm)"
check "a fresh ack does NOT stand a rearm down (tick-only; the self-rearm seam is retired later)" \
  '[ "$(dispatched)" -eq 1 ] && [ "$(jq -r .inputs.ticket <<<"$(dispatch_body)")" = 10 ]'
kill "$h1" "$h2" 2>/dev/null; wait "$h1" "$h2" 2>/dev/null

# a BUSY host exits at the slot gate even with a fresh ack — "busy", not a stand-down
reset
printf '%s true true\n' "$(date +%s)" >"$FLEET_DISPATCH_ACK_STATE"
( exec 7>"$tmp/state/slot-1.lock"; flock 7; sleep 30 ) & h1=$!
( exec 7>"$tmp/state/slot-2.lock"; flock 7; sleep 30 ) & h2=$!
sleep 0.3
out="$(run tick)"
check "a BUSY host exits at the slot gate even with a fresh ack (no stand-down line, no dispatch)" \
  '[ "$(dispatched)" -eq 0 ] && ! grep -q "live dispatcher acknowledged" <<<"$out"'
kill "$h1" "$h2" 2>/dev/null; wait "$h1" "$h2" 2>/dev/null

# ── dispatch arbitration (#351): one ticket goes to ONE host ────────────────
marker() { # <repo> <n> <id> <host> <age-seconds> — a peer's fleet-dispatch marker on a ticket
  local f="$COMMENTS_DIR/Acme_$1_issues_$2.json"; mkdir -p "$COMMENTS_DIR"; [ -f "$f" ] || echo '[]' >"$f"
  jq -c --argjson id "$3" --arg b "fleet-dispatch host=$4" --arg t "$(date -u -d "@$(( $(date +%s) - $5 ))" +%Y-%m-%dT%H:%M:%SZ)" \
    '. + [{id: $id, body: $b, created_at: $t}]' "$f" >"$f.tmp" && mv "$f.tmp" "$f"
}
reset
out="$(run tick)"
check "tick marks the ticket it dispatches (a fleet-dispatch comment naming this host)" \
  '[ "$(jq -r ".[0].body" "$COMMENTS_DIR/Acme_alpha_issues_10.json" | head -1)" = "fleet-dispatch host=box-07" ] && [ "$(dispatched)" -eq 1 ]'
check "the marker is posted BEFORE the dispatch" \
  '[ "$(grep -n "^POST .*/issues/10/comments" "$CURL_LOG" | cut -d: -f1)" -lt "$(grep -n "dispatches" "$CURL_LOG" | cut -d: -f1)" ]'

reset; marker alpha 10 50 box-02 20
out="$(run tick)"
check "a head another host is already dispatching is SKIPPED: this host takes the next in line (beta#5)" \
  '[ "$(dispatched)" -eq 1 ] && grep -q "repos/Acme/beta/actions/workflows" "$CURL_LOG" && [ "$(jq -r .inputs.ticket <<<"$(dispatch_body)")" = 5 ]'
check "the skip is named, with the holder, and the dispatch says it was next in line" \
  'grep -q "Acme/alpha#10 is being dispatched to box-02 — taking the next ticket in line" <<<"$out" && grep -q "dispatched Acme/beta#5 to box-07 (next in line; 1 ahead held by another host" <<<"$out"'
check "the skipped head gets no marker from this host; the stamp names what was dispatched" \
  '[ "$(jq length "$COMMENTS_DIR/Acme_alpha_issues_10.json")" -eq 1 ] && [ "$(cut -d" " -f2,3 "$FLEET_QUEUE_STAMP")" = "Acme/beta 5" ]'
check "a skipped head counts NO strike against this host (it never dispatched it)" \
  '[ ! -f "$FLEET_QUEUE_STRIKES" ]'

reset; marker alpha 10 50 box-02 20; marker beta 5 51 box-03 20; marker alpha 12 52 box-02 20
out="$(run tick)"
check "when every ready ticket is already being dispatched elsewhere, this host dispatches nothing and says so" \
  '[ "$(dispatched)" -eq 0 ] && grep -q "already being dispatched to another host" <<<"$out" && [ ! -f "$FLEET_QUEUE_STAMP" ]'

reset; marker alpha 10 50 box-02 99999
out="$(run tick)"
check "an EXPIRED peer marker holds nothing — the head is dispatched here" \
  '[ "$(dispatched)" -eq 1 ] && [ "$(jq -r .inputs.ticket <<<"$(dispatch_body)")" = 10 ]'

reset
out="$(RACE_FIRST=box-02 RACE_ONLY=10 run tick)"
check "two hosts ticking in the same second: the loser dispatches the NEXT ticket, never the same one" \
  '[ "$(dispatched)" -eq 1 ] && [ "$(jq -r .inputs.ticket <<<"$(dispatch_body)")" = 5 ] && ! grep -q "repos/Acme/alpha/actions/workflows" "$CURL_LOG"'

reset
out="$(COMMENTS_GET_FAIL=1 run tick)"
check "a tracker that cannot answer the comments read fails OPEN: the head is still dispatched" \
  '[ "$(dispatched)" -eq 1 ] && [ "$(jq -r .inputs.ticket <<<"$(dispatch_body)")" = 10 ] && grep -q "unarbitrated" <<<"$out"'

reset; marker alpha 10 50 box-02 20
( exec 7>"$tmp/state/slot-1.lock"; flock 7; sleep 30 ) & h1=$!
( exec 7>"$tmp/state/slot-2.lock"; flock 7; sleep 30 ) & h2=$!
sleep 0.3
out="$(run rearm)"
check "a finishing run's rearm arbitrates too: a head held elsewhere → the next in line" \
  '[ "$(dispatched)" -eq 1 ] && [ "$(jq -r .inputs.ticket <<<"$(dispatch_body)")" = 5 ]'
kill "$h1" "$h2" 2>/dev/null; wait "$h1" "$h2" 2>/dev/null

reset; marker alpha 10 50 box-02 20
out="$(run pick)"
check "pick still prints the true fleet head and writes no marker" \
  '[ "$out" = "Acme/alpha 10" ] && ! grep -q "^POST" "$CURL_LOG"'

reset
marker beta 5 60 box-07 99999
printf '%s Acme/beta 5 60\n' "$(( $(date +%s) - 99999 ))" >"$FLEET_QUEUE_MARKS"
printf '%s Acme/beta 5\n' "$(date +%s)" >"$FLEET_QUEUE_STAMP"
out="$(run tick)"
check "every tick sweeps this host's expired markers, even one that then waits on a fresh stamp" \
  '[ "$(jq length "$COMMENTS_DIR/Acme_beta_issues_5.json")" -eq 0 ] && [ "$(dispatched)" -eq 0 ]'

# ── pick: print the head, dispatch nothing ─────────────────────────────────
reset
out="$(run pick)"
check "pick prints 'slug n' and dispatches nothing" \
  '[ "$out" = "Acme/alpha 10" ] && [ "$(dispatched)" -eq 0 ] && [ -s "$FLEET_QUEUE_CACHE" ]'

# ── empty fleet ────────────────────────────────────────────────────────────
reset
out="$(FLEET_QUEUE_REPOS="$tmp/empty:Acme/empty" run tick)"
check "an empty fleet says so and dispatches nothing" \
  'grep -q "nothing ready fleet-wide" <<<"$out" && [ "$(dispatched)" -eq 0 ]'
out="$(FLEET_QUEUE_REPOS="$tmp/empty:Acme/empty" run pick)"
check "pick on an empty fleet prints nothing" '[ -z "$out" ]'

# ── a failed dispatch is reported, not stamped, so the next tick retries ────
reset
out="$(DISPATCH_FAIL=1 run tick)"
check "a non-2xx dispatch is named with its code and leaves no stamp" \
  'grep -q "FAILED (http=500)" <<<"$out" && [ ! -f "$FLEET_QUEUE_STAMP" ]'
check "a failed dispatch releases its marker at once (another host may take the ticket)" \
  '[ "$(jq length "$COMMENTS_DIR/Acme_alpha_issues_10.json")" -eq 0 ]'

# ── usage ──────────────────────────────────────────────────────────────────
check "an unknown mode is a usage error (2)" '! run bogus >/dev/null; [ "$(run bogus >/dev/null 2>&1; echo $?)" -eq 2 ]'
check "after-close without its args is a usage error (2)" '[ "$(run after-close >/dev/null 2>&1; echo $?)" -eq 2 ]'

# ── runner-queue backpressure, host side (#376 — follow-ups to #373) ────────
# item 2: a host whose OWN runner queue is backed up past the #373 ceiling declines
# to self-dispatch into its own free slot (parity with the central dispatcher gate).
reset
WR_OLD="$(jq -cn --argjson now "$(date +%s)" '{workflow_runs:[{display_title:"swarm box-07 #10",name:"swarm",created:(($now-300)|todateiso8601)}]}')"
out="$(FLEET_DISPATCH_QUEUE_LAG_MAX=240 WAITING_RUNS="$WR_OLD" run tick)"
check "a host whose own runner queue is backed up self-dispatches nothing and says so (#376 item 2)" \
  '[ "$(dispatched)" -eq 0 ] && grep -q "runner queue is backed up" <<<"$out" && grep -q "offered nothing this pass" <<<"$out"'

reset
WR_FRESH="$(jq -cn --argjson now "$(date +%s)" '{workflow_runs:[{display_title:"swarm box-07 #10",name:"swarm",created:(($now-30)|todateiso8601)}]}')"
out="$(FLEET_DISPATCH_QUEUE_LAG_MAX=240 WAITING_RUNS="$WR_FRESH" run tick)"
check "a host under the ceiling still self-dispatches (its waiting leg is fresh)" \
  '[ "$(dispatched)" -eq 1 ]'

reset
out="$(FLEET_DISPATCH_QUEUE_LAG_MAX=0 WAITING_RUNS="$WR_OLD" run tick)"
check "the backpressure check disabled (MAX=0) self-dispatches regardless (pre-#373)" \
  '[ "$(dispatched)" -eq 1 ]'

reset
out="$(FLEET_DISPATCH_QUEUE_LAG_MAX=240 WAITING_FAIL=1 run tick)"
check "an unreadable runner queue backs the host off nothing — it still self-dispatches (fail-open, #376)" \
  '[ "$(dispatched)" -eq 1 ]'

# item 1: a dispatch marker whose leg is still `waiting` past FLEET_QUEUE_LEG_WAIT_MAX
# is released EARLY so another host can take the ticket. The host is kept BUSY (both
# slots held) so the tick exits at the slot gate — item 1 runs before the gates.
hold_slots() { ( exec 7>"$tmp/state/slot-1.lock"; flock 7; sleep 30 ) & h1=$!; ( exec 7>"$tmp/state/slot-2.lock"; flock 7; sleep 30 ) & h2=$!; sleep 0.3; }
drop_slots() { kill "$h1" "$h2" 2>/dev/null; wait "$h1" "$h2" 2>/dev/null; }

reset
marker beta 5 60 box-07 10                                    # a live marker (comment id 60) on beta#5
printf '%s Acme/beta 5 60\n' "$(date +%s)" >"$FLEET_QUEUE_MARKS"   # this host recorded it
WR_LEG="$(jq -cn --argjson now "$(date +%s)" '{workflow_runs:[{display_title:"swarm box-07 #5",name:"swarm",created:(($now-300)|todateiso8601)}]}')"
hold_slots
out="$(FLEET_QUEUE_LEG_WAIT_MAX=240 WAITING_RUNS="$WR_LEG" run tick)"
check "a marker whose leg is still waiting past the threshold is released early (#376 item 1)" \
  '[ "$(jq length "$COMMENTS_DIR/Acme_beta_issues_5.json")" -eq 0 ] && ! grep -q "Acme/beta 5 60" "$FLEET_QUEUE_MARKS" && grep -q "released its dispatch marker early" <<<"$out"'
drop_slots

reset
marker beta 5 60 box-07 10
printf '%s Acme/beta 5 60\n' "$(date +%s)" >"$FLEET_QUEUE_MARKS"
WR_LEG_FRESH="$(jq -cn --argjson now "$(date +%s)" '{workflow_runs:[{display_title:"swarm box-07 #5",name:"swarm",created:(($now-30)|todateiso8601)}]}')"
hold_slots
out="$(FLEET_QUEUE_LEG_WAIT_MAX=240 WAITING_RUNS="$WR_LEG_FRESH" run tick)"
check "a marker whose leg is still fresh (under the threshold) is kept (#376 item 1)" \
  '[ "$(jq length "$COMMENTS_DIR/Acme_beta_issues_5.json")" -eq 1 ] && grep -q "Acme/beta 5 60" "$FLEET_QUEUE_MARKS"'
drop_slots

reset
marker beta 5 60 box-07 10
printf '%s Acme/beta 5 60\n' "$(date +%s)" >"$FLEET_QUEUE_MARKS"
hold_slots
out="$(FLEET_QUEUE_LEG_WAIT_MAX=240 WAITING_FAIL=1 run tick)"
check "a marker whose leg cannot be read is kept — the TTL sweep stays the backstop (fail-open, #376 item 1)" \
  '[ "$(jq length "$COMMENTS_DIR/Acme_beta_issues_5.json")" -eq 1 ] && grep -q "Acme/beta 5 60" "$FLEET_QUEUE_MARKS"'
drop_slots

reset
marker beta 5 60 box-07 10
printf '%s Acme/beta 5 60\n' "$(date +%s)" >"$FLEET_QUEUE_MARKS"
hold_slots
out="$(FLEET_QUEUE_LEG_WAIT_MAX=0 WAITING_RUNS="$WR_LEG" run tick)"
check "early release disabled (LEG_WAIT_MAX=0) keeps the marker (pre-#376)" \
  '[ "$(jq length "$COMMENTS_DIR/Acme_beta_issues_5.json")" -eq 1 ]'
drop_slots

summary fleet-queue-test
