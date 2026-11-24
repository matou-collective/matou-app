#!/usr/bin/env bash
# Offline test for the fleet dispatcher's SESSION lane (ADR 0010 / #387):
# fleet-session-lib.sh (the queue read, offers, declines, blocks), the lane-aware
# half of fleet_dispatch_allocate, the receiver's offer poll, and one
# fleet-dispatch.sh pass in each lane mode (off / shadow / live). Fake checkouts,
# crafted slot reports on disk, a shimmed curl serving a fake tracker. No network,
# no socket (the receiver is driven through its --offers / --ack seams).
# Run: bash tests/fleet-session-lib-test.sh
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"
sc="$here/.."

tmp="$(tmpdir)"
export FLEET_DISPATCH_HOME="$tmp/dispatch"
export FLEET_DISPATCH_INBOX="$tmp/dispatch/inbox"
export FLEET_DISPATCH_REPORTS="$tmp/dispatch/reports"
export FLEET_DISPATCH_REPORT_TTL=240
export FLEET_DISPATCH_SESSION_OUTBOX="$tmp/dispatch/session-offers"
export FLEET_DISPATCH_SESSION_WAITERS="$tmp/dispatch/session-waiters"
export FORGEJO_TOKEN=t CURL_LOG="$tmp/curl.log" FAKE_TRACKER="$tmp/tracker"
mkdir -p "$FLEET_DISPATCH_INBOX" "$FLEET_DISPATCH_REPORTS" "$FAKE_TRACKER"
# shellcheck source=../fleet-queue-lib.sh
. "$sc/fleet-queue-lib.sh"
# shellcheck source=../fleet-dispatch-lib.sh
. "$sc/fleet-dispatch-lib.sh"
# shellcheck source=../fleet-session-lib.sh
. "$sc/fleet-session-lib.sh"

# empty <dir> — remove every file directly under a test-owned directory.
empty() { [ -d "$1" ] && find "$1" -mindepth 1 -maxdepth 2 -type f -delete; return 0; }
forget() { local f; for f in "$@"; do [ -f "$f" ] && unlink "$f"; done; return 0; }

# The fake tracker: a GET of a repo's ready-for-session list serves
# $FAKE_TRACKER/<owner>-<repo>.queue.json; a GET of a ticket's dependencies serves
# <owner>-<repo>.deps-<n>.json (absent = no dependencies). A missing queue file
# is a failed read (curl -f's exit 22).
shim curl <<'SH'
printf '%s\n' "$*" >>"${CURL_LOG:?}"
url=""; for a in "$@"; do case "$a" in http*) url="$a" ;; esac; done
case "$*" in *'%{http_code}'*) printf '204'; exit 0 ;; esac
case "$url" in
  */dependencies*)
    slug="$(printf '%s' "$url" | sed -E 's#.*/repos/([^/]+)/([^/]+)/issues/([0-9]+)/dependencies.*#\1-\2.deps-\3#')"
    if [ -f "$FAKE_TRACKER/$slug.json" ]; then cat "$FAKE_TRACKER/$slug.json"; else printf '[]'; fi ;;
  */issues\?*ready-for-session*)
    slug="$(printf '%s' "$url" | sed -E 's#.*/repos/([^/]+)/([^/]+)/issues.*#\1-\2#')"
    [ -f "$FAKE_TRACKER/$slug.queue.json" ] || exit 22
    cat "$FAKE_TRACKER/$slug.queue.json" ;;
esac
SH

issue() { # <n> <created> <labels-csv>
  jq -cn --argjson n "$1" --arg c "$2" --arg l "$3" \
    '{number:$n, title:("t"+($n|tostring)), state:"open", created_at:$c, pull_request:null,
      labels:($l | split(",") | map({name:.}))}'
}

