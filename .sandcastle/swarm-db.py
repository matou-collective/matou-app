#!/usr/bin/env python3
"""swarm-db.py — the queryable SQLite trace MIRROR for swarm runs (#447, L4).

One WAL SQLite db on the workstation (default `~/swarm/state/swarm.db`, NEVER
in-repo) written by run-swarm.sh (via swarm-db-lib.sh) and, later, the worker
wrapper as events happen. This is a MIRROR: every existing sink stays the raw
record (host runlog, /tmp verdict artifacts, Mattermost, worker logs, healer
evidence, journalctl) — losing this db must lose nothing.

Two invariants stolen verbatim from SSSF (`references/observability.md`):

  1. **Status defaults to fail.** `attempts.status` is `NOT NULL DEFAULT 'fail'`:
     a crash can never read green — success is EARNED by a verified clean exit
     that explicitly writes it.
  2. **Kills finalise the trace.** `run-end` closes the run row and every still
     -open attempt so nothing reads `running` forever; run-swarm.sh calls it
     from its EXIT trap, which its SIGTERM/SIGINT handlers route through.

Why Python and not the sqlite3 CLI: python3 ships on every swarm host AND in the
worker sandbox (the CLI does not), and its parameter binding quotes arbitrary
verdict lines / commands safely — a sqlite3-CLI string-interpolation would be a
quoting hazard on exactly the free-text this db stores. WAL + busy_timeout are
set on EVERY connection (readers never block writers).

All writes are best-effort at the bash layer (swarm-db-lib.sh swallows a
non-zero exit): a mirror we cannot write must never red a run.
"""

import argparse
import datetime
import json
import os
import re
import sqlite3
import sys
import time

DEFAULT_DB = os.path.join(os.path.expanduser("~"), "swarm", "state", "swarm.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
  run_id         TEXT PRIMARY KEY,
  repo           TEXT,
  trigger        TEXT,            -- cron | label | dispatch | closed | ...
  started_at     INTEGER,
  ended_at       INTEGER,         -- NULL = believed still running
  verdict        TEXT,            -- the exit reason (completed, sandcastle-run-failed, killed:SIGTERM, ...)
  verdict_source TEXT,            -- the line/stage that decided the verdict
  exit_code      INTEGER
);

CREATE TABLE IF NOT EXISTS attempts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT,
  issue         INTEGER,
  iteration     INTEGER DEFAULT 1,
  -- success MUST be earned by a verified clean exit; a crash reads 'fail'.
  status        TEXT NOT NULL DEFAULT 'fail',
  commits       TEXT,             -- space/comma list of SHAs
  close_outcome TEXT,             -- close-report outcome (success|blocked|refused|...)
  started_at    INTEGER,
  ended_at      INTEGER,
  UNIQUE(run_id, issue, iteration)
);

CREATE TABLE IF NOT EXISTS events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id   TEXT,
  issue    INTEGER,               -- attempt-scoped; NULL = run-scoped
  at       INTEGER,
  kind     TEXT,                  -- gate | limit-pause | heal | ask | rescue | worker_wedge | ...
  detail   TEXT,
  evidence TEXT                   -- the proof line(s) behind the event
);

CREATE TABLE IF NOT EXISTS processes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     TEXT,
  kind       TEXT,                -- worker | claude | harness
  ref        TEXT,                -- pid or container id/name
  command    TEXT,
  started_at INTEGER,
  ended_at   INTEGER              -- NULL = believed alive (the #435 wedge marker)
);

