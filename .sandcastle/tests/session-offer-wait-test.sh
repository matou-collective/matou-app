#!/usr/bin/env bash
# Offline test for session-offer-wait.sh — a pool host's offer poll for the fleet
# dispatcher's session lane (ADR 0010 / #387). It is also the BOTH-ENDS contract
# for the offer and the decline: the body the poll receives is produced by the
# dispatcher's own code (fleet_session_offer writes the outbox; the receiver's
# --offers seam serves it), and the decline this script posts is fed verbatim to
# the dispatcher's own fleet_session_decline_ingest — no second parser on either
# side. A shimmed curl stands in for the socket; a fake launcher stands in for
# the host's generated session launcher. No network.
# Run: bash tests/session-offer-wait-test.sh
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"
sc="$here/.."

if ! command -v python3 >/dev/null 2>&1; then
  echo "session-offer-wait-test: SKIPPED — no python3 on PATH."
  exit 0
fi

tmp="$(tmpdir)"
export FLEET_DISPATCH_HOME="$tmp/dispatch"
export FLEET_DISPATCH_REPORTS="$tmp/dispatch/reports"
export FLEET_DISPATCH_SESSION_OUTBOX="$tmp/dispatch/session-offers"
export FLEET_DISPATCH_SESSION_WAITERS="$tmp/dispatch/session-waiters"
mkdir -p "$FLEET_DISPATCH_REPORTS"
# shellcheck source=../fleet-session-lib.sh
. "$sc/fleet-session-lib.sh"

export CURL_LOG="$tmp/curl.log" POSTED="$tmp/posted" RUN_LOG="$tmp/run.log"
export RECEIVER="$sc/fleet-dispatch-receiver.py"
: >"$CURL_LOG"; : >"$RUN_LOG"

# The socket, shimmed: a GET (the poll) is answered by the receiver's own
# --offers seam for the host the poll names; a POST (a decline) has its body
# saved for the dispatcher's own ingest to read. CURL_FAIL=1 = dispatcher down.
shim curl <<'SH'
printf '%s\n' "$*" >>"${CURL_LOG:?}"
[ -z "${CURL_FAIL:-}" ] || exit 7
host=""; post=0; prev=""
for a in "$@"; do
  case "$a" in host=*) host="${a#host=}" ;; esac
  [ "$prev" = "-X" ] && [ "$a" = POST ] && post=1
  prev="$a"
done
if [ "$post" = 1 ]; then cat >"${POSTED:?}"; exit 0; fi
if [ -n "${OFFERS_BODY:-}" ]; then printf '%s' "$OFFERS_BODY"; exit 0; fi
python3 "${RECEIVER:?}" --offers --host "$host"
SH

# The host's generated launcher, faked: `run <repo> <n> <decline-file>`. It logs
# the call; LAUNCH_DECLINE (a decline line) makes the "session-runner" refuse;
# a repo named in LAUNCH_UNENROLLED is one this host has no runner for (rc 3).
cat >"$tmp/launcher" <<'SH'
#!/usr/bin/env bash
[ "$1" = run ] || exit 2
printf '%s %s\n' "$2" "$3" >>"${RUN_LOG:?}"
[ "${LAUNCH_UNENROLLED:-}" = "$2" ] && exit 3
[ -z "${LAUNCH_DECLINE:-}" ] || printf '%s\n' "$LAUNCH_DECLINE" >"$4"
exit 0
SH
chmod +x "$tmp/launcher"

waiter() { # env… — one foreground poll as host boxA
  env FLEET_DISPATCHER_URL="http://dispatcher.mesh:8790/report" SESSION_OFFER_RUN="$tmp/launcher" \
      SESSION_OFFER_HOST=boxA SESSION_OFFER_STATE="$tmp/state" "$@" bash "$sc/session-offer-wait.sh" once 2>&1
}
runs() { wc -l <"$RUN_LOG" | tr -d ' '; }

