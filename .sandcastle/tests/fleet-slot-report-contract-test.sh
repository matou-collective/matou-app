#!/usr/bin/env bash
# fleet-slot-report-contract-test.sh — the BOTH-ENDS contract for ADR 0009's
# host slot report (slice 1 / #354). The report shape is defined once and must
# be the SAME description of a host's slots that fleet-tui already keeps, so the
# dispatcher (slice 2) and the Floor never grow two shapes that drift. This test
# proves it end to end: the real bash producer (fleet-slot-report-lib.sh) emits
# a report, and fleet-tui's OWN collector._host_rows / _run_rows consume its
# `slots` array unchanged — no shim between, no second parser.
#
# fleet-tui/ is operator-side and vendor-excluded, so it is ABSENT from a
# consumer's .sandcastle/ checkout even though this suite IS vendored there.
# Skip LOUDLY (collector-test.sh's posture) rather than fail on a missing dir,
# so a consumer's "run every vendored suite" contract stays honest; factory-side
# the dir is present and the contract is proven.
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"
sc="$here/.."
fleet="$sc/fleet-tui"

if [ ! -d "$fleet" ]; then
  echo "fleet-slot-report-contract-test: SKIPPED — fleet-tui/ is operator-side and"
  echo "  vendor-excluded, so it is absent from this (consumer) checkout."
  exit 0
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "fleet-slot-report-contract-test: SKIPPED — no python3 on PATH."
  exit 0
fi

tmp="$(tmpdir)"
export HOST_CAPACITY_STATE_DIR="$tmp/state"
export HOST_CAPACITY_SLOTS="$tmp/state/slot-1.lock $tmp/state/slot-2.lock"
export HOST_CAPACITY_DRIVE_WANTED="$tmp/state/drive-wanted"
export FLEET_SLOT_REPORT_PROC_LOCKS="$tmp/proclocks"
export FLEET_DISPATCHER_URL=""
mkdir -p "$tmp/state"
# shellcheck source=../fleet-slot-report-lib.sh
. "$sc/fleet-slot-report-lib.sh"

: >"$tmp/state/slot-1.lock"
: >"$tmp/state/slot-2.lock"
# slot 1: a swarm worker on Acme/alpha#354; slot 2 free.
jq -cn '{kind:"ticket",ref:"354",repo:"Acme/alpha",worker:"swarm-worker",
         pid:'"$$"',host:"mach-01",since:1700000000}' >"$tmp/state/slot-1.lock.holder"
k="$(fleet_slot_report_lock_key "$tmp/state/slot-1.lock")"
printf '1: FLOCK  ADVISORY  WRITE 42 %s 0 EOF\n' "$k" >"$tmp/proclocks"

report="$(fleet_slot_report_build tick mach-01)"
check "producer emits a valid report" 'printf "%s" "$report" | jq -e . >/dev/null'

# Feed the report's own slots into fleet-tui's collector, shaped as the per-host
# snapshot the collector reads ({state, slots}). If the collector can build its
# rows from our slots with no translation, the two ends share one description.
PYTHONDONTWRITEBYTECODE=1 python3 - "$fleet" "$report" >"$tmp/rows.json" <<'PY'
import json, sys
fleet, report_json = sys.argv[1], sys.argv[2]
sys.path.insert(0, fleet)
import collector
report = json.loads(report_json)
snaps = {report["host"]: {"state": "ok", "slots": report["slots"], "error": None}}
print(json.dumps({
    "host_rows": collector._host_rows(snaps),
    "run_rows": collector._run_rows(snaps),
}))
PY
check "collector consumed the report"    '[ -s "$tmp/rows.json" ] && jq -e . "$tmp/rows.json" >/dev/null'

rows="$tmp/rows.json"
check "collector drew two slot rows"      '[ "$(jq ".host_rows|length" "$rows")" = 2 ]'
check "slot 1 row is busy"                '[ "$(jq -r ".host_rows[0].slot_state" "$rows")" = busy ]'
check "slot 1 holder kind ticket"         '[ "$(jq -r ".host_rows[0].holder.kind" "$rows")" = ticket ]'
check "slot 1 holder issue 354"           '[ "$(jq -r ".host_rows[0].holder.issue" "$rows")" = 354 ]'
check "slot 1 holder repo Acme/alpha"     '[ "$(jq -r ".host_rows[0].holder.repo" "$rows")" = Acme/alpha ]'
check "slot 1 holder worker swarm-worker" '[ "$(jq -r ".host_rows[0].holder.worker" "$rows")" = swarm-worker ]'
check "slot 2 row is free"                '[ "$(jq -r ".host_rows[1].slot_state" "$rows")" = free ]'
# _run_rows is the Floor's agent-work-in-flight view: one row per busy ticket slot.
check "one run row for the ticket slot"   '[ "$(jq ".run_rows|length" "$rows")" = 1 ]'
check "run row names the issue"           '[ "$(jq -r ".run_rows[0].issue" "$rows")" = 354 ]'
check "run row names the repo"            '[ "$(jq -r ".run_rows[0].repo" "$rows")" = Acme/alpha ]'

echo "fleet-slot-report-contract-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