CREATE TABLE IF NOT EXISTS spend (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT,
  issue         INTEGER,
  input_tokens  INTEGER,                -- FRESH input only — cache classes are their own columns (#96)
  output_tokens INTEGER,
  requests      INTEGER,
  at            INTEGER,
  account       TEXT,                   -- the active Claude account letter (A|B); NULL = unattributed
  cache_creation_tokens INTEGER,        -- cache-write tokens (~1.25x fresh input price); NULL = unrecorded (#96)
  cache_read_tokens     INTEGER,        -- cache-hit tokens (~0.1x fresh input price); NULL = unrecorded (#96)
  model                 TEXT            -- the model that billed the tokens; NULL = unrecorded (#96)
);

CREATE INDEX IF NOT EXISTS idx_attempts_issue ON attempts(issue);
CREATE INDEX IF NOT EXISTS idx_events_issue   ON events(issue);
CREATE INDEX IF NOT EXISTS idx_events_run     ON events(run_id);
CREATE INDEX IF NOT EXISTS idx_proc_open      ON processes(ended_at);
CREATE INDEX IF NOT EXISTS idx_spend_issue    ON spend(issue);
"""


def connect(db):
    """Open a connection with the WAL pragmas set on EVERY connection (L4)."""
    d = os.path.dirname(db)
    if d:
        os.makedirs(d, exist_ok=True)
    conn = sqlite3.connect(db, timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


# Additive columns bolted onto an EXISTING db after its table was first created.
# `CREATE TABLE IF NOT EXISTS` in SCHEMA only shapes a fresh table, so a db that
# predates a column never gains it from SCHEMA alone — each additive column is
# ADDed here, guarded by a table_info probe so the migration is idempotent and
# safe to run on every connection. Additive + nullable only: never a rename or a
# drop (a consumer at an older pin still reads the same rows). `account` (#75).
ADDITIVE_COLUMNS = [
    ("spend", "account", "TEXT"),
    # #96: cache-write, cache-read, and the billing model — separated so a
    # dollar figure can be derived (the three price ~10x apart). Additive +
    # nullable like `account`: existing rows read NULL, never rewritten.
    ("spend", "cache_creation_tokens", "INTEGER"),
    ("spend", "cache_read_tokens", "INTEGER"),
    ("spend", "model", "TEXT"),
]


def _add_missing_columns(conn):
    for table, column, decl in ADDITIVE_COLUMNS:
        cols = [r[1] for r in conn.execute("PRAGMA table_info(%s)" % table).fetchall()]
        if column not in cols:
            conn.execute("ALTER TABLE %s ADD COLUMN %s %s" % (table, column, decl))


def migrate(db):
    conn = connect(db)
    with conn:
        conn.executescript(SCHEMA)
        _add_missing_columns(conn)
    conn.close()


def _now(v):
    return int(v) if v is not None else int(time.time())


# An open `runs` row older than a full run-lifetime is provably from a dead run
# (sweep-lib.sh's age floor: 3h > swarm.yml's 180-min job timeout). A younger row
# may be a live run mid-flight (or in the window before it opens its first
# process) and is spared — fail-safe, exactly like reap_containers/sweep_worktrees.
ORPHAN_MAX_AGE = 10800


def _pid_alive(ref):
    """Liveness of a `processes.ref`: True/False for a numeric OS pid, None when
    <ref> is not an ageable pid (a synthetic `wedge:<run>` marker, #435 — a
    signal cannot age it). A pid owned by another uid still EXISTS (PermissionError,
    not ProcessLookupError) and reads alive. Mirrors probe.py's copy — swarm-db.py
    stays self-contained (never imports fleet-tui)."""
    try:
        pid = int(str(ref))
    except (TypeError, ValueError):
        return None
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except (OverflowError, OSError):
        return None
    return True


def cmd_migrate(a):
    migrate(a.db)


def cmd_run_start(a):
    migrate(a.db)
    conn = connect(a.db)
    with conn:
        # Idempotent: a re-fired trigger with the same run id keeps the original
        # start; only fills the descriptive columns.
        conn.execute(
            """INSERT INTO runs (run_id, repo, trigger, started_at)
               VALUES (?,?,?,?)
               ON CONFLICT(run_id) DO UPDATE SET
                 repo=COALESCE(excluded.repo, runs.repo),
                 trigger=COALESCE(excluded.trigger, runs.trigger)""",
            (a.run, a.repo, a.trigger, _now(a.started)),
        )
    conn.close()


def cmd_run_end(a):
    """Finalise the run AND every still-open attempt (invariant 2: kills
    finalise). Never promotes an attempt to success — a clean exit earns that
    explicitly via `attempt --status success` BEFORE the end."""
    migrate(a.db)
    now = _now(a.ended)
    conn = connect(a.db)
    with conn:
        conn.execute(
            """INSERT INTO runs (run_id, ended_at, verdict, verdict_source, exit_code)
               VALUES (?,?,?,?,?)
               ON CONFLICT(run_id) DO UPDATE SET
                 ended_at=excluded.ended_at,
                 verdict=excluded.verdict,
                 verdict_source=COALESCE(excluded.verdict_source, runs.verdict_source),
                 exit_code=excluded.exit_code""",
            (a.run, now, a.verdict, a.source, a.exit),
        )
        # Close open attempts WITHOUT touching status: an already-earned
        # 'success' stays, everything else keeps the DEFAULT 'fail'.
        conn.execute(
            "UPDATE attempts SET ended_at=? WHERE run_id=? AND ended_at IS NULL",
            (now, a.run),
        )
    conn.close()


def cmd_attempt(a):
    migrate(a.db)
    conn = connect(a.db)
    with conn:
        # Omit status entirely when the caller did not pass one, so the column
        # DEFAULT 'fail' applies on insert (proving invariant 1). On update we
        # only overwrite status when a value was explicitly given.
        if a.status is None:
            conn.execute(
                """INSERT INTO attempts (run_id, issue, iteration, commits, close_outcome, started_at, ended_at)
                   VALUES (?,?,?,?,?,?,?)
                   ON CONFLICT(run_id, issue, iteration) DO UPDATE SET
                     commits=COALESCE(excluded.commits, attempts.commits),
                     close_outcome=COALESCE(excluded.close_outcome, attempts.close_outcome),
                     ended_at=COALESCE(excluded.ended_at, attempts.ended_at)""",
                (a.run, a.issue, a.iteration, a.commits, a.close_outcome,
                 _now(a.started), a.ended),
            )
        else:
            conn.execute(
                """INSERT INTO attempts (run_id, issue, iteration, status, commits, close_outcome, started_at, ended_at)
                   VALUES (?,?,?,?,?,?,?,?)
                   ON CONFLICT(run_id, issue, iteration) DO UPDATE SET
                     status=excluded.status,
                     commits=COALESCE(excluded.commits, attempts.commits),
                     close_outcome=COALESCE(excluded.close_outcome, attempts.close_outcome),
                     ended_at=COALESCE(excluded.ended_at, attempts.ended_at)""",
                (a.run, a.issue, a.iteration, a.status, a.commits, a.close_outcome,
                 _now(a.started), a.ended),
            )
    conn.close()


def cmd_event(a):
    migrate(a.db)
    conn = connect(a.db)
    with conn:
        conn.execute(
            "INSERT INTO events (run_id, issue, at, kind, detail, evidence) VALUES (?,?,?,?,?,?)",
            (a.run, a.issue, _now(a.at), a.kind, a.detail, a.evidence),
        )
    conn.close()


def cmd_proc_open(a):
    """Open a process row (ended_at NULL = believed alive). The wedge marker."""
    migrate(a.db)
    conn = connect(a.db)
    with conn:
        conn.execute(
            "INSERT INTO processes (run_id, kind, ref, command, started_at, ended_at) VALUES (?,?,?,?,?,?)",
            (a.run, a.kind, a.ref, a.command, _now(a.started), a.ended),
        )
    conn.close()


def cmd_proc_close(a):
    migrate(a.db)
    conn = connect(a.db)
    with conn:
        conn.execute(
            "UPDATE processes SET ended_at=? WHERE run_id=? AND ref=? AND ended_at IS NULL",
            (_now(a.ended), a.run, a.ref),
        )
    conn.close()


def cmd_sweep_orphans(a):
    """Durably finalise ORPHAN runs — the SIGKILL case heal.sh documents but
    cannot self-heal (#113). A Forgejo-runner CANCEL terminates the process tree
    with SIGKILL, so the run's EXIT trap (`run-end`) never fires and its `runs`
    row plus its `processes` rows stay open forever, billed by the fleet TUI as a
    busy slot. Something OTHER than the dead run must close it: this is that
    finaliser, meant to run from the next orchestrator tick / the backstop sweep.

    A run is swept ONLY when ALL hold (fail-safe, like sweep-lib.sh's age floor):
      * `started_at` predates a full run-lifetime (never reap a live run);
      * it HAS ≥1 open process row (no pid evidence at all → leave it alone);
      * EVERY open ref is a PROVABLY-dead pid (a live pid, or an un-ageable
        `wedge:<run>` marker, spares the whole run).
    It then mirrors run-end exactly: `died-in:<trigger>` verdict, `orphan-sweep`
    source, exit 137 (SIGKILL), open attempts + processes closed. Prints one
    `swept <run_id> <trigger>` line per reaped run. Idempotent and best-effort."""
    migrate(a.db)
    now = _now(a.at)
    max_age = a.max_age if a.max_age is not None else ORPHAN_MAX_AGE
    floor = now - max_age
    conn = connect(a.db)
    swept = []
    with conn:
        open_runs = conn.execute(
            "SELECT run_id, trigger, started_at FROM runs WHERE ended_at IS NULL"
        ).fetchall()
        for run_id, trigger, started_at in open_runs:
            if started_at is None or started_at > floor:
                continue                       # younger than a run-lifetime
            refs = [r[0] for r in conn.execute(
                "SELECT ref FROM processes WHERE run_id=? AND ended_at IS NULL",
                (run_id,)).fetchall()]
            if not refs:
                continue                       # no pid evidence — not our call
            if not all(_pid_alive(ref) is False for ref in refs):
                continue                       # a live/un-ageable ref spares it
            trig = trigger or "unknown"
            conn.execute(
                """INSERT INTO runs (run_id, ended_at, verdict, verdict_source, exit_code)
                   VALUES (?,?,?,?,?)
                   ON CONFLICT(run_id) DO UPDATE SET
                     ended_at=excluded.ended_at,
                     verdict=excluded.verdict,
                     verdict_source=COALESCE(excluded.verdict_source, runs.verdict_source),
                     exit_code=excluded.exit_code""",
                (run_id, now, "died-in:" + trig, "orphan-sweep", 137))
            conn.execute(
                "UPDATE attempts SET ended_at=? WHERE run_id=? AND ended_at IS NULL",
                (now, run_id))
            conn.execute(
                "UPDATE processes SET ended_at=? WHERE run_id=? AND ended_at IS NULL",
                (now, run_id))
            swept.append((run_id, trig))
    conn.close()
    for run_id, trig in swept:
        print("swept %s %s" % (run_id, trig))


def cmd_spend(a):
    migrate(a.db)
    conn = connect(a.db)
    with conn:
        conn.execute(
            "INSERT INTO spend (run_id, issue, input_tokens, output_tokens, requests, at, account, "
            "cache_creation_tokens, cache_read_tokens, model) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (a.run, a.issue, a.input, a.output, a.requests, _now(a.at), a.account,
             a.cache_creation, a.cache_read, a.model),
        )
    conn.close()


# --- session-file ingest (#98) -----------------------------------------------
# The true per-action record — every API request with its own usage, every tool
# call — already lives in the claude session jsonl `record-run-result.sh` stores
# as `iteration` events, but nothing parsed it: per-action granularity was
# archaeology. This walks ONE session jsonl and emits per-REQUEST `spend` rows
# (cache classes split, the #96 columns) plus per-tool-call `events` (tool name,
# duration from the assistant→tool_result timestamp gap). Best-effort like every
# swarm.db writer: a parse failure records nothing and never fails the caller
# (cmd_ingest swallows every exception). When it writes ≥1 per-request spend row,
# record-run-result.sh SKIPS its single aggregate row for that iteration — the
# per-request rows sum to the same tokens, so there is no double count.


def _parse_iso_ts(s):
    """ISO-8601 timestamp (trailing `Z` or numeric offset) -> float epoch, or
    None. Claude session lines stamp millisecond precision (`...T..:..:..000Z`);
    older Pythons are strict about the fractional field, so fall back to a
    fraction-stripped retry before giving up."""
    if not s or not isinstance(s, str):
        return None
    t = s.strip()
    if t.endswith("Z"):
        t = t[:-1] + "+00:00"
    try:
        return datetime.datetime.fromisoformat(t).timestamp()
    except Exception:
        pass
    try:
        return datetime.datetime.fromisoformat(re.sub(r"\.\d+", "", t)).timestamp()
    except Exception:
        return None


def ingest_session(conn, run, issue, path, account):
    """Parse one claude session jsonl into per-request spend + per-tool-call
    events on `conn`. Returns (n_spend_rows, n_tool_events). Raises on IO/parse
    of the file itself (cmd_ingest catches); a single malformed LINE is skipped,
    not fatal — a truncated session still yields every well-formed record."""
    n_spend = 0
    calls = []          # ordered {id, name, at} for each tool_use, encounter order
    result_ts = {}      # tool_use_id -> float epoch of its tool_result
    with open(path, "r") as fh:
        for line in fh:
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            typ = obj.get("type")
            msg = obj.get("message") if isinstance(obj.get("message"), dict) else {}
            ts = _parse_iso_ts(obj.get("timestamp"))
            if typ == "assistant":
                usage = msg.get("usage")
                if isinstance(usage, dict) and usage:
                    # One assistant message == one API request. requests=1 each;
                    # they SUM to the iteration's real request count.
                    conn.execute(
                        "INSERT INTO spend (run_id, issue, input_tokens, output_tokens, "
                        "requests, at, account, cache_creation_tokens, cache_read_tokens, model) "
                        "VALUES (?,?,?,?,?,?,?,?,?,?)",
                        (run, issue,
                         usage.get("input_tokens"), usage.get("output_tokens"), 1,
                         int(ts) if ts is not None else int(time.time()), account,
                         usage.get("cache_creation_input_tokens"),
                         usage.get("cache_read_input_tokens"),
                         msg.get("model")))
                    n_spend += 1
                content = msg.get("content")
                if isinstance(content, list):
                    for block in content:
                        if not isinstance(block, dict) or block.get("type") != "tool_use":
                            continue
                        name = block.get("name")
                        if isinstance(name, str) and name:
                            calls.append({"id": block.get("id"), "name": name, "at": ts})
            elif typ == "user":
                content = msg.get("content")
                if isinstance(content, list):
                    for block in content:
                        if not isinstance(block, dict) or block.get("type") != "tool_result":
                            continue
                        tid = block.get("tool_use_id")
                        if tid and ts is not None:
                            result_ts.setdefault(tid, ts)  # first result wins

    for c in calls:
        at = c["at"]
        rt = result_ts.get(c["id"]) if c["id"] else None
        # duration is derived from the gap to the matching tool_result; a call
        # with no result yet (truncated/last) records its name with no duration.
        evidence = ""
        if rt is not None and at is not None and rt >= at:
            evidence = "duration_ms=%d" % int(round((rt - at) * 1000))
        conn.execute(
            "INSERT INTO events (run_id, issue, at, kind, detail, evidence) VALUES (?,?,?,?,?,?)",
            (run, issue, int(at) if at is not None else None, "tool-call", c["name"], evidence))
    return n_spend, len(calls)


def cmd_ingest(a):
    """Best-effort: prints `<n_spend> <n_tool_events>` and ALWAYS exits 0 (return
    None => main() maps to 0). record-run-result.sh reads the spend count to
    decide whether the per-request rows replaced its aggregate fallback."""
    migrate(a.db)
    n_spend = n_events = 0
    try:
        conn = connect(a.db)
        try:
            with conn:
                n_spend, n_events = ingest_session(conn, a.run, a.issue, a.session, a.account)
        finally:
            conn.close()
    except Exception:
        n_spend = n_events = 0
    print("%d %d" % (n_spend, n_events))


# --- reader surface: canned queries (swarm-db.sh wraps these) ----------------

def _print_rows(rows, headers):
    print("\t".join(headers))
    for r in rows:
        print("\t".join("" if c is None else str(c) for c in r))


def q_issue(conn, args, repo):
    """History of one issue: attempts, then events, then spend — chronological.

    Issue numbers are PER-REPO but swarm.db is one shared db per host (ADR 0004
    point 5), so this read MUST be repo-scoped or it conflates every repo's
    issue N. `attempts`/`events`/`spend` carry no repo of their own — they reach
    it through `runs.repo` via `run_id` — so each is LEFT JOINed to `runs` and
    filtered by repo. `repo=None` means the escape hatch (`--repo all`): no
    filter, every repo's rows (a LEFT JOIN keeps rows whose run row is missing)."""
    issue = int(args[0])
    p = {"issue": issue, "repo": repo}
    rf = "" if repo is None else " AND r.repo = :repo"
    print("== attempts ==")
    _print_rows(conn.execute(
        "SELECT a.run_id, a.iteration, a.status, a.commits, a.close_outcome, a.started_at, a.ended_at "
        "FROM attempts a LEFT JOIN runs r ON a.run_id = r.run_id "
        "WHERE a.issue = :issue" + rf + " ORDER BY a.started_at, a.iteration", p).fetchall(),
        ["run", "iter", "status", "commits", "close", "started", "ended"])
    print("== events ==")
    _print_rows(conn.execute(
        "SELECT e.at, e.run_id, e.kind, e.detail, e.evidence "
        "FROM events e LEFT JOIN runs r ON e.run_id = r.run_id "
        "WHERE e.issue = :issue" + rf + " ORDER BY e.at", p).fetchall(),
        ["at", "run", "kind", "detail", "evidence"])
    print("== spend ==")
    _print_rows(conn.execute(
        "SELECT s.at, s.run_id, s.input_tokens, s.output_tokens, s.requests "
        "FROM spend s LEFT JOIN runs r ON s.run_id = r.run_id "
        "WHERE s.issue = :issue" + rf + " ORDER BY s.at", p).fetchall(),
        ["at", "run", "in", "out", "req"])


def q_open_processes(conn, args, repo):
    """Believed-alive process rows — the #435 wedge surface (a row, no end).

    Host-scoped by design (ADR 0004 point 5) — the default answers a HOST
    question — but takes an OPTIONAL repo filter (`--repo <slug>`) to narrow to
    one consumer's wedges. `repo=None` => the whole host."""
    rf = "" if repo is None else " AND r.repo = :repo"
    _print_rows(conn.execute(
        "SELECT p.run_id, p.kind, p.ref, p.command, p.started_at "
        "FROM processes p LEFT JOIN runs r ON p.run_id = r.run_id "
        "WHERE p.ended_at IS NULL" + rf + " ORDER BY p.started_at",
        {"repo": repo}).fetchall(),
        ["run", "kind", "ref", "command", "started"])


def q_spend_weekly(conn, args, repo):
    """Token/request spend bucketed by ISO week. Host-scoped by design with an
    OPTIONAL repo filter (`--repo <slug>`); `repo=None` => the whole host."""
    rf = "" if repo is None else " WHERE r.repo = :repo"
    _print_rows(conn.execute(
        "SELECT strftime('%Y-W%W', s.at, 'unixepoch') AS week, "
        "COALESCE(SUM(s.input_tokens),0), COALESCE(SUM(s.output_tokens),0), "
        "COALESCE(SUM(s.requests),0), COUNT(*) "
        "FROM spend s LEFT JOIN runs r ON s.run_id = r.run_id" + rf +
        " GROUP BY week ORDER BY week", {"repo": repo}).fetchall(),
        ["week", "in", "out", "req", "records"])


def _percentile(sorted_vals, p):
    """Nearest-rank percentile of an already-sorted list. rank = ceil(p/100 * n),
    1-based; clamped to [1, n]. SQLite has no native percentile, so the values
    come back from the query and the maths lives here."""
    n = len(sorted_vals)
    if n == 0:
        return ""
    rank = -(-(p * n) // 100)      # integer ceil of p/100 * n
    rank = max(1, min(n, rank))
    return sorted_vals[rank - 1]


def q_queue_wait(conn, args, repo):
    """Ready→claimed queue-wait percentiles bucketed by DAY, from `queue-wait`
    events (record-run-result.sh writes the seconds into `detail`). The backlog's
    core health number — how long a ticket sits claimable before a machine takes
    it (#99). Host-scoped by design with an OPTIONAL repo filter (`--repo <slug>`,
    the TUI's REPOS-tab call); `repo=None` => the whole host. Percentiles are
    computed in Python (`_percentile`) since SQLite carries none natively."""
    rf = "" if repo is None else " AND r.repo = :repo"
    rows = conn.execute(
        "SELECT strftime('%Y-%m-%d', e.at, 'unixepoch') AS day, "
        "CAST(e.detail AS INTEGER) AS secs "
        "FROM events e LEFT JOIN runs r ON e.run_id = r.run_id "
        "WHERE e.kind = 'queue-wait' AND e.detail IS NOT NULL AND e.detail != ''" + rf +
        " ORDER BY day", {"repo": repo}).fetchall()
    by_day = {}
    for day, secs in rows:
        by_day.setdefault(day, []).append(secs)
    out = []
    for day in sorted(by_day):
        vals = sorted(by_day[day])
        out.append((day, len(vals),
                    _percentile(vals, 50), _percentile(vals, 90), _percentile(vals, 99)))
    _print_rows(out, ["day", "n", "p50", "p90", "p99"])


def q_red_by_stage(conn, args, repo):
    """Red runs (non-zero exit) grouped by the verdict/stage that killed them.
    Host-scoped by design with an OPTIONAL repo filter (`--repo <slug>`);
    `repo=None` => the whole host."""
    rf = "" if repo is None else " AND repo = :repo"
    _print_rows(conn.execute(
        "SELECT COALESCE(verdict, 'unknown') AS stage, COUNT(*) "
        "FROM runs WHERE exit_code IS NOT NULL AND exit_code != 0" + rf +
        " GROUP BY stage ORDER BY COUNT(*) DESC", {"repo": repo}).fetchall(),
        ["stage", "red_runs"])


def q_limit_lost(conn, args, repo):
    """Lost capacity to Claude usage limits, per account, bucketed by ISO week
    (#100). Reads the `limit-pause` edge events limit-lib.sh records — a `park`
    opens a window for the exhausted account, the next `unpark` for that account
    closes it — and sums the parked seconds into the week the park STARTED in.

    Host-scoped by nature: a subscription window is one host-global thing, so
    this reads every `limit-pause` row (no repo filter). An unclosed park (still
    parked, or an exit no tick observed yet) contributes no duration — only
    closed windows are counted, so the number never over-reports."""
    rows = conn.execute(
        "SELECT at, detail FROM events WHERE kind = 'limit-pause' ORDER BY at, id"
    ).fetchall()
    open_at = {}          # account -> the `at` of its currently-open park
    agg = {}              # (week, account) -> [parked_seconds, windows]
    for at, detail in rows:
        parts = (detail or "").split()
        edge = parts[0] if parts else ""
        acct = next((p.split("=", 1)[1] for p in parts
                     if p.startswith("account=")), "?")
        if edge == "park":
            open_at.setdefault(acct, at)               # first park wins; re-hits ignored
        elif edge == "unpark" and acct in open_at:
            start = open_at.pop(acct)
            week = time.strftime("%Y-W%W", time.gmtime(start))
            cell = agg.setdefault((week, acct), [0, 0])
            cell[0] += max(0, (at or 0) - (start or 0))
            cell[1] += 1
    _print_rows(
        [(w, a, s, n) for (w, a), (s, n) in sorted(agg.items())],
        ["week", "account", "parked_s", "windows"])


QUERIES = {
    "issue": q_issue,
    "open-processes": q_open_processes,
    "spend-weekly": q_spend_weekly,
    "red-by-stage": q_red_by_stage,
    "queue-wait": q_queue_wait,
    "limit-lost": q_limit_lost,
}


def cmd_query(a):
    migrate(a.db)
    fn = QUERIES.get(a.name)
    if not fn:
        sys.stderr.write("unknown query: %s (have: %s)\n" % (a.name, ", ".join(sorted(QUERIES))))
        return 2
    # `--repo all` (or absent) is the escape hatch: no filter, host-wide.
    repo = getattr(a, "repo", None)
    if repo == "all":
        repo = None
    conn = connect(a.db)
    try:
        fn(conn, a.args, repo)
    finally:
        conn.close()
    return 0


def build_parser():
    p = argparse.ArgumentParser(description="swarm.db trace mirror (#447)")
    p.add_argument("--db", default=os.environ.get("SWARM_DB", DEFAULT_DB))
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("migrate").set_defaults(func=cmd_migrate)

    s = sub.add_parser("run-start"); s.set_defaults(func=cmd_run_start)
    s.add_argument("--run", required=True)
    s.add_argument("--repo")
    s.add_argument("--trigger")
    s.add_argument("--started", type=int)

    s = sub.add_parser("run-end"); s.set_defaults(func=cmd_run_end)
    s.add_argument("--run", required=True)
    s.add_argument("--verdict")
    s.add_argument("--source")
    s.add_argument("--exit", type=int)
    s.add_argument("--ended", type=int)

    s = sub.add_parser("attempt"); s.set_defaults(func=cmd_attempt)
    s.add_argument("--run", required=True)
    s.add_argument("--issue", type=int, required=True)
    s.add_argument("--iteration", type=int, default=1)
    s.add_argument("--status")               # omitted => DB DEFAULT 'fail'
    s.add_argument("--commits")
    s.add_argument("--close-outcome", dest="close_outcome")
    s.add_argument("--started", type=int)
    s.add_argument("--ended", type=int)

    s = sub.add_parser("event"); s.set_defaults(func=cmd_event)
    s.add_argument("--run", required=True)
    s.add_argument("--issue", type=int)
    s.add_argument("--kind", required=True)
    s.add_argument("--detail")
    s.add_argument("--evidence")
    s.add_argument("--at", type=int)

    s = sub.add_parser("proc-open"); s.set_defaults(func=cmd_proc_open)
    s.add_argument("--run", required=True)
    s.add_argument("--kind", required=True)
    s.add_argument("--ref")
    s.add_argument("--command")
    s.add_argument("--started", type=int)
    s.add_argument("--ended", type=int)      # normally omitted (open row)

    s = sub.add_parser("proc-close"); s.set_defaults(func=cmd_proc_close)
    s.add_argument("--run", required=True)
    s.add_argument("--ref", required=True)
    s.add_argument("--ended", type=int)

    s = sub.add_parser("sweep-orphans"); s.set_defaults(func=cmd_sweep_orphans)
    s.add_argument("--max-age", type=int, dest="max_age")  # override the run-lifetime floor
    s.add_argument("--at", type=int)                        # `now` override (tests)

    s = sub.add_parser("spend"); s.set_defaults(func=cmd_spend)
    s.add_argument("--run", required=True)
    s.add_argument("--issue", type=int)
    s.add_argument("--input", type=int)
    s.add_argument("--output", type=int)
    s.add_argument("--requests", type=int)
    s.add_argument("--at", type=int)
    s.add_argument("--account")               # the active account letter; omitted => NULL (unattributed)
    s.add_argument("--cache-creation", type=int)  # cache-write tokens; omitted => NULL (#96)
    s.add_argument("--cache-read", type=int)       # cache-read tokens; omitted => NULL (#96)
    s.add_argument("--model")                      # the billing model; omitted => NULL (#96)

    s = sub.add_parser("ingest"); s.set_defaults(func=cmd_ingest)
    s.add_argument("--run", required=True)
    s.add_argument("--issue", type=int)       # omitted => NULL (run-scoped)
    s.add_argument("--session", required=True)  # path to the claude session jsonl
    s.add_argument("--account")               # active account letter; omitted => NULL

    s = sub.add_parser("query"); s.set_defaults(func=cmd_query)
    s.add_argument("name")
    s.add_argument("--repo")                  # None/all => host-wide (no filter)
    s.add_argument("args", nargs="*")

    return p


def main(argv):
    args = build_parser().parse_args(argv)
    rc = args.func(args)
    return rc or 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
