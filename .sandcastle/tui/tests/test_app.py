import json
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import FactoryMonitorApp  # noqa: E402
from data import drive_status, identity  # noqa: E402

# The harness's own writer, one directory up from tui/ — the tests seed the
# db through it so the reader is proven against the real schema, never a
# hand-built table that could drift.
SWARM_DB_PY = Path(__file__).resolve().parents[2] / "swarm-db.py"

# Every offline test states the whole identity layer, so nothing about the
# host running the suite (its tracker, its chat env, its checkouts) can reach
# an assertion.
API = "https://forge.example.invalid/api/v1/repos/Owner/repo"
REPO = "Owner/repo"


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
    _run(db, "run-end", "--run", "run-1", "--verdict", "completed",
         "--exit", "0", "--ended", "1100")
    return db


def _seeded_db_with_run_detail(tmp_path):
    db = tmp_path / "swarm.db"
    _run(db, "run-start", "--run", "run-1", "--repo", REPO,
         "--trigger", "cron", "--started", "1000")
    _run(db, "attempt", "--run", "run-1", "--issue", "607",
         "--started", "1000", "--ended", "1100", "--status", "success")
    _run(db, "run-end", "--run", "run-1", "--verdict", "completed",
         "--exit", "0", "--ended", "1100")

    _run(db, "run-start", "--run", "run-2", "--repo", REPO,
         "--trigger", "label", "--started", "2000")
    _run(db, "attempt", "--run", "run-2", "--issue", "608",
         "--started", "2000", "--status", "fail")
    _run(db, "proc-open", "--run", "run-2", "--kind", "worker",
         "--ref", "pid-42", "--command", "claude", "--started", "2000")
    return db


DEFAULT_TEST_LABELS = [
    {"id": 1, "name": "ready-for-agent"},
    {"id": 2, "name": "ready-for-human"},
    {"id": 3, "name": "priority"},
]


def _app(tmp_path, db=None, tracker_fetch=None, cancel_dir_path=None, cancel_clock=None,
         worker_classes_path=None, worker_classes_overlay=None,
         healer_state_path=None, inbox_forgejo_fetch=None, mattermost_url=None,
         mattermost_channel_id=None, mattermost_token=None, inbox_mattermost_fetch=None,
         inbox_clock=None, labels_fetch=None, labels_poster=None, labels_deleter=None,
         labelop_clock=None, rearm_poster=None, rearm_clock=None,
         answer_fj_poster=None, answer_mm_poster=None):
    return FactoryMonitorApp(
        # A wholly synthetic identity layer: the app resolves nothing from
        # this host, so the suite is hermetic by construction (an inherited
        # MATTERMOST_URL used to flip two of these tests to a live fetch).
        ident=identity.Identity(harness_dir=str(tmp_path), forgejo_api=API, repo_slug=REPO),
        db_path=str(db or (tmp_path / "no-such.db")),
        limit_marker=str(tmp_path / "limit-marker"),
        active_marker=str(tmp_path / "active-marker"),
        drive_status_path=str(tmp_path / "drive-status.json"),
        worker_classes_path=worker_classes_path or str(tmp_path / "no-such-classes.json"),
        worker_classes_overlay=worker_classes_overlay,
        tracker_api=API,
        tracker_fetch=tracker_fetch or (lambda url, token: []),
        tracker_token="fake-token",
        cancel_dir_path=cancel_dir_path or str(tmp_path / "cancel-request"),
        cancel_clock=cancel_clock or (lambda: 1000.0),
        # Never fall through to a live host's healer ledger during tests —
        # that would read real incident data into an assertion
        # (test_healer_ledger.py covers the reader in isolation).
        healer_state_path=healer_state_path or str(tmp_path / "healer-state"),
        # Never fall through to a real network call or a real
        # /run/secrets/mattermost_bot_token read during tests — mattermost_url
        # stays None by default so inbox_snapshot reports 'chat-unavailable'
        # instead of touching urllib.
        inbox_forgejo_fetch=inbox_forgejo_fetch or (lambda url, token: []),
        inbox_mattermost_fetch=inbox_mattermost_fetch or (lambda url, token: {}),
        mattermost_url=mattermost_url,
        mattermost_channel_id=mattermost_channel_id,
        # Never None here — None would leave the identity layer's own token
        # (env, else the bind-mounted secret) in play; a concrete fake keeps
        # the suite fully offline.
        mattermost_token=mattermost_token or "fake-token",
        # Fixed clock so a fixed-epoch test post always lands inside the
        # lookback window, regardless of when the suite actually runs.
        inbox_clock=inbox_clock or (lambda: 2000.0),
        # A fixed 3-label page (<50) so fetch_label_ids resolves without a
        # real network call; tests exercising a write inject their own
        # poster/deleter to assert on, never the real urllib default.
        labels_fetch=labels_fetch or (lambda url, token: DEFAULT_TEST_LABELS),
        labels_poster=labels_poster or (lambda url, token, payload: 200),
        labels_deleter=labels_deleter or (lambda url, token: 204),
        labelop_clock=labelop_clock or (lambda: 1000.0),
        # Never a real network POST during tests — a real dispatch would
        # kick a live swarm run; tests exercising it inject their own poster.
        rearm_poster=rearm_poster or (lambda url, token, payload: 204),
        rearm_clock=rearm_clock or (lambda: 1000.0),
        # Never a real network POST during tests — tests exercising a write
        # inject their own poster to assert on.
        answer_fj_poster=answer_fj_poster or (lambda url, token, payload: 201),
        answer_mm_poster=answer_mm_poster or (lambda url, token, payload: 201),
    )


