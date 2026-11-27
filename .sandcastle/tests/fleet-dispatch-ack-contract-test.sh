#!/usr/bin/env bash
# fleet-dispatch-ack-contract-test.sh — the BOTH-ENDS contract for ADR 0009's
# acknowledgement (slice 3 / #356). The dispatcher answers every slot report; a
# LIVE dispatcher's answer says it is ACTING (it will allocate this host's free
# slots itself), and a host whose last report drew a fresh acting-ack stands its
# own fleet-queue tick down (decision 4). The ack body is produced by one end
# (the receiver, fleet-dispatch-receiver.py) and consumed by the other (the host
# producer, fleet-slot-report-lib.sh); this test wires them with no shim between
# the shapes, so the two ends can never grow an ack they disagree on — the
# precedent is the slot-report contract test (slice 1).
#
# The real dispatcher answers over a socket; here the receiver's own `--ack` seam
# prints the exact body a 200 carries (reading FLEET_DISPATCH_MODE), and a curl
# shim hands that VERBATIM back to the host's fleet_slot_report_send, which must
# then record the ack the host end reads. No network, no socket, no second parser.
# Run: bash tests/fleet-dispatch-ack-contract-test.sh
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"
sc="$here/.."

if ! command -v python3 >/dev/null 2>&1; then
  echo "fleet-dispatch-ack-contract-test: SKIPPED — no python3 on PATH."
  exit 0
fi

tmp="$(tmpdir)"
export HOST_CAPACITY_STATE_DIR="$tmp/state"
export HOST_CAPACITY_SLOTS="$tmp/state/slot-1.lock $tmp/state/slot-2.lock"
export HOST_CAPACITY_DRIVE_WANTED="$tmp/state/drive-wanted"
export FLEET_SLOT_REPORT_PROC_LOCKS="$tmp/proclocks"
export FLEET_DISPATCH_ACK_STATE="$tmp/state/fleet-dispatch-ack"
export FLEET_DISPATCHER_URL="http://dispatcher.mesh:8790/report"
mkdir -p "$tmp/state"
# shellcheck source=../fleet-slot-report-lib.sh
. "$sc/fleet-slot-report-lib.sh"

# The receiver's REAL ack body for a given mode (the one end).
ack_body() { env -u FLEET_DISPATCH_MODE ${1:+FLEET_DISPATCH_MODE="$1"} \
  python3 "$sc/fleet-dispatch-receiver.py" --ack; }
# The receiver's REAL ack body for <mode> <allowlist> <host> (stage 6b): what the
# dispatcher would answer a report FROM <host> given the live-host scope.
ack_body_for() { env -u FLEET_DISPATCH_MODE FLEET_DISPATCH_MODE="$1" FLEET_DISPATCH_LIVE_HOSTS="$2" \
  python3 "$sc/fleet-dispatch-receiver.py" --ack --host "$3"; }

# A curl shim that replays a chosen ack body + 200 the way the lib splits it
# ('\n%{http_code}') — $ACK_BODY is the receiver's own output, unchanged.
shim curl <<'SH'
case "$*" in *'%{http_code}'*) printf '%s\n200' "${ACK_BODY:-}" ;; esac
SH

report='{"report_version":1,"event":"tick","host":"mach-01","slots":[]}'

# ── live: the receiver's ack → the host stands its tick down ─────────────────
rm -f "$FLEET_DISPATCH_ACK_STATE"
body="$(ack_body live)"
check "receiver (live) emits a valid ack body" 'jq -e . <<<"$body" >/dev/null'
ACK_BODY="$body" fleet_slot_report_send "$report" 2>/dev/null
check "the host consumes the LIVE ack and is acked_fresh (stands down)" \
  'fleet_slot_report_acked_fresh'

# ── shadow: the receiver's ack → the host keeps ticking ──────────────────────
rm -f "$FLEET_DISPATCH_ACK_STATE"
body="$(ack_body shadow)"
ACK_BODY="$body" fleet_slot_report_send "$report" 2>/dev/null
check "the host consumes the SHADOW ack and is NOT acked_fresh (keeps ticking)" \
  '! fleet_slot_report_acked_fresh'

# ── default (no mode): shadow posture, the host keeps ticking ────────────────
rm -f "$FLEET_DISPATCH_ACK_STATE"
body="$(ack_body "")"
ACK_BODY="$body" fleet_slot_report_send "$report" 2>/dev/null
check "the default-mode ack never stands a host down by accident" \
  '! fleet_slot_report_acked_fresh'

# ── stage 6b (slice 4 / #357): live on ONE host — only that host stands down ──
# The report above is from host mach-01. A dispatcher live scoped to mach-01 acks
# it acting → mach-01 stands its tick down.
rm -f "$FLEET_DISPATCH_ACK_STATE"
body="$(ack_body_for live mach-01 mach-01)"
ACK_BODY="$body" fleet_slot_report_send "$report" 2>/dev/null
check "stage 6b: the in-scope host consumes an acting ack and stands down" \
  'fleet_slot_report_acked_fresh'
# The SAME live dispatcher, scoped to another host, acks mach-01 NOT acting →
# mach-01 keeps its own ADR 0007 tick (the other hosts stay on their ticks).
rm -f "$FLEET_DISPATCH_ACK_STATE"
body="$(ack_body_for live other-host mach-01)"
ACK_BODY="$body" fleet_slot_report_send "$report" 2>/dev/null
check "stage 6b: an out-of-scope host keeps ticking (not acked_fresh)" \
  '! fleet_slot_report_acked_fresh'

summary fleet-dispatch-ack-contract-test
