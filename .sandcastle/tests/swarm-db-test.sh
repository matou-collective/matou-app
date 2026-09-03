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
db run-start --run RUNfail --repo Matou/idss --trigger cron --started 1000
db attempt --run RUNfail --issue 447 --started 1001   # NO --status passed
[ "$(val "SELECT status FROM attempts WHERE run_id='RUNfail'")" = fail ] \
  || fail "an attempt with no explicit status must default to 'fail'"
pass=$((pass+1))

# --- a normal GREEN run: earned success survives finalisation -----------------
db run-start --run GREEN --repo Matou/idss --trigger dispatch --started 2000
db attempt --run GREEN --issue 900 --status success --commits deadbeef --started 2001
db run-end --run GREEN --verdict completed --source completed --exit 0 --ended 2050
[ "$(val "SELECT verdict FROM runs WHERE run_id='GREEN'")" = completed ] || fail "green run verdict wrong"
[ "$(val "SELECT exit_code FROM runs WHERE run_id='GREEN'")" = 0 ]       || fail "green run exit_code wrong"
[ -n "$(val "SELECT ended_at FROM runs WHERE run_id='GREEN'")" ]         || fail "green run not finalised (ended_at NULL)"
[ "$(val "SELECT status FROM attempts WHERE run_id='GREEN'")" = success ] \
  || fail "an earned success must SURVIVE run-end, not be reset to fail"
pass=$((pass+1))

# --- a RED run: non-zero exit, attempt stays fail, surfaced by red-by-stage ---
db run-start --run RED --repo Matou/idss --trigger cron --started 3000
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
db run-start --run KILLED --repo Matou/idss --trigger cron --started 4000
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
db run-start --run WEDGE --repo Matou/idss --trigger label --started 5000
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

# --- #99: queue-wait daily percentiles, repo-scoped ---------------------------
# queue-wait events carry the ready→claimed seconds in `detail`; the aggregate
# buckets them by day and reports p50/p90/p99 per repo. Five idss values on one
# day (all --at in the same UTC second => one bucket) + one factory value.
db run-start --run QWi --repo Matou/idss        --trigger cron --started 1600000000
db run-start --run QWf --repo Matou/dev-factory --trigger cron --started 1600000000
for s in 10 20 30 40 100; do
  db event --run QWi --issue 99 --kind queue-wait --detail "$s" --at 1600000000
done
db event --run QWf --issue 5 --kind queue-wait --detail 5 --at 1600000000
qw="$(SWARM_DB="$SWARM_DB" bash "$reader" queue-wait --repo Matou/idss)"
# nearest-rank over sorted [10,20,30,40,100]: p50=30, p90=100, p99=100, n=5
grep -qE "5[[:space:]]+30[[:space:]]+100[[:space:]]+100" <<<"$qw" \
  || fail "queue-wait --repo idss percentiles wrong (want n=5 p50=30 p90=100 p99=100): $qw"
grep -q "day" <<<"$qw" || fail "queue-wait output must carry the day/n/p50/p90/p99 header: $qw"
# repo scoping: the factory's lone 5s value must NOT leak into idss's row
! grep -qE "[[:space:]]5[[:space:]]+5[[:space:]]+5" <<<"$qw" \
  || fail "queue-wait --repo idss must not include the factory's value"
# host-wide default folds both repos' values into one day (n=6)
qwall="$(SWARM_DB="$SWARM_DB" bash "$reader" queue-wait)"
grep -qE "[[:space:]]6[[:space:]]" <<<"$qwall" || fail "queue-wait host-wide must fold both repos (n=6): $qwall"
# --repo narrows to the factory's single value
SWARM_DB="$SWARM_DB" bash "$reader" queue-wait --repo Matou/dev-factory >/dev/null \
  || fail "queue-wait --repo must run"
pass=$((pass+1))

# --- #75: spend rows carry the active Claude account letter (nullable) --------
# A stamped account is stored verbatim; an omitted --account reads NULL
# (unattributed) so the column stays purely additive — never fails a caller
# that predates it.
db spend --run GREEN --issue 900 --input 10 --output 2 --requests 1 --at 1700000001 --account B
[ "$(val "SELECT account FROM spend WHERE run_id='GREEN' AND issue=900 AND at=1700000001")" = B ] \
  || fail "spend --account must be stored verbatim on the row"
[ -z "$(val "SELECT account FROM spend WHERE run_id='GREEN' AND issue=900 AND at=1700000000")" ] \
  || fail "a spend row written without --account must read NULL (unattributed)"
