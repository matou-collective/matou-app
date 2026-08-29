"""tests for data/tracker.py — the queue+DAG screen's data source.

No real network calls: every test injects a fake `fetch` so the module is
exercised offline, same posture as the rest of this test suite.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from data import tracker  # noqa: E402

# The API base is always the caller's (data/identity.py resolves it from the
# consumer's own swarm-identity.sh) — the module has no default to fall back
# to, so every call here states one.
API = "https://forge.example.invalid/api/v1/repos/Owner/repo"


def _issue(number, title, labels):
    return {"number": number, "title": title, "labels": [{"name": l} for l in labels]}


def _dep(number, state):
    return {"number": number, "state": state}


def _pr(ref):
    return {"head": {"ref": ref}}


class FakeApi:
    """Records calls and serves canned responses keyed by URL substring."""

    def __init__(self, issues, deps_by_number=None, pulls=None):
        self.issues = issues
        self.deps_by_number = deps_by_number or {}
        self.pulls = pulls or []
        self.calls = []

    def fetch(self, url, token):
        self.calls.append(url)
        if "/dependencies" in url:
            number = int(url.rsplit("/issues/", 1)[1].split("/")[0])
            return self.deps_by_number.get(number, [])
        if "/pulls?" in url:
            return self.pulls
        if "/issues?" in url:
            return self.issues
        raise AssertionError(f"unexpected url: {url}")


def test_classify_prioritises_agent_working_over_pipeline_label():
    assert tracker.classify_state(["agent-working", "ready-for-agent"]) == "in-progress"


def test_classify_covers_each_pipeline_label():
    assert tracker.classify_state(["ready-for-agent"]) == "ready-for-agent"
    assert tracker.classify_state(["ready-for-session"]) == "ready-for-session"
    assert tracker.classify_state(["ready-for-human"]) == "ready-for-human"
    assert tracker.classify_state(["needs-design"]) == "needs-design"
    assert tracker.classify_state(["needs-triage"]) == "needs-triage"
    assert tracker.classify_state(["agent-blocked"]) == "agent-blocked"
    assert tracker.classify_state(["deferred"]) == "deferred"
    assert tracker.classify_state(["enhancement"]) == "other"


def test_fetch_open_issues_paginates_until_a_short_page(monkeypatch):
    page1 = [_issue(n, f"issue {n}", []) for n in range(50)]
    page2 = [_issue(50, "issue 50", [])]
    calls = {"n": 0}

    def fetch(url, token):
        calls["n"] += 1
        return page1 if "page=1" in url else page2

    issues = tracker.fetch_open_issues('https://x/api'.replace('%','%'), fetch=fetch, token="tok")
    assert len(issues) == 51
    assert calls["n"] == 2


def test_fetch_open_issues_stops_on_empty_page():
    def fetch(url, token):
        return []

    assert tracker.fetch_open_issues('https://x/api'.replace('%','%'), fetch=fetch, token="tok") == []


def test_queue_snapshot_marks_unblocked_ready_for_agent_issue():
    api = FakeApi(
        issues=[_issue(10, "unblocked ticket", ["ready-for-agent"])],
        deps_by_number={10: []},
    )
    snapshot = tracker.queue_snapshot(API, fetch=api.fetch, token="tok")
    assert snapshot == [
        {"number": 10, "title": "unblocked ticket", "state": "ready-for-agent",
         "labels": ["ready-for-agent"],
         "priority": False, "blocked": False, "blocked_by": []},
    ]


def test_queue_snapshot_marks_blocked_ready_for_agent_issue_with_blockers():
    api = FakeApi(
        issues=[_issue(11, "blocked ticket", ["ready-for-agent"])],
        deps_by_number={11: [_dep(7, "open"), _dep(8, "closed")]},
    )
    snapshot = tracker.queue_snapshot(API, fetch=api.fetch, token="tok")
    assert snapshot == [
        {"number": 11, "title": "blocked ticket", "state": "ready-for-agent",
         "labels": ["ready-for-agent"],
         "priority": False, "blocked": True, "blocked_by": [7]},
    ]


def test_queue_snapshot_marks_awaiting_merge_when_an_open_agent_pr_exists():
    # Unblocked ready-for-agent + an OPEN agent/issue-<N> PR = landed and
    # awaiting a human merge — the swarm's LANDING=pr filter drops it, so the
    # mirror must not count it as ready. It gets its own state instead.
    api = FakeApi(
        issues=[_issue(10, "landed ticket", ["ready-for-agent"])],
        deps_by_number={10: []},
        pulls=[_pr("agent/issue-10")],
    )
    snapshot = tracker.queue_snapshot(API, fetch=api.fetch, token="tok")
    assert snapshot[0]["state"] == "awaiting-merge"
    assert snapshot[0]["blocked"] is False and snapshot[0]["blocked_by"] == []


def test_queue_snapshot_returns_to_ready_when_the_agent_pr_is_closed():
    # PR closed/merged -> not in the open-pulls set -> back to ready.
    api = FakeApi(
        issues=[_issue(10, "no longer landed", ["ready-for-agent"])],
        deps_by_number={10: []},
        pulls=[],  # the pulls?state=open read returns nothing for #10
    )
    snapshot = tracker.queue_snapshot(API, fetch=api.fetch, token="tok")
    assert snapshot[0]["state"] == "ready-for-agent"


def test_queue_snapshot_dag_block_takes_precedence_over_awaiting_merge():
    # Both blocked AND an open agent PR: the DAG check wins, reported once in
    # its blocked form (still ready-for-agent, blocked=True) — never awaiting-
    # merge, so the two states can never double-count the same issue.
    api = FakeApi(
        issues=[_issue(11, "blocked and landed", ["ready-for-agent"])],
        deps_by_number={11: [_dep(7, "open")]},
        pulls=[_pr("agent/issue-11")],
    )
    snapshot = tracker.queue_snapshot(API, fetch=api.fetch, token="tok")
    assert snapshot[0]["state"] == "ready-for-agent"
    assert snapshot[0]["blocked"] is True and snapshot[0]["blocked_by"] == [7]


def test_queue_snapshot_only_matches_the_anchored_agent_pr_pattern():
    # Refs that merely resemble the pattern must not mark an issue awaiting-
    # merge — same anchored, digits-only match list-ready-tasks.sh uses.
    api = FakeApi(
        issues=[_issue(12, "retry-suffix ref", ["ready-for-agent"])],
        deps_by_number={12: []},
        pulls=[_pr("agent/issue-12-retry"), _pr("agent/issue-"),
               _pr("agent/issue-abc"), _pr("feature/agent/issue-12")],
    )
    snapshot = tracker.queue_snapshot(API, fetch=api.fetch, token="tok")
    assert snapshot[0]["state"] == "ready-for-agent"


def test_queue_snapshot_degrades_to_ready_when_the_pulls_read_fails():
    # A failing /pulls read must not raise or blank the snapshot — the issue
    # counts as ready (today's behaviour) rather than erroring the board.
    class FailingPulls(FakeApi):
        def fetch(self, url, token):
            if "/pulls?" in url:
                raise OSError("tracker blip")
            return super().fetch(url, token)

    api = FailingPulls(
        issues=[_issue(10, "landed but pulls down", ["ready-for-agent"])],
        deps_by_number={10: []},
    )
    snapshot = tracker.queue_snapshot(API, fetch=api.fetch, token="tok")
    assert snapshot[0]["state"] == "ready-for-agent"


def test_queue_snapshot_reads_pulls_at_most_once_and_skips_it_when_unneeded():
    # No unblocked ready-for-agent issue -> no /pulls call at all. With two
    # such issues, the open-PR set is fetched exactly once.
    api = FakeApi(issues=[_issue(1, "human", ["ready-for-human"])])
    tracker.queue_snapshot(API, fetch=api.fetch, token="tok")
    assert not any("/pulls?" in c for c in api.calls)

    api = FakeApi(
        issues=[_issue(2, "a", ["ready-for-agent"]),
                _issue(3, "b", ["ready-for-agent"])],
        deps_by_number={2: [], 3: []},
    )
    tracker.queue_snapshot(API, fetch=api.fetch, token="tok")
    assert sum("/pulls?" in c for c in api.calls) == 1


def test_queue_snapshot_skips_dependency_lookup_for_non_agent_issues():
    api = FakeApi(issues=[_issue(12, "needs a human", ["ready-for-human"])])
    snapshot = tracker.queue_snapshot(API, fetch=api.fetch, token="tok")
    assert snapshot == [
        {"number": 12, "title": "needs a human", "state": "ready-for-human",
         "labels": ["ready-for-human"],
         "priority": False, "blocked": False, "blocked_by": []},
    ]
    assert not any("/dependencies" in c for c in api.calls)


def test_queue_snapshot_preserves_tracker_order():
    api = FakeApi(issues=[
        _issue(1, "a", ["ready-for-human"]),
        _issue(2, "b", ["ready-for-session"]),
        _issue(3, "c", ["needs-triage"]),
    ])
    snapshot = tracker.queue_snapshot(API, fetch=api.fetch, token="tok")
    assert [row["number"] for row in snapshot] == [1, 2, 3]


def test_queue_snapshot_marks_priority_from_the_additive_label():
    api = FakeApi(issues=[_issue(13, "urgent one", ["ready-for-human", "priority"])])
    snapshot = tracker.queue_snapshot(API, fetch=api.fetch, token="tok")
    assert snapshot[0]["priority"] is True


def test_queue_snapshot_carries_the_full_label_list():
    # The row keeps every label in tracker order — the display layer decides
    # what to show (the fleet TUI's LABELS column filters the pipeline label
    # back out because STATE already displays it).
    api = FakeApi(issues=[_issue(14, "typed one",
                                 ["enhancement", "ready-for-human", "priority"])])
    snapshot = tracker.queue_snapshot(API, fetch=api.fetch, token="tok")
    assert snapshot[0]["labels"] == ["enhancement", "ready-for-human", "priority"]
