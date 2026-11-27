#!/usr/bin/env bash
# Offline test for fleet-slot-report-lib.sh — a pool host's slot report
# (ADR 0009, slice 1 / #354). Drives the real build/send over fake slot locks,
# fake holder sidecars and a CRAFTED /proc/locks (the probe.py seam), with a
# shimmed curl for the push. No network, no docker, no real /proc/locks
# dependency. Run: bash tests/fleet-slot-report-lib-test.sh
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"
sc="$here/.."

tmp="$(tmpdir)"
# Pin every host-global path at tmp BEFORE sourcing — a real drive reservation
# or slot lock can be live on the host running this suite (the #664 lesson the
# fleet-queue suite states).
export HOST_CAPACITY_STATE_DIR="$tmp/state"
export HOST_CAPACITY_SLOTS="$tmp/state/slot-1.lock $tmp/state/slot-2.lock"
export HOST_CAPACITY_DRIVE_WANTED="$tmp/state/drive-wanted"
export FLEET_SLOT_REPORT_PROC_LOCKS="$tmp/proclocks"
export FLEET_DISPATCHER_URL=""
export SWARM_HOST="testbox"
mkdir -p "$tmp/state"
# shellcheck source=../fleet-slot-report-lib.sh
. "$sc/fleet-slot-report-lib.sh"

: >"$tmp/state/slot-1.lock"
: >"$tmp/state/slot-2.lock"

# craft /proc/locks: slot-1 held, slot-2 free. The key is the device column the
# lib computes; surround it with the real field spacing so the whole-field match
# is exercised.
write_locks() { # <held-slot-path>...
  : >"$tmp/proclocks"
  local i=1 p k
  for p in "$@"; do
    k="$(fleet_slot_report_lock_key "$p")"
    printf '%d: FLOCK  ADVISORY  WRITE 12345 %s 0 EOF\n' "$i" "$k" >>"$tmp/proclocks"
    i=$((i + 1))
  done
}

# ── a ticket run holds slot 1, slot 2 free ──────────────────────────────────
jq -cn '{kind:"ticket",ref:"354",repo:"Acme/alpha",worker:"swarm-worker",
         pid:'"$$"',host:"testbox",since:1700000000,run_id:"r1",
         attempts_dir:null}' >"$tmp/state/slot-1.lock.holder"
write_locks "$tmp/state/slot-1.lock"

r="$(fleet_slot_report_build tick testbox)"
check "report is valid JSON"            'printf "%s" "$r" | jq -e . >/dev/null'
check "report_version is the constant"  '[ "$(jq -r .report_version <<<"$r")" = "$FLEET_SLOT_REPORT_VERSION" ]'
check "event is tick"                   '[ "$(jq -r .event <<<"$r")" = tick ]'
check "host carried through"            '[ "$(jq -r .host <<<"$r")" = testbox ]'
check "now is an epoch int"             'jq -e ".now|type==\"number\"" <<<"$r" >/dev/null'
check "two slots reported"              '[ "$(jq ".slots|length" <<<"$r")" = 2 ]'
check "drive_reserved false"            '[ "$(jq -r .drive_reserved <<<"$r")" = false ]'
check "ended null on tick"              '[ "$(jq -r .ended <<<"$r")" = null ]'

check "slot 1 is busy"                  '[ "$(jq -r ".slots[0].state" <<<"$r")" = busy ]'
check "slot 1 holder kind ticket"       '[ "$(jq -r ".slots[0].holder.kind" <<<"$r")" = ticket ]'
check "slot 1 issue resolved from ref"  '[ "$(jq -r ".slots[0].issue" <<<"$r")" = 354 ]'
check "slot 1 repo on the holder"       '[ "$(jq -r ".slots[0].holder.repo" <<<"$r")" = Acme/alpha ]'
check "slot 1 worker on the holder"     '[ "$(jq -r ".slots[0].holder.worker" <<<"$r")" = swarm-worker ]'
check "slot 1 pid_alive true"           '[ "$(jq -r ".slots[0].holder.pid_alive" <<<"$r")" = true ]'
check "slot 1 iteration null"           '[ "$(jq -r ".slots[0].iteration" <<<"$r")" = null ]'
check "slot 2 is free"                  '[ "$(jq -r ".slots[1].state" <<<"$r")" = free ]'
check "slot 2 holder null"              '[ "$(jq -r ".slots[1].holder" <<<"$r")" = null ]'

# ── orphan: slot held, but NO holder sidecar → unknown, never busy ──────────
rm -f "$tmp/state/slot-1.lock.holder"
r="$(fleet_slot_report_build tick testbox)"
check "held + no holder reads unknown"  '[ "$(jq -r ".slots[0].state" <<<"$r")" = unknown ]'

