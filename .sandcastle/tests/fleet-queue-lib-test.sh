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
export FLEET_QUEUE_MARKS="$tmp/state/fleet-queue-marks"
export COMMENTS_DIR="$tmp/comments"
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
      */issues/10/blocks*) printf '[{"number":12,"state":"open","repository":{"full_name":"Acme/alpha"}},{"number":5,"state":"open","repository":{"full_name":"Acme/beta"}},{"number":99,"state":"closed","repository":{"full_name":"Acme/beta"}}]' ;;
      */issues/77/blocks*) exit 22 ;;
      */dispatches) [ -n "${DISPATCH_FAIL:-}" ] && { printf '500'; exit 0; }; printf '204' ;;
      *) printf '[]' ;;
    esac ;;
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

# ── disk headroom: a host with no room for the act cache is NOT free (#315) ──
# df is the one external probe; shim it behind a KB-available fixture so a full
# or roomy disk is a value, not a real filesystem.
shim df <<'SH'
echo "Filesystem 1024-blocks Used Available Capacity Mounted"
echo "/dev/fake 999999999 0 ${FAKE_DF_AVAIL_KB:-999999999} 1% /"
SH
export FLEET_QUEUE_ACT_CACHE="$tmp/state"   # exists: no ancestor walk
check "free_gb reports whole GiB from df's available KB" \
  '[ "$(FAKE_DF_AVAIL_KB=$((7 * 1024 * 1024)) fleet_queue_free_gb "$tmp/state")" -eq 7 ]'
check "free_gb walks up to an existing ancestor for a cache dir not yet created" \
  '[ "$(FAKE_DF_AVAIL_KB=$((3 * 1024 * 1024)) fleet_queue_free_gb "$tmp/state/nope/act")" -eq 3 ]'
check "slot_free with the floor off (0) never consults the disk" \
  'FLEET_QUEUE_MIN_FREE_GB=0 FAKE_DF_AVAIL_KB=1 fleet_queue_slot_free'
check "slot_free is FALSE when free GiB is under the declared floor" \
  '! FLEET_QUEUE_MIN_FREE_GB=5 FAKE_DF_AVAIL_KB=$((2 * 1024 * 1024)) fleet_queue_slot_free 2>/dev/null'
check "slot_free names the shortfall on its stderr line" \
  'FLEET_QUEUE_MIN_FREE_GB=5 FAKE_DF_AVAIL_KB=$((2 * 1024 * 1024)) fleet_queue_slot_free 2>"$tmp/df.err"; grep -q "2G free" "$tmp/df.err" && grep -q "5G floor" "$tmp/df.err"'
check "slot_free is TRUE when free GiB clears the floor" \
  'FLEET_QUEUE_MIN_FREE_GB=5 FAKE_DF_AVAIL_KB=$((9 * 1024 * 1024)) fleet_queue_slot_free'
check "slot_free admits the host when the df probe returns nothing (fail-open, no blinding on a blip)" \
  'fleet_queue_free_gb() { return 1; }; FLEET_QUEUE_MIN_FREE_GB=5 fleet_queue_slot_free; rc=$?; unset -f fleet_queue_free_gb; [ "$rc" -eq 0 ]'
unset FLEET_QUEUE_ACT_CACHE

# ── stamp_ticket: the last dispatch regardless of age (#315) ────────────────
rm -f "$FLEET_QUEUE_STAMP"
check "stamp_ticket is rc 1 with no stamp" '! fleet_queue_stamp_ticket >/dev/null'
fleet_queue_stamp_write Acme/beta 5
check "stamp_ticket names the last dispatch slug and number" \
  '[ "$(fleet_queue_stamp_ticket)" = "Acme/beta 5" ]'
printf '%s Acme/beta 5\n' "$(( $(date +%s) - 99999 ))" >"$FLEET_QUEUE_STAMP"
check "stamp_ticket reports a stale stamp too (freshness-independent)" \
  '[ "$(fleet_queue_stamp_ticket)" = "Acme/beta 5" ]'

# ── strikes + stand-down: back off a host whose dispatches never claim (#315) ─
export FLEET_QUEUE_STRIKES="$tmp/state/fleet-queue-strikes"
export FLEET_QUEUE_STRIKES_MAX=3 FLEET_QUEUE_BACKOFF_BASE=600 FLEET_QUEUE_BACKOFF_MAX=7200
rm -f "$FLEET_QUEUE_STRIKES"
check "strikes is 0 with no file" '[ "$(fleet_queue_strikes)" -eq 0 ]'
check "strike_bump counts up and persists" \
  '[ "$(fleet_queue_strike_bump)" -eq 1 ] && [ "$(fleet_queue_strike_bump)" -eq 2 ] && [ "$(fleet_queue_strikes)" -eq 2 ]'
check "standdown is rc 1 below the threshold" '! fleet_queue_standdown >/dev/null'
check "the third strike reaches the threshold" '[ "$(fleet_queue_strike_bump)" -eq 3 ]'
check "standdown is rc 0 at the threshold, naming the strikes and a remaining backoff" \
  'out="$(fleet_queue_standdown)" && [ "$(cut -d" " -f1 <<<"$out")" -eq 3 ] && [ "$(cut -d" " -f2 <<<"$out")" -gt 0 ]'