# ── no dispatcher declared: nothing to do, quietly ───────────────────────────
out="$(env -u FLEET_DISPATCHER_URL -u FLEET_DISPATCHER_OFFERS_URL SESSION_OFFER_RUN="$tmp/launcher" bash "$sc/session-offer-wait.sh" once 2>&1)"
check "with no dispatcher declared the waiter exits 0 and polls nothing" \
  '[ "$?" -eq 0 ] && grep -q "no dispatcher declared" <<<"$out" && [ ! -s "$CURL_LOG" ]'

# ── the poll: the right endpoint, as this host ───────────────────────────────
out="$(waiter)"
check "the poll goes to /session-offers on the dispatcher's own address" 'grep -q "http://dispatcher.mesh:8790/session-offers" "$CURL_LOG"'
check "the poll names this host"                                          'grep -q "host=boxA" "$CURL_LOG"'
check "an empty poll starts nothing"                                      '[ "$(runs)" = 0 ]'
check "the poll stamped this host's waiter on the dispatcher side"        'fleet_session_waiter_fresh boxA'

# ── an offer the dispatcher wrote is started by the host's launcher ──────────
fleet_session_offer Acme/alpha boxA 42 "a ticket" >/dev/null
out="$(waiter)"
check "an offered ticket starts the launcher with repo + number"          '[ "$(cat "$RUN_LOG")" = "Acme/alpha 42" ]'
check "an accepted offer posts nothing back"                              '[ ! -e "$POSTED" ] && grep -q "took the offer" <<<"$out"'
check "the offer was consumed (not started twice on the next poll)"       'waiter >/dev/null; [ "$(runs)" = 1 ]'

# ── an offer for another host is never started here ──────────────────────────
: >"$RUN_LOG"
fleet_session_offer Acme/alpha boxB 43 "other host" >/dev/null
waiter >/dev/null
check "a ticket offered to another host is not started here"              '[ "$(runs)" = 0 ]'

# ── a refusal becomes a decline the dispatcher's own ingest accepts ──────────
: >"$RUN_LOG"
fleet_session_offer Acme/alpha boxA 44 "to refuse" >/dev/null
out="$(waiter LAUNCH_DECLINE="ticket 1200 cooling down after an attempt on this host that did not advance it")"
check "a refused offer posts a decline"                                   '[ -s "$POSTED" ] && [ "$(jq -r .kind "$POSTED")" = session-decline ]'
check "the decline carries host, ticket, scope, hold and the runner's reason" \
  '[ "$(jq -r "[.host,.repo,(.number|tostring),.scope,(.retry_after|tostring)]|join(\" \")" "$POSTED")" = "boxA Acme/alpha 44 ticket 1200" ] && jq -e ".reason|test(\"cooling down\")" "$POSTED" >/dev/null'
check "the dispatcher's own ingest accepts that decline verbatim"         'fleet_session_decline_ingest "$(cat "$POSTED")" >/dev/null'
check "…and it now blocks that ticket on this host, and frees the offer"  \
  'b="$(fleet_session_blocks)"; jq -e "any(.[]; .host==\"boxA\" and .scope==\"ticket\" and .number==44)" <<<"$b" >/dev/null && ! jq -e "any(.[]; .host==\"*\" and .number==44)" <<<"$b" >/dev/null'
check "the decline file is cleaned up"                                    '[ -z "$(ls "$tmp/state" | grep decline)" ]'

# ── a host-scope refusal (limit park) and a repo with no runner here ─────────
unlink "$POSTED"
fleet_session_offer Acme/alpha boxA 45 t >/dev/null
waiter LAUNCH_DECLINE="host 900 this host is parked on the Claude usage limit" >/dev/null
check "a host-scope refusal is sent host-scoped"                          '[ "$(jq -r .scope "$POSTED")" = host ] && fleet_session_decline_ingest "$(cat "$POSTED")" >/dev/null'
unlink "$POSTED"
fleet_session_offer Acme/gamma boxA 7 t >/dev/null
out="$(waiter LAUNCH_UNENROLLED=Acme/gamma)"
check "a repo with no session-runner on this host is declined repo-wide"  \
  '[ "$(jq -r "[.scope,.repo]|join(\" \")" "$POSTED")" = "repo Acme/gamma" ] && fleet_session_decline_ingest "$(cat "$POSTED")" >/dev/null'
