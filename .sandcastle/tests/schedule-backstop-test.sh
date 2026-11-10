#!/usr/bin/env bash
# Offline test for schedule-backstop.sh's WAITING-AWARE dispatch guard (#238
# AC3). Run: bash .sandcastle/tests/schedule-backstop-test.sh
#
# Before #238 the backstop counted only STARTED runs (run_started_at within the
# window). On the capacity-1 runner that serves two repos a dispatch sits
# `status=waiting` for hours behind the busy host, so every tick re-dispatched a
# workflow whose earlier dispatch was still queued — duplicates piled up. The
# fix treats an in-flight run (`waiting` OR `running`) as "already covered" and
# skips. This pins that: a waiting/running run SUPPRESSES dispatch, while a truly
# idle scheduler (no run of any status in range) still gets a dispatch.
#
# curl is shimmed on PATH: it serves a canned runs listing on the GET, and logs
# any dispatch POST to $DISPATCH_LOG so the assertion can see whether the
# backstop fired.
#
# Two views (GOTCHAS 78): `actions/tasks` ($RUNS_JSON) holds only PICKED jobs —
# the forge mints a task row when a runner takes the job, so a queued run never
# appears there (the `"status":"waiting"` task rows the #238 scenarios feed are
# a shape the live forge does not produce; they stay as the legacy guard).
# `runs?status=waiting` ($WAITING_JSON) is where a queued run lives, and the
# 2026-10-15 scenarios below pin that it suppresses dispatch on its own.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"

# The shim: GET .../actions/tasks... -> $RUNS_JSON; POST .../dispatches -> log it
# and emit nothing. Any other URL is an unexpected call and fails the shim.
cat > "$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
url="" ; method=GET
while [ $# -gt 0 ]; do
  case "$1" in
    -X) method="$2"; shift 2 ;;
    -H|-d|--max-time) [ "$1" = -d ] && method=POST; shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  *actions/tasks*) cat "$RUNS_JSON" ;;
  # The queued-runs read (2026-10-15 flood): `runs?status=waiting` is the ONLY
  # view a queued-but-unpicked run appears in. $WAITING_JSON when set (and
  # WAITING_DOWN=1 fails it like a 5xx); an empty queue otherwise.
  *actions/runs*status=waiting*)
    [ "${WAITING_DOWN:-0}" = 1 ] && exit 22
    if [ -n "${WAITING_JSON:-}" ] && [ -f "$WAITING_JSON" ]; then cat "$WAITING_JSON"; else printf '{"total_count":0,"workflow_runs":[]}'; fi ;;
  *dispatches*) printf 'dispatched %s\n' "$url" >> "$DISPATCH_LOG" ;;
  *) echo "fake curl: unhandled $method $url" >&2; exit 22 ;;
esac
SH
chmod +x "$tmp/bin/curl"

run_backstop() { # run_backstop <runs-json-file> [workflow-file]
  : > "$tmp/dispatch.log"
  env PATH="$tmp/bin:$PATH" FORGEJO_TOKEN=dummy \
    FORGEJO_API=http://x/api/v1/repos/Matou/idss \
    RUNS_JSON="$1" DISPATCH_LOG="$tmp/dispatch.log" \
    bash "$here/../schedule-backstop.sh" "${2:-swarm.yml}" 25
}
dispatched() { [ -s "$tmp/dispatch.log" ]; }

old="$(date -u -d '-90 minutes' +%Y-%m-%dT%H:%M:%SZ)"     # outside a 25m window
fresh="$(date -u -d '-5 minutes' +%Y-%m-%dT%H:%M:%SZ)"    # inside a 25m window

# --- AC3: a WAITING run (queued, never started) SUPPRESSES dispatch -----------
# run_started_at empty and its earlier sibling started long ago — the pre-#238
# code would have re-dispatched. The waiting clause must catch it.
cat > "$tmp/waiting.json" <<JSON
{"workflow_runs":[
  {"name":"swarm","status":"waiting","run_started_at":""},
  {"name":"swarm","status":"success","run_started_at":"$old"}
]}
JSON
run_backstop "$tmp/waiting.json" >/dev/null
dispatched && fail "a waiting swarm run must SUPPRESS a new dispatch (#238 AC3)"
pass=$((pass+1))

