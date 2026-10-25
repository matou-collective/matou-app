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
export FORGEJO_TOKEN=t HOST_NAME=box-07 CURL_LOG="$tmp/curl.log" LISTER_LOG="$tmp/listers.log"
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
case "$url" in
  */repos/Acme/alpha/issues/10/blocks*) printf '[{"number":5,"state":"open","repository":{"full_name":"Acme/beta"}}]' ;;
  */blocks*) printf '[]' ;;
  */dispatches) printf '204' ;;
  *) printf '[]' ;;
esac
SH

reset() { : >"$CURL_LOG"; : >"$LISTER_LOG"; rm -f "$FLEET_QUEUE_STAMP" "$FLEET_QUEUE_CACHE" "$FLEET_QUEUE_RECENT_CLOSES" "$HOST_CAPACITY_DRIVE_WANTED"; }
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
  'grep -q "repos/Acme/prio/actions" "$CURL_LOG" && [ "$(jq -r .inputs.ticket <<<"$(dispatch_body)")" = 1 ]'

# ── after-close: dependants first, no slot gate, the close is recorded ──────
reset
( exec 7>"$tmp/state/slot-1.lock"; flock 7; sleep 30 ) & h1=$!
( exec 7>"$tmp/state/slot-2.lock"; flock 7; sleep 30 ) & h2=$!
sleep 0.3
out="$(run after-close Acme/alpha 10)"
check "after-close reads what the closed ticket blocks" \
  'grep -q "GET https://forge.test/api/v1/repos/Acme/alpha/issues/10/blocks" "$CURL_LOG"'
check "after-close dispatches the DEPENDANT (beta#5) ahead of the older alpha#10, slots held or not" \
  '[ "$(dispatched)" -eq 1 ] && grep -q "repos/Acme/beta/actions" "$CURL_LOG" && [ "$(jq -r .inputs.ticket <<<"$(dispatch_body)")" = 5 ]'
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
  'grep -q "repos/Acme/beta/actions" "$CURL_LOG" && grep -q "dependant of Acme/alpha#10" <<<"$out"'

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
shim curl <<'SH'
printf '%s\n' "$*" >>"${CURL_LOG:?}"
case "$*" in *dispatches*) cat >/dev/null; printf '500' ;; *) printf '[]' ;; esac
SH
out="$(run tick)"
check "a non-2xx dispatch is named with its code and leaves no stamp" \
  'grep -q "FAILED (http=500)" <<<"$out" && [ ! -f "$FLEET_QUEUE_STAMP" ]'

# ── usage ──────────────────────────────────────────────────────────────────
check "an unknown mode is a usage error (2)" '! run bogus >/dev/null; [ "$(run bogus >/dev/null 2>&1; echo $?)" -eq 2 ]'
check "after-close without its args is a usage error (2)" '[ "$(run after-close >/dev/null 2>&1; echo $?)" -eq 2 ]'

summary fleet-queue-test
