#!/usr/bin/env bash
# Offline test for fleet-dispatch-lib.sh — the fleet dispatcher's SHADOW
# allocator (ADR 0009, slice 2 / #355). Drives the pure functions over crafted
# slot reports (slice 1's shape) and a crafted fleet order: ingest, the free-slot
# inventory, the allocation, its log format, and the single start-a-run seam in
# both modes (shadow logs + dispatches nothing; live rides fleet_queue_dispatch
# through a shimmed curl). No network, no docker — the HTTP receiver and the loop
# are runtime glue proven at the ends (the main-mts-offline rule), exactly as the
# slot-report producer's inline wiring is. Run: bash tests/fleet-dispatch-lib-test.sh
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
mkdir -p "$FLEET_DISPATCH_INBOX" "$FLEET_DISPATCH_REPORTS"
# shellcheck source=../fleet-dispatch-lib.sh
. "$sc/fleet-dispatch-lib.sh"

# a slot object in slice-1 shape; <state> free|busy|unknown
slot() { # <n> <state> [issue] [repo]
  jq -cn --argjson n "$1" --arg st "$2" --argjson issue "${3:-null}" --arg repo "${4:-}" \
    '{n:$n, path:("/s/"+($n|tostring)), state:$st, issue:$issue, iteration:null,
      holder:(if $st=="busy" then {kind:"ticket",repo:(if $repo=="" then null else $repo end),
                                   worker:"swarm-worker",ref:($issue|tostring),since:1,pid:1,pid_alive:true}
              else null end)}'
}
# a full report in slice-1 shape; <age> = seconds since we received it
report() { # <host> <drive_reserved> <slots-json-array>
  jq -cn --arg h "$1" --argjson dr "$2" --argjson slots "$3" --argjson now "$(_fleet_dispatch_now)" \
    '{report_version:1, event:"tick", host:$h, now:$now, drive_reserved:$dr, slots:$slots, ended:null}'
}

# ── ingest: a valid report is keyed by host; junk is refused ─────────────────
r="$(report boxA false "[$(slot 1 busy 10 Acme/alpha),$(slot 2 free)]")"
check "ingest accepts a valid report (rc 0)"        'fleet_dispatch_ingest "$r"'
check "ingest keys the report by host"              '[ -f "$FLEET_DISPATCH_REPORTS/boxA.json" ]'
check "ingest stamps a received-at"                 'jq -e "._received_at|type==\"number\"" "$FLEET_DISPATCH_REPORTS/boxA.json" >/dev/null'
check "ingest preserves the slots"                  '[ "$(jq ".slots|length" "$FLEET_DISPATCH_REPORTS/boxA.json")" = 2 ]'
check "ingest refuses non-JSON (rc 1)"              '! fleet_dispatch_ingest "not json" 2>/dev/null'
check "ingest refuses a report with no host (rc 1)" '! fleet_dispatch_ingest "{\"slots\":[]}" 2>/dev/null'
check "ingest refuses a host with a path separator" '! fleet_dispatch_ingest "{\"host\":\"a/../b\",\"slots\":[]}" 2>/dev/null'
check "a refused report writes no file"             '[ ! -e "$FLEET_DISPATCH_REPORTS/a.json" ]'

