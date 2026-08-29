"""rearm.py — the TUI's rearm_dispatch write action (#617).

Mirrors claim-lib.sh's rearm_dispatch exactly: a single workflow_dispatch
POST against the swarm workflow on main (forgejo_dispatch_workflow's own
shape, forgejo-lib.sh) — no state to read back and act on afterward, unlike
labels.py's arm/park: the dispatch either fired or it didn't.

`api` and `workflow` are always passed in (data/identity.py resolves both).
"""

import json
import os
import urllib.request

REF = "main"


def _http_post(url, token, payload):
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Authorization": f"token {token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return resp.status


def dispatch(api, workflow, token=None, poster=_http_post):
    """POST /actions/workflows/<workflow>/dispatches {"ref":"main"} — the same
    call run-swarm.sh's own rearm_dispatch makes when claimable work remains
    after a run, fired here on demand instead of waiting for the next
    :15/:45 cron tick (schedule-backstop.sh)."""
    token = token or os.environ.get("FORGEJO_TOKEN")
    return poster(f"{api}/actions/workflows/{workflow}/dispatches", token, {"ref": REF})