pass=$((pass+1))

# --- #96: cache classes + model are their own columns, written verbatim, and
#     nullable (omitted => NULL, so the columns stay purely additive).
db spend --run GREEN --issue 900 --input 40 --output 20 --requests 7 --at 1700000002 \
  --cache-creation 8 --cache-read 800 --model claude-opus-4-8 --account A
[ "$(val "SELECT cache_creation_tokens FROM spend WHERE run_id='GREEN' AND at=1700000002")" = 8 ] \
  || fail "spend --cache-creation must be stored verbatim"
[ "$(val "SELECT cache_read_tokens FROM spend WHERE run_id='GREEN' AND at=1700000002")" = 800 ] \
  || fail "spend --cache-read must be stored verbatim"
[ "$(val "SELECT model FROM spend WHERE run_id='GREEN' AND at=1700000002")" = claude-opus-4-8 ] \
  || fail "spend --model must be stored verbatim"
[ -z "$(val "SELECT model FROM spend WHERE run_id='GREEN' AND at=1700000000")" ] \
  || fail "a spend row written without --model/--cache-* must read NULL (additive)"
[ -z "$(val "SELECT cache_creation_tokens FROM spend WHERE run_id='GREEN' AND at=1700000000")" ] \
  || fail "a spend row written without --cache-creation must read NULL"
pass=$((pass+1))

# --- #75: the additive column reaches a PRE-EXISTING db (migration, not just
#     SCHEMA). A db whose spend table was created BEFORE the column existed must
#     GAIN it on the next migrate, and its old rows must read NULL — additive
#     and idempotent, never a rewrite of existing data.
legacy="$tmp/legacy.db"
python3 - "$legacy" <<'PY'
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
c.execute("CREATE TABLE spend (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, "
          "issue INTEGER, input_tokens INTEGER, output_tokens INTEGER, requests INTEGER, at INTEGER)")
c.execute("INSERT INTO spend (run_id, issue, input_tokens, output_tokens, requests, at) "
          "VALUES ('OLD', 1, 5, 1, 1, 100)")
c.commit(); c.close()
PY
python3 "$py" --db "$legacy" migrate
python3 "$py" --db "$legacy" migrate   # idempotent: a second migrate must not error
lval() { python3 - "$legacy" "$1" <<'PY'
import sqlite3, sys
row = sqlite3.connect(sys.argv[1]).execute(sys.argv[2]).fetchone()
print("" if row is None or row[0] is None else row[0])
PY
}
[ "$(lval "SELECT count(*) FROM pragma_table_info('spend') WHERE name='account'")" = 1 ] \
  || fail "migrate must ADD the account column to a pre-existing spend table"
[ -z "$(lval "SELECT account FROM spend WHERE run_id='OLD'")" ] \
  || fail "an existing pre-migration spend row must read NULL account, not be rewritten"
# #96: the same additive path lands cache_creation_tokens/cache_read_tokens/model.
for col in cache_creation_tokens cache_read_tokens model; do
  [ "$(lval "SELECT count(*) FROM pragma_table_info('spend') WHERE name='$col'")" = 1 ] \
    || fail "migrate must ADD the $col column to a pre-existing spend table"
  [ -z "$(lval "SELECT $col FROM spend WHERE run_id='OLD'")" ] \
    || fail "an existing pre-migration spend row must read NULL $col, not be rewritten"
done
python3 "$py" --db "$legacy" spend --run NEW --issue 2 --input 1 --output 1 --requests 1 --at 101 \
  --account A --cache-creation 3 --cache-read 30 --model claude-opus-4-8
[ "$(lval "SELECT account FROM spend WHERE run_id='NEW'")" = A ] \
  || fail "a post-migration insert must be able to stamp the new account column"
[ "$(lval "SELECT cache_read_tokens FROM spend WHERE run_id='NEW'")" = 30 ] \
  || fail "a post-migration insert must be able to stamp the new cache columns"
[ "$(lval "SELECT model FROM spend WHERE run_id='NEW'")" = claude-opus-4-8 ] \
  || fail "a post-migration insert must be able to stamp the new model column"
pass=$((pass+1))