# ── drain_inbox: valid files ingest, junk is dropped, the inbox empties ──────
rm -f "$FLEET_DISPATCH_REPORTS"/*.json
printf '%s' "$(report boxB false "[$(slot 1 free)]")" >"$FLEET_DISPATCH_INBOX/0001.json"
printf 'garbage' >"$FLEET_DISPATCH_INBOX/0002.json"
n="$(fleet_dispatch_drain_inbox)"
check "drain ingests the valid report and reports the count"  '[ "$n" = 1 ]'
check "drain keyed the valid report by host"                  '[ -f "$FLEET_DISPATCH_REPORTS/boxB.json" ]'
check "drain empties the inbox (junk dropped too)"            '[ -z "$(ls -A "$FLEET_DISPATCH_INBOX")" ]'

# ── free_slots: fresh non-drive hosts only, free slots only, stable order ────
rm -f "$FLEET_DISPATCH_REPORTS"/*.json
fleet_dispatch_ingest "$(report boxA false "[$(slot 1 busy 10 Acme/alpha),$(slot 2 free)]")"
fleet_dispatch_ingest "$(report boxD false "[$(slot 1 free),$(slot 2 free)]")"
fleet_dispatch_ingest "$(report boxDrive true "[$(slot 1 free)]")"          # ruling E: offered nothing
# a stale host: rewrite its received-at to older than the TTL
fleet_dispatch_ingest "$(report boxStale false "[$(slot 1 free)]")"
jq -c '._received_at = (._received_at - 9999)' "$FLEET_DISPATCH_REPORTS/boxStale.json" >"$FLEET_DISPATCH_REPORTS/boxStale.json.t" \
  && mv "$FLEET_DISPATCH_REPORTS/boxStale.json.t" "$FLEET_DISPATCH_REPORTS/boxStale.json"
fs="$(fleet_dispatch_free_slots)"
check "free_slots is a JSON array"                  'jq -e "type==\"array\"" <<<"$fs" >/dev/null'
check "free_slots excludes busy slots"              '! jq -e "any(.[]; .host==\"boxA\" and .n==1)" <<<"$fs" >/dev/null'
check "free_slots keeps a fresh host's free slot"   'jq -e "any(.[]; .host==\"boxA\" and .n==2)" <<<"$fs" >/dev/null'
check "free_slots excludes a drive-reserved host (ruling E)" '! jq -e "any(.[]; .host==\"boxDrive\")" <<<"$fs" >/dev/null'
check "free_slots excludes a stale host (>2 ticks)" '! jq -e "any(.[]; .host==\"boxStale\")" <<<"$fs" >/dev/null'
check "free_slots counts three offerable slots"     '[ "$(jq length <<<"$fs")" = 3 ]'
check "free_slots is host-then-slot ordered (boxA#2 first, then boxD#1, boxD#2)" \
  '[ "$(jq -c "map(\"\(.host)#\(.n)\")" <<<"$fs")" = "[\"boxA#2\",\"boxD#1\",\"boxD#2\"]" ]'

# ── host status lines: every host says why it offered what it did ────────────
hl="$(fleet_dispatch_host_lines)"
check "host line names a drive-reserved host and ruling E" 'grep -q "boxDrive" <<<"$hl" && grep -qi "drive" <<<"$hl"'
check "host line marks a stale host unknown"               'grep -q "boxStale" <<<"$hl" && grep -qi "unknown\|stale" <<<"$hl"'

# ── allocate: head pick to a free slot, the rest explained ───────────────────
order='[{"repo":"Acme/alpha","number":10},{"repo":"Acme/beta","number":5},{"repo":"Acme/alpha","number":12}]'
twofree='[{"host":"boxD","n":1,"path":"/s/1"},{"host":"boxD","n":2,"path":"/s/2"}]'
dec="$(fleet_dispatch_allocate "$order" "$twofree")"
check "allocate is a JSON array one-per-ready-ticket" '[ "$(jq length <<<"$dec")" = 3 ]'
check "the head pick is placed on the first free slot" \
  '[ "$(jq -r ".[0].placed" <<<"$dec")" = true ] && [ "$(jq -r ".[0].host" <<<"$dec")" = boxD ] && [ "$(jq -r ".[0].slot" <<<"$dec")" = 1 ]'
check "the second pick takes the second free slot"    '[ "$(jq -r ".[1].placed" <<<"$dec")" = true ] && [ "$(jq -r ".[1].slot" <<<"$dec")" = 2 ]'
check "the third pick is queued (slots exhausted)"    '[ "$(jq -r ".[2].placed" <<<"$dec")" = false ]'
check "the queued pick's reason answers why not sooner (2 ahead took the 2 free slots)" \
  '[ "$(jq -r ".[2].reason" <<<"$dec")" = "$(jq -rn "\"no free slot — the 2 free slot(s) went to the 2 higher pick(s) ahead\"")" ]'

dec0="$(fleet_dispatch_allocate "$order" '[]')"
check "with no free slot every pick is queued"        '[ "$(jq "[.[]|select(.placed)]|length" <<<"$dec0")" = 0 ]'
check "the no-slot reason names the fleet-wide stall" 'jq -r ".[0].reason" <<<"$dec0" | grep -qi "no free slot anywhere"'

# ── format_decisions: the shadow log the acceptance reads ────────────────────
lines="$(fleet_dispatch_format_decisions "$dec")"
check "a placed pick logs which slot it would be offered" \
  'grep -q "Acme/alpha#10" <<<"$lines" && grep -qi "boxD" <<<"$lines" && grep -qi "slot 1" <<<"$lines"'
check "a queued pick logs why it was not offered sooner" \
  'grep -q "Acme/alpha#12" <<<"$lines" && grep -qi "went to the 2 higher" <<<"$lines"'

# ── start-a-run seam (ruling C): shadow logs + dispatches nothing ────────────
shim curl <<'SH'
printf '%s\n' "$*" >>"$CURL_LOG"
case "$*" in *'%{http_code}'*) printf '204' ;; esac
SH
export CURL_LOG="$tmp/curl.log"; : >"$CURL_LOG"
out="$(fleet_dispatch_start_run shadow https://forge.test/api/v1 Acme/alpha 10 boxD 1 2>&1)"
check "shadow start_run dispatches NOTHING (no curl)"  '[ ! -s "$CURL_LOG" ]'
check "shadow start_run logs what it WOULD start"      'grep -qi "would start" <<<"$out" && grep -q "Acme/alpha#10" <<<"$out" && grep -q "boxD" <<<"$out"'
check "shadow start_run returns rc 0"                  'fleet_dispatch_start_run shadow https://forge.test/api/v1 Acme/alpha 10 boxD 1 >/dev/null 2>&1'

: >"$CURL_LOG"
fleet_dispatch_start_run live https://forge.test/api/v1 Acme/alpha 10 boxD 1 >/dev/null 2>&1 || true
check "live start_run DOES ride the dispatch seam (workflow_dispatch)" \
  'grep -q "Acme/alpha/actions/workflows/swarm.yml/dispatches" "$CURL_LOG"'

# ── per-host live scoping (slice 4 / #357): stages 6b and 6c ─────────────────
# shadow mode: no host is live, whatever the allowlist says.
check "shadow mode: a host is NOT live even if named in the allowlist" \
  '(FLEET_DISPATCH_MODE=shadow FLEET_DISPATCH_LIVE_HOSTS=boxA; ! _fleet_dispatch_host_is_live boxA)'
check "shadow mode: host_mode is shadow" \
  '[ "$(FLEET_DISPATCH_MODE=shadow fleet_dispatch_host_mode boxA)" = shadow ]'
# live + empty allowlist = fleet-wide (stage 6c): every host is live.
check "live + empty allowlist: any host is live (fleet-wide, stage 6c)" \
  'FLEET_DISPATCH_MODE=live FLEET_DISPATCH_LIVE_HOSTS= _fleet_dispatch_host_is_live boxA && FLEET_DISPATCH_MODE=live FLEET_DISPATCH_LIVE_HOSTS= _fleet_dispatch_host_is_live boxZ'
check "live + empty allowlist: host_mode is live for any host" \
  '[ "$(FLEET_DISPATCH_MODE=live FLEET_DISPATCH_LIVE_HOSTS= fleet_dispatch_host_mode boxZ)" = live ]'
# live + non-empty allowlist = scoped (stage 6b): only the named host(s).
check "live + scoped allowlist: a listed host is live" \
  'FLEET_DISPATCH_MODE=live FLEET_DISPATCH_LIVE_HOSTS="boxA boxB" _fleet_dispatch_host_is_live boxA'
check "live + scoped allowlist: an unlisted host is NOT live (stays on its tick)" \
  '(FLEET_DISPATCH_MODE=live FLEET_DISPATCH_LIVE_HOSTS="boxA boxB"; ! _fleet_dispatch_host_is_live boxC)'
check "live + scoped allowlist: host_mode is shadow for the unlisted host" \
  '[ "$(FLEET_DISPATCH_MODE=live FLEET_DISPATCH_LIVE_HOSTS="boxA" fleet_dispatch_host_mode boxC)" = shadow ]'
check "live + scoped allowlist: a substring is not a match (boxA vs boxAA)" \
  '(FLEET_DISPATCH_MODE=live FLEET_DISPATCH_LIVE_HOSTS=boxA; ! _fleet_dispatch_host_is_live boxAA)'

# ── host status lines carry the per-host scope when live (stage 6b surface) ───
rm -f "$FLEET_DISPATCH_REPORTS"/*.json
fleet_dispatch_ingest "$(report boxA false "[$(slot 1 free)]")"
fleet_dispatch_ingest "$(report boxC false "[$(slot 1 free)]")"
hl2="$(FLEET_DISPATCH_MODE=live FLEET_DISPATCH_LIVE_HOSTS=boxA fleet_dispatch_host_lines)"
check "a live-scoped host's line says the dispatcher allocates it" \
  'grep "boxA" <<<"$hl2" | grep -qi "live — dispatcher allocates"'
check "an out-of-scope host's line says it stays on its own tick" \
  'grep "boxC" <<<"$hl2" | grep -qi "shadow — on its own tick"'
hl3="$(fleet_dispatch_host_lines)"
check "a shadow pass's host line carries no scope annotation (reads as before)" \
  '! grep -qi "own tick\|dispatcher allocates" <<<"$hl3"'

# ── fleet_dispatch_arbitrate (#365): the dispatcher's cross-pass memory ───────
# The dispatcher holds nothing it cannot rebuild (ADR 0009 decision 2), so "I
# already offered this pick" lives on the tracker as the #351 marker. The rule
# differs from the host tick's: ANY live marker — the dispatcher's own from a
# prior pass (the leg has not claimed yet) or a peer host's tick — means SKIP, so
# one ready ticket + one free slot stops firing a fresh run every pass. A tiny
# comment-store curl shim (the fleet-queue-lib test's tracker), ids strictly
# increasing across the forge.
export FLEET_QUEUE_MARKS="$tmp/dispatch/marks"
export COMMENTS_DIR="$tmp/comments"
shim curl <<'SH'
url=""; method=GET; data=""
while [ $# -gt 0 ]; do
  case "$1" in -X) method="$2"; shift 2 ;; -H|-d|--max-time|-o|-w) [ "$1" = -d ] && data="$2"; shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac
done
[ "$data" = "@-" ] && data="$(cat)"
printf '%s %s %s\n' "$method" "$url" "$data" >>"${CURL_LOG:?}"
store="${COMMENTS_DIR:?}"; mkdir -p "$store"
cfile() { local k="${url#*/repos/}"; k="${k%/comments}"; printf '%s/%s.json' "$store" "${k//\//_}"; }
nextid() { local i; i=$(( $(cat "$store/seq" 2>/dev/null || echo 100) + 1 )); echo "$i" >"$store/seq"; echo "$i"; }
put() { local f="$1" id c; id="$(nextid)"; [ -f "$f" ] || echo '[]' >"$f"
  c="$(jq -cn --argjson id "$id" --arg b "$3" --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{id:$id, body:$b, created_at:$t}')"
  jq -c --argjson c "$c" '. + [$c]' "$f" >"$f.tmp" && mv "$f.tmp" "$f"; printf '%s' "$c"; }
case "$method $url" in
  "GET "*/issues/*/comments) [ -n "${COMMENTS_GET_FAIL:-}" ] && exit 22
    f="$(cfile)"; if [ -f "$f" ]; then cat "$f"; else printf '[]'; fi ;;
  "POST "*/issues/*/comments) f="$(cfile)"; put "$f" x "$(jq -r .body <<<"$data")" ;;
  "DELETE "*/issues/comments/*)
    id="${url##*/}"; hit=404
    for f in "$store"/*.json; do [ -f "$f" ] || continue
      if jq -e --argjson id "$id" 'any(.[]; .id == $id)' "$f" >/dev/null; then
        jq -c --argjson id "$id" 'map(select(.id != $id))' "$f" >"$f.tmp" && mv "$f.tmp" "$f"; hit=204; fi
    done; printf '%s' "$hit" ;;
  *) case "$url" in *'%{http_code}'*) printf '204' ;; *) printf '[]' ;; esac ;;
esac
SH
export CURL_LOG="$tmp/arb.curl.log"; : >"$CURL_LOG"
R=https://forge.test/api/v1
posts() { local n; n="$(grep -c "^POST .*/comments" "$CURL_LOG")" || true; echo "${n:-0}"; }

