"""data/drive_status.py — the drive record is read at whatever path the
consumer's identity layer declares; the reader itself knows no path at all."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from data import drive_status  # noqa: E402


def test_absent_file_is_none(tmp_path):
    assert drive_status.read_drive_status_at(str(tmp_path / "no-such.json")) is None


def test_no_configured_path_is_none():
    # A consumer that declares no DRIVE_STATUS_FILE has no drive to show —
    # never a guessed host path.
    assert drive_status.read_drive_status_at(None) is None
    assert drive_status.read_drive_status_at("") is None


# The exact key spelling a consumer may ALREADY be writing, pinned literally
# rather than built from the reader's constant: the record is that consumer's
# schema and the topology is pull-only, so this is a wire format, and a change
# to the reader's constant must not be able to drop a live writer in silence.
LEGACY_BOX_KEYS = {  # box-vocabulary-waiver (#53)
    "droplet_name": "rehearsal-01",  # box-vocabulary-waiver (#53)
    "droplet_ip": "10.0.0.5",  # box-vocabulary-waiver (#53)
}


def test_parses_live_record(tmp_path):
    path = tmp_path / "drive-status.json"
    path.write_text(json.dumps({
        "pid": "1234", "target": "selfhosted", "startedAt": 1700000000,
        "box_name": "rehearsal-01", "box_ip": "10.0.0.5",
    }))
    status = drive_status.read_drive_status_at(str(path))
    assert status["pid"] == "1234"
    assert status["box_ip"] == "10.0.0.5"
    assert drive_status.box_name(status) == "rehearsal-01"
    assert drive_status.box_ip(status) == "10.0.0.5"


def test_box_accessors_read_a_consumers_legacy_keys(tmp_path):
    # A repo writing the provider-shaped spelling keeps its panel: renaming a
    # key in a file the CONSUMER writes is a schema change on someone else's
    # file, and pull-only (ADR 0001) means the harness cannot make it.
    path = tmp_path / "drive-status.json"
    path.write_text(json.dumps({"pid": "1234", **LEGACY_BOX_KEYS}))
    status = drive_status.read_drive_status_at(str(path))
    assert drive_status.box_name(status) == "rehearsal-01"
    assert drive_status.box_ip(status) == "10.0.0.5"


def test_box_accessors_prefer_the_neutral_keys(tmp_path):
    # Both spellings present (a consumer mid-migration): the factory's own
    # vocabulary wins, so the writer can move over one key at a time.
    path = tmp_path / "drive-status.json"
    path.write_text(json.dumps(
        {**LEGACY_BOX_KEYS, "box_name": "new-01", "box_ip": "10.0.0.9"}))
    status = drive_status.read_drive_status_at(str(path))
    assert drive_status.box_name(status) == "new-01"
    assert drive_status.box_ip(status) == "10.0.0.9"


def test_box_accessors_tolerate_a_record_without_a_box():
    # A drive that stands up no box at all, and the no-drive case: the panel
    # asks either way, so neither may raise.
    assert drive_status.box_name({"pid": "1234"}) is None
    assert drive_status.box_ip({"pid": "1234"}) is None
    assert drive_status.box_name(None) is None
    assert drive_status.box_ip(None) is None


def test_malformed_json_is_none(tmp_path):
    path = tmp_path / "drive-status.json"
    path.write_text("{not json")
    assert drive_status.read_drive_status_at(str(path)) is None


def test_unreadable_path_is_none(tmp_path):
    # A directory where a file is expected — same best-effort posture.
    assert drive_status.read_drive_status_at(str(tmp_path)) is None