# --- reader: issue history ties attempts + events together -------------------
# issue is now repo-scoped (#36); scope to GREEN's repo via the REPO_SLUG default.
hist="$(REPO_SLUG=Matou/idss SWARM_DB="$SWARM_DB" bash "$reader" issue 900)"
grep -q "== attempts ==" <<<"$hist" || fail "issue reader missing attempts section"
grep -q "success"        <<<"$hist" || fail "issue reader missing the earned success row"
pass=$((pass+1))

# --- #36: reads are REPO-SCOPED (issue numbers collide across repos) ----------
# swarm.db is one shared db per host (ADR 0004 pt5) but issue numbers are
# per-repo, so two repos both number an issue 555. Each repo-scoped read must
# return ONLY its own repo's rows; --repo overrides; --repo all drops the scope.
db run-start --run R_IDSS --repo Matou/idss --trigger cron --started 6000
db attempt   --run R_IDSS --issue 555 --status success --commits idsscommit --started 6001
db event     --run R_IDSS --issue 555 --kind gate --detail "idss gate" --at 6002
db spend     --run R_IDSS --issue 555 --input 111 --output 11 --requests 1 --at 6003
db run-start --run R_FAC  --repo Matou/dev-factory --trigger cron --started 6100
db attempt   --run R_FAC  --issue 555 --status fail --commits faccommit --started 6101
db event     --run R_FAC  --issue 555 --kind gate --detail "factory gate" --at 6102
db spend     --run R_FAC  --issue 555 --input 222 --output 22 --requests 2 --at 6103

# the REPO_SLUG default scopes to the caller's own repo
idss="$(REPO_SLUG=Matou/idss SWARM_DB="$SWARM_DB" bash "$reader" issue 555)"
grep -q "idsscommit"     <<<"$idss" || fail "issue read must include the caller repo's attempt: $idss"
grep -q "idss gate"      <<<"$idss" || fail "issue read must include the caller repo's event"
grep -q "111"            <<<"$idss" || fail "issue read must include the caller repo's spend"
! grep -q "faccommit"    <<<"$idss" || fail "issue read must EXCLUDE another repo's attempt (numbers collide): $idss"
! grep -q "factory gate" <<<"$idss" || fail "issue read must EXCLUDE another repo's event"
! grep -q "222"          <<<"$idss" || fail "issue read must EXCLUDE another repo's spend"

# explicit --repo overrides the default
fac="$(REPO_SLUG=Matou/idss SWARM_DB="$SWARM_DB" bash "$reader" issue 555 --repo Matou/dev-factory)"
grep -q "faccommit"      <<<"$fac"  || fail "--repo must scope the issue read to the named repo: $fac"
! grep -q "idsscommit"   <<<"$fac"  || fail "--repo must exclude other repos"

# --repo all is the escape hatch: every repo's issue 555
all="$(REPO_SLUG=Matou/idss SWARM_DB="$SWARM_DB" bash "$reader" issue 555 --repo all)"
{ grep -q "idsscommit" <<<"$all" && grep -q "faccommit" <<<"$all"; } \
  || fail "--repo all must return every repo's issue 555: $all"

# no --repo AND no resolvable REPO_SLUG => refuse rather than conflate. Isolate
# the reader from any sibling swarm-identity.sh so the ONLY source of a repo is
# REPO_SLUG (which we unset) — this proves the refuse path, not the sibling one.
iso="$tmp/iso"; mkdir -p "$iso"; cp "$root/swarm-db.sh" "$root/swarm-db.py" "$iso/"
if ( unset REPO_SLUG; SWARM_DB="$SWARM_DB" bash "$iso/swarm-db.sh" issue 555 ) >/dev/null 2>&1; then
  fail "issue read with no repo and no REPO_SLUG must refuse (else it conflates repos)"
fi
# ...but the sibling swarm-identity.sh IS a valid repo source when present.
# Isolate the reader with a FIXTURE identity as the ONLY resolvable sibling, so
# the fallback resolves the fixture's slug regardless of which checkout invokes
# this suite. Run straight off `$reader` (=$root/swarm-db.sh) and its real
# sibling identity would win — the factory's own factory-side, but a CONSUMER's
# real swarm-identity.sh (its product slug) when the suite runs vendored inside
# that consumer's .sandcastle/tests/, reddening this group (#87).
sibdir="$tmp/sibdir"; mkdir -p "$sibdir"
cp "$root/swarm-db.sh" "$root/swarm-db.py" "$sibdir/"
printf '%s\n' ': "${REPO_SLUG:=Matou/dev-factory}"' > "$sibdir/swarm-identity.sh"
sib="$(unset REPO_SLUG; SWARM_DB="$SWARM_DB" bash "$sibdir/swarm-db.sh" issue 555)"
grep -q "faccommit" <<<"$sib" || fail "issue must fall back to the sibling swarm-identity.sh REPO_SLUG: $sib"
pass=$((pass+1))