rm -rf "$COMMENTS_DIR"; rm -f "$FLEET_QUEUE_MARKS"; : >"$CURL_LOG"
check "arbitrate on an unmarked ticket posts one marker and says dispatch (rc 0, mark exposed)" \
  'fleet_dispatch_arbitrate $R Acme/alpha 10 boxA && [ "$(posts)" -eq 1 ] && [ -n "$FLEET_DISPATCH_ARB_MARK" ]'
check "the marker it posts names the TARGET host, not the dispatcher's" \
  '[ "$(fleet_queue_marks $R Acme/alpha 10 | cut -d" " -f2)" = boxA ]'
check "arbitrate AGAIN on the same ticket SKIPS it (rc 2), posting nothing — no duplicate run" \
  'fleet_dispatch_arbitrate $R Acme/alpha 10 boxA; rc=$?; [ "$rc" -eq 2 ] && [ "$(posts)" -eq 1 ] && [ "$FLEET_DISPATCH_ARB_HOLDER" = boxA ]'

# a peer host's live marker already stands -> skip (rc 2), name it, post nothing (#351)
rm -rf "$COMMENTS_DIR"; rm -f "$FLEET_QUEUE_MARKS"; : >"$CURL_LOG"; mkdir -p "$COMMENTS_DIR"
jq -cn --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '[{id:50, body:"fleet-dispatch host=boxB\n(automated)", created_at:$t}]' >"$COMMENTS_DIR/Acme_beta_issues_5.json"
check "arbitrate SKIPS a ticket carrying a PEER host's live marker (rc 2, names it, posts nothing)" \
  'fleet_dispatch_arbitrate $R Acme/beta 5 boxA; rc=$?; [ "$rc" -eq 2 ] && [ "$FLEET_DISPATCH_ARB_HOLDER" = boxB ] && [ "$(posts)" -eq 0 ]'