def _seeded_db_with_open_run(tmp_path):
    db = tmp_path / "swarm.db"
    _run(db, "run-start", "--run", "run-live", "--repo", REPO,
         "--trigger", "cron", "--started", "1000")
    return db


@pytest.mark.asyncio
async def test_runs_table_shows_seeded_rows(tmp_path):
    db = _seeded_db(tmp_path)
    app = _app(tmp_path, db=db)
    async with app.run_test() as pilot:
        await pilot.pause()
        table = app.query_one("#runs-table")
        assert table.row_count == 1
        row = table.get_row_at(0)
        assert "run-1" in row
        assert "completed" in row


@pytest.mark.asyncio
async def test_runs_table_empty_when_db_missing(tmp_path):
    app = _app(tmp_path)
    async with app.run_test() as pilot:
        await pilot.pause()
        table = app.query_one("#runs-table")
        assert table.row_count == 0


@pytest.mark.asyncio
async def test_drive_status_panel_shows_no_drive_when_absent(tmp_path):
    app = _app(tmp_path)
    async with app.run_test() as pilot:
        await pilot.pause()
        text = str(app.query_one("#drive-status").content)
        assert "no drive in flight" in text.lower()


@pytest.mark.asyncio
async def test_drive_status_panel_shows_live_drive(tmp_path):
    status_path = tmp_path / "drive-status.json"
    status_path.write_text(json.dumps({
        "pid": "4242", "target": "selfhosted", "startedAt": 1700000000,
        "box_name": "rehearsal-01", "box_ip": "10.0.0.5",
    }))
    app = _app(tmp_path)
    async with app.run_test() as pilot:
        await pilot.pause()
        text = str(app.query_one("#drive-status").content)
        assert "box=rehearsal-01" in text
        assert "10.0.0.5" in text


@pytest.mark.asyncio
async def test_drive_status_panel_reads_a_consumers_legacy_keys(tmp_path):
    # The record is written by a consumer's own rehearsal machinery and the
    # topology is pull-only, so the panel must keep working for a repo still
    # writing the provider-shaped spelling (#53).
    legacy = drive_status.LEGACY_BOX_PREFIX
    status_path = tmp_path / "drive-status.json"
    status_path.write_text(json.dumps({
        "pid": "4242", f"{legacy}name": "rehearsal-01", f"{legacy}ip": "10.0.0.5",
    }))
    app = _app(tmp_path)
    async with app.run_test() as pilot:
        await pilot.pause()
        text = str(app.query_one("#drive-status").content)
        assert "box=rehearsal-01" in text
        assert "10.0.0.5" in text


@pytest.mark.asyncio
async def test_limit_status_panel_shows_not_parked_by_default(tmp_path):
    app = _app(tmp_path)
    async with app.run_test() as pilot:
        await pilot.pause()
        text = str(app.query_one("#limit-status").content)
        assert "not parked" in text.lower()
        assert "account a" in text.lower()


@pytest.mark.asyncio
async def test_limit_status_panel_shows_parked(tmp_path):
    marker = tmp_path / "limit-marker"
    marker.write_text("")
    app = _app(tmp_path)
    async with app.run_test() as pilot:
        await pilot.pause()
        text = str(app.query_one("#limit-status").content)
        assert "parked" in text.lower()


def _fake_fetch(issues_by_number=None):
    issues_by_number = issues_by_number or {}

    def fetch(url, token):
        if "/dependencies" in url:
            return []
        if "/issues?" in url:
            return list(issues_by_number.values())
        raise AssertionError(f"unexpected url: {url}")

    return fetch


@pytest.mark.asyncio
async def test_queue_table_shows_open_issues_by_state(tmp_path):
    fetch = _fake_fetch({
        1: {"number": 1, "title": "needs a ruling",
            "labels": [{"name": "ready-for-human"}]},
    })
    app = _app(tmp_path, tracker_fetch=fetch)
    async with app.run_test() as pilot:
        await pilot.pause()
        table = app.query_one("#queue-table")
        assert table.row_count == 1
        row = table.get_row_at(0)
        assert "1" in row
        assert "needs a ruling" in row
        assert "ready-for-human" in row


@pytest.mark.asyncio
async def test_queue_table_shows_blocked_ready_for_agent_issue(tmp_path):
    def fetch(url, token):
        if "/dependencies" in url:
            return [{"number": 2, "state": "open"}]
        if "/issues?" in url:
            return [{"number": 3, "title": "blocked ticket",
                      "labels": [{"name": "ready-for-agent"}]}]
        raise AssertionError(f"unexpected url: {url}")

    app = _app(tmp_path, tracker_fetch=fetch)
    async with app.run_test() as pilot:
        await pilot.pause()
        table = app.query_one("#queue-table")
        row = table.get_row_at(0)
        assert "blocked by #2" in " ".join(str(c) for c in row).lower()


