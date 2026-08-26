"""data/cancel.py — the TUI's write side of the operator-cancel kill-path
(ADR 0186). Pins the marker-file protocol from the Python end;
tests/cancel-lib-test.sh pins the SAME protocol from the bash end (main.mts's
poll + run-swarm.sh's log detector) — see cancel.py's own header for why the
contract is the file shape, not shared code."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from data import cancel  # noqa: E402


def test_request_cancel_writes_a_file_named_after_the_run_id(tmp_path):
    cancel.request_cancel("repo-1755600000-123", "operator: stuck", cancel_dir_path=str(tmp_path))
    marker = tmp_path / "repo-1755600000-123"
    assert marker.exists()
    assert marker.read_text() == "operator: stuck"


def test_request_cancel_creates_the_dir_if_missing(tmp_path):
    target = tmp_path / "cancel-request"
    assert not target.exists()
    cancel.request_cancel("run-1", "", cancel_dir_path=str(target))
    assert (target / "run-1").exists()


def test_request_cancel_empty_reason_writes_empty_file(tmp_path):
    cancel.request_cancel("run-1", "", cancel_dir_path=str(tmp_path))
    assert (tmp_path / "run-1").read_text() == ""


def test_request_cancel_is_idempotent_overwrites_reason(tmp_path):
    cancel.request_cancel("run-1", "first reason", cancel_dir_path=str(tmp_path))
    cancel.request_cancel("run-1", "second reason", cancel_dir_path=str(tmp_path))
    assert (tmp_path / "run-1").read_text() == "second reason"


def test_no_resolved_dir_refuses_rather_than_guessing_a_host_path(monkeypatch):
    # cancel-lib.sh owns $SWARM_CANCEL_DIR; if the identity layer resolved
    # none, writing a marker somewhere invented would be worse than refusing
    # — main.mts polls the lib's dir, and nothing would ever read it.
    monkeypatch.setenv("SWARM_CANCEL_DIR", "/should/not/be/used")
    for missing in (None, ""):
        try:
            cancel.request_cancel("run-1", "", cancel_dir_path=missing)
        except ValueError as exc:
            assert "identity layer" in str(exc)
        else:
            raise AssertionError("expected a refusal, not a guessed path")
