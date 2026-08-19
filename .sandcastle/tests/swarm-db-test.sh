#!/usr/bin/env bash
# Offline tests for the swarm.db trace mirror (#447, L4): the SQLite engine
# (swarm-db.py), the best-effort bash writers (swarm-db-lib.sh), and the reader
# (swarm-db.sh). Run: bash .sandcastle/tests/swarm-db-test.sh
#
# The db is a MIRROR — losing it must lose nothing — so the writers are proven
# to NEVER fail their caller, and the two invariants are pinned as law: status
# defaults to fail (a crash can never read green), and kills finalise the trace
# (nothing reads 'running' forever). A green run, a red run, and a killed run
# each leave correct finalised rows; the #435 wedge leaves an UNFINALISED
# processes row that `open-processes` surfaces.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
py="$root/swarm-db.py"
reader="$root/swarm-db.sh"

fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0

command -v python3 >/dev/null 2>&1 || fail "python3 is required to run these tests"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
export SWARM_DB="$tmp/swarm.db"
# The writers resolve the engine relative to swarm-db-lib.sh, so sourcing it
# from the real tree points at the real swarm-db.py.
# shellcheck source=../swarm-db-lib.sh
. "$root/swarm-db-lib.sh"

db() { python3 "$py" --db "$SWARM_DB" "$@"; }
# one-value SQL read straight against the db (asserts on content, not exit code)
val() { python3 - "$SWARM_DB" "$1" <<'PY'
import sqlite3, sys
row = sqlite3.connect(sys.argv[1]).execute(sys.argv[2]).fetchone()
print("" if row is None or row[0] is None else row[0])
PY
}

# --- migrate: idempotent, WAL on every connection ----------------------------
db migrate
db migrate   # second call must not error (CREATE TABLE IF NOT EXISTS)
[ "$(python3 -c "import sqlite3;print(sqlite3.connect('$SWARM_DB').execute('PRAGMA journal_mode').fetchone()[0])")" = wal ] \
  || fail "journal_mode must be WAL on every connection"
for t in runs attempts events processes spend; do
  [ "$(val "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='$t'")" = 1 ] \
    || fail "table $t missing after migrate"
done
pass=$((pass+1))

# --- invariant 1: status defaults to 'fail' (success must be EARNED) ----------
db run-start --run RUNfail --repo Matou/ourcloud --trigger cron --started 1000
db attempt --run RUNfail --issue 447 --started 1001   # NO --status passed
[ "$(val "SELECT status FROM attempts WHERE run_id='RUNfail'")" = fail ] \
  || fail "an attempt with no explicit status must default to 'fail'"
pass=$((pass+1))

# --- a normal GREEN run: earned success survives finalisation -----------------
db run-start --run GREEN --repo Matou/ourcloud --trigger dispatch --started 2000
db attempt --run GREEN --issue 900 --status success --commits deadbeef --started 2001
db run-end --run GREEN --verdict completed --source completed --exit 0 --ended 2050
[ "$(val "SELECT verdict FROM runs WHERE run_id='GREEN'")" = completed ] || fail "green run verdict wrong"
[ "$(val "SELECT exit_code FROM runs WHERE run_id='GREEN'")" = 0 ]       || fail "green run exit_code wrong"
[ -n "$(val "SELECT ended_at FROM runs WHERE run_id='GREEN'")" ]         || fail "green run not finalised (ended_at NULL)"
[ "$(val "SELECT status FROM attempts WHERE run_id='GREEN'")" = success ] \
  || fail "an earned success must SURVIVE run-end, not be reset to fail"
pass=$((pass+1))

# --- a RED run: non-zero exit, attempt stays fail, surfaced by red-by-stage ---
db run-start --run RED --repo Matou/ourcloud --trigger cron --started 3000
db attempt --run RED --issue 901 --started 3001                 # opened, never earned
db run-end --run RED --verdict sandcastle-run-failed --source "died in workers" --exit 1 --ended 3040
[ "$(val "SELECT exit_code FROM runs WHERE run_id='RED'")" = 1 ] || fail "red run exit_code wrong"
[ "$(val "SELECT status FROM attempts WHERE run_id='RED'")" = fail ] \
  || fail "a red run's open attempt must read 'fail'"
[ -n "$(val "SELECT ended_at FROM attempts WHERE run_id='RED'")" ] \
  || fail "run-end must finalise the open attempt (ended_at set)"
red="$(SWARM_DB="$SWARM_DB" bash "$reader" red-by-stage)"
grep -q "sandcastle-run-failed" <<<"$red" || fail "red-by-stage must surface the failed stage: $red"
pass=$((pass+1))

