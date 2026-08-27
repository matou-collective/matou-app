"""tests for data/labels.py — the TUI's label-write actions (arm/park/
prioritise, #615). No real network calls: every test injects fake
fetch/poster/deleter callables, same offline posture as test_tracker.py."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from data import labels  # noqa: E402


def _label(id_, name):
    return {"id": id_, "name": name}


class FakeLabelsApi:
    """Records every write call; serves a canned GET /labels page set."""

    def __init__(self, pages):
        self.pages = pages
        self.posts = []
        self.deletes = []

    def fetch(self, url, token):
        page = int(url.rsplit("page=", 1)[1])
        return self.pages[page - 1]

    def post(self, url, token, payload):
        self.posts.append((url, payload))
        return 200

    def delete(self, url, token):
        self.deletes.append(url)
        return 204


def test_fetch_label_ids_builds_name_to_id_map():
    api = FakeLabelsApi(pages=[[_label(1, "ready-for-agent"), _label(2, "priority")]])
    assert labels.fetch_label_ids(api="https://x/api", fetch=api.fetch, token="tok") == {
        "ready-for-agent": 1, "priority": 2,
    }


def test_fetch_label_ids_paginates_until_a_short_page():
    page1 = [_label(n, f"label-{n}") for n in range(50)]
    page2 = [_label(50, "priority")]
    api = FakeLabelsApi(pages=[page1, page2])
    ids = labels.fetch_label_ids(api="https://x/api", fetch=api.fetch, token="tok")
    assert ids["priority"] == 50
    assert len(ids) == 51


def test_add_label_posts_the_single_id():
    api = FakeLabelsApi(pages=[[]])
    labels.add_label(42, 7, api="https://x/api", token="tok", poster=api.post)
    assert api.posts == [("https://x/api/issues/42/labels", {"labels": [7]})]


def test_remove_label_deletes_by_id():
    api = FakeLabelsApi(pages=[[]])
    labels.remove_label(42, 7, api="https://x/api", token="tok", deleter=api.delete)
    assert api.deletes == ["https://x/api/issues/42/labels/7"]


def test_arm_adds_ready_for_agent_and_removes_ready_for_human():
    api = FakeLabelsApi(pages=[[]])
    ids = {"ready-for-agent": 1, "ready-for-human": 2}
    labels.arm(42, ids, api="https://x/api", token="tok", poster=api.post, deleter=api.delete)
    assert api.posts == [("https://x/api/issues/42/labels", {"labels": [1]})]
    assert api.deletes == ["https://x/api/issues/42/labels/2"]


def test_park_adds_ready_for_human_and_removes_ready_for_agent():
    api = FakeLabelsApi(pages=[[]])
    ids = {"ready-for-agent": 1, "ready-for-human": 2}
    labels.park(42, ids, api="https://x/api", token="tok", poster=api.post, deleter=api.delete)
    assert api.posts == [("https://x/api/issues/42/labels", {"labels": [2]})]
    assert api.deletes == ["https://x/api/issues/42/labels/1"]


def test_set_priority_true_adds_the_priority_label():
    api = FakeLabelsApi(pages=[[]])
    ids = {"priority": 9}
    labels.set_priority(42, True, ids, api="https://x/api", token="tok", poster=api.post, deleter=api.delete)
    assert api.posts == [("https://x/api/issues/42/labels", {"labels": [9]})]
    assert api.deletes == []


def test_set_priority_false_removes_the_priority_label():
    api = FakeLabelsApi(pages=[[]])
    ids = {"priority": 9}
    labels.set_priority(42, False, ids, api="https://x/api", token="tok", poster=api.post, deleter=api.delete)
    assert api.deletes == ["https://x/api/issues/42/labels/9"]
    assert api.posts == []
