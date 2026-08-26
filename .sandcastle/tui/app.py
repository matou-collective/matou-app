"""app.py — the factory TUI: a read-only monitor, plus write actions.

Every per-repo and per-host value it reads — the tracker API, swarm.db, the
Claude limit markers, the healer's ledger dir, the cancel-marker dir, the
drive-status record, the swarm workflow — is resolved ONCE at construction by
data/identity.py from the consumer's own identity layer, and injected into
the readers below. Nothing here defaults to any repo, host or product path;
a value the identity layer does not resolve shows as an honest "not
configured", never as a confidently empty panel.

Mostly read-only by design (the ADR 0174 scope ruling): shows
recent swarm.db runs, the live rehearsal-drive status record (#574), the
Claude limit/active-account markers, the tracker queue with its DAG
blockers, and the ask inbox (#614) — parked ask-human.sh threads, Forgejo
`ready-for-human` issues crossed with their Mattermost thread state. Four
write actions live here. The Run tab's Cancel action (#612, ADR 0186) is a
two-keypress arm/confirm that writes the marker file main.mts polls for
(data/cancel.py) — no label PUT, no comment POST, nothing against the
tracker. The Queue tab's arm/park/prioritise actions (#615) are the same
two-keypress shape but DO write the tracker: a `/labels` POST/DELETE pair
(data/labels.py) against the selected row's issue, mirroring
resume-parked-asks.sh's own re-arm label-swap. The Queue tab's rearm_dispatch
action (#617) is the same two-keypress shape again, but with no row to be
wrong about — a single `workflow_dispatch` POST against swarm.yml
(data/rearm.py), mirroring claim-lib.sh's own rearm_dispatch. The Inbox
tab's answer action (#618, #617's own "Suggested next slice") is a
different confirm shape — it needs free text, not a bare keypress — so
arm/confirm becomes open/submit: `w` on a selected outstanding row opens a
text Input, Enter sends it (data/answer_ask.py, composing ask_inbox's
already-fetched thread id with labels.py's `arm`), Escape cancels.
"""

import os
import sqlite3
import time

from textual.app import App, ComposeResult
from textual.containers import Horizontal
from textual.widgets import DataTable, Footer, Header, Input, Static, TabbedContent, TabPane

from data import answer_ask as answer_ask_mod
from data import ask_inbox as ask_inbox_mod
from data import cancel as cancel_mod
from data import drive_status as drive_status_mod
from data import healer_ledger as healer_ledger_mod
from data import identity as identity_mod
from data import labels as labels_mod
from data import limits as limits_mod
from data import rearm as rearm_mod
from data import swarmdb
from data import tracker as tracker_mod
from data import worker_classes as worker_classes_mod


# Said the same way everywhere a screen needs a tracker it has not been given.
_NO_API = (
    "no FORGEJO_API — this checkout's identity layer (swarm-identity.sh) "
    "resolved none; run onboard.sh identity <owner/repo> <dir>/swarm-identity.sh"
)


def _fmt_epoch(epoch):
    return "-" if epoch is None else str(epoch)