# ── a holder sidecar beside a FREE lock is a crash leftover → ignored ───────
jq -cn '{kind:"ticket",ref:"999",repo:"Acme/alpha",worker:"swarm-worker"}' \
  >"$tmp/state/slot-2.lock.holder"
r="$(fleet_slot_report_build tick testbox)"
check "free lock ignores a stale holder" \
  '[ "$(jq -r ".slots[1].state" <<<"$r")" = free ] && [ "$(jq -r ".slots[1].holder" <<<"$r")" = null ]'
rm -f "$tmp/state/slot-2.lock.holder"

# ── /proc/locks unreadable → every slot unknown, no lock taken ──────────────
# The override rides the function call INSIDE the substitution only (a bare
# `VAR=x r=$(...)` with no command word would clobber the suite's own setting).
r="$(FLEET_SLOT_REPORT_PROC_LOCKS="$tmp/does-not-exist" fleet_slot_report_build tick testbox)"
check "unreadable locks → slot unknown" '[ "$(jq -r ".slots[0].state" <<<"$r")" = unknown ]'

# ── ref=run, issue resolved from the in-sandbox claim sink (#350) ───────────
mkdir -p "$tmp/claims"
printf '770\n770\n' >"$tmp/claims/claimed.log"
jq -cn --arg d "$tmp/claims" '{kind:"ticket",ref:"run",repo:"Acme/beta",
   worker:"swarm-worker",pid:'"$$"',attempts_dir:$d}' >"$tmp/state/slot-1.lock.holder"
write_locks "$tmp/state/slot-1.lock"
r="$(fleet_slot_report_build tick testbox)"
check "ref=run issue from claimed.log"  '[ "$(jq -r ".slots[0].issue" <<<"$r")" = 770 ]'
# two distinct claims → no single pick, issue null (never a guess)
printf '770\n771\n' >"$tmp/claims/claimed.log"
r="$(fleet_slot_report_build tick testbox)"
check "ambiguous claim → issue null"    '[ "$(jq -r ".slots[0].issue" <<<"$r")" = null ]'

# ── the END report names the finishing ticket ──────────────────────────────
r="$(fleet_slot_report_build end testbox Acme/alpha 354)"
check "end event tag"                   '[ "$(jq -r .event <<<"$r")" = end ]'
check "ended.repo named"                '[ "$(jq -r .ended.repo <<<"$r")" = Acme/alpha ]'
check "ended.issue is an int"           '[ "$(jq -r ".ended.issue" <<<"$r")" = 354 ] && jq -e ".ended.issue|type==\"number\"" <<<"$r" >/dev/null'
r="$(fleet_slot_report_build end testbox)"
check "end with nothing closed → ended null" '[ "$(jq -r .ended <<<"$r")" = null ]'

# ── drive reservation surfaces in the report ───────────────────────────────
host_capacity_drive_reserve
r="$(fleet_slot_report_build tick testbox)"
check "drive_reserved true when reserved" '[ "$(jq -r .drive_reserved <<<"$r")" = true ]'
host_capacity_drive_release

# ── send: a no-op with no dispatcher, a POST with one (shimmed curl) ─────────
shim curl <<SH
# record argv + stdin so the test can assert the push shape
printf '%s\n' "\$*" >"$tmp/curl.args"
cat >"$tmp/curl.body"
# honour -w: print the http code the caller formats on
case "\$*" in *'%{http_code}'*) printf '200' ;; esac
SH

FLEET_DISPATCHER_URL="" fleet_slot_report_send '{"x":1}'
check "no URL → no curl called"         '[ ! -f "$tmp/curl.args" ]'

FLEET_DISPATCHER_URL="http://dispatcher.mesh:9000/report" \
FLEET_DISPATCHER_TOKEN="sekret" \
  fleet_slot_report_send '{"report_version":1,"event":"tick"}'
check "with URL curl is called"         '[ -f "$tmp/curl.args" ]'
check "pushes to the declared URL"      'grep -q "http://dispatcher.mesh:9000/report" "$tmp/curl.args"'
check "sends a POST"                     'grep -q -- "-X POST" "$tmp/curl.args"'
check "carries the bearer token"        'grep -q "Bearer sekret" "$tmp/curl.args"'
check "body is the report JSON"         '[ "$(jq -r .event <"$tmp/curl.body")" = tick ]'

# a non-2xx push is swallowed (rc 0) — a failed push never reds a tick
shim curl <<'SH'
case "$*" in *'%{http_code}'*) printf '503' ;; esac
SH
FLEET_DISPATCHER_URL="http://dispatcher.mesh:9000/report" \
  fleet_slot_report_send '{"event":"tick"}' 2>/dev/null
