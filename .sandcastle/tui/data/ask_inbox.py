"""ask_inbox.py — cross-read parked ask-human.sh threads for the factory
TUI's Inbox screen (#614, #613 follow-up).

Two data sources joined: Forgejo's open `ready-for-human` issues (the
tracker side) and each issue's Mattermost ask thread (the chat side) —
mirrors the THREAD MODEL shared by ask-human.sh / post-issue-ask.sh /
resume-parked-asks.sh (a root post starting `:raising_hand:` naming `#N` is
the thread; the newest bot `:raising_hand:` post in it is the CURRENT
question; a bot `:white_check_mark:` at/after that timestamp CONSUMES the
round) rather than any local marker file — #613 confirmed by reading
post-issue-ask.sh that no local marker file exists at all; idempotency is
entirely thread-state-derived.

`forgejo_api` and the Mattermost config are always passed in
(data/identity.py resolves them) — this module carries no repo's API base
and no host's chat credentials.

Read-only: GET only, no POST — same posture as tracker.py. Two independent
fetch seams (Forgejo, Mattermost), injectable like tracker.py's `_http_get`,
so the whole module is testable offline; the pure thread-state functions
below take already-fetched JSON and don't touch urllib at all.
"""

import json
import os
import re
import time
import urllib.request

# Same lookback default as ask-human.sh / post-issue-ask.sh / resume-parked-asks.sh.
DEFAULT_LOOKBACK_SECONDS = 172800

_QUESTION_PREFIX = ":raising_hand:"
_CONSUMED_PREFIX = ":white_check_mark:"


