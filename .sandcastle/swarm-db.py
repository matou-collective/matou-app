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
import os
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
  input_tokens  INTEGER,
  output_tokens INTEGER,
  requests      INTEGER,
  at            INTEGER
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


def migrate(db):
    conn = connect(db)
    with conn:
        conn.executescript(SCHEMA)
    conn.close()


def _now(v):
    return int(v) if v is not None else int(time.time())


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


def cmd_spend(a):
    migrate(a.db)
    conn = connect(a.db)
    with conn:
        conn.execute(
            "INSERT INTO spend (run_id, issue, input_tokens, output_tokens, requests, at) VALUES (?,?,?,?,?,?)",
            (a.run, a.issue, a.input, a.output, a.requests, _now(a.at)),
        )
    conn.close()


# --- reader surface: canned queries (swarm-db.sh wraps these) ----------------

def _print_rows(rows, headers):
    print("\t".join(headers))
    for r in rows:
        print("\t".join("" if c is None else str(c) for c in r))


def q_issue(conn, args):
    """History of one issue: attempts, then events, then spend — chronological."""
    issue = int(args[0])
    print("== attempts ==")
    _print_rows(conn.execute(
        "SELECT run_id, iteration, status, commits, close_outcome, started_at, ended_at "
        "FROM attempts WHERE issue=? ORDER BY started_at, iteration", (issue,)).fetchall(),
        ["run", "iter", "status", "commits", "close", "started", "ended"])
    print("== events ==")
    _print_rows(conn.execute(
        "SELECT at, run_id, kind, detail, evidence FROM events WHERE issue=? ORDER BY at", (issue,)).fetchall(),
        ["at", "run", "kind", "detail", "evidence"])
    print("== spend ==")
    _print_rows(conn.execute(
        "SELECT at, run_id, input_tokens, output_tokens, requests FROM spend WHERE issue=? ORDER BY at", (issue,)).fetchall(),
        ["at", "run", "in", "out", "req"])


def q_open_processes(conn, args):
    """Believed-alive process rows — the #435 wedge surface (a row, no end)."""
    _print_rows(conn.execute(
        "SELECT run_id, kind, ref, command, started_at FROM processes "
        "WHERE ended_at IS NULL ORDER BY started_at").fetchall(),
        ["run", "kind", "ref", "command", "started"])


def q_spend_weekly(conn, args):
    """Token/request spend bucketed by ISO week."""
    _print_rows(conn.execute(
        "SELECT strftime('%Y-W%W', at, 'unixepoch') AS week, "
        "COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0), "
        "COALESCE(SUM(requests),0), COUNT(*) "
        "FROM spend GROUP BY week ORDER BY week").fetchall(),
        ["week", "in", "out", "req", "records"])


def q_red_by_stage(conn, args):
    """Red runs (non-zero exit) grouped by the verdict/stage that killed them."""
    _print_rows(conn.execute(
        "SELECT COALESCE(verdict, 'unknown') AS stage, COUNT(*) "
        "FROM runs WHERE exit_code IS NOT NULL AND exit_code != 0 "
        "GROUP BY stage ORDER BY COUNT(*) DESC").fetchall(),
        ["stage", "red_runs"])


QUERIES = {
    "issue": q_issue,
    "open-processes": q_open_processes,
    "spend-weekly": q_spend_weekly,
    "red-by-stage": q_red_by_stage,
}


def cmd_query(a):
    migrate(a.db)
    fn = QUERIES.get(a.name)
    if not fn:
        sys.stderr.write("unknown query: %s (have: %s)\n" % (a.name, ", ".join(sorted(QUERIES))))
        return 2
    conn = connect(a.db)
    try:
        fn(conn, a.args)
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

    s = sub.add_parser("spend"); s.set_defaults(func=cmd_spend)
    s.add_argument("--run", required=True)
    s.add_argument("--issue", type=int)
    s.add_argument("--input", type=int)
    s.add_argument("--output", type=int)
    s.add_argument("--requests", type=int)
    s.add_argument("--at", type=int)

    s = sub.add_parser("query"); s.set_defaults(func=cmd_query)
    s.add_argument("name")
    s.add_argument("args", nargs="*")

    return p


def main(argv):
    args = build_parser().parse_args(argv)
    rc = args.func(args)
    return rc or 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