# --- #36: host-scoped reads keep host default, take an OPTIONAL repo filter ----
db run-end --run R_IDSS --verdict idss-red    --source y --exit 1 --ended 6010
db run-end --run R_FAC  --verdict factory-red --source x --exit 1 --ended 6110
allred="$(SWARM_DB="$SWARM_DB" bash "$reader" red-by-stage)"
{ grep -q "idss-red" <<<"$allred" && grep -q "factory-red" <<<"$allred"; } \
  || fail "red-by-stage default must be host-wide (every repo): $allred"
facred="$(SWARM_DB="$SWARM_DB" bash "$reader" red-by-stage --repo Matou/dev-factory)"
grep -q "factory-red"  <<<"$facred" || fail "red-by-stage --repo must include that repo: $facred"
! grep -q "idss-red"   <<<"$facred" || fail "red-by-stage --repo must exclude other repos"
# spend-weekly and open-processes accept --repo without erroring
SWARM_DB="$SWARM_DB" bash "$reader" spend-weekly   --repo Matou/idss >/dev/null || fail "spend-weekly --repo must run"
SWARM_DB="$SWARM_DB" bash "$reader" open-processes --repo Matou/idss >/dev/null || fail "open-processes --repo must run"
pass=$((pass+1))

# --- limit-lost (#100): lost capacity per account per ISO week, paired from the
#     limit-pause park/unpark edges limit-lib.sh records. A park opens a window
#     for its account, the next unpark for that account closes it; a re-hit
#     (duplicate park) does not double-count, and an unclosed park counts 0. ---
t0=1704067200                               # 2024-01-01 00:00:00 UTC (a Monday)
db event --run LP --kind limit-pause --detail "park account=A"   --at "$t0"
db event --run LP --kind limit-pause --detail "park account=A"   --at "$((t0+100))"    # re-hit, ignored
db event --run LP --kind limit-pause --detail "unpark account=A" --at "$((t0+3600))"   # A parked 3600s
db event --run LP --kind limit-pause --detail "park account=B"   --at "$((t0+200))"
db event --run LP --kind limit-pause --detail "unpark account=B" --at "$((t0+7400))"   # B parked 7200s
db event --run LP --kind limit-pause --detail "park account=A"   --at "$((t0+90000))"  # still open → 0
lost="$(SWARM_DB="$SWARM_DB" bash "$reader" limit-lost)"
week="$(python3 -c "import time;print(time.strftime('%Y-W%W', time.gmtime($t0)))")"
grep -qE "$week[[:space:]]+A[[:space:]]+3600[[:space:]]+1" <<<"$lost" \
  || fail "limit-lost must attribute 3600 parked seconds to account A (one window): $lost"
grep -qE "$week[[:space:]]+B[[:space:]]+7200[[:space:]]+1" <<<"$lost" \
  || fail "limit-lost must attribute 7200 parked seconds to account B (one window): $lost"
# the still-open park adds no second A window (no unclosed duration counted)
[ "$(grep -cE "[[:space:]]A[[:space:]]" <<<"$lost")" = 1 ] \
  || fail "an unclosed park must not add a counted window: $lost"
pass=$((pass+1))

# --- best-effort: writers NEVER fail their caller (the db is a mirror) --------
# An unwritable db path must not red the run — swallowed, caller sees exit 0.
( set -e
  SWARM_DB=/proc/nonexistent/cannot.db
  swarmdb_run_start X Matou/idss cron 1 || exit 7
  swarmdb_event X "" ready-set "1 task" "[447]" || exit 7
  swarmdb_run_end X completed completed 0 2 || exit 7
) || fail "a swarm-db writer must NEVER fail its caller (mirror is best-effort)"
# And with python3 unavailable, writers degrade to silent no-ops.
mkdir -p "$tmp/emptybin"
( set -e
  export PATH="$tmp/emptybin"
  swarmdb_run_start Y Matou/idss cron 1 || exit 7   # swarmdb_available false → return 0
) || fail "writers must no-op (return 0) when python3 is absent"
pass=$((pass+1))

