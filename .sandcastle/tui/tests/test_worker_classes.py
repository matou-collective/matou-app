import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from data import worker_classes  # noqa: E402


def _write(path, classes):
    path.write_text(json.dumps({"classes": classes}))
    return str(path)


def test_bundled_table_travels_with_the_reader():
    # The harness's own classes are vendored beside this module, so every
    # consumer's Fleet tab shows the same factory table.
    classes = worker_classes.load_worker_classes()
    assert len(classes) >= 9
    ids = {c["id"] for c in classes}
    assert {"swarm-worker", "triage", "healer", "session-runner"} <= ids


def test_bundled_table_declares_no_hosts():
    # Which machines run a class is a per-deployment fact — a vendored file
    # that named one would be wrong in every other consumer.
    for cls in worker_classes.load_worker_classes():
        assert not cls.get("hosts"), f"{cls['id']} names hosts in the vendored table"


def test_load_worker_classes_absent_file_is_empty(tmp_path):
    assert worker_classes.load_worker_classes(str(tmp_path / "no-such.json")) == []


def test_load_worker_classes_malformed_json_is_empty(tmp_path):
    path = tmp_path / "worker-classes.json"
    path.write_text("{not json")
    assert worker_classes.load_worker_classes(str(path)) == []


def test_load_worker_classes_parses_classes_array(tmp_path):
    path = _write(tmp_path / "worker-classes.json",
                  [{"id": "healer", "name": "healer", "hosts": ["host-a"]}])
    classes = worker_classes.load_worker_classes(path)
    assert len(classes) == 1
    assert classes[0]["id"] == "healer"


def test_overlay_is_optional(tmp_path):
    assert worker_classes.load_overlay(None) == []
    assert worker_classes.load_overlay(str(tmp_path / "no-such.json")) == []


def test_overlay_declares_hosts_for_a_known_class(tmp_path):
    base = [{"id": "healer", "name": "healer", "trigger": "hourly cron",
             "stuck_signal": "none by design"}]
    overlay = [{"id": "healer", "hosts": ["host-a"]}]
    merged = worker_classes.merge_classes(base, overlay)
    assert len(merged) == 1
    assert merged[0]["hosts"] == ["host-a"]
    # …without losing the vendored description of the class.
    assert merged[0]["trigger"] == "hourly cron"


def test_overlay_appends_a_class_only_this_repo_runs(tmp_path):
    base = [{"id": "healer", "name": "healer"}]
    overlay = [{"id": "check-verifications", "name": "check-verifications",
                "hosts": ["host-b"], "trigger": "verify.yml"}]
    merged = worker_classes.merge_classes(base, overlay)
    assert [c["id"] for c in merged] == ["healer", "check-verifications"]


def test_merge_never_mutates_the_vendored_table():
    base = [{"id": "healer", "name": "healer"}]
    worker_classes.merge_classes(base, [{"id": "healer", "hosts": ["host-a"]}])
    assert "hosts" not in base[0]


def test_fleet_rows_expands_multi_host_class():
    classes = [{
        "id": "swarm-worker", "name": "swarm worker",
        "hosts": ["host-a", "host-b"],
        "trigger": "cron", "lock": "slot lock",
        "invisible_failure": False, "stuck_signal": "verdict file",
    }]
    rows = worker_classes.fleet_rows(classes)
    assert [r["host"] for r in rows] == ["host-a", "host-b"]
    assert all(r["name"] == "swarm worker" for r in rows)
    assert all(r["invisible_failure"] is False for r in rows)


def test_fleet_rows_gives_placeholder_host_for_undeclared_hosts():
    classes = [{
        "id": "check-verifications", "name": "check-verifications",
        "hosts": [], "trigger": "verify.yml", "lock": None,
        "invisible_failure": False, "stuck_signal": None,
    }]
    rows = worker_classes.fleet_rows(classes)
    assert len(rows) == 1
    assert rows[0]["host"] == "-"
    assert rows[0]["lock"] == "none"
    assert rows[0]["stuck_signal"] == "-"


def test_fleet_rows_surfaces_invisible_failure_flag():
    classes = [
        {"id": "healer", "name": "healer", "hosts": ["host-a"],
         "invisible_failure": True, "stuck_signal": "none by design"},
        {"id": "triage", "name": "triage", "hosts": ["host-a"],
         "invisible_failure": False, "stuck_signal": "trap EXIT"},
    ]
    rows = worker_classes.fleet_rows(classes)
    flagged = [r for r in rows if r["invisible_failure"]]
    assert [r["id"] for r in flagged] == ["healer"]