# ── candidates: the session-runner's own label filter, pure ──────────────────
q="[$(issue 1 2026-10-01T00:00:00Z ready-for-session),$(issue 2 2026-10-02T00:00:00Z ready-for-session,agent-working),$(issue 3 2026-10-03T00:00:00Z ready-for-session,deferred),$(issue 4 2026-10-04T00:00:00Z ready-for-session,agent-blocked),$(issue 5 2026-10-05T00:00:00Z ready-for-session,no-triage),$(issue 6 2026-10-06T00:00:00Z ready-for-session,priority)]"
c="$(fleet_session_candidates "$q")"
check "candidates keep a plain ready-for-session ticket"           'jq -e "any(.[]; .number==1)" <<<"$c" >/dev/null'
check "candidates drop agent-working / deferred / agent-blocked / no-triage" \
  '[ "$(jq -c "[.[].number]" <<<"$c")" = "[1,6]" ]'
check "candidates carry the priority flag off the label"           '[ "$(jq -r ".[]|select(.number==6)|.priority" <<<"$c")" = true ]'
check "candidates of junk are an empty list, never an error"       '[ "$(fleet_session_candidates "not json")" = "[]" ]'

# ── collect_repo: dependencies are read, cached, and block ───────────────────
printf '%s' "$q" >"$FAKE_TRACKER/Acme-alpha.queue.json"
printf '[{"number":900,"state":"open"}]' >"$FAKE_TRACKER/Acme-alpha.deps-1.json"
: >"$CURL_LOG"
r="$(fleet_session_collect_repo https://forge.test/api/v1 Acme/alpha)"
check "collect_repo keeps a blocked ticket, marked with its open dependencies" \
  '[ "$(jq -c "[.[].number]|sort" <<<"$r")" = "[1,6]" ] && [ "$(jq -r ".[]|select(.number==1)|.open_deps" <<<"$r")" = 1 ]'
check "only the unblocked ticket is ready for the allocator"       '[ "$(fleet_session_ready "$r" | jq -c "[.[].number]")" = "[6]" ]'
check "the blocked ticket is logged HELD with its reason"          'fleet_session_format_held "$r" | grep -q "HELD   Acme/alpha#1 -> (none)  \[blocked by 1 open issue(s)\]"'
check "collect_repo marks the lane and the rank (priority = 0)"    'jq -e ".[]|select(.number==6)|.lane==\"session\" and .rank==0 and .repo==\"Acme/alpha\"" <<<"$r" >/dev/null'
u='[{"repo":"Acme/alpha","number":9,"lane":"session","rank":1,"open_deps":-1}]'
check "a ticket whose dependencies could not be read is not ready, and says so" \
  '[ "$(fleet_session_ready "$u")" = "[]" ] && fleet_session_format_held "$u" | grep -q "HELD   Acme/alpha#9 .*could not be read"'
n1="$(grep -c dependencies "$CURL_LOG")"
fleet_session_collect_repo https://forge.test/api/v1 Acme/alpha >/dev/null
check "a second read inside the cache window re-reads no dependency" '[ "$(grep -c dependencies "$CURL_LOG")" = "$n1" ]'
forget "$FAKE_TRACKER/Acme-alpha.deps-1.json"
r="$(FLEET_DISPATCH_NOW=$(( $(date +%s) + FLEET_DISPATCH_SESSION_DEPS_TTL + 1 )) fleet_session_collect_repo https://forge.test/api/v1 Acme/alpha)"
check "past the cache window a ticket whose blocker closed is ready" '[ "$(fleet_session_ready "$r" | jq -c "[.[].number]|sort")" = "[1,6]" ]'
check "collect_repo fails (rc 1) when the queue cannot be read"    '! fleet_session_collect_repo https://forge.test/api/v1 Acme/missing >/dev/null 2>&1'