@pytest.mark.asyncio
async def test_queue_table_shows_error_on_fetch_failure(tmp_path):
    def fetch(url, token):
        raise OSError("no route to host")

    app = _app(tmp_path, tracker_fetch=fetch)
    async with app.run_test() as pilot:
        await pilot.pause()
        text = str(app.query_one("#queue-error").content)
        assert "no route to host" in text.lower()


@pytest.mark.asyncio
async def test_attempts_table_shows_seeded_rows_newest_first(tmp_path):
    db = _seeded_db_with_run_detail(tmp_path)
    app = _app(tmp_path, db=db)
    async with app.run_test() as pilot:
        await pilot.pause()
        table = app.query_one("#attempts-table")
        assert table.row_count == 2
        row = table.get_row_at(0)
        assert "run-2" in row
        assert "608" in row
        assert "fail" in row


@pytest.mark.asyncio
async def test_processes_table_shows_only_open_processes(tmp_path):
    db = _seeded_db_with_run_detail(tmp_path)
    app = _app(tmp_path, db=db)
    async with app.run_test() as pilot:
        await pilot.pause()
        table = app.query_one("#processes-table")
        assert table.row_count == 1
        row = table.get_row_at(0)
        assert "run-2" in row
        assert "pid-42" in row
        assert "claude" in row


@pytest.mark.asyncio
async def test_run_tab_tables_empty_when_db_missing(tmp_path):
    app = _app(tmp_path)
    async with app.run_test() as pilot:
        await pilot.pause()
        assert app.query_one("#attempts-table").row_count == 0
        assert app.query_one("#processes-table").row_count == 0


def _seed_worker_classes(tmp_path, classes):
    """Stand in for the vendored table (_app points the Fleet tab at it)."""
    path = tmp_path / "worker-classes.json"
    path.write_text(json.dumps({"classes": classes}))
    return str(path)


def _seed_worker_classes_overlay(tmp_path, classes):
    """Stand in for a consumer's own worker-classes.local.json."""
    path = tmp_path / "worker-classes.local.json"
    path.write_text(json.dumps({"classes": classes}))
    return str(path)


@pytest.mark.asyncio
async def test_fleet_table_shows_worker_classes_from_doc(tmp_path):
    _seed_worker_classes(tmp_path, [{
        "id": "healer", "name": "healer", "hosts": ["host-a"],
        "trigger": "cron 0 * * * *", "lock": "flock", "invisible_failure": True,
        "stuck_signal": "none by design",
    }])
    app = _app(tmp_path, worker_classes_path=str(tmp_path / "worker-classes.json"))
    async with app.run_test() as pilot:
        await pilot.pause()
        table = app.query_one("#fleet-table")
        assert table.row_count == 1
        row = table.get_row_at(0)
        assert "host-a" in row
        assert "healer" in row
        assert "yes" in [str(c).lower() for c in row]


@pytest.mark.asyncio
async def test_fleet_table_expands_multi_host_class_into_multiple_rows(tmp_path):
    _seed_worker_classes(tmp_path, [{
        "id": "swarm-worker", "name": "swarm worker",
        "hosts": ["host-a", "host-b"],
        "trigger": "cron", "lock": "slot lock", "invisible_failure": False,
        "stuck_signal": "verdict file",
    }])
    app = _app(tmp_path, worker_classes_path=str(tmp_path / "worker-classes.json"))
    async with app.run_test() as pilot:
        await pilot.pause()
        table = app.query_one("#fleet-table")
        assert table.row_count == 2
        hosts = {str(table.get_row_at(i)[0]) for i in range(2)}
        assert hosts == {"host-a", "host-b"}


@pytest.mark.asyncio
async def test_fleet_table_empty_when_doc_missing(tmp_path):
    app = _app(tmp_path)
    async with app.run_test() as pilot:
        await pilot.pause()
        assert app.query_one("#fleet-table").row_count == 0


def _seed_incident(healer_state_dir, signature, fields):
    healer_state_dir.mkdir(parents=True, exist_ok=True)
    body = "".join(f"{k}={v}\n" for k, v in fields.items())
    (healer_state_dir / signature).write_text(body)


@pytest.mark.asyncio
async def test_incidents_table_shows_seeded_ledger(tmp_path):
    healer_state = tmp_path / "healer-state"
    _seed_incident(healer_state, "133fb5592b07", {
        "workflow": "swarm", "first_seen": "1786560370", "last_seen": "1786560370",
        "attempts": "1", "repaired": "0", "thread_id": "3731mdbmppnsjyhp8q4d1hdesh",
    })
    app = _app(tmp_path, healer_state_path=str(healer_state))
    async with app.run_test() as pilot:
        await pilot.pause()
        table = app.query_one("#incidents-table")
        assert table.row_count == 1
        row = table.get_row_at(0)
        assert "133fb5592b07" in row
        assert "swarm" in row
        assert "3731mdbmppnsjyhp8q4d1hdesh" in row


@pytest.mark.asyncio
async def test_incidents_table_ignores_chanmove_bak_and_retired(tmp_path):
    healer_state = tmp_path / "healer-state"
    _seed_incident(healer_state, "424240d0561a.chanmove-bak", {
        "workflow": "ci", "first_seen": "1785534296", "last_seen": "1785534296",
    })
    _seed_incident(healer_state / "retired", "59febfdb8d87", {
        "workflow": "triage", "last_seen": "1785526112",
    })
    app = _app(tmp_path, healer_state_path=str(healer_state))
    async with app.run_test() as pilot:
        await pilot.pause()
        assert app.query_one("#incidents-table").row_count == 0