# --- #98: session-file ingest → per-request spend + per-tool-call events ------
# A minimal but realistic claude session jsonl: two assistant API requests
# (each its OWN usage block with the three token classes split + a model) and
# two tool calls whose durations are the gap to the matching tool_result. Ingest
# must emit ONE spend row per request (requests=1 each) and ONE tool-call event
# per tool_use, duration derived from the timestamps.
sess="$tmp/session.jsonl"
cat > "$sess" <<'JSONL'
{"type":"assistant","timestamp":"2026-08-26T00:00:00.000Z","message":{"model":"claude-opus-4-8","usage":{"input_tokens":100,"cache_creation_input_tokens":200,"cache_read_input_tokens":50,"output_tokens":30},"content":[{"type":"text","text":"looking"},{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"ls"}}]}}
{"type":"user","timestamp":"2026-08-26T00:00:02.000Z","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"a b c"}]}}
{"type":"assistant","timestamp":"2026-08-26T00:00:05.000Z","message":{"model":"claude-opus-4-8","usage":{"input_tokens":40,"cache_creation_input_tokens":0,"cache_read_input_tokens":800,"output_tokens":12},"content":[{"type":"tool_use","id":"toolu_2","name":"Read","input":{"file_path":"/x"}}]}}
{"type":"user","timestamp":"2026-08-26T00:00:06.500Z","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_2","content":"..."}]}}
JSONL
out="$(db ingest --run ING --issue 98 --session "$sess" --account A)"
[ "$out" = "2 2" ] || fail "ingest must report '2 2' (2 spend rows, 2 tool events), got: [$out]"
# per-request spend: two rows, each requests=1, cache classes split, model set.
[ "$(val "SELECT count(*) FROM spend WHERE run_id='ING'")" = 2 ] \
  || fail "ingest must emit one spend row PER API request (2)"
[ "$(val "SELECT count(*) FROM spend WHERE run_id='ING' AND requests=1")" = 2 ] \
  || fail "each per-request spend row must carry requests=1"
[ "$(val "SELECT input_tokens FROM spend WHERE run_id='ING' AND at=$(python3 -c 'import datetime;print(int(datetime.datetime.fromisoformat("2026-08-26T00:00:00+00:00").timestamp()))')")" = 100 ] \
  || fail "the first request's FRESH input must be 100"
[ "$(val "SELECT cache_creation_tokens FROM spend WHERE run_id='ING' AND input_tokens=100")" = 200 ] \
  || fail "the first request's cache_creation_tokens must split out (200)"
[ "$(val "SELECT cache_read_tokens FROM spend WHERE run_id='ING' AND input_tokens=40")" = 800 ] \
  || fail "the second request's cache_read_tokens must split out (800)"
[ "$(val "SELECT model FROM spend WHERE run_id='ING' AND input_tokens=100")" = "claude-opus-4-8" ] \
  || fail "each per-request row must record the billing model"
[ "$(val "SELECT account FROM spend WHERE run_id='ING' AND input_tokens=100")" = A ] \
  || fail "each per-request row must be stamped with the active account"
[ "$(val "SELECT issue FROM spend WHERE run_id='ING' AND input_tokens=100")" = 98 ] \
  || fail "the per-request rows must carry the attributed issue"
# per-tool-call events: tool name in detail, duration_ms in evidence.
[ "$(val "SELECT count(*) FROM events WHERE run_id='ING' AND kind='tool-call'")" = 2 ] \
  || fail "ingest must emit one tool-call event per tool_use (2)"
[ "$(val "SELECT detail FROM events WHERE run_id='ING' AND kind='tool-call' AND evidence='duration_ms=2000'")" = Bash ] \
  || fail "the Bash tool-call must record name=Bash and a 2000ms duration"
[ "$(val "SELECT detail FROM events WHERE run_id='ING' AND kind='tool-call' AND evidence='duration_ms=1500'")" = Read ] \
  || fail "the Read tool-call must record name=Read and a 1500ms duration"
pass=$((pass+1))

# --- #98 best-effort: a missing / unparseable session records nothing, exit 0 -
out="$(db ingest --run MISS --session "$tmp/does-not-exist.jsonl")"
[ "$out" = "0 0" ] || fail "a missing session file must report '0 0', got: [$out]"
[ "$(val "SELECT count(*) FROM spend WHERE run_id='MISS'")" = 0 ] \
  || fail "a missing session file must record no spend"