# ── mode + per-host scope ────────────────────────────────────────────────────
check "the lane is off by default"                                 '[ "$(FLEET_DISPATCH_SESSION_MODE= fleet_session_mode)" = off ]'
check "an unknown mode reads off (a typo never turns offers on)"   '[ "$(FLEET_DISPATCH_SESSION_MODE=lvie fleet_session_mode)" = off ]'
check "live with no allowlist is live for every host"              '( FLEET_DISPATCH_SESSION_MODE=live; FLEET_DISPATCH_SESSION_LIVE_HOSTS=; _fleet_session_host_is_live boxA )'
check "live with an allowlist is live only for a named host"       '( FLEET_DISPATCH_SESSION_MODE=live; FLEET_DISPATCH_SESSION_LIVE_HOSTS="boxB"; ! _fleet_session_host_is_live boxA && _fleet_session_host_is_live boxB )'
check "shadow is live for no host"                                 '( FLEET_DISPATCH_SESSION_MODE=shadow; ! _fleet_session_host_is_live boxA )'

# ── offers: the outbox file, the outstanding record, the sweep ───────────────
check "offer writes one file into the host's outbox"               'fleet_session_offer Acme/alpha boxA 6 "a title" && [ "$(ls "$FLEET_DISPATCH_SESSION_OUTBOX/boxA" | wc -l)" = 1 ]'
of="$(ls "$FLEET_DISPATCH_SESSION_OUTBOX/boxA"/*.json)"
check "the offer names the ticket, the host and an expiry"         '[ "$(jq -r ".repo" "$of")" = Acme/alpha ] && [ "$(jq -r ".number" "$of")" = 6 ] && [ "$(jq -r ".host" "$of")" = boxA ] && [ "$(jq -r ".expires > .offered_at" "$of")" = true ]'
check "offer refuses an unsafe host or repo (rc 1, no file)"       '! fleet_session_offer Acme/alpha "../x" 6 && ! fleet_session_offer "../../etc" boxA 6 && ! fleet_session_offer Acme/alpha boxA abc'
b="$(fleet_session_blocks)"
check "an outstanding offer blocks the ticket on EVERY host"       'jq -e "any(.[]; .host==\"*\" and .scope==\"ticket\" and .repo==\"Acme/alpha\" and .number==6)" <<<"$b" >/dev/null'
check "an outstanding offer blocks a second same-repo session on its host" 'jq -e "any(.[]; .host==\"boxA\" and .scope==\"repo\" and .repo==\"Acme/alpha\")" <<<"$b" >/dev/null'
b="$(FLEET_DISPATCH_NOW=$(( $(date +%s) + FLEET_DISPATCH_SESSION_OFFER_TTL + 1 )) fleet_session_blocks)"
check "an offer past its TTL blocks nothing"                       '[ "$b" = "[]" ]'
FLEET_DISPATCH_NOW=$(( $(date +%s) + FLEET_DISPATCH_SESSION_DELIVER_TTL + 1 )) fleet_session_outbox_sweep
check "the sweep drops an offer no waiter collected in time"       '[ -z "$(ls -A "$FLEET_DISPATCH_SESSION_OUTBOX/boxA")" ]'

# ── declines: validated, clamped, remembered, and they free the offer ────────
forget "$(_fleet_session_offered_path)" "$(_fleet_session_declines_path)"
fleet_session_offer Acme/alpha boxA 6 >/dev/null
d='{"kind":"session-decline","host":"boxA","repo":"Acme/alpha","number":6,"scope":"ticket","reason":"#6 cooling down\nafter a failed attempt","retry_after":1200}'
check "a well-formed decline is accepted"                          'fleet_session_decline_ingest "$d" >/dev/null'
b="$(fleet_session_blocks)"
check "the decline blocks that ticket on that host, in the host's words" \
  'jq -e "any(.[]; .host==\"boxA\" and .scope==\"ticket\" and .number==6 and (.reason|test(\"cooling down after a failed attempt\")))" <<<"$b" >/dev/null'
