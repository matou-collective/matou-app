#!/usr/bin/env bash
# Offline test for fleet-queue-lib.sh — the fleet-wide ticket order (#301).
# Drives the real functions over fake checkouts (each with a fake lister and a
# fake identity layer), a shimmed curl, and tmp-pinned host state. No network,
# no docker. Run: bash tests/fleet-queue-lib-test.sh
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"
sc="$here/.."

tmp="$(tmpdir)"
# Pin EVERY host-global path at tmp before sourcing: a real drive reservation
# or slot lock can be live on the host running this suite (the #664 lesson).
export HOST_CAPACITY_STATE_DIR="$tmp/state"
export HOST_CAPACITY_SLOTS="$tmp/state/slot-1.lock $tmp/state/slot-2.lock"
export HOST_CAPACITY_DRIVE_WANTED="$tmp/state/drive-wanted"
export FLEET_QUEUE_CACHE="$tmp/state/fleet-queue.json"
export FLEET_QUEUE_STAMP="$tmp/state/fleet-queue-dispatched"
export FLEET_QUEUE_RECENT_CLOSES="$tmp/state/fleet-recent-closes"
export FORGEJO_TOKEN=t
mkdir -p "$tmp/state"
. "$sc/fleet-queue-lib.sh"

# ── fake checkouts: a consumer (vendored under .sandcastle/) and the self-
# hosting root layout; each lister emits what the real one would, plus the
# fields #301 added (created_at, priority, blocker).
mk_checkout() { # <dir> <layout: vendored|root> <lister-body>
  local d="$1" base
  case "$2" in vendored) base="$d/.sandcastle" ;; *) base="$d" ;; esac
  mkdir -p "$base"
  printf ': "${FORGEJO_API:=https://forge.test/api/v1/repos/%s}"\n' "$3" >"$base/swarm-identity.sh"
  cat >"$base/list-ready-tasks.sh"
}
mk_checkout "$tmp/alpha" vendored Acme/alpha <<'SH'
#!/usr/bin/env bash
touch "${LISTER_RAN:-/dev/null}"
cat <<'JSON'
[{"number":10,"title":"alpha old","body":"","url":"u","created_at":"2026-10-01T00:00:00Z","priority":false,"blocker":false},
 {"number":12,"title":"alpha new","body":"","url":"u","created_at":"2026-10-20T00:00:00Z","priority":false,"blocker":false},
 {"number":11,"title":"alpha prio","body":"","url":"u","created_at":"2026-10-21T00:00:00Z","priority":true,"blocker":false}]
JSON
SH
mk_checkout "$tmp/beta" root Acme/beta <<'SH'
#!/usr/bin/env bash
cat <<'JSON'
[{"number":5,"title":"beta older","body":"","url":"u","created_at":"2026-09-01T00:00:00Z","priority":false,"blocker":false},
 {"number":6,"title":"beta blocker","body":"","url":"u","created_at":"2026-10-22T00:00:00Z","priority":false,"blocker":true}]
JSON
SH
mk_checkout "$tmp/gamma" vendored Acme/gamma <<'SH'
#!/usr/bin/env bash
echo "gamma: GET /issues failed after 3 attempts (last http=503)" >&2
exit 22
SH
mk_checkout "$tmp/delta" vendored Acme/delta <<'SH'
#!/usr/bin/env bash
# an OLDER pin's lister: no created_at / priority / blocker fields at all
printf '[{"number":3,"title":"delta no-date","body":"","url":"u"}]'
SH

# ── api root from the checkout's OWN identity, never this shell's ───────────
export FORGEJO_API="https://other.test/api/v1/repos/Some/thing"
check "api_root reads the vendored identity layer" \
  '[ "$(fleet_queue_api_root "$tmp/alpha")" = "https://forge.test/api/v1" ]'
check "api_root reads the root-layout identity layer" \
  '[ "$(fleet_queue_api_root "$tmp/beta")" = "https://forge.test/api/v1" ]'
check "api_root fails on a checkout with no identity layer" \
  '! fleet_queue_api_root "$tmp/nowhere" >/dev/null 2>&1'
unset FORGEJO_API

# ── collect: every repo's OWN lister, merged, tagged, fail-open per repo ─────
err="$tmp/collect.err"
merged="$(fleet_queue_collect "$tmp/alpha:Acme/alpha" "$tmp/beta:Acme/beta" "$tmp/gamma:Acme/gamma" "$tmp/delta:Acme/delta" "$tmp/none:Acme/none" 2>"$err")"
check "collect merges every repo that answered" \
  '[ "$(jq length <<<"$merged")" -eq 6 ]'
check "collect tags each ticket with its repo slug" \
  '[ "$(jq -r "map(select(.number == 5)) | .[0].repo" <<<"$merged")" = "Acme/beta" ]'
