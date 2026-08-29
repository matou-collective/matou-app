"""tests for data/rearm.py — the TUI's rearm_dispatch write action. No real
network call: injects a fake poster, same offline posture as test_labels.py."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from data import rearm  # noqa: E402


class FakeRearmApi:
    def __init__(self, status=204):
        self.status = status
        self.posts = []

    def post(self, url, token, payload):
        self.posts.append((url, token, payload))
        return self.status


def test_dispatch_posts_the_swarm_workflow_dispatch_with_main_ref():
    api = FakeRearmApi()
    code = rearm.dispatch(api="https://x/api", workflow="swarm.yml", token="tok", poster=api.post)
    assert code == 204
    assert api.posts == [
        ("https://x/api/actions/workflows/swarm.yml/dispatches", "tok", {"ref": "main"}),
    ]


def test_dispatch_returns_the_posters_status():
    api = FakeRearmApi(status=409)
    assert rearm.dispatch(api="https://x/api", workflow="swarm.yml", token="tok", poster=api.post) == 409


def test_dispatch_falls_back_to_env_token_when_none_given(monkeypatch):
    monkeypatch.setenv("FORGEJO_TOKEN", "env-tok")
    api = FakeRearmApi()
    rearm.dispatch(api="https://x/api", workflow="swarm.yml", token=None, poster=api.post)
    assert api.posts[0][1] == "env-tok"


def test_dispatch_uses_the_workflow_the_caller_was_given():
    # The workflow file is identity-resolved (SWARM_WORKFLOW_FILE), never
    # pinned in the module — a consumer that renamed it still re-arms.
    api = FakeRearmApi()
    rearm.dispatch(api="https://x/api", workflow="other.yml", token="tok", poster=api.post)
    assert api.posts[0][0] == "https://x/api/actions/workflows/other.yml/dispatches"