def _http_get(url, token):
    req = urllib.request.Request(url, headers={"Authorization": f"token {token}"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.load(resp)


def _mattermost_get(url, token):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.load(resp)


def fetch_parked_issues(api, token=None, fetch=_http_get):
    """Open issues labelled ready-for-human, tracker order preserved —
    mirrors resume-parked-asks.sh's own query exactly, unpaginated like it
    (the parked set is always small under ADR 0174's narrowed bar)."""
    return fetch(f"{api}/issues?state=open&type=issues&labels=ready-for-human&limit=50", token)


def bot_user_id(mattermost_url, token, fetch=_mattermost_get):
    return fetch(f"{mattermost_url}/api/v4/users/me", token)["id"]


def fetch_channel_posts(mattermost_url, channel_id, token, fetch=_mattermost_get):
    return fetch(f"{mattermost_url}/api/v4/channels/{channel_id}/posts?per_page=200", token)


def fetch_thread(mattermost_url, post_id, token, fetch=_mattermost_get):
    return fetch(f"{mattermost_url}/api/v4/posts/{post_id}/thread", token)


def _posts(page):
    """Mattermost's `posts` field is an {id: post} object, not an array —
    `.posts[]` in the bash scripts' jq iterates its values regardless of
    shape; mirror that here rather than assume a list."""
    posts = (page or {}).get("posts", {})
    return list(posts.values()) if isinstance(posts, dict) else list(posts or [])


def _names_issue(message, issue_number):
    key = f"#{issue_number}"
    return message.startswith(_QUESTION_PREFIX) and bool(re.search(re.escape(key) + r"([^0-9]|$)", message))


def candidate_threads(channel_posts, bot_id, issue_number, cutoff_ms):
    """Bot root `:raising_hand:` posts naming #issue_number within the
    lookback window, newest first — mirrors ask-human.sh's own `cands`
    selection (root_id == "", not deleted, create_at >= cutoff)."""
    posts = [
        p for p in _posts(channel_posts)
        if p.get("user_id") == bot_id
        and p.get("root_id", "") == ""
        and p.get("delete_at", 0) == 0
        and p.get("create_at", 0) >= cutoff_ms
        and _names_issue(p.get("message", ""), issue_number)
    ]
    return sorted(posts, key=lambda p: p["create_at"], reverse=True)


def latest_question_ts(thread, root_id, bot_id):
    """create_at of the CURRENT question in a thread — mirrors
    ask-human.sh's latest_question_ts: the newest bot `:raising_hand:` post
    that is either the root itself or a reply to it."""
    questions = [
        p for p in _posts(thread)
        if (p.get("id") == root_id or p.get("root_id") == root_id)
        and p.get("user_id") == bot_id
        and p.get("delete_at", 0) == 0
        and p.get("message", "").startswith(_QUESTION_PREFIX)
    ]
    return max((p["create_at"] for p in questions), default=0)


def consumed_after(thread, root_id, bot_id, min_ts):
    """Whether a bot `:white_check_mark:` reply landed at/after the current
    question's timestamp — mirrors ask-human.sh's consumed_after (there a
    count used only for >0; here the bool directly)."""
    return any(
        p.get("root_id") == root_id
        and p.get("user_id") == bot_id
        and p.get("delete_at", 0) == 0
        and p.get("create_at", 0) >= min_ts
        and p.get("message", "").startswith(_CONSUMED_PREFIX)
        for p in _posts(thread)
    )


def first_reply(thread, root_id, bot_id, min_ts):
    """Earliest non-bot reply to the current round, or None — mirrors
    ask-human.sh's first_reply."""
    replies = [
        p for p in _posts(thread)
        if p.get("root_id") == root_id
        and p.get("user_id") != bot_id
        and p.get("delete_at", 0) == 0
        and p.get("create_at", 0) >= min_ts
    ]
    if not replies:
        return None
    return min(replies, key=lambda p: p["create_at"])["message"]


def resolve_thread_state(issue_number, channel_posts, bot_id, fetch_thread_fn, cutoff_ms):
    """One issue's ask state, judged the same way ask-human.sh and
    resume-parked-asks.sh judge it: walk candidate threads newest first,
    stop at the first unconsumed round — reporting it as 'outstanding'
    (nobody has replied yet) or 'answered-pending-sweep' (a reply landed but
    resume-parked-asks.sh, which runs on its own schedule, hasn't picked it
    up yet). Falls back to the newest fully-consumed ('idle') thread, else
    'no-thread' when nothing was ever posted in the lookback window.

    fetch_thread_fn(post_id) -> thread json — the seam that keeps this
    function ignorant of urllib/caching so it's directly unit-testable.
    """
    candidates = candidate_threads(channel_posts, bot_id, issue_number, cutoff_ms)
    idle_id = None
    for cand in candidates:
        thread = fetch_thread_fn(cand["id"])
        if not thread:
            continue
        qts = latest_question_ts(thread, cand["id"], bot_id)
        if consumed_after(thread, cand["id"], bot_id, qts):
            if idle_id is None:
                idle_id = cand["id"]
            continue
        reply = first_reply(thread, cand["id"], bot_id, qts)
        if reply is not None:
            return {"state": "answered-pending-sweep", "thread_id": cand["id"],
                    "question_ts": qts, "reply_preview": reply}
        return {"state": "outstanding", "thread_id": cand["id"],
                "question_ts": qts, "reply_preview": None}
    if idle_id is not None:
        return {"state": "idle", "thread_id": idle_id, "question_ts": None, "reply_preview": None}
    return {"state": "no-thread", "thread_id": None, "question_ts": None, "reply_preview": None}


def inbox_snapshot(
    forgejo_api,
    forgejo_token=None,
    forgejo_fetch=_http_get,
    mattermost_url=None,
    mattermost_channel_id=None,
    mattermost_token=None,
    mattermost_fetch=_mattermost_get,
    lookback_seconds=DEFAULT_LOOKBACK_SECONDS,
    clock=time.time,
):
    """One row per open `ready-for-human` issue: number, title, and its
    Mattermost ask-thread state. Mattermost config is optional — same
    fail-closed-but-don't-crash posture as ask-human.sh exiting 2 when its
    env is unset: rows still come back from the Forgejo half (independently
    useful — that's the tracker-side half of the parked queue) with state
    'chat-unavailable' instead of the whole screen erroring out."""
    forgejo_token = forgejo_token or os.environ.get("FORGEJO_TOKEN")
    issues = fetch_parked_issues(forgejo_api, forgejo_token, forgejo_fetch)
    rows = [{"number": i["number"], "title": i["title"],
             "labels": [l["name"] for l in (i.get("labels") or [])]}
            for i in issues]

    if not (mattermost_url and mattermost_channel_id and mattermost_token):
        for row in rows:
            row.update({"state": "chat-unavailable", "thread_id": None,
                        "question_ts": None, "reply_preview": None})
        return rows

    cutoff_ms = int((clock() - lookback_seconds) * 1000)
    bot_id = bot_user_id(mattermost_url, mattermost_token, mattermost_fetch)
    channel_posts = fetch_channel_posts(
        mattermost_url, mattermost_channel_id, mattermost_token, mattermost_fetch,
    )

    def fetch_thread_fn(post_id):
        return fetch_thread(mattermost_url, post_id, mattermost_token, mattermost_fetch)

    for row in rows:
        row.update(resolve_thread_state(row["number"], channel_posts, bot_id, fetch_thread_fn, cutoff_ms))
    return rows


def fmt_epoch_ms(value):
    if not value:
        return "-"
    try:
        return time.strftime("%Y-%m-%d %H:%M", time.localtime(int(value) / 1000))
    except (TypeError, ValueError, OSError):
        return "-"
