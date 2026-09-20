#!/usr/bin/env bash
# collector-test.sh — the factory-floor collector's OFFLINE guard from the bash
# side (issue #150). fleet-tui/collector.py composes fleet-tui's existing pure
# poll/parse functions into one versioned JSON document for the browser floor.
#
# fleet-tui/ is operator-side and vendor-excluded (onboarding/vendor-exclude),
# so it is ABSENT from a consumer's .sandcastle/ checkout even though this suite
# IS vendored there (tests/**). Skip LOUDLY rather than fail on a missing dir —
# matching fleet-tui-test.sh's posture — so a consumer's "run every vendored
# suite" contract stays honest. Factory-side the dir is present and it runs.
#
# The collector is Textual-free by construction, so — unlike the pytest suite,
# which needs a venv and SKIPs in this loop — the composition CAN be exercised
# end to end here with only python3 + a shimmed `ssh`, no network, no docker.
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
fleet="$repo/fleet-tui"

if [ ! -d "$fleet" ]; then
  echo "collector-test: SKIPPED — fleet-tui/ is operator-side and vendor-excluded,"
  echo "  so it is absent from this (consumer) checkout. Nothing to check here."
  exit 0
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "collector-test: SKIPPED — no python3 on PATH."
  exit 0
fi

pass=0 fail=0
check() { if eval "$2"; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: $1"; fi; }

check "collector.py exists" '[ -f "$fleet/collector.py" ]'

# The collector must never import app.py (textual): a floor collector that drags
# in the TUI framework would not run headless on the operator box.
check "collector.py never imports app" \
  '! grep -qE "^\s*(from app import|import app\b)" "$fleet/collector.py"'

# ── the assembly: mocked transport in, one JSON document out ────────────────
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

PYTHONDONTWRITEBYTECODE=1 python3 - "$fleet" >"$work/doc.json" <<'PY'
import json, os, sys
fleet = sys.argv[1]
sys.path.insert(0, fleet)
import collector, fleetconf

NOW = 1_700_000_000
conf = fleetconf.FleetConf(api="https://f/api", repos=["Acme/widget"])
conf.hosts = [fleetconf.HostEntry("box-a", "agent@box-a"),
              fleetconf.HostEntry("dead", "agent@dead")]

def poller(entry, spend_since, cache):
    if entry.name == "dead":
        return {"ok": False, "error": "ssh rc 255: no route"}
    cache["registry"] = {"heavy_slots": 2}
    blob = {"runs": [{"run_id": "r1", "repo": "Acme/widget",
                      "started_at": NOW - 100, "ended_at": None}],
            "attempts": [{"run_id": "r1", "issue": 42, "iteration": 2}],
            "processes": [],
            "slots": [{"path": "/l/1", "held": True, "pid_alive": True,
                       "holder": {"kind": "ticket", "run_id": "r1",
                                  "repo": "Acme/widget", "worker": "healer"},
                       "holder_error": None},
                      {"path": "/l/2", "held": False, "holder": None}]}
    return {"ok": True, "blob": blob, "registry": {"heavy_slots": 2},
            "capacity": {"HOST_HEAVY_SLOTS": "2"}}

q = [{"repo": "Acme/widget", "number": 5, "state": "ready-for-agent",
      "blocked": False, "title": "t", "labels": []}]
asks = [{"repo": "Acme/widget", "number": 9, "state": "ready-for-human"}]
doc = collector.build_document(conf, "tok", {}, NOW, poller=poller,
                               queue_fn=lambda *a, **k: q,
                               asks_fn=lambda *a, **k: asks)
json.dump(doc, sys.stdout)
PY
check "build_document emitted a document" '[ -s "$work/doc.json" ]'

# Assert the SHAPE and snapshot_version, and — the metaphor mapping itself,
# never mocked — that the field each room reads is present with the right value.
assert_json() {
  python3 - "$work/doc.json" "$1" "$2" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
expr, want = sys.argv[2], sys.argv[3]
got = eval(expr, {"d": doc})
sys.exit(0 if repr(got) == want else (sys.stderr.write("  %s => %r (want %s)\n" % (expr, got, want)) or 1))
PY
}
# The version is a deliberate shape pin owned by collector.SNAPSHOT_VERSION, not
# a literal this gate re-declares — pinning it here just doubles the maintenance
# and (issue #153) goes stale on the next bump for the wrong reason. Derive it
# from the module the way the pytest twin does, and gate the property that is
# actually worth gating: the key is PRESENT and an INT, and equals the source.
check "snapshot_version is present, an int, and matches collector.SNAPSHOT_VERSION" \
  'PYTHONDONTWRITEBYTECODE=1 python3 - "$fleet" "$work/doc.json" <<'"'"'PY'"'"'
import json, sys
sys.path.insert(0, sys.argv[1])
import collector
doc = json.load(open(sys.argv[2]))
v = doc.get("snapshot_version")
if not isinstance(v, int):
    sys.stderr.write("  snapshot_version => %r (want an int)\n" % (v,)); sys.exit(1)
if v != collector.SNAPSHOT_VERSION:
    sys.stderr.write("  snapshot_version => %r (want %r from collector.SNAPSHOT_VERSION)\n"
                     % (v, collector.SNAPSHOT_VERSION)); sys.exit(1)
PY'
check "one row per heavy slot (2 live + 1 broken machine)" 'assert_json "len(d[\"hosts\"])" "3"'
check "slot 1 is a busy ticket holder" 'assert_json "d[\"hosts\"][0][\"slot_state\"]" "'"'"'busy'"'"'"'
check "holder carries its worker class id" 'assert_json "d[\"hosts\"][0][\"holder\"][\"worker\"]" "'"'"'healer'"'"'"'
check "unreachable host is a broken machine, not a blank floor" 'assert_json "d[\"hosts\"][2][\"host_state\"]" "'"'"'error'"'"'"'
check "runs are live busy-ticket attempts" 'assert_json "d[\"runs\"][0][\"issue\"]" "42"'
check "repos carry per-state counts" 'assert_json "d[\"repos\"][0][\"ready\"]" "1"'
check "inwards-goods total_ready is emitted" 'assert_json "d[\"total_ready\"]" "1"'
check "asks carry the parked ready-for-human threads" 'assert_json "d[\"asks\"][0][\"number\"]" "9"'
check "invisible_failure rides the healer class row (never re-derived)" \
  'assert_json "next(c[\"invisible_failure\"] for c in d[\"worker_classes\"][\"classes\"] if c[\"id\"]==\"healer\")" "True"'
check "cadence mirrors fleet-tui (15s host / 60s tracker)" \
  'assert_json "[d[\"host_interval_s\"], d[\"tracker_interval_s\"]]" "[15, 60]"'

# ── the CLI end to end: real hostpoll, offline via a shimmed `ssh` ──────────
# A one-shot run against a fleet.conf whose single host's ssh fails must still
# emit ONE well-formed document with that host as a broken machine — the CLI
# loop, hostpoll's read-only probe transport and snapshot's error path, proven
# without a live host or the network.
cat >"$work/ssh" <<'SH'
#!/usr/bin/env bash
echo "no route to host" >&2
exit 255
SH
chmod +x "$work/ssh"
cat >"$work/fleet.conf" <<'CONF'
host box-x agent@box-x
CONF
PATH="$work:$PATH" FLEET_CONF="$work/fleet.conf" \
  python3 "$fleet/collector.py" >"$work/cli.json" 2>"$work/cli.err"
cli_rc=$?
check "CLI one-shot exits 0 even with an unreachable host" '[ "$cli_rc" -eq 0 ]'
check "CLI emitted well-formed JSON" 'python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$work/cli.json"'
check "CLI names the FORGEJO_TOKEN gap rather than guessing a queue" \
  'python3 -c "import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d[\"tracker_error\"] else 1)" "$work/cli.json"'

echo "collector-test: $pass/$((pass + fail)) checks passed"
[ "$fail" -eq 0 ]