# --- a RUNNING run (started before the window, still executing) suppresses -----
cat > "$tmp/running.json" <<JSON
{"workflow_runs":[{"name":"swarm","status":"running","run_started_at":"$old"}]}
JSON
run_backstop "$tmp/running.json" >/dev/null
dispatched && fail "a running swarm run must SUPPRESS a new dispatch"
pass=$((pass+1))

# --- a truly idle scheduler (only old, finished runs) STILL dispatches ---------
# This is the whole point of the backstop; the fix must not have broken it.
cat > "$tmp/idle.json" <<JSON
{"workflow_runs":[{"name":"swarm","status":"success","run_started_at":"$old"}]}
JSON
run_backstop "$tmp/idle.json" >/dev/null
dispatched || fail "no run of any status in range must still DISPATCH (backstop's job)"
pass=$((pass+1))

# --- a fresh STARTED run (Forgejo's own scheduler working) suppresses ----------
cat > "$tmp/recent.json" <<JSON
{"workflow_runs":[{"name":"swarm","status":"success","run_started_at":"$fresh"}]}
JSON
run_backstop "$tmp/recent.json" >/dev/null
dispatched && fail "a run started within the window must SUPPRESS dispatch (regression guard)"
pass=$((pass+1))

# --- a waiting run for a DIFFERENT workflow does not suppress swarm ------------
cat > "$tmp/other.json" <<JSON
{"workflow_runs":[{"name":"watchdog","status":"waiting","run_started_at":""}]}
JSON
run_backstop "$tmp/other.json" >/dev/null
dispatched || fail "a waiting run for another workflow must not suppress swarm's dispatch"
pass=$((pass+1))

# --- a MATRIX-SUFFIXED running run ("swarm (1)") suppresses dispatch (#588) ----
# swarm.yml's 2-wide worker matrix (44fe333) makes Forgejo name each matrix job
# "swarm (1)"/"swarm (2)", never bare "swarm" (live-probed 2026-08-15, same
# finding as #541's claim_alive_runs). A pre-fix exact-match filter never sees
# this as in-flight and re-dispatches on top of already-running matrix workers.
cat > "$tmp/matrix.json" <<JSON
{"workflow_runs":[{"name":"swarm (1)","status":"running","run_started_at":"$old"}]}
JSON
run_backstop "$tmp/matrix.json" >/dev/null
dispatched && fail "a matrix-suffixed running swarm run ('swarm (1)') must SUPPRESS dispatch (#588)"
pass=$((pass+1))

# --- GOTCHAS 62: per-HOST legs — another host's leg never silences THIS host --
# swarm.yml renders one leg per pool host, named "swarm (<host label>)". With
# HOST_NAME set (the generated backstop-tick.sh exports the registry name), a
# leg that belongs to ANOTHER host — mid-ticket for two hours — must not count
# as "in flight" for this one, or the idle host's backstop sits silent for the
# whole ticket: the exact starvation the per-host legs exist to end.
cat > "$tmp/other-host.json" <<JSON
{"workflow_runs":[{"name":"swarm (matou-workstation)","status":"running","run_started_at":"$old"}]}
JSON
HOST_NAME=bens-mac-04 run_backstop "$tmp/other-host.json" >/dev/null
dispatched || fail "another host's running leg ('swarm (matou-workstation)') must NOT suppress this host's dispatch when HOST_NAME is set (GOTCHAS 62)"
pass=$((pass+1))

# this host's OWN leg in flight (waiting or running) still suppresses
cat > "$tmp/own-host.json" <<JSON
{"workflow_runs":[{"name":"swarm (bens-mac-04)","status":"waiting","run_started_at":""}]}
JSON
HOST_NAME=bens-mac-04 run_backstop "$tmp/own-host.json" >/dev/null
dispatched && fail "this host's own waiting leg ('swarm (bens-mac-04)') must SUPPRESS dispatch"
pass=$((pass+1))

# a legacy numeric leg (a consumer not yet re-rendered) still suppresses with
# HOST_NAME set — the old shape keeps the old guard.
HOST_NAME=bens-mac-04 run_backstop "$tmp/matrix.json" >/dev/null
dispatched && fail "a legacy numeric leg ('swarm (1)') must still SUPPRESS dispatch when HOST_NAME is set"
pass=$((pass+1))