unlink "$POSTED"
fleet_session_offer Acme/alpha boxA 46 t >/dev/null
waiter LAUNCH_DECLINE="nonsense" >/dev/null
check "a malformed decline line still reaches the dispatcher as a valid ticket decline" \
  '[ "$(jq -r .scope "$POSTED")" = ticket ] && fleet_session_decline_ingest "$(cat "$POSTED")" >/dev/null'

# ── an offer is data from the network: a malformed one is never run ──────────
: >"$RUN_LOG"
bad='{"ok":true,"offers":[{"repo":"Acme/alpha; touch /tmp/x","number":1,"host":"boxA"},{"repo":"../../etc","number":2,"host":"boxA"},{"repo":"Acme/alpha","number":"9","host":"boxA"},{"repo":"Acme/alpha","number":-3,"host":"boxA"},{"repo":"Acme/alpha","number":50,"host":"boxA"}]}'
waiter OFFERS_BODY="$bad" >/dev/null
check "only the well-formed offer in a hostile list is started"           '[ "$(cat "$RUN_LOG")" = "Acme/alpha 50" ]'
: >"$RUN_LOG"
out="$(waiter OFFERS_BODY="not json")"
check "an answer that is not an offer list starts nothing (rc 1)"         '[ "$?" -ne 0 ] && [ "$(runs)" = 0 ]'
out="$(waiter CURL_FAIL=1)"
check "an unreachable dispatcher starts nothing (rc 1)"                   '[ "$?" -ne 0 ] && [ "$(runs)" = 0 ]'

# ── the loop: one waiter per host, the kill switch, the lifetime ─────────────
loop() { env FLEET_DISPATCHER_URL="http://dispatcher.mesh:8790/report" SESSION_OFFER_RUN="$tmp/launcher" \
           SESSION_OFFER_HOST=boxA SESSION_OFFER_STATE="$tmp/state" SESSION_OFFER_WAIT=0 SESSION_OFFER_BACKOFF=0 \
           "$@" bash "$sc/session-offer-wait.sh" loop 2>&1; }
: >"$tmp/ks"
out="$(loop SESSION_OFFER_KILLSWITCH="$tmp/ks" SESSION_OFFER_LIFETIME=30)"
check "the host kill switch stops the loop before it polls"               'grep -q "kill switch is on" <<<"$out"'
unlink "$tmp/ks"
out="$(loop SESSION_OFFER_LIFETIME=0)"
check "a waiter past its lifetime exits 0 for cron to restart"            '[ "$?" -eq 0 ] && grep -q "lifetime reached" <<<"$out"'
exec 7>"$tmp/state/wait.lock"; flock -n 7
out="$(loop SESSION_OFFER_LIFETIME=30)"
check "a second waiter exits at once while one holds the host's lock"     '[ "$?" -eq 0 ] && [ -z "$out" ]'
exec 7>&-
: >"$RUN_LOG"
fleet_session_offer Acme/alpha boxA 60 t >/dev/null
( loop SESSION_OFFER_LIFETIME=3 SESSION_OFFER_WAIT=0 SESSION_OFFER_BACKOFF=1 >/dev/null ) &
lp=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do [ "$(runs)" -ge 1 ] && break; sleep 0.5; done
wait "$lp" 2>/dev/null
check "the loop starts an offered ticket's launcher in the background"    '[ "$(cat "$RUN_LOG")" = "Acme/alpha 60" ]'

echo "session-offer-wait-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