check "the decline frees the outstanding offer (the ticket may go elsewhere)" '! jq -e "any(.[]; .host==\"*\")" <<<"$b" >/dev/null'
check "the reason is stored as ONE line"                           '[ "$(wc -l <"$(_fleet_session_declines_path)")" = 1 ]'
check "a decline holds for its retry_after and then lapses"        '[ "$(FLEET_DISPATCH_NOW=$(( $(date +%s) + 1201 )) fleet_session_blocks)" = "[]" ]'
fleet_session_decline_ingest '{"kind":"session-decline","host":"boxA","scope":"host","reason":"limit-parked","retry_after":999999999}' >/dev/null
check "a host-scope decline needs no repo and its hold is clamped" \
  'jq -e "any(.[]; .host==\"boxA\" and .scope==\"host\" and .repo==null)" <<<"$(fleet_session_blocks)" >/dev/null && [ "$(FLEET_DISPATCH_NOW=$(( $(date +%s) + FLEET_DISPATCH_SESSION_DECLINE_MAX + 1 )) fleet_session_blocks)" = "[]" ]'
check "a decline with an unsafe host is refused"                   '! fleet_session_decline_ingest "{\"kind\":\"session-decline\",\"host\":\"a/b\",\"scope\":\"host\"}" >/dev/null 2>&1'
check "a decline with an unknown scope is refused"                 '! fleet_session_decline_ingest "{\"kind\":\"session-decline\",\"host\":\"boxA\",\"repo\":\"Acme/alpha\",\"scope\":\"fleet\"}" >/dev/null 2>&1'
check "a ticket-scope decline with no repo is refused"             '! fleet_session_decline_ingest "{\"kind\":\"session-decline\",\"host\":\"boxA\",\"scope\":\"ticket\",\"number\":3}" >/dev/null 2>&1'
check "a slot report is not mistaken for a decline"                '! fleet_session_decline_ingest "{\"host\":\"boxA\",\"slots\":[]}" >/dev/null 2>&1'
# the same decline arriving through the receiver's spool
forget "$(_fleet_session_declines_path)"
printf '%s' "$d" >"$FLEET_DISPATCH_INBOX/0001.json"
printf '%s' '{"report_version":1,"event":"tick","host":"boxZ","now":1,"drive_reserved":false,"slots":[],"ended":null}' >"$FLEET_DISPATCH_INBOX/0002.json"
n="$(fleet_dispatch_drain_inbox 2>/dev/null)"
check "drain routes a decline to the session lane and still ingests the report" \
  '[ "$n" = 1 ] && [ -s "$(_fleet_session_declines_path)" ] && [ -f "$FLEET_DISPATCH_REPORTS/boxZ.json" ] && [ -z "$(ls -A "$FLEET_DISPATCH_INBOX")" ]'

# ── a running session in a slot report blocks a second one for that repo ─────
empty "$FLEET_DISPATCH_REPORTS"; forget "$(_fleet_session_declines_path)" "$(_fleet_session_offered_path)"
jq -cn --argjson now "$(date +%s)" '{report_version:1,event:"tick",host:"boxS",now:$now,drive_reserved:false,_received_at:$now,ended:null,
  slots:[{n:1,path:"/s/1",state:"busy",issue:41,iteration:null,holder:{kind:"session",repo:"Acme/alpha",worker:"session-runner",ref:"41"}},
         {n:2,path:"/s/2",state:"free",issue:null,iteration:null,holder:null}]}' >"$FLEET_DISPATCH_REPORTS/boxS.json"
b="$(fleet_session_blocks)"
check "a session holder on a fresh report is a repo-scope block for its host" \
  'jq -e "any(.[]; .host==\"boxS\" and .scope==\"repo\" and .repo==\"Acme/alpha\")" <<<"$b" >/dev/null'