# fail-open like the host tick: a markers read that fails dispatches unarbitrated
rm -rf "$COMMENTS_DIR"; rm -f "$FLEET_QUEUE_MARKS"; : >"$CURL_LOG"
check "arbitrate fails OPEN (rc 0, empty mark, a stderr line) when the markers read fails" \
  'COMMENTS_GET_FAIL=1 fleet_dispatch_arbitrate $R Acme/alpha 10 boxA 2>"$tmp/arb.err"; rc=$?; [ "$rc" -eq 0 ] && [ -z "$FLEET_DISPATCH_ARB_MARK" ] && grep -q "unarbitrated" "$tmp/arb.err"'

# ── runner-queue backpressure (#373): per-host lag, gating, fail-open ─────────
# A free heavy slot does not mean the host's runner will pick a dispatched leg up
# soon; before a live offer the dispatcher estimates the host's runner-queue lag
# from the tracker (actions/runs?status=waiting, GOTCHAS 78) and treats a host over
# the ceiling as not free this pass. These drive the pure attribution + gating; the
# fleet-wide gather over per-repo api roots is fleet-dispatch.sh glue (its own test).
qnow=1000000
qruns="$(jq -cn --argjson now "$qnow" '{workflow_runs:[
  {display_title:"swarm boxA #10", name:"swarm", created:(($now-300)|todateiso8601)},
  {display_title:"swarm boxA #12", name:"swarm", created:(($now-120)|todateiso8601)},
  {display_title:"ci on boxD",     name:"ci",    created:(($now-30) |todateiso8601)},
  {display_title:"unrelated work", name:"ci",    created:(($now-9999)|todateiso8601)}
]}')"
lm="$(fleet_dispatch_lag_from_runs "$qruns" "$qnow" "boxA boxD")"
check "lag_from_runs keeps a host's OLDEST waiting leg (boxA 300s, not 120s)" '[ "$(jq -r ".boxA" <<<"$lm")" = 300 ]'
check "lag_from_runs attributes a leg to the host it names (boxD 30s)"        '[ "$(jq -r ".boxD" <<<"$lm")" = 30 ]'
check "lag_from_runs attributes a run naming no known host to nobody"         '[ "$(jq "keys|length" <<<"$lm")" = 2 ]'
check "lag_from_runs is {} over an empty runs set"                           '[ "$(fleet_dispatch_lag_from_runs "{\"workflow_runs\":[]}" "$qnow" boxA)" = "{}" ]'
check "lag_from_runs tolerates an unparseable created time (nothing inflated)" \
  '[ "$(fleet_dispatch_lag_from_runs "{\"workflow_runs\":[{\"display_title\":\"boxA\",\"created\":\"nope\"}]}" "$qnow" boxA)" = "{}" ]'
