import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from data import healer_ledger  # noqa: E402


def _write_ledger(dir_path, signature, fields):
    dir_path.mkdir(parents=True, exist_ok=True)
    body = "".join(f"{k}={v}\n" for k, v in fields.items())
    (dir_path / signature).write_text(body)


def test_load_incidents_absent_dir_is_empty(tmp_path):
    assert healer_ledger.load_incidents(str(tmp_path / "no-such")) == []


def test_load_incidents_parses_a_ledger_file(tmp_path):
    _write_ledger(tmp_path, "133fb5592b07", {
        "thread_id": "3731mdbmppnsjyhp8q4d1hdesh", "repaired": "0",
        "workflow": "swarm (2)", "first_seen": "1786560370",
        "attempts": "1", "last_seen": "1786560370",
    })
    incidents = healer_ledger.load_incidents(str(tmp_path))
    assert len(incidents) == 1
    inc = incidents[0]
    assert inc["signature"] == "133fb5592b07"
    assert inc["workflow"] == "swarm (2)"
    assert inc["first_seen"] == "1786560370"
    assert inc["attempts"] == "1"
    assert inc["repaired"] is False
    assert inc["thread_id"] == "3731mdbmppnsjyhp8q4d1hdesh"
    # replies/escalated are absent from this file — must default, not KeyError.
    assert inc["replies"] == "0"
    assert inc["escalated"] is False


def test_load_incidents_reads_replies_and_escalated(tmp_path):
    _write_ledger(tmp_path, "26418c5a86f3", {
        "repaired": "0", "workflow": "ci", "first_seen": "1785449907",
        "attempts": "1", "replies": "2", "escalated": "1",
        "last_seen": "1785452841",
    })
    inc = healer_ledger.load_incidents(str(tmp_path))[0]
    assert inc["replies"] == "2"
    assert inc["escalated"] is True


def test_load_incidents_ignores_chanmove_bak_files(tmp_path):
    # Real host cruft seen in a live ledger: <sig>.chanmove-bak from an ad-hoc
    # migration, not written by any committed script. Its filename fails the
    # 12-hex-char signature match and must never be read as an incident.
    _write_ledger(tmp_path, "424240d0561a.chanmove-bak", {
        "workflow": "ci", "first_seen": "1785534296", "last_seen": "1785534296",
    })
    assert healer_ledger.load_incidents(str(tmp_path)) == []


def test_load_incidents_ignores_retired_subdirectory(tmp_path):
    # Real host state: manually-retired incidents live under
    # healer/retired/<sig> — a directory, never a top-level ledger file.
    retired = tmp_path / "retired"
    _write_ledger(retired, "59febfdb8d87", {"workflow": "triage", "last_seen": "1785526112"})
    (retired / "README").write_text("# retired 2026-07-31: false positives\n")
    _write_ledger(tmp_path, "133fb5592b07", {"workflow": "swarm", "last_seen": "1786560370"})
    incidents = healer_ledger.load_incidents(str(tmp_path))
    assert [i["signature"] for i in incidents] == ["133fb5592b07"]


def test_load_incidents_empty_file_is_skipped(tmp_path):
    (tmp_path / "000000000000").write_text("")
    assert healer_ledger.load_incidents(str(tmp_path)) == []


def test_incident_rows_sorts_newest_last_seen_first(tmp_path):
    _write_ledger(tmp_path, "aaaaaaaaaaaa", {"workflow": "ci", "last_seen": "1000"})
    _write_ledger(tmp_path, "bbbbbbbbbbbb", {"workflow": "swarm", "last_seen": "3000"})
    _write_ledger(tmp_path, "cccccccccccc", {"workflow": "triage", "last_seen": "2000"})
    incidents = healer_ledger.load_incidents(str(tmp_path))
    rows = healer_ledger.incident_rows(incidents)
    assert [r["signature"] for r in rows] == ["bbbbbbbbbbbb", "cccccccccccc", "aaaaaaaaaaaa"]


def test_incident_rows_tolerates_missing_last_seen(tmp_path):
    _write_ledger(tmp_path, "aaaaaaaaaaaa", {"workflow": "ci"})
    incidents = healer_ledger.load_incidents(str(tmp_path))
    rows = healer_ledger.incident_rows(incidents)
    assert len(rows) == 1


def test_fmt_epoch_none_and_missing_is_dash():
    assert healer_ledger.fmt_epoch(None) == "-"
    assert healer_ledger.fmt_epoch("") == "-"
    assert healer_ledger.fmt_epoch("not-a-number") == "-"


def test_fmt_epoch_formats_a_real_epoch():
    formatted = healer_ledger.fmt_epoch("1000000000")
    assert formatted != "-"
    assert "2001" in formatted
