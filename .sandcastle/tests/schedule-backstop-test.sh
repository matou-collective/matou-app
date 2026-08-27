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
  *dispatches*) printf 'dispatched %s\n' "$url" >> "$DISPATCH_LOG" ;;
  *) echo "fake curl: unhandled $method $url" >&2; exit 22 ;;
esac
SH
chmod +x "$tmp/bin/curl"

run_backstop() { # run_backstop <runs-json-file>
  : > "$tmp/dispatch.log"
  env PATH="$tmp/bin:$PATH" FORGEJO_TOKEN=dummy \
    FORGEJO_API=http://x/api/v1/repos/Matou/idss \
    RUNS_JSON="$1" DISPATCH_LOG="$tmp/dispatch.log" \
    bash "$here/../schedule-backstop.sh" swarm.yml 25
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