check "lag_from_runs does not match a host as a substring (boxA vs boxAA)" \
  '[ "$(fleet_dispatch_lag_from_runs "{\"workflow_runs\":[{\"display_title\":\"swarm boxAA #9\",\"created\":\"$(jq -rn "($qnow-300)|todateiso8601")\"}]}" "$qnow" boxA)" = "{}" ]'

export FLEET_DISPATCH_QUEUE_LAG_MAX=240
lm2='{"boxA":300,"boxD":30}'
check "backed_off_hosts names a host at/over the ceiling (boxA, 300>=240)"   '[ "$(fleet_dispatch_backed_off_hosts "$lm2")" = boxA ]'
check "backed_off_hosts omits a host under the ceiling (boxD, 30<240)"       '! fleet_dispatch_backed_off_hosts "$lm2" | grep -q boxD'
check "backed_off_hosts is empty when the check is disabled (MAX=0)"         '[ -z "$(FLEET_DISPATCH_QUEUE_LAG_MAX=0 fleet_dispatch_backed_off_hosts "$lm2")" ]'
check "backed_off_hosts is empty over an empty map"                         '[ -z "$(fleet_dispatch_backed_off_hosts "{}")" ]'
check "host_backed_off is true for a host over the ceiling"                  '_fleet_dispatch_host_backed_off boxA "$lm2"'
check "host_backed_off is false for a host under the ceiling"               '! _fleet_dispatch_host_backed_off boxD "$lm2"'
check "host_backed_off is false with no lagmap (pre-#373 default)"          '! _fleet_dispatch_host_backed_off boxA ""'