@pytest.mark.asyncio
async def test_incidents_table_empty_when_healer_state_missing(tmp_path):
    app = _app(tmp_path)
    async with app.run_test() as pilot:
        await pilot.pause()
        assert app.query_one("#incidents-table").row_count == 0


async def _goto_run_tab(pilot):
    from textual.widgets import TabbedContent
    pilot.app.query_one(TabbedContent).active = "run-tab"
    await pilot.pause()


@pytest.mark.asyncio
async def test_cancel_status_shows_hint_on_mount(tmp_path):
    app = _app(tmp_path)
    async with app.run_test() as pilot:
        await pilot.pause()
        text = str(app.query_one("#cancel-status").content).lower()
        assert "press c" in text


@pytest.mark.asyncio
async def test_cancel_run_with_no_live_run_reports_nothing_to_cancel(tmp_path):
    db = _seeded_db(tmp_path)  # run-1 is already ended
    app = _app(tmp_path, db=db)
    async with app.run_test() as pilot:
        await _goto_run_tab(pilot)
        await pilot.press("c")
        text = str(app.query_one("#cancel-status").content).lower()
        assert "no live run" in text


@pytest.mark.asyncio
async def test_cancel_run_first_press_arms_without_writing_marker(tmp_path):
    db = _seeded_db_with_open_run(tmp_path)
    cancel_dir = tmp_path / "cancel-request"
    app = _app(tmp_path, db=db, cancel_dir_path=str(cancel_dir))
    async with app.run_test() as pilot:
        await _goto_run_tab(pilot)
        await pilot.press("c")
        text = str(app.query_one("#cancel-status").content).lower()
        assert "press c again" in text
        assert "run-live" in text
        assert not cancel_dir.exists() or not list(cancel_dir.iterdir())


@pytest.mark.asyncio
async def test_cancel_run_second_press_within_window_writes_marker(tmp_path):
    db = _seeded_db_with_open_run(tmp_path)
    cancel_dir = tmp_path / "cancel-request"
    clock = iter([1000.0, 1002.0])  # 2s apart, inside the 5s window
    app = _app(tmp_path, db=db, cancel_dir_path=str(cancel_dir), cancel_clock=lambda: next(clock))
    async with app.run_test() as pilot:
        await _goto_run_tab(pilot)
        await pilot.press("c")
        await pilot.press("c")
        marker = cancel_dir / "run-live"
        assert marker.exists()
        text = str(app.query_one("#cancel-status").content).lower()
        assert "cancel requested" in text
        assert "run-live" in text


@pytest.mark.asyncio
async def test_cancel_run_second_press_after_window_rearms_instead_of_confirming(tmp_path):
    db = _seeded_db_with_open_run(tmp_path)
    cancel_dir = tmp_path / "cancel-request"
    clock = iter([1000.0, 1010.0])  # 10s apart, past the 5s window
    app = _app(tmp_path, db=db, cancel_dir_path=str(cancel_dir), cancel_clock=lambda: next(clock))
    async with app.run_test() as pilot:
        await _goto_run_tab(pilot)
        await pilot.press("c")
        await pilot.press("c")
        assert not cancel_dir.exists() or not list(cancel_dir.iterdir())
        text = str(app.query_one("#cancel-status").content).lower()
        assert "press c again" in text


@pytest.mark.asyncio
async def test_inbox_table_shows_chat_unavailable_without_mattermost_config(tmp_path):
    def forgejo_fetch(url, token):
        return [{"number": 40, "title": "parked ticket"}]

    app = _app(tmp_path, inbox_forgejo_fetch=forgejo_fetch)
    async with app.run_test() as pilot:
        await pilot.pause()
        table = app.query_one("#inbox-table")
        assert table.row_count == 1
        row = table.get_row_at(0)
        assert "40" in row
        assert "parked ticket" in row
        assert "chat-unavailable" in row


@pytest.mark.asyncio
async def test_inbox_table_shows_thread_state_with_mattermost_config(tmp_path):
    def forgejo_fetch(url, token):
        return [{"number": 41, "title": "needs a ruling"}]

    root = {"id": "t41", "root_id": "", "user_id": "bot1", "create_at": 1000,
            "delete_at": 0, "message": ":raising_hand: about #41 decision"}
    channel_page = {"posts": {"t41": root}}
    thread_page = {"posts": {"t41": root}}

    def mattermost_fetch(url, token):
        if "/users/me" in url:
            return {"id": "bot1"}
        if "/thread" in url:
            return thread_page
        return channel_page

    app = _app(
        tmp_path, inbox_forgejo_fetch=forgejo_fetch, inbox_mattermost_fetch=mattermost_fetch,
        mattermost_url="https://chat.example", mattermost_channel_id="chan1",
    )
    async with app.run_test() as pilot:
        await pilot.pause()
        table = app.query_one("#inbox-table")
        assert table.row_count == 1
        row = table.get_row_at(0)
        assert "41" in row
        assert "outstanding" in row