# a host label is never a substring match: "swarm (bens-mac-04-lan)" is not us
cat > "$tmp/near-host.json" <<JSON
{"workflow_runs":[{"name":"swarm (bens-mac-04-lan)","status":"running","run_started_at":"$old"}]}
JSON
HOST_NAME=bens-mac-04 run_backstop "$tmp/near-host.json" >/dev/null
dispatched || fail "a leg named for a host whose label merely CONTAINS ours must not suppress dispatch"
pass=$((pass+1))

# without HOST_NAME (a tick predating the export) the any-suffix guard holds:
# another host's leg still suppresses — the pre-62 behaviour, never a storm.
run_backstop "$tmp/other-host.json" >/dev/null
dispatched && fail "with HOST_NAME unset, any suffixed running leg must still SUPPRESS dispatch (legacy guard)"
pass=$((pass+1))

# --- #190: a workflow whose JOB name differs from its FILE stem --------------
# resume-asks.yml's job is named `resume`, so the runs listing reports .name
# "resume", never "resume-asks". Before the job-name mapping the guard searched
# for "resume-asks", matched nothing, and dispatched on EVERY tick — 3x the
# designed :10/:40 cadence in every repo whose registry carries this backstop.
# A real in-flight `resume` run must SUPPRESS the dispatch.
cat > "$tmp/resume-running.json" <<JSON
{"workflow_runs":[{"name":"resume","status":"running","run_started_at":"$old"}]}
JSON
run_backstop "$tmp/resume-running.json" resume-asks.yml >/dev/null
dispatched && fail "a running 'resume' job must SUPPRESS resume-asks.yml's dispatch (#190 — job name differs from file stem)"
pass=$((pass+1))

# a WAITING resume run (queued behind the busy host) also suppresses
cat > "$tmp/resume-waiting.json" <<JSON
{"workflow_runs":[{"name":"resume","status":"waiting","run_started_at":""}]}
JSON
run_backstop "$tmp/resume-waiting.json" resume-asks.yml >/dev/null
dispatched && fail "a waiting 'resume' job must SUPPRESS resume-asks.yml's dispatch (#190)"
pass=$((pass+1))

# a 'resume' run started within the window (Forgejo's own :10/:40 cron working)
# suppresses too — the no-op-while-scheduler-alive property, for this workflow.
cat > "$tmp/resume-recent.json" <<JSON
{"workflow_runs":[{"name":"resume","status":"success","run_started_at":"$fresh"}]}
JSON
run_backstop "$tmp/resume-recent.json" resume-asks.yml >/dev/null
dispatched && fail "a 'resume' run started within the window must SUPPRESS resume-asks.yml's dispatch (#190)"
pass=$((pass+1))

# with NO in-flight/recent resume run, the backstop still DISPATCHES — the
# no-op-when-scheduler-silent property is preserved for this workflow too.
cat > "$tmp/resume-idle.json" <<JSON
{"workflow_runs":[{"name":"resume","status":"success","run_started_at":"$old"}]}
JSON
run_backstop "$tmp/resume-idle.json" resume-asks.yml >/dev/null
dispatched || fail "no in-flight/recent 'resume' run must still DISPATCH resume-asks.yml (backstop's job, #190)"
pass=$((pass+1))

# --- the 2026-10-15 flood: a QUEUED run is invisible to the tasks view ---------
# `actions/tasks` lists ActionTask rows, and Forgejo mints a task only when a
# runner PICKS the job (CreateTaskForRunner). A run whose job is still queued —
# a stalled runner, a saturated host — has NO task row, so the tasks-only guard
# above read "idle" while hundreds of runs sat `waiting`, and re-dispatched on
# every tick: backstop.log 04Z 2026-10-15 = 101 dispatches / 15 skips against
# the normal 24 / 92, ~4x the run rate across every repo the tick serves, and a
# 1h45m oldest-first lag on the forge's global queue. The queued run shows up
# ONLY in `runs?status=waiting` (the canary's saturation read, GOTCHAS 34). A
# waiting run of THIS workflow must SUPPRESS the dispatch even when the tasks
# view is idle.
cat > "$tmp/queued.json" <<JSON
{"total_count":1,"workflow_runs":[{"id":172341,"workflow_id":"swarm.yml","status":"waiting","created":"$old"}]}
JSON
WAITING_JSON="$tmp/queued.json" run_backstop "$tmp/idle.json" >/dev/null
dispatched && fail "a QUEUED swarm.yml run (runs?status=waiting, no task row) must SUPPRESS dispatch even when the tasks view is idle (2026-10-15 flood)"
pass=$((pass+1))