# --- invariant 2: KILLS finalise the trace (nothing reads 'running' forever) --
# Model run-swarm's SIGTERM route: start, open an attempt, then the EXIT trap's
# run-end fires with a killed: verdict. No row may be left open afterwards.
db run-start --run KILLED --repo Matou/ourcloud --trigger cron --started 4000
db attempt --run KILLED --issue 902 --started 4001              # still running when killed
db run-end --run KILLED --verdict "killed:SIGTERM" --source "killed:SIGTERM" --exit 143 --ended 4005
[ "$(val "SELECT verdict FROM runs WHERE run_id='KILLED'")" = "killed:SIGTERM" ] || fail "killed verdict wrong"
[ "$(val "SELECT count(*) FROM runs WHERE run_id='KILLED' AND ended_at IS NULL")" = 0 ] \
  || fail "a killed run must leave NO run reading 'running' (ended_at NULL)"
[ "$(val "SELECT count(*) FROM attempts WHERE run_id='KILLED' AND ended_at IS NULL")" = 0 ] \
  || fail "a killed run must finalise every open attempt"
# but status of the un-earned attempt stays fail (a crash never reads green)
[ "$(val "SELECT status FROM attempts WHERE run_id='KILLED'")" = fail ] \
  || fail "a killed attempt must read 'fail'"
pass=$((pass+1))

# --- the #435 wedge: an UNFINALISED processes row + a worker_wedge event -------
# Deliberately the ONE row that stays open — a hung agent emits nothing, so the
# open row IS the evidence; open-processes surfaces it forever until accounted.
db run-start --run WEDGE --repo Matou/ourcloud --trigger label --started 5000
swarmdb_wedge WEDGE "447,446"
[ "$(val "SELECT count(*) FROM processes WHERE run_id='WEDGE' AND ended_at IS NULL")" = 1 ] \
  || fail "the wedge must leave exactly one unfinalised (ended_at NULL) processes row"
[ "$(val "SELECT kind FROM processes WHERE run_id='WEDGE'")" = worker ] || fail "wedge proc kind must be 'worker'"
[ "$(val "SELECT count(*) FROM events WHERE run_id='WEDGE' AND kind='worker_wedge'")" = 1 ] \
  || fail "the wedge must also write a worker_wedge event"
open="$(SWARM_DB="$SWARM_DB" bash "$reader" open-processes)"
grep -q "WEDGE" <<<"$open" || fail "open-processes must surface the wedge row: $open"
# run-end must NOT close the wedge process row (it is not an attempt)
db run-end --run WEDGE --verdict no-worker-spawned --source "green wedge" --exit 1 --ended 5010
[ "$(val "SELECT count(*) FROM processes WHERE run_id='WEDGE' AND ended_at IS NULL")" = 1 ] \
  || fail "run-end must leave the wedge processes row OPEN (forensic marker)"
pass=$((pass+1))

# --- spend: per-issue token/request figures, weekly rollup -------------------
db spend --run GREEN --issue 900 --input 1200 --output 300 --requests 4 --at 1700000000
week="$(SWARM_DB="$SWARM_DB" bash "$reader" spend-weekly)"
grep -qE "1200[[:space:]]+300[[:space:]]+4" <<<"$week" || fail "spend-weekly rollup wrong: $week"
pass=$((pass+1))

# --- reader: issue history ties attempts + events together -------------------
hist="$(SWARM_DB="$SWARM_DB" bash "$reader" issue 900)"
grep -q "== attempts ==" <<<"$hist" || fail "issue reader missing attempts section"
grep -q "success"        <<<"$hist" || fail "issue reader missing the earned success row"
pass=$((pass+1))

# --- best-effort: writers NEVER fail their caller (the db is a mirror) --------
# An unwritable db path must not red the run — swallowed, caller sees exit 0.
( set -e
  SWARM_DB=/proc/nonexistent/cannot.db
  swarmdb_run_start X Matou/ourcloud cron 1 || exit 7
  swarmdb_event X "" ready-set "1 task" "[447]" || exit 7
  swarmdb_run_end X completed completed 0 2 || exit 7
) || fail "a swarm-db writer must NEVER fail its caller (mirror is best-effort)"
# And with python3 unavailable, writers degrade to silent no-ops.
mkdir -p "$tmp/emptybin"
( set -e
  export PATH="$tmp/emptybin"
  swarmdb_run_start Y Matou/ourcloud cron 1 || exit 7   # swarmdb_available false → return 0
) || fail "writers must no-op (return 0) when python3 is absent"
pass=$((pass+1))

echo "swarm-db: $pass groups passed"