@pytest.mark.asyncio
async def test_inbox_table_shows_error_on_fetch_failure(tmp_path):
    def forgejo_fetch(url, token):
        raise OSError("no route to host")

    app = _app(tmp_path, inbox_forgejo_fetch=forgejo_fetch)
    async with app.run_test() as pilot:
        await pilot.pause()
        text = str(app.query_one("#inbox-error").content)
        assert "no route to host" in text.lower()


@pytest.mark.asyncio
async def test_inbox_table_empty_when_nothing_parked(tmp_path):
    app = _app(tmp_path, inbox_forgejo_fetch=lambda url, token: [])
    async with app.run_test() as pilot:
        await pilot.pause()
        assert app.query_one("#inbox-table").row_count == 0


@pytest.mark.asyncio
async def test_cancel_run_ignored_outside_run_tab(tmp_path):
    db = _seeded_db_with_open_run(tmp_path)
    cancel_dir = tmp_path / "cancel-request"
    app = _app(tmp_path, db=db, cancel_dir_path=str(cancel_dir))
    async with app.run_test() as pilot:
        await pilot.pause()  # default tab (Monitor), never switched to Run
        await pilot.press("c")
        await pilot.press("c")
        assert not cancel_dir.exists() or not list(cancel_dir.iterdir())


async def _goto_queue_tab(pilot):
    from textual.widgets import TabbedContent
    pilot.app.query_one(TabbedContent).active = "queue-tab"
    await pilot.pause()


def _queue_issue(number, title, labels):
    return {"number": number, "title": title, "labels": [{"name": l} for l in labels]}


@pytest.mark.asyncio
async def test_labelop_status_shows_hint_on_mount(tmp_path):
    app = _app(tmp_path)
    async with app.run_test() as pilot:
        await pilot.pause()
        text = str(app.query_one("#queue-labelop-status").content).lower()
        assert "arm" in text and "park" in text and "priority" in text


@pytest.mark.asyncio
async def test_arm_issue_with_no_row_selected_reports_nothing(tmp_path):
    app = _app(tmp_path, tracker_fetch=lambda url, token: [])
    async with app.run_test() as pilot:
        await _goto_queue_tab(pilot)
        await pilot.press("a")
        text = str(app.query_one("#queue-labelop-status").content).lower()
        assert "no row selected" in text


@pytest.mark.asyncio
async def test_arm_issue_first_press_arms_without_writing(tmp_path):
    posts, deletes = [], []
    app = _app(
        tmp_path,
        tracker_fetch=lambda url, token: [_queue_issue(40, "parked ticket", ["ready-for-human"])],
        labels_poster=lambda url, token, payload: posts.append((url, payload)) or 200,
        labels_deleter=lambda url, token: deletes.append(url) or 204,
    )
    async with app.run_test() as pilot:
        await _goto_queue_tab(pilot)
        await pilot.press("a")
        text = str(app.query_one("#queue-labelop-status").content).lower()
        assert "press again" in text
        assert "#40" in text
        assert posts == []
        assert deletes == []


@pytest.mark.asyncio
async def test_arm_issue_second_press_within_window_writes_labels(tmp_path):
    posts, deletes = [], []
    clock = iter([1000.0, 1002.0])  # 2s apart, inside the 5s window
    app = _app(
        tmp_path,
        tracker_fetch=lambda url, token: [_queue_issue(40, "parked ticket", ["ready-for-human"])],
        labels_poster=lambda url, token, payload: posts.append((url, payload)) or 200,
        labels_deleter=lambda url, token: deletes.append(url) or 204,
        labelop_clock=lambda: next(clock),
    )
    async with app.run_test() as pilot:
        await _goto_queue_tab(pilot)
        await pilot.press("a")
        await pilot.press("a")
        assert posts == [(f"{API}/issues/40/labels", {"labels": [1]})]
        assert deletes == [f"{API}/issues/40/labels/2"]
        text = str(app.query_one("#queue-labelop-status").content).lower()
        assert "armed #40" in text


@pytest.mark.asyncio
async def test_park_issue_second_press_writes_the_opposite_pair(tmp_path):
    posts, deletes = [], []
    clock = iter([1000.0, 1002.0])
    app = _app(
        tmp_path,
        tracker_fetch=lambda url, token: [_queue_issue(41, "live ticket", ["ready-for-agent"])],
        labels_poster=lambda url, token, payload: posts.append((url, payload)) or 200,
        labels_deleter=lambda url, token: deletes.append(url) or 204,
        labelop_clock=lambda: next(clock),
    )
    async with app.run_test() as pilot:
        await _goto_queue_tab(pilot)
        await pilot.press("p")
        await pilot.press("p")
        assert posts == [(f"{API}/issues/41/labels", {"labels": [2]})]
        assert deletes == [f"{API}/issues/41/labels/1"]
        text = str(app.query_one("#queue-labelop-status").content).lower()
        assert "parked #41" in text