check "a 5xx push still returns rc 0"    '[ "$?" -eq 0 ]'

# ── the dispatcher's acknowledgement (ADR 0009 decision 4 / #356) ────────────
# A curl shim that echoes a crafted 2xx body + the http code the lib splits on
# ('\n%{http_code}'); $ACK_BODY / $ACK_CODE pick the response per case.
export FLEET_DISPATCH_ACK_STATE="$tmp/state/fleet-dispatch-ack"
shim curl <<'SH'
case "$*" in *'%{http_code}'*) printf '%s\n%s' "${ACK_BODY:-}" "${ACK_CODE:-200}" ;; esac
SH
ack_send() { FLEET_DISPATCHER_URL="http://dispatcher.mesh:9000/report" fleet_slot_report_send "$@" 2>/dev/null; }

# no dispatcher URL → no ack recorded at all (the fleet runs on its own ticks)
rm -f "$FLEET_DISPATCH_ACK_STATE"
FLEET_DISPATCHER_URL="" fleet_slot_report_send '{"event":"tick"}'
check "no dispatcher → no ack file → not acked_fresh" \
  '[ ! -f "$FLEET_DISPATCH_ACK_STATE" ] && ! fleet_slot_report_acked_fresh'

# a LIVE dispatcher's 200 (acting=true) → the host is acked_fresh (stands down)
rm -f "$FLEET_DISPATCH_ACK_STATE"
ACK_BODY='{"ok":true,"acting":true,"mode":"live"}' ACK_CODE=200 ack_send '{"event":"tick"}'
check "a live 2xx ack (acting=true) is recorded fresh" 'fleet_slot_report_acked_fresh'
check "the ack state stamps ok=true acting=true" \
  '[ "$(cut -d" " -f2,3 "$FLEET_DISPATCH_ACK_STATE")" = "true true" ]'

# a SHADOW dispatcher's 200 (acting=false) → NOT acked_fresh (host keeps ticking)
rm -f "$FLEET_DISPATCH_ACK_STATE"
ACK_BODY='{"ok":true,"acting":false,"mode":"shadow"}' ACK_CODE=200 ack_send '{"event":"tick"}'
check "a shadow 2xx ack (acting=false) is not acked_fresh" '! fleet_slot_report_acked_fresh'
check "a shadow ack still records ok=true acting=false" \
  '[ "$(cut -d" " -f2,3 "$FLEET_DISPATCH_ACK_STATE")" = "true false" ]'

# a 200 with no acting field (an older/dumb body) reads acting=false, never fresh
rm -f "$FLEET_DISPATCH_ACK_STATE"
ACK_BODY='{"ok":true}' ACK_CODE=200 ack_send '{"event":"tick"}'
check "a 200 with no acting field defaults to not-acting" '! fleet_slot_report_acked_fresh'

# a 5xx push → a DEAD ack, so the next tick resumes at once (not at the TTL)
rm -f "$FLEET_DISPATCH_ACK_STATE"
ACK_BODY='' ACK_CODE=503 ack_send '{"event":"tick"}'
check "a 5xx push records a dead ack (ok=false) → not acked_fresh" \
  '! fleet_slot_report_acked_fresh && [ "$(cut -d" " -f2 "$FLEET_DISPATCH_ACK_STATE")" = false ]'

# a previously-acting ack goes stale past the TTL → the host resumes
rm -f "$FLEET_DISPATCH_ACK_STATE"
ACK_BODY='{"ok":true,"acting":true,"mode":"live"}' ACK_CODE=200 ack_send '{"event":"tick"}'
check "within the TTL the live ack is still fresh" 'fleet_slot_report_acked_fresh'
printf '%s true true\n' "$(( $(date +%s) - FLEET_DISPATCH_ACK_TTL - 10 ))" >"$FLEET_DISPATCH_ACK_STATE"
check "an ack older than the TTL is stale (host resumes its own tick)" '! fleet_slot_report_acked_fresh'
# a malformed ack line is treated as no ack (fail toward today's behaviour)
printf 'garbage line\n' >"$FLEET_DISPATCH_ACK_STATE"
check "a malformed ack line → not acked_fresh" '! fleet_slot_report_acked_fresh'

# acked_fresh reads OUR clock, so a dispatcher clock far in the future cannot
# forge freshness: the receipt time we stamp is what counts (we just proved a
# live 2xx stamps now and reads fresh — the dispatcher's own clock is unread).

echo "fleet-slot-report-lib-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