# ── the allocator: one order, two lanes ──────────────────────────────────────
free2='[{"host":"boxA","n":1,"path":"/s/1"},{"host":"boxB","n":1,"path":"/s/1"}]'
ord='[{"repo":"Acme/alpha","number":7,"lane":"session"},{"repo":"Acme/alpha","number":8},{"repo":"Acme/alpha","number":9,"lane":"session"}]'
a="$(fleet_dispatch_allocate "$ord" "$free2" '[]' '[]')"
check "a session ticket ahead in the order takes the first free slot"        '[ "$(jq -r ".[0]|\"\(.lane) \(.placed) \(.host)\"" <<<"$a")" = "session true boxA" ]'
check "a swarm ticket of the same repo may share that host (different checkout)" '[ "$(jq -r ".[1]|\"\(.lane) \(.placed) \(.host)\"" <<<"$a")" = "swarm true boxB" ]'
check "a decision with no lane on the ticket reads lane=swarm"               '[ "$(jq -r ".[1].lane" <<<"$a")" = swarm ]'
free3='[{"host":"boxA","n":1,"path":"/s/1"},{"host":"boxA","n":2,"path":"/s/2"},{"host":"boxB","n":1,"path":"/s/1"}]'
ord2='[{"repo":"Acme/alpha","number":7,"lane":"session"},{"repo":"Acme/alpha","number":9,"lane":"session"},{"repo":"Acme/alpha","number":11,"lane":"session"}]'
a="$(fleet_dispatch_allocate "$ord2" "$free3" '[]' '[]')"
check "two session tickets of one repo land on DIFFERENT hosts in one pass"  '[ "$(jq -r "[.[]|select(.placed)|.host]|join(\",\")" <<<"$a")" = "boxA,boxB" ]'
check "a third is queued, naming the one-session-per-repo rule"              'jq -e ".[2] | (.placed|not) and (.reason|test(\"one session per repo per host\"))" <<<"$a" >/dev/null'
blk='[{"host":"boxA","scope":"ticket","repo":"Acme/alpha","number":7,"reason":"boxA declined: #7 cooling down"}]'
a="$(fleet_dispatch_allocate '[{"repo":"Acme/alpha","number":7,"lane":"session"}]' "$free2" '[]' "$blk")"
check "a ticket a host declined is offered to the next host"                 '[ "$(jq -r ".[0].host" <<<"$a")" = boxB ]'
blk='[{"host":"boxA","scope":"host","repo":null,"number":0,"reason":"boxA declined: limit-parked"},{"host":"boxB","scope":"repo","repo":"Acme/alpha","number":0,"reason":"boxB declined: not session-enrolled"}]'
a="$(fleet_dispatch_allocate '[{"repo":"Acme/alpha","number":7,"lane":"session"},{"repo":"Acme/beta","number":2,"lane":"session"},{"repo":"Acme/alpha","number":3}]' "$free2" '[]' "$blk")"
check "a ticket every free host rules out is queued with the hosts' reasons" \
  'jq -e ".[0] | (.placed|not) and (.reason|test(\"limit-parked\")) and (.reason|test(\"not session-enrolled\"))" <<<"$a" >/dev/null'
check "a repo-scope block does not stop another repo's session on that host"  '[ "$(jq -r ".[1].host" <<<"$a")" = boxB ]'
check "a session block never affects a swarm ticket"                         '[ "$(jq -r ".[2]|\"\(.placed) \(.host)\"" <<<"$a")" = "true boxA" ]'
blk='[{"host":"*","scope":"ticket","repo":"Acme/alpha","number":7,"reason":"already offered to boxC 5s ago"}]'
a="$(fleet_dispatch_allocate '[{"repo":"Acme/alpha","number":7,"lane":"session"}]' "$free2" '[]' "$blk")"
check "a ticket with an offer outstanding is placed nowhere"                 'jq -e ".[0] | (.placed|not) and (.reason|test(\"already offered\"))" <<<"$a" >/dev/null'
check "garbled blocks read as none (the allocation still runs)"              '[ "$(fleet_dispatch_allocate "[{\"repo\":\"Acme/alpha\",\"number\":7,\"lane\":\"session\"}]" "$free2" "[]" "nope" | jq -r ".[0].placed")" = true ]'
check "format_decisions prints no session row; fleet_session_format prints only those" \
  '[ "$(fleet_dispatch_format_decisions "$(fleet_dispatch_allocate "$ord" "$free2")" | grep -c ALLOC)" = 1 ] && [ "$(fleet_session_format "$(fleet_dispatch_allocate "$ord" "$free2")" | grep -c OFFER)" = 1 ]'