@pytest.mark.asyncio
async def test_toggle_priority_adds_when_not_currently_prioritised(tmp_path):
    posts, deletes = [], []
    clock = iter([1000.0, 1002.0])
    app = _app(
        tmp_path,
        tracker_fetch=lambda url, token: [_queue_issue(42, "ticket", ["ready-for-agent"])],
        labels_poster=lambda url, token, payload: posts.append((url, payload)) or 200,
        labels_deleter=lambda url, token: deletes.append(url) or 204,
        labelop_clock=lambda: next(clock),
    )
    async with app.run_test() as pilot:
        await _goto_queue_tab(pilot)
        await pilot.press("i")
        await pilot.press("i")
        assert posts == [(f"{API}/issues/42/labels", {"labels": [3]})]
        assert deletes == []
        text = str(app.query_one("#queue-labelop-status").content).lower()
        assert "prioritised #42" in text


@pytest.mark.asyncio
async def test_toggle_priority_removes_when_already_prioritised(tmp_path):
    posts, deletes = [], []
    clock = iter([1000.0, 1002.0])
    app = _app(
        tmp_path,
        tracker_fetch=lambda url, token: [_queue_issue(43, "ticket", ["ready-for-agent", "priority"])],
        labels_poster=lambda url, token, payload: posts.append((url, payload)) or 200,
        labels_deleter=lambda url, token: deletes.append(url) or 204,
        labelop_clock=lambda: next(clock),
    )
    async with app.run_test() as pilot:
        await _goto_queue_tab(pilot)
        await pilot.press("i")
        await pilot.press("i")
        assert deletes == [f"{API}/issues/43/labels/3"]
        assert posts == []
        text = str(app.query_one("#queue-labelop-status").content).lower()
        assert "un-prioritised #43" in text


@pytest.mark.asyncio
async def test_labelop_second_press_after_window_rearms_instead_of_confirming(tmp_path):
    posts, deletes = [], []
    clock = iter([1000.0, 1010.0])  # 10s apart, past the 5s window
    app = _app(
        tmp_path,
        tracker_fetch=lambda url, token: [_queue_issue(40, "parked ticket", ["ready-for-human"])],
        labels_poster=lambda url, token, payload: posts.append((url, payload)) or 200,
        labels_deleter=lambda url, token: deletes.append(url) or 204,
        labelop_clock=lambda: next(clock),
    )
    async with app.run_test() as pilot:
        await _goto_queue_tab(pilot)
        await pilot.press("a")
        await pilot.press("a")
        assert posts == []
        assert deletes == []
        text = str(app.query_one("#queue-labelop-status").content).lower()
        assert "press again" in text


@pytest.mark.asyncio
async def test_labelop_ignored_outside_queue_tab(tmp_path):
    posts, deletes = [], []
    app = _app(
        tmp_path,
        tracker_fetch=lambda url, token: [_queue_issue(40, "parked ticket", ["ready-for-human"])],
        labels_poster=lambda url, token, payload: posts.append((url, payload)) or 200,
        labels_deleter=lambda url, token: deletes.append(url) or 204,
    )
    async with app.run_test() as pilot:
        await pilot.pause()  # default tab (Monitor), never switched to Queue
        await pilot.press("a")
        await pilot.press("a")
        assert posts == []
        assert deletes == []


@pytest.mark.asyncio
async def test_rearm_status_shows_hint_on_mount(tmp_path):
    app = _app(tmp_path)
    async with app.run_test() as pilot:
        await pilot.pause()
        text = str(app.query_one("#rearm-status").content).lower()
        assert "press r" in text


@pytest.mark.asyncio
async def test_rearm_dispatch_first_press_arms_without_posting(tmp_path):
    posts = []
    app = _app(tmp_path, rearm_poster=lambda url, token, payload: posts.append((url, token, payload)) or 204)
    async with app.run_test() as pilot:
        await _goto_queue_tab(pilot)
        await pilot.press("r")
        text = str(app.query_one("#rearm-status").content).lower()
        assert "press r again" in text
        assert posts == []


@pytest.mark.asyncio
async def test_rearm_dispatch_second_press_within_window_posts_the_dispatch(tmp_path):
    posts = []
    clock = iter([1000.0, 1002.0])  # 2s apart, inside the 5s window
    app = _app(
        tmp_path,
        rearm_poster=lambda url, token, payload: posts.append((url, token, payload)) or 204,
        rearm_clock=lambda: next(clock),
    )
    async with app.run_test() as pilot:
        await _goto_queue_tab(pilot)
        await pilot.press("r")
        await pilot.press("r")
        assert posts == [
            (f"{API}/actions/workflows/swarm.yml/dispatches",
             "fake-token", {"ref": "main"}),
        ]
        text = str(app.query_one("#rearm-status").content).lower()
        assert "dispatched a fresh swarm run" in text


@pytest.mark.asyncio
async def test_rearm_dispatch_second_press_after_window_rearms_instead_of_confirming(tmp_path):
    posts = []
    clock = iter([1000.0, 1010.0])  # 10s apart, past the 5s window
    app = _app(
        tmp_path,
        rearm_poster=lambda url, token, payload: posts.append((url, token, payload)) or 204,
        rearm_clock=lambda: next(clock),
    )
    async with app.run_test() as pilot:
        await _goto_queue_tab(pilot)
        await pilot.press("r")
        await pilot.press("r")
        assert posts == []
        text = str(app.query_one("#rearm-status").content).lower()
        assert "press r again" in text


