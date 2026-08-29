"""swarmdb.py — read-only queries over swarm.db for the factory TUI.

Read-only mirror of the schema swarm-db.py owns and writes; this module never
migrates or writes. The db path is swarm-db-lib.sh's own $SWARM_DB, resolved
by data/identity.py and passed in. Same WAL/busy_timeout posture as every other
reader (readers never block writers) so a live run-swarm.sh keeps writing
while the TUI is open.
"""

import sqlite3


def connect(db):
    # A falsy path means the identity layer resolved none; raising the error
    # the callers already handle keeps "no db" a display concern, not a crash.
    if not db:
        raise sqlite3.OperationalError("no swarm.db path resolved from the identity layer")
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=30)
    conn.execute("PRAGMA busy_timeout=5000")
    conn.row_factory = sqlite3.Row
    return conn


def recent_runs(conn, limit=20):
    """Most recent runs, newest first. ended_at NULL = believed still running."""
    return conn.execute(
        """SELECT run_id, repo, trigger, started_at, ended_at, verdict, exit_code
           FROM runs ORDER BY started_at DESC LIMIT ?""",
        (limit,),
    ).fetchall()


def recent_attempts(conn, limit=20):
    """Most recent attempts, newest first, joined to their run's repo."""
    return conn.execute(
        """SELECT a.run_id, r.repo, a.issue, a.iteration, a.status,
                  a.close_outcome, a.started_at, a.ended_at
           FROM attempts a LEFT JOIN runs r ON r.run_id = a.run_id
           ORDER BY a.started_at DESC LIMIT ?""",
        (limit,),
    ).fetchall()


def running_run(conn):
    """The run believed still running (ended_at IS NULL — the same #435 wedge
    marker `open_processes` uses), most recent first, or None. This is the
    Cancel action's target: #612 cancels a whole run (all remaining
    iterations), which is exactly the granularity `runs` rows are at."""
    return conn.execute(
        """SELECT run_id, repo, trigger, started_at
           FROM runs WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1"""
    ).fetchone()


def open_processes(conn):
    """Processes with no ended_at — the #435 wedge marker: believed alive."""
    return conn.execute(
        """SELECT run_id, kind, ref, command, started_at
           FROM processes WHERE ended_at IS NULL ORDER BY started_at DESC"""
    ).fetchall()


def spend_totals(conn, since_epoch=0):
    """Aggregate token/request spend since a given epoch (0 = all time)."""
    row = conn.execute(
        """SELECT COALESCE(SUM(input_tokens),0) AS input_tokens,
                  COALESCE(SUM(output_tokens),0) AS output_tokens,
                  COALESCE(SUM(requests),0) AS requests
           FROM spend WHERE at >= ?""",
        (since_epoch,),
    ).fetchone()
    return dict(row)