# ── the waiter stamp and the unconnected-host block ──────────────────────────
mkdir -p "$FLEET_DISPATCH_SESSION_WAITERS"; empty "$FLEET_DISPATCH_SESSION_WAITERS"
: >"$FLEET_DISPATCH_SESSION_WAITERS/boxA"
check "a fresh poll stamp proves a connected waiter"               'fleet_session_waiter_fresh boxA && ! fleet_session_waiter_fresh boxB'
check "a stamp past the TTL does not"                              '! FLEET_DISPATCH_NOW=$(( $(date +%s) + FLEET_DISPATCH_SESSION_WAITER_TTL + 1 )) fleet_session_waiter_fresh boxA'
u="$(fleet_session_unconnected_blocks "$free2")"
check "a host with no connected waiter is host-blocked for sessions" '[ "$(jq -r "[.[].host]|join(\",\")" <<<"$u")" = boxB ]'

# ── the receiver's offer poll (no socket: --offers) ──────────────────────────
if command -v python3 >/dev/null 2>&1; then
  rx() { python3 "$sc/fleet-dispatch-receiver.py" "$@"; }
  empty "$FLEET_DISPATCH_SESSION_OUTBOX"; empty "$FLEET_DISPATCH_SESSION_WAITERS"; forget "$(_fleet_session_offered_path)"
  fleet_session_offer Acme/alpha boxA 6 "t" >/dev/null
  o="$(rx --offers --host boxA)"
  check "a poll hands over the host's offer"                       '[ "$(jq -r ".offers|length" <<<"$o")" = 1 ] && [ "$(jq -r ".offers[0].repo" <<<"$o")" = Acme/alpha ] && [ "$(jq -r ".offers[0].number" <<<"$o")" = 6 ]'
  check "an offer is delivered once (the file is gone)"            '[ "$(rx --offers --host boxA | jq -r ".offers|length")" = 0 ]'
  check "a poll stamps the waiter"                                 'fleet_session_waiter_fresh boxA'
  check "a poll for another host gets nothing of boxA's"           'fleet_session_offer Acme/alpha boxA 7 t >/dev/null; [ "$(rx --offers --host boxB | jq -r ".offers|length")" = 0 ]'
  check "an expired offer is dropped, never delivered"             'f="$(ls "$FLEET_DISPATCH_SESSION_OUTBOX/boxA"/*.json)"; jq -c ".expires = 1" "$f" >"$f.t" && mv "$f.t" "$f"; [ "$(rx --offers --host boxA | jq -r ".offers|length")" = 0 ] && [ -z "$(ls -A "$FLEET_DISPATCH_SESSION_OUTBOX/boxA")" ]'
  check "a poll refuses an unsafe host"                            '! rx --offers --host "../x" >/dev/null 2>&1'
  # the acknowledgement's session half: live for the host AND its waiter connected
  check "ack session_acting is false when the lane is off"         '[ "$(rx --ack --host boxA | jq -r .session_acting)" = false ]'
  check "ack session_acting is false in shadow"                    '[ "$(FLEET_DISPATCH_SESSION_MODE=shadow rx --ack --host boxA | jq -r .session_acting)" = false ]'
  check "ack session_acting is true: live + connected waiter"      '[ "$(FLEET_DISPATCH_SESSION_MODE=live rx --ack --host boxA | jq -r .session_acting)" = true ]'
  check "ack session_acting is false for a host with no waiter"    '[ "$(FLEET_DISPATCH_SESSION_MODE=live rx --ack --host boxNone | jq -r .session_acting)" = false ]'
  check "ack session_acting is false for a host outside the allowlist" '[ "$(FLEET_DISPATCH_SESSION_MODE=live FLEET_DISPATCH_SESSION_LIVE_HOSTS=boxQ rx --ack --host boxA | jq -r .session_acting)" = false ]'
  check "the swarm half of the ack is unchanged by the session lane" '[ "$(FLEET_DISPATCH_MODE=live FLEET_DISPATCH_SESSION_MODE=off rx --ack --host boxA | jq -r .acting)" = true ]'