@pytest.mark.asyncio
async def test_rearm_dispatch_reports_failure_on_transport_error(tmp_path):
    def failing_poster(url, token, payload):
        raise OSError("no route to host")

    clock = iter([1000.0, 1002.0])
    app = _app(tmp_path, rearm_poster=failing_poster, rearm_clock=lambda: next(clock))
    async with app.run_test() as pilot:
        await _goto_queue_tab(pilot)
        await pilot.press("r")
        await pilot.press("r")
        text = str(app.query_one("#rearm-status").content).lower()
        assert "rearm dispatch failed" in text
        assert "no route to host" in text


@pytest.mark.asyncio
async def test_rearm_dispatch_ignored_outside_queue_tab(tmp_path):
    posts = []
    app = _app(tmp_path, rearm_poster=lambda url, token, payload: posts.append((url, token, payload)) or 204)
    async with app.run_test() as pilot:
        await pilot.pause()  # default tab (Monitor), never switched to Queue
        await pilot.press("r")
        await pilot.press("r")
        assert posts == []


async def _goto_inbox_tab(pilot):
    from textual.widgets import TabbedContent
    pilot.app.query_one(TabbedContent).active = "inbox-tab"
    await pilot.pause()


def _outstanding_issue(number, title):
    root = {"id": f"t{number}", "root_id": "", "user_id": "bot1", "create_at": 1000,
            "delete_at": 0, "message": f":raising_hand: about #{number} decision"}
    channel_page = {"posts": {f"t{number}": root}}
    thread_page = {"posts": {f"t{number}": root}}

    def forgejo_fetch(url, token):
        return [{"number": number, "title": title}]

    def mattermost_fetch(url, token):
        if "/users/me" in url:
            return {"id": "bot1"}
        if "/thread" in url:
            return thread_page
        return channel_page

    return forgejo_fetch, mattermost_fetch


@pytest.mark.asyncio
async def test_answer_status_shows_hint_on_mount(tmp_path):
    app = _app(tmp_path)
    async with app.run_test() as pilot:
        await pilot.pause()
        text = str(app.query_one("#answer-status").content).lower()
        assert "answer" in text and "outstanding" in text
        assert app.query_one("#answer-input").disabled is True


@pytest.mark.asyncio
async def test_open_answer_with_no_row_selected_reports_nothing(tmp_path):
    app = _app(tmp_path, inbox_forgejo_fetch=lambda url, token: [])
    async with app.run_test() as pilot:
        await _goto_inbox_tab(pilot)
        await pilot.press("w")
        text = str(app.query_one("#answer-status").content).lower()
        assert "no row selected" in text


@pytest.mark.asyncio
async def test_open_answer_on_non_outstanding_row_reports_state(tmp_path):
    # No mattermost config -> the row's state resolves to "chat-unavailable".
    app = _app(tmp_path, inbox_forgejo_fetch=lambda url, token: [{"number": 50, "title": "idle one"}])
    async with app.run_test() as pilot:
        await _goto_inbox_tab(pilot)
        await pilot.press("w")
        text = str(app.query_one("#answer-status").content).lower()
        assert "no outstanding question" in text
        assert "chat-unavailable" in text
        assert app.query_one("#answer-input").disabled is True


@pytest.mark.asyncio
async def test_open_answer_focuses_input_and_shows_prompt(tmp_path):
    forgejo_fetch, mattermost_fetch = _outstanding_issue(51, "needs a ruling")
    app = _app(
        tmp_path, inbox_forgejo_fetch=forgejo_fetch, inbox_mattermost_fetch=mattermost_fetch,
        mattermost_url="https://chat.example", mattermost_channel_id="chan1",
    )
    async with app.run_test() as pilot:
        await _goto_inbox_tab(pilot)
        await pilot.press("w")
        text = str(app.query_one("#answer-status").content).lower()
        assert "typing answer for #51" in text
        input_widget = app.query_one("#answer-input")
        assert input_widget.disabled is False
        assert app.focused is input_widget


@pytest.mark.asyncio
async def test_submit_answer_writes_comment_labels_reply_and_consume(tmp_path):
    forgejo_fetch, mattermost_fetch = _outstanding_issue(52, "needs a ruling")
    fj_posts, mm_posts = [], []
    labels_posts, labels_deletes = [], []
    app = _app(
        tmp_path, inbox_forgejo_fetch=forgejo_fetch, inbox_mattermost_fetch=mattermost_fetch,
        mattermost_url="https://chat.example", mattermost_channel_id="chan1", mattermost_token="mmtok",
        answer_fj_poster=lambda url, token, payload: fj_posts.append((url, payload)) or 201,
        answer_mm_poster=lambda url, token, payload: mm_posts.append((url, payload)) or 201,
        labels_poster=lambda url, token, payload: labels_posts.append((url, payload)) or 200,
        labels_deleter=lambda url, token: labels_deletes.append(url) or 204,
    )
    async with app.run_test() as pilot:
        await _goto_inbox_tab(pilot)
        await pilot.press("w")
        await pilot.press(*list("proceed"))
        await pilot.press("enter")
        assert fj_posts and fj_posts[0][0] == f"{app.tracker_api}/issues/52/comments"
        assert "proceed" in fj_posts[0][1]["body"]
        assert labels_posts == [(f"{app.tracker_api}/issues/52/labels", {"labels": [1]})]
        assert labels_deletes == [f"{app.tracker_api}/issues/52/labels/2"]
        assert len(mm_posts) == 2
        assert "proceed" in mm_posts[0][1]["message"]
        assert mm_posts[1][1]["message"].startswith(":white_check_mark:")
        text = str(app.query_one("#answer-status").content).lower()
        assert "answered #52" in text
        input_widget = app.query_one("#answer-input")
        assert input_widget.value == ""
        assert input_widget.disabled is True


