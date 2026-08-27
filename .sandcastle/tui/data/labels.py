"""labels.py — the TUI's label-write actions (arm/park/prioritise, #615).

Speaks the exact protocol forgejo-lib.sh pins (and the factory's
docs/agents/issue-tracker.md records — a factory doc, not a path in a
consumer's checkout, #47): POST /issues/N/labels {"labels":[id]} ADDS a
label, DELETE /issues/N/labels/{id} removes one, and a `labels` field in a
PATCH on the issue itself is silently ignored — never used here.
`arm`/`park` mirror resume-parked-asks.sh's own re-arm pair (add one state
label, remove the other) rather than clearing every possible pipeline label,
so an issue that isn't currently in the label being removed just no-ops that
half (a DELETE of an absent label is harmless, same posture as
claim-lib.sh's `|| true` callers).
"""

import json
import os
import urllib.request



def _http_get(url, token):
    req = urllib.request.Request(url, headers={"Authorization": f"token {token}"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.load(resp)


def _http_post(url, token, payload):
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Authorization": f"token {token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return resp.status


def _http_delete(url, token):
    req = urllib.request.Request(url, method="DELETE", headers={"Authorization": f"token {token}"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return resp.status


def fetch_label_ids(api, token=None, fetch=_http_get):
    """name -> id map, from GET /labels — paged (claim-lib.sh's `claim_label_id`
    finding, #470 M-2): a single-page fetch goes silently blind past 50 labels."""
    token = token or os.environ.get("FORGEJO_TOKEN")
    ids = {}
    page = 1
    while True:
        batch = fetch(f"{api}/labels?limit=50&page={page}", token)
        for label in batch:
            ids[label["name"]] = label["id"]
        if len(batch) < 50:
            break
        page += 1
    return ids


def add_label(number, label_id, api, token=None, poster=_http_post):
    return poster(f"{api}/issues/{number}/labels", token, {"labels": [label_id]})


def remove_label(number, label_id, api, token=None, deleter=_http_delete):
    return deleter(f"{api}/issues/{number}/labels/{label_id}", token)


def arm(number, label_ids, api, token=None, poster=_http_post, deleter=_http_delete):
    """ready-for-human -> ready-for-agent."""
    add_label(number, label_ids["ready-for-agent"], api, token, poster)
    remove_label(number, label_ids["ready-for-human"], api, token, deleter)


def park(number, label_ids, api, token=None, poster=_http_post, deleter=_http_delete):
    """ready-for-agent -> ready-for-human."""
    add_label(number, label_ids["ready-for-human"], api, token, poster)
    remove_label(number, label_ids["ready-for-agent"], api, token, deleter)


def set_priority(number, want_priority, label_ids, api, token=None,
                  poster=_http_post, deleter=_http_delete):
    """priority is additive (triage-labels.md) — toggle it on or off without
    touching any pipeline-state label."""
    if want_priority:
        add_label(number, label_ids["priority"], api, token, poster)
    else:
        remove_label(number, label_ids["priority"], api, token, deleter)