rm -f "$FLEET_DISPATCH_REPORTS"/*.json
fleet_dispatch_ingest "$(report boxA false "[$(slot 1 free)]")"
fleet_dispatch_ingest "$(report boxD false "[$(slot 1 free),$(slot 2 free)]")"
fsx="$(fleet_dispatch_free_slots "$lm2")"
check "free_slots drops a backed-off host's slots (boxA over the ceiling)"   '! jq -e "any(.[]; .host==\"boxA\")" <<<"$fsx" >/dev/null'
check "free_slots keeps a healthy host's slots (boxD under the ceiling)"     '[ "$(jq "[.[]|select(.host==\"boxD\")]|length" <<<"$fsx")" = 2 ]'
check "free_slots with no lagmap withholds nothing (pre-#373 behaviour)"     'jq -e "any(.[]; .host==\"boxA\")" <<<"$(fleet_dispatch_free_slots)" >/dev/null'

hlq="$(fleet_dispatch_host_lines "$lm2")"
check "host line names a backed-off host's runner-queue lag (#373)" \
  'grep "boxA" <<<"$hlq" | grep -qi "runner queue backed up" && grep "boxA" <<<"$hlq" | grep -q "300s"'
check "host line leaves a healthy host's free count untouched (boxD)" \
  'grep "boxD" <<<"$hlq" | grep -qi "free"'

# _fleet_dispatch_waiting_runs: the one queued-run curl, bounded + fail-open
shim curl <<'SH'
printf '%s\n' "$*" >>"$CURL_LOG"
case "$*" in *status=waiting*) printf '{"workflow_runs":[]}' ;; esac
SH
export CURL_LOG="$tmp/wr.curl.log"; : >"$CURL_LOG"
wr="$(_fleet_dispatch_waiting_runs https://forge.test/api/v1 Acme/alpha)"
check "waiting_runs reads the status=waiting queued view, paged + curl-timed" \
  'grep -q "actions/runs?status=waiting" "$CURL_LOG" && grep -q "page=1" "$CURL_LOG" && grep -q "max-time" "$CURL_LOG"'
check "waiting_runs returns the forge JSON"            '[ "$wr" = "{\"workflow_runs\":[]}" ]'
shim curl <<'SH'
exit 22
SH
check "waiting_runs fails open (rc 1, no output) when the read fails" \
  '! wr2="$(_fleet_dispatch_waiting_runs https://forge.test/api/v1 Acme/alpha 2>/dev/null)"; [ -z "${wr2:-}" ]'

# ── #384: one run per repo per host ──────────────────────────────────────────
# A host works at most one run of a repo (the workflow's per-repo workdir lock),
# so the allocator never sends a host a second pick of a repo it already runs.
o384='[{"repo":"Acme/alpha","number":1},{"repo":"Acme/alpha","number":2},{"repo":"Acme/alpha","number":3},{"repo":"Acme/beta","number":9}]'
f384='[{"host":"boxA","n":1,"path":"/s/1"},{"host":"boxA","n":2,"path":"/s/2"},{"host":"boxB","n":1,"path":"/s/1"},{"host":"boxB","n":2,"path":"/s/2"}]'
d384="$(fleet_dispatch_allocate "$o384" "$f384")"
check "#384 two same-repo picks in one pass land on DIFFERENT hosts" \
  '[ "$(jq -c "[.[0].host,.[1].host]" <<<"$d384")" = "[\"boxA\",\"boxB\"]" ]'
check "#384 a third same-repo pick is queued though slots are still free" \
  '[ "$(jq -r ".[2].placed" <<<"$d384")" = false ]'
check "#384 its reason names the one-run-per-repo-per-host rule" \
  'jq -r ".[2].reason" <<<"$d384" | grep -q "already running a Acme/alpha run" && jq -r ".[2].reason" <<<"$d384" | grep -q "#384"'
check "#384 a different repo behind it still takes a free slot the blocked pick left" \
  '[ "$(jq -r ".[3].placed" <<<"$d384")" = true ] && [ "$(jq -r ".[3].host" <<<"$d384")" = boxA ] && [ "$(jq -r ".[3].slot" <<<"$d384")" = 2 ]'
h384='[{"host":"boxA","repo":"Acme/alpha","number":77}]'
dh="$(fleet_dispatch_allocate "$o384" "$f384" "$h384")"
check "#384 a host already running the repo is skipped for the head pick" \
  '[ "$(jq -r ".[0].host" <<<"$dh")" = boxB ] && [ "$(jq -r ".[1].placed" <<<"$dh")" = false ]'
check "#384 the held host still takes another repo's pick" \
  '[ "$(jq -r ".[3].host" <<<"$dh")" = boxA ]'
check "#384 a pick's OWN held entry never blocks it (the re-offer is the marker's business, #365)" \
  '[ "$(jq -r ".[0].host" <<<"$(fleet_dispatch_allocate "$o384" "$f384" "[{\"host\":\"boxA\",\"repo\":\"Acme/alpha\",\"number\":1}]")")" = boxA ]'
check "#384 a garbled held list is ignored (allocates as if none held)" \
  '[ "$(jq -r ".[0].host" <<<"$(fleet_dispatch_allocate "$o384" "$f384" "not json")")" = boxA ]'

# held_repos: a busy ticket holder counts, a session holder and a free slot do not,
# and a recent placement counts until its TTL passes.
rm -f "$FLEET_DISPATCH_REPORTS"/*.json "$(_fleet_dispatch_placed_path)"
fleet_dispatch_ingest "$(report boxA false "[$(slot 1 busy 10 Acme/alpha),$(slot 2 free)]")"
sess="$(slot 1 busy 7 Acme/beta | jq -c '.holder.kind = "session"')"
fleet_dispatch_ingest "$(report boxB false "[$sess,$(slot 2 free)]")"
hr="$(fleet_dispatch_held_repos)"
check "#384 held_repos names a busy ticket holder's host+repo" 'jq -e "any(.[]; .host==\"boxA\" and .repo==\"Acme/alpha\")" <<<"$hr" >/dev/null'
check "#384 held_repos skips a session holder (no workdir lock)" '! jq -e "any(.[]; .host==\"boxB\")" <<<"$hr" >/dev/null'
fleet_dispatch_placed_record Acme/gamma boxB 4
hr2="$(fleet_dispatch_held_repos)"
check "#384 a recent placement is held before its leg takes the slot" 'jq -e "any(.[]; .host==\"boxB\" and .repo==\"Acme/gamma\")" <<<"$hr2" >/dev/null'
hr3="$(FLEET_DISPATCH_NOW=$(( $(_fleet_dispatch_now) + FLEET_DISPATCH_PLACED_TTL + 1 )) fleet_dispatch_held_repos)"
check "#384 a placement past its TTL no longer holds the host" '! jq -e "any(.[]; .repo==\"Acme/gamma\")" <<<"$hr3" >/dev/null'
FLEET_DISPATCH_NOW=$(( $(_fleet_dispatch_now) + FLEET_DISPATCH_PLACED_TTL + 1 )) fleet_dispatch_placed_record Acme/delta boxA 6
check "#384 recording a placement prunes the expired ones" '[ "$(wc -l <"$(_fleet_dispatch_placed_path)")" = 1 ]'
check "#384 held_repos is [] with no reports and no placements" \
  'rm -f "$FLEET_DISPATCH_REPORTS"/*.json "$(_fleet_dispatch_placed_path)"; [ "$(fleet_dispatch_held_repos)" = "[]" ]'

echo "fleet-dispatch-lib-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