check "collect ranks priority and drive-blocker tickets 0, the rest 1" \
  '[ "$(jq -c "map(select(.number == 11 or .number == 6)) | map(.rank)" <<<"$merged")" = "[0,0]" ] && [ "$(jq -r "map(select(.number == 10)) | .[0].rank" <<<"$merged")" = "1" ]'
check "collect omits a repo whose lister failed, naming it and its last stderr line" \
  'grep -q "Acme/gamma lister failed (rc=22)" "$err" && grep -q "http=503" "$err" && ! jq -e "any(.[]; .repo == \"Acme/gamma\")" <<<"$merged" >/dev/null'
check "collect omits a checkout with no lister, naming it" \
  'grep -q "Acme/none carries no list-ready-tasks.sh" "$err"'
check "collect runs a lister from its own checkout as cwd with its slug" \
  'LISTER_RAN="$tmp/ran" fleet_queue_collect "$tmp/alpha:Acme/alpha" >/dev/null 2>&1 && [ -f "$tmp/ran" ]'

# ── order: rank, then filing date, then number; no created_at sorts last ────
ordered="$(fleet_queue_order "$merged")"
check "order puts priority/blocker tickets first, oldest of those first" \
  '[ "$(jq -c "map(\"\(.repo)#\(.number)\") | .[0:2]" <<<"$ordered")" = "[\"Acme/alpha#11\",\"Acme/beta#6\"]" ]'
check "order then runs oldest-first across repos" \
  '[ "$(jq -c "map(\"\(.repo)#\(.number)\") | .[2:5]" <<<"$ordered")" = "[\"Acme/beta#5\",\"Acme/alpha#10\",\"Acme/alpha#12\"]" ]'
check "order sorts a ticket with no created_at LAST within its rank (older pin)" \
  '[ "$(jq -r ".[-1] | \"\(.repo)#\(.number)\"" <<<"$ordered")" = "Acme/delta#3" ]'
same="$(fleet_queue_order '[{"repo":"r","number":9,"rank":1,"created_at":"2026-01-01T00:00:00Z"},{"repo":"r","number":4,"rank":1,"created_at":"2026-01-01T00:00:00Z"}]')"
check "order breaks a created_at tie on the number" \
  '[ "$(jq -c "map(.number)" <<<"$same")" = "[4,9]" ]'

# ── dependants: the `blocks` read, open only, cross-repo ───────────────────
shim curl <<'SH'
url=""; method=GET; data=""
while [ $# -gt 0 ]; do
  case "$1" in -X) method="$2"; shift 2 ;; -H|-d|--max-time|-o|-w) [ "$1" = -d ] && data="$2"; shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac
done
[ "$data" = "@-" ] && data="$(cat)"
printf '%s %s %s\n' "$method" "$url" "$data" >>"${CURL_LOG:?}"
case "$url" in
  */issues/10/blocks*) printf '[{"number":12,"state":"open","repository":{"full_name":"Acme/alpha"}},{"number":5,"state":"open","repository":{"full_name":"Acme/beta"}},{"number":99,"state":"closed","repository":{"full_name":"Acme/beta"}}]' ;;
  */issues/77/blocks*) exit 22 ;;
  */dispatches) [ -n "${DISPATCH_FAIL:-}" ] && { printf '500'; exit 0; }; printf '204' ;;
  *) printf '[]' ;;
esac
SH
export CURL_LOG="$tmp/curl.log"; : >"$CURL_LOG"
deps="$(fleet_queue_dependants https://forge.test/api/v1 Acme/alpha 10 2>/dev/null)"
check "dependants lists the OPEN issues the ticket blocks, in any repo" \
  '[ "$(jq -c "map(\"\(.repo)#\(.number)\")" <<<"$deps")" = "[\"Acme/alpha#12\",\"Acme/beta#5\"]" ]'
check "dependants hits the blocks endpoint of the ticket's own repo" \
  'grep -q "GET https://forge.test/api/v1/repos/Acme/alpha/issues/10/blocks" "$CURL_LOG"'
none="$(fleet_queue_dependants https://forge.test/api/v1 Acme/alpha 77 2>"$tmp/dep.err")"
check "dependants answers [] with a line on a failed read (never a wrong promotion)" \
  '[ "$none" = "[]" ] && grep -q "could not read what Acme/alpha#77 blocks" "$tmp/dep.err"'

# ── promote: dependants to the front, fleet order kept among them ───────────
promoted="$(fleet_queue_promote "$ordered" "$deps")"
check "promote moves the dependants to the front in their fleet order" \
  '[ "$(jq -c "map(\"\(.repo)#\(.number)\") | .[0:2]" <<<"$promoted")" = "[\"Acme/beta#5\",\"Acme/alpha#12\"]" ]'