else
  echo "fleet-session-lib-test: receiver checks SKIPPED — no python3 on PATH."
fi

# ── one dispatcher pass per lane mode ────────────────────────────────────────
mk_checkout() { # <dir> <slug> <lister-json>
  mkdir -p "$1/.sandcastle"
  printf ': "${FORGEJO_API:=https://forge.test/api/v1/repos/%s}"\n' "$2" >"$1/.sandcastle/swarm-identity.sh"
  printf '#!/usr/bin/env bash\ncat <<'"'"'JSON'"'"'\n%s\nJSON\n' "$3" >"$1/.sandcastle/list-ready-tasks.sh"
}
mk_checkout "$tmp/alpha" Acme/alpha '[{"number":10,"title":"swarm","body":"","url":"u","created_at":"2026-10-05T00:00:00Z","priority":false,"blocker":false}]'
mk_checkout "$tmp/beta"  Acme/beta  '[]'
export FLEET_QUEUE_REPOS="$tmp/alpha:Acme/alpha $tmp/beta:Acme/beta"
# alpha#3 is an OLDER session ticket than swarm alpha#10; beta#4 is newer but priority.
printf '[%s]' "$(issue 3 2026-10-01T00:00:00Z ready-for-session)" >"$FAKE_TRACKER/Acme-alpha.queue.json"
printf '[%s]' "$(issue 4 2026-10-09T00:00:00Z ready-for-session,priority)" >"$FAKE_TRACKER/Acme-beta.queue.json"
put_report() { # <host> <n-free-slots>
  jq -cn --arg h "$1" --argjson k "$2" --argjson now "$(date +%s)" \
    '{report_version:1,event:"tick",host:$h,now:$now,drive_reserved:false,ended:null,_received_at:$now,
      slots:[range(1;$k+1) | {n:.,path:("/s/"+(.|tostring)),state:"free",issue:null,iteration:null,holder:null}]}' \
    >"$FLEET_DISPATCH_REPORTS/$1.json"
}
reset_spool() {
  empty "$FLEET_DISPATCH_HOME/session-deps"; empty "$FLEET_DISPATCH_SESSION_OUTBOX"
  empty "$FLEET_DISPATCH_SESSION_WAITERS"; empty "$FLEET_DISPATCH_REPORTS"
  forget "$FLEET_DISPATCH_HOME/session-offered" "$FLEET_DISPATCH_HOME/session-declines" "$FLEET_DISPATCH_HOME/recent-placements"
  mkdir -p "$FLEET_DISPATCH_SESSION_WAITERS"; : >"$CURL_LOG"
}
connect() { local h; for h in "$@"; do : >"$FLEET_DISPATCH_SESSION_WAITERS/$h"; done; }
run() { FLEET_DISPATCH_DETECT=off bash "$sc/fleet-dispatch.sh" "$@" 2>&1; }
offers_for() { ls "$FLEET_DISPATCH_SESSION_OUTBOX/$1" 2>/dev/null | wc -l | tr -d ' '; }

reset_spool; put_report boxA 1; put_report boxB 1
out="$(run once)"
check "lane off: no session line, no session read, the swarm head is allocated as before" \
  '! grep -q "session lane" <<<"$out" && ! grep -q "ready-for-session" "$CURL_LOG" && grep -q "ALLOC  Acme/alpha#10 -> boxA slot 1" <<<"$out"'

reset_spool; put_report boxA 1; put_report boxB 1
out="$(FLEET_DISPATCH_SESSION_MODE=shadow run once)"
check "shadow: the session lane is logged with its count"          'grep -q "session lane (shadow — offering nothing): 2 workable of 2 ready-for-session" <<<"$out"'
check "shadow: the merged order puts the priority session ticket first, then the oldest" \
  'grep -q "OFFER  Acme/beta#4 -> boxA slot 1" <<<"$out" && grep -q "OFFER  Acme/alpha#3 -> boxB slot 1" <<<"$out"'