printf 'not json {\n{"type":"assistant"}\ngarbage\n' > "$tmp/bad.jsonl"
out="$(db ingest --run BAD --session "$tmp/bad.jsonl")"
[ "$out" = "0 0" ] || fail "an unparseable session must report '0 0' (no usage/tools), got: [$out]"
[ "$(val "SELECT count(*) FROM spend WHERE run_id='BAD'")" = 0 ] \
  || fail "an unparseable session must record no spend rows"
pass=$((pass+1))

# --- #98: the swarmdb_ingest bash wrapper echoes the count and never fails ----
#     (record-run-result.sh reads its stdout to decide the aggregate skip).
wc="$(swarmdb_ingest INGW 98 "$sess" A)"
[ "$wc" = "2 2" ] || fail "swarmdb_ingest must echo the engine's '<spend> <events>' count, got: [$wc]"
[ "$(val "SELECT count(*) FROM spend WHERE run_id='INGW'")" = 2 ] \
  || fail "swarmdb_ingest must have written the per-request rows"
# python absent => silent no-op echoing '0 0', never an error.
( set -e
  export PATH="$tmp/emptybin"
  w="$(swarmdb_ingest X 1 "$sess" A)"
  [ "$w" = "0 0" ] || exit 7
) || fail "swarmdb_ingest must echo '0 0' and never fail when python3 is absent"
pass=$((pass+1))

# --- #98: a tool call with no matching result records name, no duration -------
sess2="$tmp/truncated.jsonl"
cat > "$sess2" <<'JSONL'
{"type":"assistant","timestamp":"2026-08-26T01:00:00.000Z","message":{"model":"m","usage":{"input_tokens":5,"output_tokens":1},"content":[{"type":"tool_use","id":"toolu_x","name":"Grep","input":{}}]}}
JSONL
out="$(db ingest --run TRUNC --session "$sess2")"
[ "$out" = "1 1" ] || fail "a truncated session must still yield its request + tool event, got: [$out]"
[ "$(val "SELECT detail FROM events WHERE run_id='TRUNC' AND kind='tool-call'")" = Grep ] \
  || fail "an unmatched tool call must still record its name"
[ -z "$(val "SELECT evidence FROM events WHERE run_id='TRUNC' AND kind='tool-call'")" ] \
  || fail "an unmatched tool call must record NO duration (empty evidence)"
pass=$((pass+1))

# --- #94: swarmdb_spend_from_result turns a --output-format json blob into ONE
#     aggregate spend row (session-runner today; triage/heal next). ------------
res="$tmp/result.json"
cat > "$res" <<'JSON'
{"type":"result","subtype":"success","is_error":false,"result":"ok",
 "session_id":"s1","total_cost_usd":0.02,"num_turns":4,
 "modelUsage":{"claude-opus-4-8":{"inputTokens":500}},
 "usage":{"input_tokens":500,"output_tokens":60,
          "cache_creation_input_tokens":700,"cache_read_input_tokens":900}}
JSON
wrote="$(swarmdb_spend_from_result SFR 94 B "$res")"
[ "$wrote" = 1 ] || fail "swarmdb_spend_from_result must echo 1 when it writes a row, got: [$wrote]"
[ "$(val "SELECT count(*) FROM spend WHERE run_id='SFR'")" = 1 ] \
  || fail "swarmdb_spend_from_result must write exactly ONE aggregate spend row"
[ "$(val "SELECT input_tokens||'/'||output_tokens||'/'||cache_creation_tokens||'/'||cache_read_tokens FROM spend WHERE run_id='SFR'")" = "500/60/700/900" ] \
  || fail "the row must carry the usage block's fresh input/output + split cache classes"
[ "$(val "SELECT account FROM spend WHERE run_id='SFR'")" = B ] \
  || fail "the row must be stamped with the passed account letter"
[ "$(val "SELECT issue FROM spend WHERE run_id='SFR'")" = 94 ] \
  || fail "the row must carry the attributed issue"
[ "$(val "SELECT model FROM spend WHERE run_id='SFR'")" = "claude-opus-4-8" ] \
  || fail "the row must pass through the model from .modelUsage when present"
[ "$(val "SELECT requests FROM spend WHERE run_id='SFR'")" = 1 ] \
  || fail "an aggregate result has no per-request count — requests must default to 1"
# a result with no usage block → NO row, echo 0, never fails.
echo '{"type":"result","result":"no usage"}' > "$tmp/nouse.json"
[ "$(swarmdb_spend_from_result NOUSE 1 A "$tmp/nouse.json")" = 0 ] \
  || fail "a usage-less result must echo 0 and write nothing"
