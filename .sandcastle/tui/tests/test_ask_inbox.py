"""tests for data/ask_inbox.py — the Inbox screen's data source.

No real network calls: every test injects fake Forgejo/Mattermost fetch
functions, same posture as test_tracker.py.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from data import ask_inbox  # noqa: E402

# Always the caller's — the module carries no repo's API base.
API = "https://forge.example.invalid/api/v1/repos/Owner/repo"

BOT_ID = "bot123"
HUMAN_ID = "human456"


def _post(id, message, create_at, root_id="", user_id=BOT_ID, delete_at=0):
    return {
        "id": id, "root_id": root_id, "user_id": user_id,
        "create_at": create_at, "delete_at": delete_at, "message": message,
    }


def _page(posts):
    return {"order": [p["id"] for p in posts], "posts": {p["id"]: p for p in posts}}


def _issue(number, title, labels=None):
    return {"number": number, "title": title,
            "labels": [{"name": l} for l in (labels or [])]}


# ---- Forgejo half ----------------------------------------------------


def test_fetch_parked_issues_queries_ready_for_human_label():
    calls = []

    def fetch(url, token):
        calls.append((url, token))
        return [_issue(614, "ask inbox")]

    issues = ask_inbox.fetch_parked_issues(API, token="tok", fetch=fetch)
    assert issues == [_issue(614, "ask inbox")]
    assert "labels=ready-for-human" in calls[0][0]
    assert "state=open" in calls[0][0]
    assert calls[0][1] == "tok"


# ---- pure thread-state helpers ----------------------------------------


def test_posts_handles_object_shaped_posts_field():
    page = {"posts": {"a": _post("a", ":raising_hand: hi #1", 100)}}
    assert [p["id"] for p in ask_inbox._posts(page)] == ["a"]


def test_posts_handles_missing_posts_field():
    assert ask_inbox._posts({}) == []
    assert ask_inbox._posts(None) == []


def test_candidate_threads_matches_issue_number_with_boundary():
    posts = [
        _post("root-614", ":raising_hand: about #614 please", 5000),
        _post("root-6142", ":raising_hand: about #6142 please", 6000),
        _post("reply", ":raising_hand: not a root", 7000, root_id="root-614"),
        _post("old", ":raising_hand: about #614 too old", 100),
        _post("deleted", ":raising_hand: about #614 gone", 8000, delete_at=1),
        _post("human-posted", ":raising_hand: about #614 impersonation?", 9000, user_id=HUMAN_ID),
    ]
    channel = _page(posts)
    cands = ask_inbox.candidate_threads(channel, BOT_ID, 614, cutoff_ms=1000)
    assert [c["id"] for c in cands] == ["root-614"]


def test_candidate_threads_sorted_newest_first():
    posts = [
        _post("older", ":raising_hand: #9 first round", 1000),
        _post("newer", ":raising_hand: #9 follow-up round", 2000),
    ]
    cands = ask_inbox.candidate_threads(_page(posts), BOT_ID, 9, cutoff_ms=0)
    assert [c["id"] for c in cands] == ["newer", "older"]


def test_latest_question_ts_picks_newest_raising_hand_root_or_reply():
    thread = _page([
        _post("root", ":raising_hand: round 1", 1000),
        _post("r1", "no", 1100, root_id="root", user_id=HUMAN_ID),
        _post("r2", ":raising_hand: round 2 follow-up", 1500, root_id="root"),
    ])
    assert ask_inbox.latest_question_ts(thread, "root", BOT_ID) == 1500


def test_latest_question_ts_zero_when_no_question_posts():
    assert ask_inbox.latest_question_ts(_page([]), "root", BOT_ID) == 0


def test_consumed_after_true_when_checkmark_at_or_after_ts():
    thread = _page([
        _post("root", ":raising_hand: q", 1000),
        _post("ok", ":white_check_mark: done", 1500, root_id="root"),
    ])
    assert ask_inbox.consumed_after(thread, "root", BOT_ID, 1000) is True


def test_consumed_after_false_when_checkmark_before_ts():
    thread = _page([
        _post("root", ":raising_hand: q1", 1000),
        _post("ok1", ":white_check_mark: done round 1", 1100, root_id="root"),
        _post("root2", ":raising_hand: q2 follow-up", 2000, root_id="root"),
    ])
    assert ask_inbox.consumed_after(thread, "root", BOT_ID, 2000) is False


def test_first_reply_returns_earliest_human_reply_at_or_after_ts():
    thread = _page([
        _post("root", ":raising_hand: q", 1000),
        _post("late", "second reply", 1300, root_id="root", user_id=HUMAN_ID),
        _post("early", "first reply", 1200, root_id="root", user_id=HUMAN_ID),
        _post("stale", "too early", 900, root_id="root", user_id=HUMAN_ID),
        _post("bot-eyes", ":eyes: resuming", 1250, root_id="root", user_id=BOT_ID),
    ])
    assert ask_inbox.first_reply(thread, "root", BOT_ID, 1000) == "first reply"


def test_first_reply_none_when_only_bot_posts():
    thread = _page([_post("root", ":raising_hand: q", 1000)])
    assert ask_inbox.first_reply(thread, "root", BOT_ID, 1000) is None


# ---- resolve_thread_state ----------------------------------------------


def test_resolve_thread_state_outstanding_when_unanswered():
    channel = _page([_post("root", ":raising_hand: #7 decision needed", 1000)])
    thread = _page([_post("root", ":raising_hand: #7 decision needed", 1000)])
    state = ask_inbox.resolve_thread_state(7, channel, BOT_ID, lambda pid: thread, cutoff_ms=0)
    assert state["state"] == "outstanding"
    assert state["thread_id"] == "root"


def test_resolve_thread_state_answered_pending_sweep():
    channel = _page([_post("root", ":raising_hand: #8 decision needed", 1000)])
    thread = _page([
        _post("root", ":raising_hand: #8 decision needed", 1000),
        _post("reply", "do the thing", 1200, root_id="root", user_id=HUMAN_ID),
    ])
    state = ask_inbox.resolve_thread_state(8, channel, BOT_ID, lambda pid: thread, cutoff_ms=0)
    assert state["state"] == "answered-pending-sweep"
    assert state["reply_preview"] == "do the thing"


def test_resolve_thread_state_idle_when_consumed_and_no_other_candidate():
    channel = _page([_post("root", ":raising_hand: #9 decision needed", 1000)])
    thread = _page([
        _post("root", ":raising_hand: #9 decision needed", 1000),
        _post("check", ":white_check_mark: got it", 1200, root_id="root"),
    ])
    state = ask_inbox.resolve_thread_state(9, channel, BOT_ID, lambda pid: thread, cutoff_ms=0)
    assert state["state"] == "idle"
    assert state["thread_id"] == "root"


def test_resolve_thread_state_skips_idle_and_reports_older_outstanding():
    channel = _page([
        _post("newer", ":raising_hand: #10 idle round", 2000),
        _post("older", ":raising_hand: #10 first round", 1000),
    ])
    threads = {
        "newer": _page([
            _post("newer", ":raising_hand: #10 idle round", 2000),
            _post("check", ":white_check_mark: got it", 2100, root_id="newer"),
        ]),
        "older": _page([_post("older", ":raising_hand: #10 first round", 1000)]),
    }
    state = ask_inbox.resolve_thread_state(10, channel, BOT_ID, lambda pid: threads[pid], cutoff_ms=0)
    assert state["state"] == "outstanding"
    assert state["thread_id"] == "older"


def test_resolve_thread_state_no_thread_when_nothing_posted():
    state = ask_inbox.resolve_thread_state(11, _page([]), BOT_ID, lambda pid: _page([]), cutoff_ms=0)
    assert state == {"state": "no-thread", "thread_id": None, "question_ts": None, "reply_preview": None}


def test_resolve_thread_state_skips_unreadable_thread_and_falls_back():
    channel = _page([
        _post("unreadable", ":raising_hand: #12 gone", 2000),
        _post("older", ":raising_hand: #12 real", 1000),
    ])
    threads = {
        "unreadable": None,
        "older": _page([_post("older", ":raising_hand: #12 real", 1000)]),
    }
    state = ask_inbox.resolve_thread_state(12, channel, BOT_ID, lambda pid: threads[pid], cutoff_ms=0)
    assert state["state"] == "outstanding"
    assert state["thread_id"] == "older"


# ---- inbox_snapshot end-to-end -----------------------------------------


class FakeMattermostApi:
    def __init__(self, channel_posts, threads_by_id):
        self.channel_posts = channel_posts
        self.threads_by_id = threads_by_id
        self.calls = []

    def fetch(self, url, token):
        self.calls.append(url)
        if "/users/me" in url:
            return {"id": BOT_ID}
        if "/channels/" in url and "/posts" in url:
            return self.channel_posts
        if "/thread" in url:
            post_id = url.rsplit("/posts/", 1)[1].split("/")[0]
            return self.threads_by_id.get(post_id, {})
        raise AssertionError(f"unexpected url: {url}")


def test_inbox_snapshot_chat_unavailable_without_mattermost_config():
    def forgejo_fetch(url, token):
        return [_issue(20, "no chat config")]

    rows = ask_inbox.inbox_snapshot(API, forgejo_fetch=forgejo_fetch, forgejo_token="tok")
    assert rows == [{"number": 20, "title": "no chat config", "labels": [],
                     "state": "chat-unavailable",
                     "thread_id": None, "question_ts": None, "reply_preview": None}]


def test_inbox_snapshot_carries_the_ticket_labels():
    # Rows keep the issue's label names (labels missing entirely tolerated) —
    # the fleet TUI's Asks LABELS column reads them.
    def forgejo_fetch(url, token):
        return [_issue(23, "typed one", ["ready-for-human", "bug"]),
                {"number": 24, "title": "no labels field"}]

    rows = ask_inbox.inbox_snapshot(API, forgejo_fetch=forgejo_fetch, forgejo_token="tok")
    assert rows[0]["labels"] == ["ready-for-human", "bug"]
    assert rows[1]["labels"] == []


def test_inbox_snapshot_joins_forgejo_and_mattermost_state():
    def forgejo_fetch(url, token):
        return [_issue(21, "outstanding one"), _issue(22, "answered one")]

    root21 = _post("t21", ":raising_hand: about #21 decision", 1000)
    root22 = _post("t22", ":raising_hand: about #22 decision", 1000)
    channel = _page([root21, root22])
    threads = {
        "t21": _page([root21]),
        "t22": _page([root22, _post("r22", "yes do it", 1200, root_id="t22", user_id=HUMAN_ID)]),
    }
    mm = FakeMattermostApi(channel, threads)

    rows = ask_inbox.inbox_snapshot(
        API, forgejo_fetch=forgejo_fetch, forgejo_token="tok",
        mattermost_url="https://chat.example", mattermost_channel_id="chan1",
        mattermost_token="mmtok", mattermost_fetch=mm.fetch,
        clock=lambda: 2.0,
    )
    by_number = {r["number"]: r for r in rows}
    assert by_number[21]["state"] == "outstanding"
    assert by_number[22]["state"] == "answered-pending-sweep"
    assert by_number[22]["reply_preview"] == "yes do it"


def test_fmt_epoch_ms_handles_missing_and_present():
    assert ask_inbox.fmt_epoch_ms(None) == "-"
    assert ask_inbox.fmt_epoch_ms(0) == "-"
    assert ask_inbox.fmt_epoch_ms("not-a-number") == "-"
    assert ask_inbox.fmt_epoch_ms(1700000000000) != "-"