@pytest.mark.asyncio
async def test_submit_empty_answer_does_not_write(tmp_path):
    forgejo_fetch, mattermost_fetch = _outstanding_issue(53, "needs a ruling")
    mm_posts = []
    app = _app(
        tmp_path, inbox_forgejo_fetch=forgejo_fetch, inbox_mattermost_fetch=mattermost_fetch,
        mattermost_url="https://chat.example", mattermost_channel_id="chan1",
        answer_mm_poster=lambda url, token, payload: mm_posts.append((url, payload)) or 201,
    )
    async with app.run_test() as pilot:
        await _goto_inbox_tab(pilot)
        await pilot.press("w")
        await pilot.press("enter")
        assert mm_posts == []
        text = str(app.query_one("#answer-status").content).lower()
        assert "empty answer not sent" in text
        assert app.query_one("#answer-input").disabled is False


@pytest.mark.asyncio
async def test_cancel_answer_with_escape_clears_target(tmp_path):
    forgejo_fetch, mattermost_fetch = _outstanding_issue(54, "needs a ruling")
    mm_posts = []
    app = _app(
        tmp_path, inbox_forgejo_fetch=forgejo_fetch, inbox_mattermost_fetch=mattermost_fetch,
        mattermost_url="https://chat.example", mattermost_channel_id="chan1",
        answer_mm_poster=lambda url, token, payload: mm_posts.append((url, payload)) or 201,
    )
    async with app.run_test() as pilot:
        await _goto_inbox_tab(pilot)
        await pilot.press("w")
        await pilot.press(*list("proceed"))
        await pilot.press("escape")
        text = str(app.query_one("#answer-status").content).lower()
        assert "answer cancelled" in text
        input_widget = app.query_one("#answer-input")
        assert input_widget.disabled is True
        assert input_widget.value == ""
        assert mm_posts == []


@pytest.mark.asyncio
async def test_open_answer_ignored_outside_inbox_tab(tmp_path):
    forgejo_fetch, mattermost_fetch = _outstanding_issue(55, "needs a ruling")
    app = _app(
        tmp_path, inbox_forgejo_fetch=forgejo_fetch, inbox_mattermost_fetch=mattermost_fetch,
        mattermost_url="https://chat.example", mattermost_channel_id="chan1",
    )
    async with app.run_test() as pilot:
        await pilot.pause()  # default tab (Monitor), never switched to Inbox
        await pilot.press("w")
        text = str(app.query_one("#answer-status").content).lower()
        assert "typing answer" not in text
        assert app.query_one("#answer-input").disabled is True


@pytest.mark.asyncio
async def test_fleet_table_merges_the_repos_own_overlay(tmp_path):
    # The vendored table describes the harness's classes with no hosts; a
    # consumer's overlay declares which hosts run them and adds the classes
    # only that repo runs.
    table_path = _seed_worker_classes(tmp_path, [
        {"id": "healer", "name": "healer", "trigger": "hourly cron",
         "lock": "flock", "invisible_failure": True, "stuck_signal": "none by design"},
    ])
    overlay_path = _seed_worker_classes_overlay(tmp_path, [
        {"id": "healer", "hosts": ["host-a"]},
        {"id": "check-verifications", "name": "check-verifications",
         "hosts": ["host-b"], "trigger": "verify.yml"},
    ])
    app = _app(tmp_path, worker_classes_path=table_path, worker_classes_overlay=overlay_path)
    async with app.run_test() as pilot:
        await pilot.pause()
        table = app.query_one("#fleet-table")
        assert table.row_count == 2
        rows = [table.get_row_at(i) for i in range(2)]
        assert rows[0][0] == "host-a"
        assert "healer" in rows[0][1]
        # …and the vendored description survived the overlay's host declaration.
        assert rows[0][2] == "hourly cron"
        assert rows[1][0] == "host-b"


@pytest.mark.asyncio
async def test_screens_say_so_when_no_identity_layer_resolved(tmp_path):
    # A checkout with no readable identity layer must state the gap, never
    # show a confidently empty queue or invent a path.
    app = FactoryMonitorApp(
        ident=identity.Identity(harness_dir=str(tmp_path)),
        tracker_fetch=lambda url, token: [],
        inbox_forgejo_fetch=lambda url, token: [],
    )
    async with app.run_test() as pilot:
        await pilot.pause()
        assert "FORGEJO_API" in str(app.query_one("#queue-error").content)
        assert "FORGEJO_API" in str(app.query_one("#inbox-error").content)
        assert "DRIVE_STATUS_FILE" in str(app.query_one("#drive-status").content)
        assert app.query_one("#runs-table").row_count == 0
        await _goto_run_tab(pilot)
        await pilot.press("c")
        assert "SWARM_CANCEL_DIR" in str(app.query_one("#cancel-status").content)