[ "$(val "SELECT count(*) FROM spend WHERE run_id='NOUSE'")" = 0 ] \
  || fail "a usage-less result must write no spend row"
# a missing file, and a run/account only (no issue) → NULL issue, still works.
[ "$(swarmdb_spend_from_result MISSR '' A "$tmp/does-not-exist.json")" = 0 ] \
  || fail "a missing result file must echo 0 and write nothing"
[ "$(swarmdb_spend_from_result NOISS '' A "$res")" = 1 ] \
  || fail "swarmdb_spend_from_result must accept an empty issue (run-scoped)"
[ -z "$(val "SELECT issue FROM spend WHERE run_id='NOISS'")" ] \
  || fail "an empty issue must record NULL, not a literal"
# python absent => silent no-op echoing 0, never an error.
( set -e
  export PATH="$tmp/emptybin"
  [ "$(swarmdb_spend_from_result X 1 A "$res")" = 0 ] || exit 7
) || fail "swarmdb_spend_from_result must echo 0 and never fail when python3 is absent"
pass=$((pass+1))

# --- #113: sweep-orphans finalises SIGKILLed runs, fail-safe on the rest -------
# A Forgejo-runner CANCEL is a SIGKILL, so a cancelled run's EXIT trap never
# fires: its `runs` row + `processes` rows stay open forever and the fleet TUI
# bills the dead row as a busy slot. sweep-orphans is the durable finaliser the
# dead run's own trap could not be — but it must reap ONLY the provably-dead.
now=2000000000
old=$(( now - 20000 ))       # older than the 3h run-lifetime floor
young=$(( now - 100 ))       # inside a run-lifetime — a possibly-live run
# a genuinely-dead pid: spawn, kill, reap — its number is now free.
sleep 300 & deadpid=$!; kill "$deadpid" 2>/dev/null; wait "$deadpid" 2>/dev/null || true

# ORPHAN: old open run, its one open process is a dead pid → swept.
db run-start --run ORPH --repo Matou/idss --trigger heal --started "$old"
db attempt   --run ORPH --issue 500 --started "$old"
db proc-open --run ORPH --kind claude --ref "$deadpid" --started "$old"
# LIVE: old open run, but its pid ($$) is alive → spared.
db run-start --run LIVE --repo Matou/idss --trigger issues --started "$old"
db proc-open --run LIVE --kind claude --ref "$$" --started "$old"
# YOUNG: dead pid but started inside a run-lifetime → spared (age floor).
db run-start --run YOUNG --repo Matou/idss --trigger heal --started "$young"
db proc-open --run YOUNG --kind claude --ref "$deadpid" --started "$young"
# WEDGE113: old open run whose only ref is a synthetic #435 marker → un-ageable,
# spared (a wedge marker must survive until a human accounts for it).
db run-start --run WEDGE113 --repo Matou/idss --trigger label --started "$old"
db proc-open --run WEDGE113 --kind worker --ref "wedge:WEDGE113" --started "$old"
# NOPROC: old open run with NO process rows → no pid evidence, left alone.
db run-start --run NOPROC --repo Matou/idss --trigger cron --started "$old"

out="$(db sweep-orphans --at "$now")"
grep -q "^swept ORPH heal$" <<<"$out" || fail "sweep-orphans must report the reaped run+trigger: [$out]"
[ "$(val "SELECT verdict FROM runs WHERE run_id='ORPH'")" = "died-in:heal" ] \
  || fail "an orphan must be finalised with a died-in:<trigger> verdict"
[ "$(val "SELECT verdict_source FROM runs WHERE run_id='ORPH'")" = "orphan-sweep" ] \
  || fail "the finalise must record verdict_source orphan-sweep"
[ "$(val "SELECT exit_code FROM runs WHERE run_id='ORPH'")" = 137 ] \
  || fail "a SIGKILLed orphan must record exit 137"
[ -n "$(val "SELECT ended_at FROM runs WHERE run_id='ORPH'")" ] \
  || fail "sweep must set ended_at on the orphan run"
[ -n "$(val "SELECT ended_at FROM attempts WHERE run_id='ORPH'")" ] \
  || fail "sweep must finalise the orphan's open attempt (kills-finalise)"
[ -z "$(val "SELECT ref FROM processes WHERE run_id='ORPH' AND ended_at IS NULL")" ] \
  || fail "sweep must close the orphan's open process row"
