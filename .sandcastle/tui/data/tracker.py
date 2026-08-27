"""tracker.py — read-only Forgejo tracker queries for the factory TUI's
Queue+DAG screen (#573 slice 2).

Mirrors `.sandcastle/list-ready-tasks.sh`'s two real API shapes (paginated
open-issue listing, per-issue native dependency lookup) but classifies every
open issue by its ADR 0174 / triage-labels.md pipeline label instead of
filtering down to just `ready-for-agent` — the TUI shows the whole queue, the
swarm queue only needs the actionable slice. Never writes: no label PUT, no
comment POST, nothing but GET.

`api` is always passed in (data/identity.py resolves it from the consumer's
own swarm-identity.sh) — this module carries no repo's API base.
"""

import json
import os
import re
import urllib.request

# An OPEN PR whose head ref is exactly `agent/issue-<N>` means issue <N> is
# landed and awaiting a human merge — the third of list-ready-tasks.sh's three
# ready-filters (its LANDING=pr block, #13). Anchored, digits only, so the TUI
# and the swarm can never disagree about what an agent PR is: `agent/issue-12-
# retry`, `agent/issue-`, `agent/issue-abc` are NOT agent PRs.
_AGENT_PR_REF = re.compile(r"^agent/issue-([0-9]+)$")

# Ordered so the first matching label wins — mirrors triage-labels.md's
# precedence (a claimed ticket is "in-progress" regardless of which pipeline
# label it also still carries).
_STATE_LABELS = (
    ("agent-working", "in-progress"),
    ("ready-for-agent", "ready-for-agent"),
    ("ready-for-session", "ready-for-session"),
    ("ready-for-human", "ready-for-human"),
    ("needs-design", "needs-design"),
    ("needs-triage", "needs-triage"),
    ("agent-blocked", "agent-blocked"),
    ("deferred", "deferred"),
)


def classify_state(labels):
    for label, state in _STATE_LABELS:
        if label in labels:
            return state
    return "other"


def _http_get(url, token):
    req = urllib.request.Request(url, headers={"Authorization": f"token {token}"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.load(resp)


def fetch_open_issues(api, token=None, fetch=_http_get):
    """All open issues, paginated — same page-until-short-page loop as
    list-ready-tasks.sh."""
    issues = []
    page = 1
    while True:
        batch = fetch(f"{api}/issues?state=open&type=issues&limit=50&page={page}", token)
        issues.extend(batch)
        if len(batch) < 50:
            break
        page += 1
    return issues


def _open_blockers(number, api, token, fetch):
    deps = fetch(f"{api}/issues/{number}/dependencies?limit=50", token)
    return [d["number"] for d in deps if d.get("state") == "open"]


def _awaiting_merge_numbers(api, token, fetch):
    """Issue numbers with an OPEN `agent/issue-<N>` PR — the set the swarm's
    LANDING=pr block drops. One `pulls?state=open` read, the same single-page
    shape list-ready-tasks.sh uses (no pagination, limit=50), so the count
    matches what a swarm run would list. A failed or unavailable read degrades
    to an empty set: those issues then count as ready (today's behaviour)
    rather than erroring the snapshot — a monitor that dies on a tracker blip
    is worse than one that briefly overstates."""
    try:
        pulls = fetch(f"{api}/pulls?state=open&limit=50", token)
    except Exception:  # noqa: BLE001 — isolate; a PR-read blip must not blank the queue
        return set()
    numbers = set()
    for pr in pulls or []:
        ref = (pr.get("head") or {}).get("ref") or ""
        m = _AGENT_PR_REF.match(ref)
        if m:
            numbers.add(int(m.group(1)))
    return numbers


def queue_snapshot(api, token=None, fetch=_http_get):
    """One row per open issue, tracker order preserved: number, title,
    triage state, the full label-name list (display layers pick what to
    show), whether it carries the additive `priority` label (#615 —
    the engage side's prioritise toggle needs to know current state to flip
    it), and — for ready-for-agent issues only, mirroring the swarm's own
    three filters — whether the DAG still blocks it and by what, and whether
    it is landed-and-awaiting-merge (an open `agent/issue-<N>` PR, the
    LANDING=pr drop).

    Precedence, stated so the two never double-count: the DAG check wins. A
    ready-for-agent ticket that is BOTH blocked and awaiting-merge stays
    `ready-for-agent` with `blocked=True` — reported once, in its blocked
    form. Only an UNblocked ready-for-agent ticket with an open agent PR
    becomes `awaiting-merge`. The open-PR read happens at most once per
    snapshot, lazily, and only if some ready-for-agent ticket needs it."""
    token = token or os.environ.get("FORGEJO_TOKEN")
    rows = []
    awaiting = None  # lazily fetched once — skip the /pulls call when unneeded
    for issue in fetch_open_issues(api, token, fetch):
        labels = [l["name"] for l in issue["labels"]]
        state = classify_state(labels)
        blocked_by = _open_blockers(issue["number"], api, token, fetch) if state == "ready-for-agent" else []
        if state == "ready-for-agent" and not blocked_by:
            if awaiting is None:
                awaiting = _awaiting_merge_numbers(api, token, fetch)
            if issue["number"] in awaiting:
                state = "awaiting-merge"
        rows.append({
            "number": issue["number"],
            "title": issue["title"],
            "state": state,
            "labels": labels,
            "priority": "priority" in labels,
            "blocked": bool(blocked_by),
            "blocked_by": blocked_by,
        })
    return rows
