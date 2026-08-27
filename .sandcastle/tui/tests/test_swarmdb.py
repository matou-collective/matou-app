"""Builds a real swarm.db via the actual .sandcastle/swarm-db.py CLI (the
production writer) so these tests exercise the exact schema/producer the TUI
reads in the field, never a hand-duplicated schema that could drift."""

import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from data import swarmdb  # noqa: E402

# A stand-in slug: the reader is repo-agnostic, and no product name belongs
# in a vendored file.
REPO = "Owner/repo"

SWARM_DB_PY = Path(__file__).resolve().parents[2] / "swarm-db.py"


def _run(db, *args):
    subprocess.run(
        [sys.executable, str(SWARM_DB_PY), "--db", str(db), *args],
        check=True, capture_output=True, text=True,
    )


def _seeded_db(tmp_path):
    db = tmp_path / "swarm.db"
    _run(db, "run-start", "--run", "run-1", "--repo", REPO,
         "--trigger", "cron", "--started", "1000")
    _run(db, "attempt", "--run", "run-1", "--issue", "573",
         "--started", "1000", "--status", "success")
    _run(db, "spend", "--run", "run-1", "--issue", "573",
         "--input", "100", "--output", "50",
         "--requests", "3", "--at", "1000")
    _run(db, "run-end", "--run", "run-1", "--verdict", "completed",
         "--exit", "0", "--ended", "1100")

    _run(db, "run-start", "--run", "run-2", "--repo", REPO,
         "--trigger", "label", "--started", "2000")
    _run(db, "proc-open", "--run", "run-2", "--kind", "worker",
         "--ref", "pid-42", "--command", "claude", "--started", "2000")
    return db


def test_recent_runs_newest_first(tmp_path):
    conn = swarmdb.connect(_seeded_db(tmp_path))
    rows = swarmdb.recent_runs(conn)
    assert [r["run_id"] for r in rows] == ["run-2", "run-1"]
    assert rows[1]["verdict"] == "completed"
    assert rows[1]["exit_code"] == 0
    assert rows[0]["ended_at"] is None  # run-2 never ended: believed running


def test_recent_attempts_carries_repo_via_join(tmp_path):
    conn = swarmdb.connect(_seeded_db(tmp_path))
    rows = swarmdb.recent_attempts(conn)
    assert len(rows) == 1
    assert rows[0]["issue"] == 573
    assert rows[0]["repo"] == REPO
    assert rows[0]["status"] == "success"


def test_open_processes_excludes_closed(tmp_path):
    conn = swarmdb.connect(_seeded_db(tmp_path))
    rows = swarmdb.open_processes(conn)
    assert len(rows) == 1
    assert rows[0]["ref"] == "pid-42"


def test_spend_totals_sums_all_rows(tmp_path):
    conn = swarmdb.connect(_seeded_db(tmp_path))
    totals = swarmdb.spend_totals(conn)
    assert totals == {"input_tokens": 100, "output_tokens": 50, "requests": 3}


def test_spend_totals_since_epoch_excludes_older_rows(tmp_path):
    conn = swarmdb.connect(_seeded_db(tmp_path))
    totals = swarmdb.spend_totals(conn, since_epoch=1500)
    assert totals == {"input_tokens": 0, "output_tokens": 0, "requests": 0}


def test_recent_runs_respects_limit(tmp_path):
    conn = swarmdb.connect(_seeded_db(tmp_path))
    rows = swarmdb.recent_runs(conn, limit=1)
    assert len(rows) == 1
    assert rows[0]["run_id"] == "run-2"


def test_running_run_returns_the_open_run(tmp_path):
    conn = swarmdb.connect(_seeded_db(tmp_path))
    row = swarmdb.running_run(conn)
    assert row["run_id"] == "run-2"  # run-1 ended, run-2 never did
    assert row["repo"] == REPO


def test_running_run_none_when_every_run_ended(tmp_path):
    db = tmp_path / "swarm.db"
    _run(db, "run-start", "--run", "run-1", "--repo", REPO,
         "--trigger", "cron", "--started", "1000")
    _run(db, "run-end", "--run", "run-1", "--verdict", "completed",
         "--exit", "0", "--ended", "1100")
    conn = swarmdb.connect(db)
    assert swarmdb.running_run(conn) is None


def test_connect_is_read_only(tmp_path):
    conn = swarmdb.connect(_seeded_db(tmp_path))
    try:
        conn.execute("INSERT INTO runs (run_id) VALUES ('should-fail')")
        conn.commit()
        assert False, "expected sqlite3.OperationalError on a read-only connection"
    except Exception as exc:
        assert "readonly" in str(exc).lower()