check "standdown's first backoff is the base window" \
  '[ "$(fleet_queue_standdown | cut -d" " -f2)" -le 600 ]'
# A strike past the threshold doubles the backoff; a far-past last-strike time
# lets the window elapse so a probe is due.
printf '4 %s\n' "$(( $(date +%s) - 10 ))" >"$FLEET_QUEUE_STRIKES"
check "standdown doubles the backoff for a strike past the threshold" \
  '[ "$(fleet_queue_standdown | cut -d" " -f2)" -gt 600 ]'
printf '3 %s\n' "$(( $(date +%s) - 1000 ))" >"$FLEET_QUEUE_STRIKES"
check "standdown is rc 1 once the backoff has elapsed (a probe is due)" \
  '! fleet_queue_standdown >/dev/null'
printf '50 %s\n' "$(( $(date +%s) - 10 ))" >"$FLEET_QUEUE_STRIKES"
check "standdown caps the backoff at the max" \
  '[ "$(fleet_queue_standdown | cut -d" " -f2)" -le 7200 ]'
fleet_queue_strike_reset
check "strike_reset clears the counter" \
  '[ "$(fleet_queue_strikes)" -eq 0 ] && ! fleet_queue_standdown >/dev/null'
unset FLEET_QUEUE_STRIKES_MAX FLEET_QUEUE_BACKOFF_BASE FLEET_QUEUE_BACKOFF_MAX FLEET_QUEUE_STRIKES

# ── dispatch arbitration (#351): one ticket goes to ONE host ────────────────
# Every idle host's tick fires in the same cron minute and saw the same fleet
# head, so each dispatched it to itself. The marker is a comment on the ticket
# (`fleet-dispatch host=<h>`), arbitrated by the forge's strictly increasing
# comment ids exactly as the claim is: the LOWEST live marker's host dispatches.
R=https://forge.test/api/v1
cstore() { printf '%s/Acme_%s_issues_%s.json' "$COMMENTS_DIR" "$1" "$2"; }
seed() { # <repo> <n> <id> <body> <age-seconds>
  local f; f="$(cstore "$1" "$2")"; mkdir -p "$COMMENTS_DIR"; [ -f "$f" ] || echo '[]' >"$f"
  jq -c --argjson id "$3" --arg b "$4" --arg t "$(date -u -d "@$(( $(date +%s) - $5 ))" +%Y-%m-%dT%H:%M:%SZ)" \
    '. + [{id: $id, body: $b, created_at: $t}]' "$f" >"$f.tmp" && mv "$f.tmp" "$f"
}
arb_reset() { rm -rf "$COMMENTS_DIR"; rm -f "$FLEET_QUEUE_MARKS"; : >"$CURL_LOG"; }
posts() { local n; n="$(grep -c "^POST .*/comments" "$CURL_LOG")" || true; echo "${n:-0}"; }

arb_reset
seed alpha 10 7 "a human said something" 10
seed alpha 10 8 "swarm-claim host=box-02 run=44" 10
check "marks ignores ordinary comments and swarm-claims (no marker, rc 0, empty)" \
  'out="$(fleet_queue_marks $R Acme/alpha 10)" && [ -z "$out" ]'
seed alpha 10 9 "fleet-dispatch host=box-02
(automated)" 30
seed alpha 10 12 "fleet-dispatch host=box-07" 5
check "marks lists live markers as 'id host', lowest id first" \
  '[ "$(fleet_queue_marks $R Acme/alpha 10 | tr "\n" ",")" = "9 box-02,12 box-07," ]'
seed alpha 10 6 "fleet-dispatch host=box-99" 99999
check "marks drops a marker older than the TTL (a dead dispatch must not hold a ticket)" \
  '! fleet_queue_marks $R Acme/alpha 10 | grep -q box-99'
check "marks is rc 1 on a failed comments read (never an empty 'nobody holds it')" \
  '! COMMENTS_GET_FAIL=1 fleet_queue_marks $R Acme/alpha 10 >/dev/null 2>&1'

arb_reset
check "arbitrate on an unmarked ticket posts ONE marker and wins" \
  'fleet_queue_arbitrate $R Acme/alpha 10 box-07 && [ "$(posts)" -eq 1 ] && [ "$(fleet_queue_marks $R Acme/alpha 10 | cut -d" " -f2)" = box-07 ]'
check "arbitrate exposes the marker it holds and records it on the host for the sweep" \
  '[ -n "$FLEET_QUEUE_ARB_MARK" ] && grep -q " Acme/alpha 10 $FLEET_QUEUE_ARB_MARK\$" "$FLEET_QUEUE_MARKS"'
check "the marker says which host and that it is automated" \
  'jq -r ".[0].body" "$(cstore alpha 10)" | head -1 | grep -qx "fleet-dispatch host=box-07" && jq -r ".[0].body" "$(cstore alpha 10)" | grep -qi "automated"'
