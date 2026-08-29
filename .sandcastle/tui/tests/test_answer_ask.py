"""tests for data/answer_ask.py — the TUI's answer-parked-ask write action
(#618, #617 follow-up). No real network calls: every test injects fake
poster callables, same offline posture as test_labels.py/test_rearm.py."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from data import answer_ask  # noqa: E402

LABEL_IDS = {"ready-for-agent": 1, "ready-for-human": 2}


class FakePoster:
    def __init__(self, status=200):
        self.status = status
        self.calls = []

    def post(self, url, token, payload):
        self.calls.append((url, token, payload))
        return self.status


def test_post_reply_posts_a_thread_reply_naming_the_operators_text():
    mm = FakePoster()
    answer_ask.post_reply(
        "https://chat.example", "chan1", "mmtok", "t41", "do the thing", poster=mm.post,
    )
    assert len(mm.calls) == 1
    url, token, payload = mm.calls[0]
    assert url == "https://chat.example/api/v4/posts"
    assert token == "mmtok"
    assert payload["channel_id"] == "chan1"
    assert payload["root_id"] == "t41"
    assert "do the thing" in payload["message"]


def test_consume_thread_posts_a_checkmark_reply():
    mm = FakePoster()
    answer_ask.consume_thread("https://chat.example", "chan1", "mmtok", "t41", poster=mm.post)
    assert len(mm.calls) == 1
    url, token, payload = mm.calls[0]
    assert url == "https://chat.example/api/v4/posts"
    assert payload["root_id"] == "t41"
    assert payload["message"].startswith(":white_check_mark:")


def test_record_ruling_comment_posts_the_answer_as_an_issue_comment():
    fj = FakePoster()
    answer_ask.record_ruling_comment(41, "do the thing", api="https://x/api", token="tok", poster=fj.post)
    assert fj.calls == [
        ("https://x/api/issues/41/comments", "tok", fj.calls[0][2]),
    ]
    body = fj.calls[0][2]["body"]
    assert "do the thing" in body
    assert "ready-for-agent" in body


def test_record_ruling_comment_quotes_every_line():
    fj = FakePoster()
    answer_ask.record_ruling_comment(41, "line one\nline two", api="https://x/api", token="tok", poster=fj.post)
    body = fj.calls[0][2]["body"]
    assert "> line one" in body
    assert "> line two" in body


def test_answer_records_labels_replies_and_consumes_in_order():
    fj = FakePoster()
    mm = FakePoster()
    label_posts, label_deletes = [], []

    def labels_poster(url, token, payload):
        label_posts.append((url, payload))
        return 200

    def labels_deleter(url, token):
        label_deletes.append(url)
        return 204

    answer_ask.answer(
        41, "t41", "do the thing", LABEL_IDS,
        api="https://x/api", token="tok",
        mattermost_url="https://chat.example", mattermost_channel_id="chan1",
        mattermost_token="mmtok",
        mm_poster=mm.post, fj_poster=fj.post,
        labels_poster=labels_poster, labels_deleter=labels_deleter,
    )

    # Durable record and re-arm land before any Mattermost write.
    assert fj.calls[0][0] == "https://x/api/issues/41/comments"
    assert label_posts == [("https://x/api/issues/41/labels", {"labels": [1]})]
    assert label_deletes == ["https://x/api/issues/41/labels/2"]

    # Mattermost side: the reply, then the checkmark, in that order.
    assert len(mm.calls) == 2
    assert mm.calls[0][2]["root_id"] == "t41"
    assert "do the thing" in mm.calls[0][2]["message"]
    assert mm.calls[1][2]["message"].startswith(":white_check_mark:")


def test_answer_consumes_the_thread_last():
    fj = FakePoster()
    order = []

    def labels_poster(url, token, payload):
        order.append("label-post")
        return 200

    def labels_deleter(url, token):
        order.append("label-delete")
        return 204

    def mm_poster(url, token, payload):
        order.append("consume" if payload["message"].startswith(":white_check_mark:") else "reply")
        return 200

    def fj_poster(url, token, payload):
        order.append("comment")
        return 201

    answer_ask.answer(
        41, "t41", "do the thing", LABEL_IDS,
        api="https://x/api", token="tok",
        mattermost_url="https://chat.example", mattermost_channel_id="chan1",
        mattermost_token="mmtok",
        mm_poster=mm_poster, fj_poster=fj_poster,
        labels_poster=labels_poster, labels_deleter=labels_deleter,
    )
    assert order[-1] == "consume"
    assert order.index("comment") < order.index("consume")
    assert order.index("reply") < order.index("consume")