check "promote keeps everything else behind them, unchanged" \
  '[ "$(jq -c "map(\"\(.repo)#\(.number)\") | .[2:]" <<<"$promoted")" = "[\"Acme/alpha#11\",\"Acme/beta#6\",\"Acme/alpha#10\",\"Acme/delta#3\"]" ]'
check "promote with no dependants is the identity" \
  '[ "$(fleet_queue_promote "$ordered" "[]")" = "$ordered" ]'

# ── recent closes: recorded, pruned by age, de-duplicated, newest first ─────
fleet_queue_recent_close_record Acme/alpha 10
printf '%s Acme/beta 2\n' "$(( $(date +%s) - 5000 ))" >>"$FLEET_QUEUE_RECENT_CLOSES"
fleet_queue_recent_close_record Acme/alpha 10
check "recent_closes lists a fresh close once and drops one past the TTL" \
  '[ "$(fleet_queue_recent_closes)" = "Acme/alpha 10" ]'
check "recent_closes rewrites the file pruned" \
  '[ "$(grep -c . "$FLEET_QUEUE_RECENT_CLOSES")" -eq 2 ] && ! grep -q "Acme/beta 2" "$FLEET_QUEUE_RECENT_CLOSES"'
rm -f "$FLEET_QUEUE_RECENT_CLOSES"
check "recent_closes with no file is quiet and rc 0" \
  '[ -z "$(fleet_queue_recent_closes)" ] && fleet_queue_recent_closes'

# ── cache: the head, only while fresh and non-empty ─────────────────────────
fleet_queue_cache_write "$ordered"
check "cache_head names the fleet head from a fresh cache" \
  '[ "$(fleet_queue_cache_head)" = "Acme/alpha 11" ]'
check "cache_head refuses a stale cache" \
  '! fleet_queue_cache_head 0 >/dev/null'
fleet_queue_cache_write '[]'
check "cache_head refuses an empty cache" \
  '! fleet_queue_cache_head >/dev/null'
rm -f "$FLEET_QUEUE_CACHE"
check "cache_head refuses an absent cache" \
  '! fleet_queue_cache_head >/dev/null'

# ── stamp: the last dispatch, fresh inside the window ───────────────────────
check "stamp_fresh is false with no stamp" '! fleet_queue_stamp_fresh >/dev/null'
fleet_queue_stamp_write Acme/beta 5
check "stamp_fresh names the pick and its age inside the window" \
  '[ "$(fleet_queue_stamp_fresh | cut -d" " -f1,2)" = "Acme/beta 5" ]'
check "stamp_fresh is false once the window has passed" \
  '! fleet_queue_stamp_fresh 0 >/dev/null'

# ── slot_free: probe-and-release; a held slot and a fresh drive are busy ─────
check "slot_free with both slots unheld" 'fleet_queue_slot_free'
( exec 7>"$tmp/state/slot-1.lock"; flock 7; sleep 30 ) & h1=$!
( exec 7>"$tmp/state/slot-2.lock"; flock 7; sleep 30 ) & h2=$!
sleep 0.3
check "slot_free is false while every pooled slot is held" '! fleet_queue_slot_free'
kill "$h1" 2>/dev/null; wait "$h1" 2>/dev/null; sleep 0.2
check "slot_free is true once one slot frees" 'fleet_queue_slot_free'
kill "$h2" 2>/dev/null; wait "$h2" 2>/dev/null
touch "$HOST_CAPACITY_DRIVE_WANTED"
check "slot_free is false under a fresh rehearsal-drive reservation" '! fleet_queue_slot_free'
rm -f "$HOST_CAPACITY_DRIVE_WANTED"
check "slot_free leaves no lock held behind it (a second probe still succeeds)" \
  'fleet_queue_slot_free && fleet_queue_slot_free'

# ── dispatch: ONE repo's swarm.yml with inputs.ticket + inputs.host ─────────
: >"$CURL_LOG"
code="$(fleet_queue_dispatch https://forge.test/api/v1 Acme/beta 5 box-07)"
check "dispatch posts to the pick's OWN repo workflow and returns the code" \
  '[ "$code" = 204 ] && grep -q "POST https://forge.test/api/v1/repos/Acme/beta/actions/workflows/swarm.yml/dispatches" "$CURL_LOG"'
check "dispatch body carries ref main, inputs.ticket and inputs.host" \
  'body="$(grep dispatches "$CURL_LOG" | cut -d" " -f3-)" && [ "$(jq -r .ref <<<"$body")" = main ] && [ "$(jq -r .inputs.ticket <<<"$body")" = 5 ] && [ "$(jq -r .inputs.host <<<"$body")" = box-07 ]'
check "dispatch rc is non-zero on a non-2xx" \
  '! DISPATCH_FAIL=1 fleet_queue_dispatch https://forge.test/api/v1 Acme/beta 5 box-07 >/dev/null'

summary fleet-queue-lib-test