class FactoryMonitorApp(App):
    """A read-only monitor over the swarm software factory."""

    CSS = """
    #status-row { height: auto; }
    #drive-status, #limit-status { width: 1fr; height: auto; border: solid $accent; padding: 1; }
    #runs-table { height: 1fr; }
    #queue-table { height: 1fr; }
    #queue-error { height: auto; border: solid $error; padding: 1; display: none; }
    #queue-error.-visible { display: block; }
    #fleet-table { height: 1fr; }
    #cancel-status { height: auto; border: solid $accent; padding: 1; }
    #incidents-table { height: 1fr; }
    #inbox-table { height: 1fr; }
    #inbox-error { height: auto; border: solid $error; padding: 1; display: none; }
    #inbox-error.-visible { display: block; }
    #queue-labelop-status { height: auto; border: solid $accent; padding: 1; }
    #rearm-status { height: auto; border: solid $accent; padding: 1; }
    #answer-status { height: auto; border: solid $accent; padding: 1; }
    """

    BINDINGS = [
        ("c", "cancel_run", "Cancel live run"),
        ("a", "arm_issue", "Arm selected issue"),
        ("p", "park_issue", "Park selected issue"),
        ("i", "toggle_priority", "Toggle priority"),
        ("r", "rearm_dispatch", "Dispatch fresh swarm run"),
        ("w", "open_answer", "Answer selected ask"),
        ("escape", "cancel_answer", "Cancel answer"),
    ]

    # #612: an armed-but-not-yet-confirmed cancel expires after this many
    # seconds — a stray second 'c' minutes later must re-arm, never confirm a
    # long-forgotten request. Two keypresses, not a modal dialog (ADR 0186 §4):
    # cheaper to build/test, and the marker file itself stays deletable up to
    # main.mts's next ~2s poll tick, a real undo window before it takes effect.
    CANCEL_CONFIRM_WINDOW = 5

    # #615: same two-keypress shape as Cancel, applied to the Queue tab's
    # label writes (arm/park/prioritise) — a stray second press on a
    # different row/action must re-arm, never confirm a stale request.
    LABELOP_CONFIRM_WINDOW = 5

    # #617: same two-keypress shape as Cancel and the label ops, but with no
    # row to be wrong about — the armed state here is a bare timestamp, not
    # an (action, issue) pair.
    REARM_CONFIRM_WINDOW = 5

    # #618: no timed re-arm window here — typing an answer and pressing
    # Enter is already a deliberate two-step gesture (open, then submit
    # non-empty text), unlike a bare keypress that could be a stray repeat.

    _LABELOP_VERBS = {
        "arm": "arm #{n} (-> ready-for-agent)",
        "park": "park #{n} (-> ready-for-human)",
    }

    def __init__(
        self,
        ident=None,
        db_path=None,
        limit_marker=None,
        active_marker=None,
        drive_status_path=None,
        refresh_interval=5,
        tracker_api=None,
        tracker_token=None,
        tracker_fetch=tracker_mod._http_get,
        queue_refresh_interval=30,
        worker_classes_path=None,
        worker_classes_overlay=None,
        swarm_workflow=None,
        cancel_dir_path=None,
        cancel_clock=time.time,
        healer_state_path=None,
        mattermost_url=None,
        mattermost_channel_id=None,
        mattermost_token=None,
        inbox_forgejo_fetch=ask_inbox_mod._http_get,
        inbox_mattermost_fetch=ask_inbox_mod._mattermost_get,
        inbox_refresh_interval=30,
        inbox_clock=time.time,
        labels_fetch=labels_mod._http_get,
        labels_poster=labels_mod._http_post,
        labels_deleter=labels_mod._http_delete,
        labelop_clock=time.time,
        rearm_poster=rearm_mod._http_post,
        rearm_clock=time.time,
        answer_fj_poster=answer_ask_mod._http_post,
        answer_mm_poster=answer_ask_mod._mattermost_post,
    ):
        super().__init__()
        # One resolution of the identity layer, at construction: every path
        # and URL below is either an explicit override (tests, and an
        # operator pointing at another host's state) or the layer's own
        # answer. A test that passes `ident` never touches the host at all.
        self.ident = identity_mod.load() if ident is None else ident
        def resolved(override, value):
            return value if override is None else override
        self.db_path = resolved(db_path, self.ident.swarm_db)
        self.limit_marker = resolved(limit_marker, self.ident.limit_marker)
        self.active_marker = resolved(active_marker, self.ident.active_marker)
        self.drive_status_path = resolved(drive_status_path, self.ident.drive_status_file)
        self.refresh_interval = refresh_interval
        self.tracker_api = resolved(tracker_api, self.ident.forgejo_api)
        self.tracker_token = tracker_token
        self.tracker_fetch = tracker_fetch
        self.queue_refresh_interval = queue_refresh_interval
        self.worker_classes_path = resolved(
            worker_classes_path, worker_classes_mod.BUNDLED_WORKER_CLASSES)
        self.worker_classes_overlay = resolved(
            worker_classes_overlay, self.ident.worker_classes_overlay)
        self.swarm_workflow = resolved(swarm_workflow, self.ident.swarm_workflow)
        self.cancel_dir_path = resolved(cancel_dir_path, self.ident.cancel_dir)
        self.cancel_clock = cancel_clock
        self._cancel_armed_run_id = None
        self._cancel_armed_at = None
        self.healer_state_path = resolved(healer_state_path, self.ident.healer_state)
        self.mattermost_url = resolved(mattermost_url, self.ident.mattermost_url)
        self.mattermost_channel_id = resolved(mattermost_channel_id, self.ident.mattermost_channel_id)
        self.mattermost_token = resolved(mattermost_token, self.ident.mattermost_token)
        self.inbox_forgejo_fetch = inbox_forgejo_fetch
        self.inbox_mattermost_fetch = inbox_mattermost_fetch
        self.inbox_refresh_interval = inbox_refresh_interval
        self.inbox_clock = inbox_clock
        self.labels_fetch = labels_fetch
        self.labels_poster = labels_poster
        self.labels_deleter = labels_deleter
        self.labelop_clock = labelop_clock
        self.rearm_poster = rearm_poster
        self.rearm_clock = rearm_clock
        self.answer_fj_poster = answer_fj_poster
        self.answer_mm_poster = answer_mm_poster
        self._label_ids_cache = None
        self._queue_rows = []
        self._labelop_armed = None
        self._labelop_armed_at = None
        self._rearm_armed_at = None
        self._inbox_rows = []
        self._answer_target = None

    def compose(self) -> ComposeResult:
        yield Header()
        with TabbedContent():
            with TabPane("Monitor", id="monitor-tab"):
                with Horizontal(id="status-row"):
                    yield Static(id="drive-status")
                    yield Static(id="limit-status")
                yield DataTable(id="runs-table")
            with TabPane("Queue", id="queue-tab"):
                yield Static(id="queue-error")
                yield Static(id="queue-labelop-status")
                yield Static(id="rearm-status")
                yield DataTable(id="queue-table")
            with TabPane("Run", id="run-tab"):
                yield Static(id="cancel-status")
                yield DataTable(id="attempts-table")
                yield DataTable(id="processes-table")
            with TabPane("Fleet", id="fleet-tab"):
                yield DataTable(id="fleet-table")
            with TabPane("Incidents", id="incidents-tab"):
                yield DataTable(id="incidents-table")
            with TabPane("Inbox", id="inbox-tab"):
                yield Static(id="inbox-error")
                yield Static(id="answer-status")
                yield Input(id="answer-input", placeholder="Type an answer, Enter to send, Escape to cancel")
                yield DataTable(id="inbox-table")
        yield Footer()

    def on_mount(self):
        # Which repo's factory this is watching — the one-host, one-repo scope
        # of the monitor, stated rather than assumed (a swarm host carries
        # several checkouts, each with its own identity layer).
        self.title = "factory monitor"
        self.sub_title = self.ident.repo_slug or "no identity layer resolved"
        table = self.query_one("#runs-table", DataTable)
        table.add_columns("run_id", "repo", "trigger", "started_at", "verdict", "exit_code")
        queue_table = self.query_one("#queue-table", DataTable)
        queue_table.add_columns("number", "title", "state", "blocked")
        attempts_table = self.query_one("#attempts-table", DataTable)
        attempts_table.add_columns(
            "run_id", "issue", "iteration", "status", "close_outcome", "started_at", "ended_at",
        )
        processes_table = self.query_one("#processes-table", DataTable)
        processes_table.add_columns("run_id", "kind", "ref", "command", "started_at")
        self.query_one("#cancel-status", Static).update(
            "Cancel: press c to arm, c again to confirm cancelling the live run"
        )
        fleet_table = self.query_one("#fleet-table", DataTable)
        fleet_table.add_columns("host", "worker class", "trigger", "lock", "fails invisibly", "stuck signal")
        incidents_table = self.query_one("#incidents-table", DataTable)
        incidents_table.add_columns(
            "signature", "workflow", "first seen", "last seen", "attempts",
            "replies", "repaired", "escalated", "thread",
        )
        inbox_table = self.query_one("#inbox-table", DataTable)
        inbox_table.add_columns("number", "title", "state", "detail")
        self.query_one("#queue-labelop-status", Static).update(
            "Labels: select a row — a arm, p park, i toggle priority "
            f"(press again within {self.LABELOP_CONFIRM_WINDOW}s to confirm)"
        )
        self.query_one("#rearm-status", Static).update(
            "Rearm: press r to arm, r again within "
            f"{self.REARM_CONFIRM_WINDOW}s to dispatch a fresh swarm run"
        )
        self.query_one("#answer-status", Static).update(
            "Answer: select an outstanding row, w to type an answer (Enter to send, Escape to cancel)"
        )
        self.query_one("#answer-input", Input).disabled = True
        self.refresh_data()
        self.set_interval(self.refresh_interval, self.refresh_data)
        self._refresh_queue_table()
        self.set_interval(self.queue_refresh_interval, self._refresh_queue_table)
        self._refresh_fleet_table()
        self._refresh_inbox_table()
        self.set_interval(self.inbox_refresh_interval, self._refresh_inbox_table)

    def refresh_data(self):
        self._refresh_runs_table()
        self._refresh_drive_status()
        self._refresh_limit_status()
        self._refresh_run_detail()
        self._refresh_incidents_table()

    def _refresh_runs_table(self):
        table = self.query_one("#runs-table", DataTable)
        table.clear()
        try:
            conn = swarmdb.connect(self.db_path)
        except sqlite3.OperationalError:
            return
        try:
            for run in swarmdb.recent_runs(conn):
                table.add_row(
                    run["run_id"], run["repo"] or "-", run["trigger"] or "-",
                    _fmt_epoch(run["started_at"]), run["verdict"] or "running",
                    _fmt_epoch(run["exit_code"]),
                )
        finally:
            conn.close()

    def _refresh_drive_status(self):
        panel = self.query_one("#drive-status", Static)
        status = drive_status_mod.read_drive_status_at(self.drive_status_path)
        if status is None:
            panel.update(
                "Drive: no drive in flight" if self.drive_status_path
                else "Drive: no DRIVE_STATUS_FILE declared by this repo's identity layer"
            )
        else:
            panel.update(
                f"Drive: {status.get('target', '?')} pid={status.get('pid', '?')} "
                f"box={drive_status_mod.box_name(status) or '?'} "
                f"({drive_status_mod.box_ip(status) or '?'})"
            )

    def _refresh_run_detail(self):
        attempts_table = self.query_one("#attempts-table", DataTable)
        processes_table = self.query_one("#processes-table", DataTable)
        attempts_table.clear()
        processes_table.clear()
        try:
            conn = swarmdb.connect(self.db_path)
        except sqlite3.OperationalError:
            return
        try:
            for attempt in swarmdb.recent_attempts(conn):
                attempts_table.add_row(
                    attempt["run_id"], str(attempt["issue"]), str(attempt["iteration"]),
                    attempt["status"] or "-", attempt["close_outcome"] or "-",
                    _fmt_epoch(attempt["started_at"]), _fmt_epoch(attempt["ended_at"]),
                )
            for proc in swarmdb.open_processes(conn):
                processes_table.add_row(
                    proc["run_id"], proc["kind"] or "-", proc["ref"] or "-",
                    proc["command"] or "-", _fmt_epoch(proc["started_at"]),
                )
        finally:
            conn.close()

    def action_cancel_run(self):
        # Scoped to the Run tab (#612): 'c' pressed anywhere else is a no-op,
        # never a stray cancel of a run the operator isn't even looking at.
        if self.query_one(TabbedContent).active != "run-tab":
            return
        if not self.cancel_dir_path:
            self._set_cancel_status(
                "Cancel: no SWARM_CANCEL_DIR resolved — cancel-lib.sh is not readable from here"
            )
            return
        try:
            conn = swarmdb.connect(self.db_path)
        except sqlite3.OperationalError:
            self._set_cancel_status("Cancel: no swarm.db to read")
            return
        try:
            run = swarmdb.running_run(conn)
        finally:
            conn.close()
        if run is None:
            self._cancel_armed_run_id = None
            self._set_cancel_status("Cancel: no live run right now")
            return
        run_id = run["run_id"]
        now = self.cancel_clock()
        armed_for_this_run = self._cancel_armed_run_id == run_id
        still_within_window = (
            self._cancel_armed_at is not None
            and (now - self._cancel_armed_at) <= self.CANCEL_CONFIRM_WINDOW
        )
        if armed_for_this_run and still_within_window:
            cancel_mod.request_cancel(run_id, "", cancel_dir_path=self.cancel_dir_path)
            self._cancel_armed_run_id = None
            self._cancel_armed_at = None
            self._set_cancel_status(f"Cancel requested for {run_id} — main.mts will stop within seconds")
        else:
            self._cancel_armed_run_id = run_id
            self._cancel_armed_at = now
            self._set_cancel_status(
                f"Press c again within {self.CANCEL_CONFIRM_WINDOW}s to confirm cancelling {run_id}"
            )

    def _set_cancel_status(self, text):
        self.query_one("#cancel-status", Static).update(text)

    def _refresh_limit_status(self):
        panel = self.query_one("#limit-status", Static)
        parked = limits_mod.limit_parked(self.limit_marker)
        account = limits_mod.active_account(self.active_marker)
        state = "PARKED" if parked else "not parked"
        panel.update(f"Claude: {state} — account {account}")

    def _refresh_queue_table(self):
        error_panel = self.query_one("#queue-error", Static)
        table = self.query_one("#queue-table", DataTable)
        if not self.tracker_api:
            table.clear()
            error_panel.update(f"Queue: {_NO_API}")
            error_panel.add_class("-visible")
            return
        try:
            rows = tracker_mod.queue_snapshot(
                api=self.tracker_api, token=self.tracker_token, fetch=self.tracker_fetch,
            )
        except Exception as exc:  # noqa: BLE001 — any transport failure is a display-only concern
            error_panel.update(f"Queue: {exc}")
            error_panel.add_class("-visible")
            return
        error_panel.remove_class("-visible")
        self._queue_rows = rows
        table.clear()
        for row in rows:
            blocked = f"blocked by {', '.join(f'#{n}' for n in row['blocked_by'])}" if row["blocked"] else "-"
            table.add_row(str(row["number"]), row["title"], row["state"], blocked)

    def _selected_queue_row(self):
        table = self.query_one("#queue-table", DataTable)
        if not self._queue_rows or table.row_count == 0:
            return None
        idx = table.cursor_row
        if idx is None or idx < 0 or idx >= len(self._queue_rows):
            return None
        return self._queue_rows[idx]

    def _set_labelop_status(self, text):
        self.query_one("#queue-labelop-status", Static).update(text)

    def _label_ids(self):
        if self._label_ids_cache is None:
            self._label_ids_cache = labels_mod.fetch_label_ids(
                api=self.tracker_api, token=self.tracker_token, fetch=self.labels_fetch,
            )
        return self._label_ids_cache

    def action_arm_issue(self):
        self._start_or_confirm_labelop("arm")

    def action_park_issue(self):
        self._start_or_confirm_labelop("park")

    def action_toggle_priority(self):
        self._start_or_confirm_labelop("priority")

    def _start_or_confirm_labelop(self, action):
        # Scoped to the Queue tab (same posture as #612's Cancel, scoped to
        # Run): these keys pressed anywhere else are a no-op, never a stray
        # label write on a row the operator isn't even looking at.
        if self.query_one(TabbedContent).active != "queue-tab":
            return
        row = self._selected_queue_row()
        if row is None:
            self._set_labelop_status("Labels: no row selected")
            return
        number = row["number"]
        now = self.labelop_clock()
        armed_for_this = self._labelop_armed == (action, number)
        still_within_window = (
            self._labelop_armed_at is not None
            and (now - self._labelop_armed_at) <= self.LABELOP_CONFIRM_WINDOW
        )
        if armed_for_this and still_within_window:
            self._labelop_armed = None
            self._labelop_armed_at = None
            self._confirm_labelop(action, row)
        else:
            self._labelop_armed = (action, number)
            self._labelop_armed_at = now
            if action == "priority":
                verb = "remove priority from" if row["priority"] else "add priority to"
                prompt = f"{verb} #{number}"
            else:
                prompt = self._LABELOP_VERBS[action].format(n=number)
            self._set_labelop_status(
                f"Press again within {self.LABELOP_CONFIRM_WINDOW}s to confirm: {prompt}"
            )

    def _confirm_labelop(self, action, row):
        number = row["number"]
        if not self.tracker_api:
            self._set_labelop_status(f"Labels: {_NO_API}")
            return
        try:
            label_ids = self._label_ids()
            if action == "arm":
                labels_mod.arm(
                    number, label_ids, api=self.tracker_api, token=self.tracker_token,
                    poster=self.labels_poster, deleter=self.labels_deleter,
                )
                self._set_labelop_status(f"Armed #{number} — ready-for-agent")
            elif action == "park":
                labels_mod.park(
                    number, label_ids, api=self.tracker_api, token=self.tracker_token,
                    poster=self.labels_poster, deleter=self.labels_deleter,
                )
                self._set_labelop_status(f"Parked #{number} — ready-for-human")
            else:
                want = not row["priority"]
                labels_mod.set_priority(
                    number, want, label_ids, api=self.tracker_api, token=self.tracker_token,
                    poster=self.labels_poster, deleter=self.labels_deleter,
                )
                self._set_labelop_status(f"{'Prioritised' if want else 'Un-prioritised'} #{number}")
        except Exception as exc:  # noqa: BLE001 — any transport failure is a display-only concern
            self._set_labelop_status(f"Labels: write failed for #{number} — {exc}")
            return
        self._refresh_queue_table()

    def action_rearm_dispatch(self):
        # Scoped to the Queue tab (same posture as arm/park/prioritise,
        # #615): 'r' pressed anywhere else is a no-op. Unlike those per-row
        # actions there is no selection to be wrong about — a stray second
        # press outside the window just re-arms, never fires a stale
        # dispatch.
        if self.query_one(TabbedContent).active != "queue-tab":
            return
        now = self.rearm_clock()
        armed_and_within_window = (
            self._rearm_armed_at is not None
            and (now - self._rearm_armed_at) <= self.REARM_CONFIRM_WINDOW
        )
        if armed_and_within_window:
            self._rearm_armed_at = None
            if not self.tracker_api:
                self._set_rearm_status(f"Rearm: {_NO_API}")
                return
            try:
                code = rearm_mod.dispatch(
                    api=self.tracker_api, workflow=self.swarm_workflow,
                    token=self.tracker_token, poster=self.rearm_poster,
                )
            except Exception as exc:  # noqa: BLE001 — any transport failure is a display-only concern
                self._set_rearm_status(f"Rearm dispatch failed: {exc}")
                return
            self._set_rearm_status(f"Dispatched a fresh swarm run (HTTP {code})")
        else:
            self._rearm_armed_at = now
            self._set_rearm_status(
                f"Press r again within {self.REARM_CONFIRM_WINDOW}s to confirm dispatching a fresh swarm run"
            )

    def _set_rearm_status(self, text):
        self.query_one("#rearm-status", Static).update(text)

    def _refresh_fleet_table(self):
        # The worker-class table is doc-maintained, not live state — one load
        # on mount, no polling interval, unlike the other tabs' live-state
        # tables. The vendored harness classes plus this repo's own overlay.
        table = self.query_one("#fleet-table", DataTable)
        table.clear()
        classes = worker_classes_mod.merge_classes(
            worker_classes_mod.load_worker_classes(self.worker_classes_path),
            worker_classes_mod.load_overlay(self.worker_classes_overlay),
        )
        for row in worker_classes_mod.fleet_rows(classes):
            table.add_row(
                row["host"], row["name"], row["trigger"], row["lock"],
                "yes" if row["invisible_failure"] else "-", row["stuck_signal"],
            )

    def _refresh_incidents_table(self):
        # Live host state (heal.sh updates it as incidents occur) — same 5s
        # refresh cadence as the Monitor/Run tabs, unlike Fleet's one-shot
        # doc load.
        table = self.query_one("#incidents-table", DataTable)
        table.clear()
        incidents = healer_ledger_mod.load_incidents(self.healer_state_path)
        for row in healer_ledger_mod.incident_rows(incidents):
            table.add_row(
                row["signature"], row["workflow"],
                healer_ledger_mod.fmt_epoch(row["first_seen"]),
                healer_ledger_mod.fmt_epoch(row["last_seen"]),
                row["attempts"], row["replies"],
                "yes" if row["repaired"] else "-",
                "yes" if row["escalated"] else "-",
                row["thread_id"],
            )

    def _refresh_inbox_table(self):
        # Network-bound like the Queue tab (Forgejo's ready-for-human issues
        # plus a Mattermost thread-state read), not a local-file read like
        # Fleet/Incidents — same own-interval + inline-error-panel shape as
        # _refresh_queue_table (#614).
        error_panel = self.query_one("#inbox-error", Static)
        table = self.query_one("#inbox-table", DataTable)
        if not self.tracker_api:
            table.clear()
            error_panel.update(f"Inbox: {_NO_API}")
            error_panel.add_class("-visible")
            return
        try:
            rows = ask_inbox_mod.inbox_snapshot(
                forgejo_api=self.tracker_api,
                forgejo_token=self.tracker_token,
                forgejo_fetch=self.inbox_forgejo_fetch,
                mattermost_url=self.mattermost_url,
                mattermost_channel_id=self.mattermost_channel_id,
                mattermost_token=self.mattermost_token,
                mattermost_fetch=self.inbox_mattermost_fetch,
                clock=self.inbox_clock,
            )
        except Exception as exc:  # noqa: BLE001 — any transport failure is a display-only concern
            error_panel.update(f"Inbox: {exc}")
            error_panel.add_class("-visible")
            return
        error_panel.remove_class("-visible")
        self._inbox_rows = rows
        table.clear()
        for row in rows:
            table.add_row(
                str(row["number"]), row["title"], row["state"], row["reply_preview"] or "-",
            )

    def _selected_inbox_row(self):
        table = self.query_one("#inbox-table", DataTable)
        if not self._inbox_rows or table.row_count == 0:
            return None
        idx = table.cursor_row
        if idx is None or idx < 0 or idx >= len(self._inbox_rows):
            return None
        return self._inbox_rows[idx]

    def _set_answer_status(self, text):
        self.query_one("#answer-status", Static).update(text)

    def action_open_answer(self):
        # Scoped to the Inbox tab (same posture as every other write
        # action): 'w' pressed anywhere else is a no-op.
        if self.query_one(TabbedContent).active != "inbox-tab":
            return
        row = self._selected_inbox_row()
        if row is None:
            self._set_answer_status("Answer: no row selected")
            return
        if row["state"] != "outstanding":
            self._set_answer_status(
                f"Answer: #{row['number']} has no outstanding question (state: {row['state']})"
            )
            return
        self._answer_target = (row["number"], row["thread_id"])
        input_widget = self.query_one("#answer-input", Input)
        input_widget.disabled = False
        input_widget.value = ""
        self.set_focus(input_widget)
        self._set_answer_status(f"Typing answer for #{row['number']} — Enter to send, Escape to cancel")

    def action_cancel_answer(self):
        if self._answer_target is None:
            return
        self._answer_target = None
        input_widget = self.query_one("#answer-input", Input)
        input_widget.value = ""
        input_widget.disabled = True
        self.set_focus(self.query_one("#inbox-table", DataTable))
        self._set_answer_status("Answer cancelled")

    def on_input_submitted(self, event):
        if event.input.id != "answer-input":
            return
        self._submit_answer(event.value)

    def _submit_answer(self, text):
        if self._answer_target is None:
            return
        text = text.strip()
        if not text:
            self._set_answer_status("Answer: empty answer not sent")
            return
        number, thread_id = self._answer_target
        self._answer_target = None
        input_widget = self.query_one("#answer-input", Input)
        input_widget.value = ""
        input_widget.disabled = True
        self.set_focus(self.query_one("#inbox-table", DataTable))
        if not self.tracker_api:
            self._set_answer_status(f"Answer: {_NO_API}")
            return
        try:
            label_ids = self._label_ids()
            answer_ask_mod.answer(
                number, thread_id, text, label_ids,
                api=self.tracker_api, token=self.tracker_token,
                mattermost_url=self.mattermost_url,
                mattermost_channel_id=self.mattermost_channel_id,
                mattermost_token=self.mattermost_token,
                mm_poster=self.answer_mm_poster, fj_poster=self.answer_fj_poster,
                labels_poster=self.labels_poster, labels_deleter=self.labels_deleter,
            )
        except Exception as exc:  # noqa: BLE001 — any transport failure is a display-only concern
            self._set_answer_status(f"Answer: write failed for #{number} — {exc}")
            return
        self._set_answer_status(f"Answered #{number} — ready-for-agent")
        self._refresh_inbox_table()


if __name__ == "__main__":
    FactoryMonitorApp().run()