[ "$(val "SELECT status FROM attempts WHERE run_id='ORPH'")" = fail ] \
  || fail "a swept attempt keeps its default 'fail' — a kill never earns success"
for spared in LIVE YOUNG WEDGE113 NOPROC; do
  [ -z "$(val "SELECT ended_at FROM runs WHERE run_id='$spared'")" ] \
    || fail "sweep-orphans must SPARE $spared (live/young/un-ageable/no-proc)"
done
# idempotent: a second sweep finds nothing new to reap.
[ -z "$(db sweep-orphans --at "$now")" ] \
  || fail "a second sweep-orphans must be a no-op (idempotent)"
# the bash wrapper is best-effort and echoes what it swept. It uses the REAL
# clock (no --at), so age the row against wall-time, not the fixed fixture now.
realold=$(( $(date +%s) - 20000 ))
db run-start --run ORPH2 --repo Matou/idss --trigger heal --started "$realold"
db proc-open --run ORPH2 --kind claude --ref "$deadpid" --started "$realold"
wrapout="$(SWARM_DB="$SWARM_DB" swarmdb_sweep_orphans)"
grep -q "ORPH2" <<<"$wrapout" || fail "swarmdb_sweep_orphans wrapper must echo swept runs: [$wrapout]"
[ -n "$(val "SELECT ended_at FROM runs WHERE run_id='ORPH2'")" ] \
  || fail "the wrapper must actually finalise the orphan"
# python absent => the wrapper is a silent no-op, never an error.
( set -e
  export PATH="$tmp/emptybin"
  swarmdb_sweep_orphans >/dev/null || exit 7
) || fail "swarmdb_sweep_orphans must no-op (return 0) when python3 is absent"
pass=$((pass+1))

# --- #116: SWARMDB_ASSERT_UNDER leak tripwire refuses out-of-sandbox writes ----
# A test suite that sources this lib in host-mode without redirecting SWARM_DB
# writes fixture rows into the LIVE ~/swarm/state/swarm.db. The tripwire (a
# test-only env) refuses any write whose SWARM_DB escapes the named sandbox, so
# a leaking suite fails loud instead of poisoning the Loss telemetry.
sandbox="$tmp/sandbox"; outside="$tmp/outside"; mkdir -p "$sandbox" "$outside"
# control: with NO tripwire a write to an outside db lands — the leak this guards
# against, and proof the write path is live (so the refusals below are the guard,
# not an inert path).
( set -e; SWARM_DB="$outside/leak.db" swarmdb migrate )
[ -f "$outside/leak.db" ] || fail "control: a write with no tripwire must land (proves the guard is what stops it)"
rm -f "$outside/leak.db"
# armed + SWARM_DB OUTSIDE the sandbox → write REFUSED, db untouched, loud stderr,
# breadcrumb recorded for a suite to assert on.
trip_err="$( SWARMDB_ASSERT_UNDER="$sandbox" SWARM_DB="$outside/leak.db" swarmdb migrate 2>&1 )"
[ ! -f "$outside/leak.db" ] || fail "the tripwire must REFUSE a write to a db outside SWARMDB_ASSERT_UNDER"
grep -q "LEAK TRIPWIRE" <<<"$trip_err" || fail "the tripwire must announce itself loudly on stderr, got: $trip_err"
[ -f "$sandbox/.swarmdb-leak-attempts" ] || fail "the tripwire must record the leak attempt as a breadcrumb"
grep -q "$outside/leak.db" "$sandbox/.swarmdb-leak-attempts" || fail "the breadcrumb must name the escaped db path"
# the same guard on the direct-python writers (they bypass swarmdb()).
( set -e; out="$(SWARMDB_ASSERT_UNDER="$sandbox" SWARM_DB="$outside/leak.db" swarmdb_ingest R '' /nope)"; [ "$out" = "0 0" ] ) \
  || fail "swarmdb_ingest must honour the tripwire (echo 0 0, no write)"
[ ! -f "$outside/leak.db" ] || fail "swarmdb_ingest must not write outside the sandbox under the tripwire"
# armed + SWARM_DB INSIDE the sandbox → write proceeds exactly as normal.
( set -e; SWARMDB_ASSERT_UNDER="$sandbox" SWARM_DB="$sandbox/ok.db" swarmdb migrate )
[ -f "$sandbox/ok.db" ] || fail "the tripwire must ALLOW a write whose SWARM_DB is under the sandbox"
pass=$((pass+1))

echo "swarm-db: $pass groups passed"