check "shadow: the LIVE swarm allocation is untouched by the session lane" 'grep -q "ALLOC  Acme/alpha#10 -> boxA slot 1" <<<"$out"'
check "shadow: nothing is offered (no outbox file, no outstanding record)" '[ "$(offers_for boxA)" = 0 ] && [ "$(offers_for boxB)" = 0 ] && [ ! -s "$FLEET_DISPATCH_HOME/session-offered" ]'

reset_spool; put_report boxA 1; put_report boxB 1; connect boxA boxB
out="$(FLEET_DISPATCH_SESSION_MODE=live run once)"
check "live: session tickets take the slots their rank earns"      'grep -q "OFFER  Acme/beta#4 -> boxA slot 1" <<<"$out" && grep -q "OFFER  Acme/alpha#3 -> boxB slot 1" <<<"$out"'
check "live: the swarm ticket behind them is queued, not placed"   'grep -q "QUEUE  Acme/alpha#10" <<<"$out" && ! grep -q "would start Acme/alpha#10" <<<"$out"'
check "live: each placed session ticket is an offer in its host's outbox" '[ "$(offers_for boxA)" = 1 ] && [ "$(offers_for boxB)" = 1 ] && grep -q "offered Acme/beta#4 to boxA" <<<"$out"'
check "live: an offer posts nothing to the tracker"                '! grep -qE "X POST|comments" "$CURL_LOG"'
out="$(FLEET_DISPATCH_SESSION_MODE=live run once)"
check "live: the next pass does not offer the same tickets again"  '[ "$(offers_for boxA)" = 1 ] && [ "$(offers_for boxB)" = 1 ] && grep -q "already offered to boxA" <<<"$out"'

reset_spool; put_report boxA 1; put_report boxB 1; connect boxB
out="$(FLEET_DISPATCH_SESSION_MODE=live run once)"
check "live: a host with no connected offer poll is offered no session; its slot goes to the swarm ticket" \
  '[ "$(offers_for boxA)" = 0 ] && grep -q "OFFER  Acme/beta#4 -> boxB slot 1" <<<"$out" && grep -q "ALLOC  Acme/alpha#10 -> boxA slot 1" <<<"$out" && grep -q "no offer poll connected" <<<"$out"'

reset_spool; put_report boxA 1; put_report boxB 1; connect boxA boxB
out="$(FLEET_DISPATCH_SESSION_MODE=live FLEET_DISPATCH_SESSION_LIVE_HOSTS=boxB run once)"
check "live on ONE host: session work is offered only there"       '[ "$(offers_for boxA)" = 0 ] && [ "$(offers_for boxB)" = 1 ] && grep -q "live host list" <<<"$out"'

reset_spool; put_report boxA 1; put_report boxB 1
printf '[{"number":77,"state":"open"}]' >"$FAKE_TRACKER/Acme-beta.deps-4.json"
out="$(FLEET_DISPATCH_SESSION_MODE=shadow run once)"
check "a blocked session ticket is not placed and is logged HELD with why" \
  'grep -q "1 workable of 2 ready-for-session" <<<"$out" && grep -q "HELD   Acme/beta#4 -> (none)  \[blocked by 1 open issue(s)\]" <<<"$out" && ! grep -q "OFFER  Acme/beta#4" <<<"$out"'
forget "$FAKE_TRACKER/Acme-beta.deps-4.json"

reset_spool; put_report boxA 1; connect boxA
forget "$FAKE_TRACKER/Acme-beta.queue.json"
out="$(FLEET_DISPATCH_SESSION_MODE=live run once)"
check "a repo whose session queue cannot be read is omitted; the rest is allocated" \
  'grep -q "Acme/beta session queue could not be read" <<<"$out" && grep -q "OFFER  Acme/alpha#3 -> boxA slot 1" <<<"$out"'

echo "fleet-session-lib-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