: >"$CURL_LOG"
check "arbitrate again by the SAME host reuses its live marker (no second comment)" \
  'fleet_queue_arbitrate $R Acme/alpha 10 box-07 && [ "$(posts)" -eq 0 ]'
: >"$CURL_LOG"
check "arbitrate by ANOTHER host loses without posting anything, naming the holder" \
  '! fleet_queue_arbitrate $R Acme/alpha 10 box-02 && [ "$FLEET_QUEUE_ARB_HOLDER" = box-07 ] && [ "$(posts)" -eq 0 ]'

arb_reset
RACE_FIRST=box-02 fleet_queue_arbitrate $R Acme/alpha 10 box-07; rc=$?
check "two ticks in the same second: the LOWER comment id wins, this host loses" \
  '[ "$rc" -eq 1 ] && [ "$FLEET_QUEUE_ARB_HOLDER" = box-02 ]'
check "the loser deletes its own marker so the ticket carries only the winner's" \
  '[ "$(fleet_queue_marks $R Acme/alpha 10 | tr "\n" ",")" = "101 box-02," ]'
arb_reset
RACE_AFTER=box-02 fleet_queue_arbitrate $R Acme/alpha 10 box-07; rc=$?
check "two ticks in the same second: this host's lower id wins" \
  '[ "$rc" -eq 0 ] && [ "$(fleet_queue_marks $R Acme/alpha 10 | head -1)" = "101 box-07" ]'

arb_reset
seed alpha 10 50 "fleet-dispatch host=box-02" 99999
check "an EXPIRED foreign marker holds nothing: this host posts and wins" \
  'fleet_queue_arbitrate $R Acme/alpha 10 box-07 && [ "$(posts)" -eq 1 ]'

# Fail OPEN: a tracker blip must never stall the fleet — the dispatch goes out
# as it did before #351 and the in-sandbox claim still guards the ticket.
arb_reset
check "arbitrate fails OPEN (rc 0, a stderr line, no marker) when the comments read fails" \
  'COMMENTS_GET_FAIL=1 fleet_queue_arbitrate $R Acme/alpha 10 box-07 2>"$tmp/arb.err" && [ -z "$FLEET_QUEUE_ARB_MARK" ] && grep -q "could not read .*Acme/alpha#10.*unarbitrated" "$tmp/arb.err"'
check "arbitrate fails OPEN when the marker post fails" \
  'COMMENTS_POST_FAIL=1 fleet_queue_arbitrate $R Acme/alpha 10 box-07 2>"$tmp/arb.err" && [ -z "$FLEET_QUEUE_ARB_MARK" ] && grep -q "unarbitrated" "$tmp/arb.err"'

# The sweep: a marker is litter once it has expired; the host that posted it
# removes it (and only it — never a peer's, never a live one).
arb_reset
fleet_queue_arbitrate $R Acme/alpha 10 box-07
fleet_queue_marks_sweep $R
check "sweep leaves a LIVE marker alone" \
  '[ -n "$(fleet_queue_marks $R Acme/alpha 10)" ] && [ -s "$FLEET_QUEUE_MARKS" ]'
seed beta 5 60 "fleet-dispatch host=box-07" 99999
printf '%s Acme/beta 5 60\n' "$(( $(date +%s) - 99999 ))" >>"$FLEET_QUEUE_MARKS"
fleet_queue_marks_sweep $R
check "sweep deletes this host's EXPIRED marker from the ticket and forgets it" \
  '[ "$(jq length "$(cstore beta 5)")" -eq 0 ] && ! grep -q "Acme/beta 5 60" "$FLEET_QUEUE_MARKS" && grep -q "Acme/alpha 10" "$FLEET_QUEUE_MARKS"'
printf '%s Acme/beta 5 61\n' "$(( $(date +%s) - 99999 ))" >>"$FLEET_QUEUE_MARKS"
fleet_queue_marks_sweep $R
check "sweep forgets a marker the forge no longer has (404 — the loser already deleted it)" \
  '! grep -q "Acme/beta 5 61" "$FLEET_QUEUE_MARKS"'
printf '%s Acme/beta 5 62\n' "$(( $(date +%s) - 700 ))" >>"$FLEET_QUEUE_MARKS"
COMMENTS_DELETE_FAIL=1 fleet_queue_marks_sweep $R
check "sweep KEEPS the record when the delete fails, so the next tick retries" \
  'grep -q "Acme/beta 5 62" "$FLEET_QUEUE_MARKS"'
arb_reset
check "sweep with no record is quiet, rc 0, and reads nothing" \
  'fleet_queue_marks_sweep $R && [ ! -s "$CURL_LOG" ]'
fleet_queue_arbitrate $R Acme/alpha 10 box-07; mark="$FLEET_QUEUE_ARB_MARK"
fleet_queue_mark_release $R "$mark"
check "mark_release deletes a marker at once (a dispatch that failed frees the ticket)" \
  '[ -z "$(fleet_queue_marks $R Acme/alpha 10)" ]'

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