# a queued run of ANOTHER workflow does not suppress this one
cat > "$tmp/queued-other.json" <<JSON
{"total_count":1,"workflow_runs":[{"id":172342,"workflow_id":"triage.yml","status":"waiting","created":"$old"}]}
JSON
WAITING_JSON="$tmp/queued-other.json" run_backstop "$tmp/idle.json" >/dev/null
dispatched || fail "a queued run of another workflow (triage.yml) must not suppress swarm.yml's dispatch"
pass=$((pass+1))

# the queued-runs read keys on the workflow FILE (`.workflow_id`), not the job
# name: resume-asks.yml's queued run suppresses resume-asks.yml.
cat > "$tmp/queued-resume.json" <<JSON
{"total_count":1,"workflow_runs":[{"id":172343,"workflow_id":"resume-asks.yml","status":"waiting","created":"$old"}]}
JSON
WAITING_JSON="$tmp/queued-resume.json" run_backstop "$tmp/resume-idle.json" resume-asks.yml >/dev/null
dispatched && fail "a queued resume-asks.yml run must SUPPRESS resume-asks.yml's dispatch (keyed on .workflow_id)"
pass=$((pass+1))

# the queued-runs read failing (a degraded forge) fails CLOSED like the tasks
# read: we cannot tell "nothing queued" from "could not look", and dispatching
# blind is the flood.
WAITING_DOWN=1 run_backstop "$tmp/idle.json" >/dev/null
dispatched && fail "a failed runs?status=waiting read must SKIP the tick (fail closed), never dispatch blind"
pass=$((pass+1))

# --- #45: order-repos lists repos STALEST-first, missing stamp first of all ----
# The freed-slot fairness the generated host backstop-tick.sh dispatches in.
# alpha evaluated 2m ago, beta 90m ago, gamma never (no stamp): the order must
# be gamma (missing = stalest of all), then beta, then alpha.
odir="$tmp/lastready"; mkdir -p "$odir"
oprefix="$odir/matou-swarm-lastready-"
: > "${oprefix}Acme-alpha"; touch -d '-2 minutes'  "${oprefix}Acme-alpha"
: > "${oprefix}Acme-beta";  touch -d '-90 minutes' "${oprefix}Acme-beta"
# gamma: no stamp file at all
order="$(SWARM_LASTREADY_PREFIX="$oprefix" \
  bash "$here/../schedule-backstop.sh" order-repos Acme/alpha Acme/beta Acme/gamma)"
[ "$order" = "$(printf 'Acme/gamma\nAcme/beta\nAcme/alpha')" ] \
  || fail "order-repos must list stalest first, missing stamp first of all (got: $(printf '%s' "$order" | tr '\n' ' '))"
pass=$((pass+1))

# two never-evaluated repos keep INPUT order (stable) — deterministic dispatch.
order2="$(SWARM_LASTREADY_PREFIX="$tmp/none-" \
  bash "$here/../schedule-backstop.sh" order-repos Zed/one Zed/two)"
[ "$order2" = "$(printf 'Zed/one\nZed/two')" ] \
  || fail "two missing-stamp repos must keep input order (got: $(printf '%s' "$order2" | tr '\n' ' '))"
pass=$((pass+1))

# order-repos is PURE: it needs neither a token nor the tasks API (it exits
# before sourcing swarm-identity), so it must dispatch NOTHING.
: > "$tmp/dispatch.log"
SWARM_LASTREADY_PREFIX="$oprefix" \
  bash "$here/../schedule-backstop.sh" order-repos Acme/alpha >/dev/null
dispatched && fail "order-repos must never dispatch a workflow"
pass=$((pass+1))

echo "schedule-backstop: $pass scenarios passed"
