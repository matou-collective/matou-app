"""answer_ask.py — the TUI's answer-parked-ask write action (#618, #617's
own "Suggested next slice": the write side of ask-human.sh's thread
protocol that #614's Inbox tab only reads).

The operator types an answer in the TUI; this posts it into the issue's
current OUTSTANDING ask thread as a reply (ask-human.sh's own protocol
shape a direct Mattermost reply would take), then does synchronously what
resume-parked-asks.sh's sweep does on its own twice-hourly schedule when it
next notices a reply: records the answer as a durable comment on the issue
and re-arms `ready-for-agent` — composing labels.py's `arm` (#615) rather
than inventing a third label-write path — before touching Mattermost at
all, so the load-bearing tracker-side state change lands even if the chat
side is flaky. The reply and the closing `:white_check_mark:` follow, the
checkmark LAST — same invariant resume-parked-asks.sh itself protects ("can
never consume a reply without re-arming its issue"): a crash after the
comment+re-arm but before the checkmark leaves a stale-looking but harmless
open thread (the issue has already left `ready-for-human`, so no sweep or
poller ever looks at it again); a crash before the comment+re-arm leaves
nothing durable recorded, recoverable by answering again from the TUI —
add_label/remove_label are idempotent (labels.py), so a re-attempt is safe.

The reply is posted with the TUI's own Mattermost bot credentials (the only
chat credential this host session holds — there is no separate per-operator
account), so it carries the bot's user_id like every other bot post. That
means it can never be picked up as a "human reply" by ask-human.sh's/
resume-parked-asks.sh's own `first_reply` (which filters `user_id != bot`)
— by design: this module does not lean on that shared detection machinery,
it performs the comment+re-arm those scripts would otherwise wait for.
"""

import json
import urllib.request

from data import labels as labels_mod


def _http_post(url, token, payload):
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Authorization": f"token {token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return resp.status


def _mattermost_post(url, token, payload):
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return resp.status


def post_reply(mattermost_url, channel_id, token, thread_id, answer_text, poster=_mattermost_post):
    """Reply into the ask thread with the operator's answer, attributed to
    the TUI (never mistakable for an organic human reply, see module
    docstring on bot authorship)."""
    return poster(f"{mattermost_url}/api/v4/posts", token, {
        "channel_id": channel_id,
        "message": f"**Answered via the factory TUI:**\n\n{answer_text}",
        "root_id": thread_id,
        "props": {"remove_link_preview": "true"},
    })


def consume_thread(mattermost_url, channel_id, token, thread_id, poster=_mattermost_post):
    """The bot's :white_check_mark: — mirrors resume-parked-asks.sh's own
    consume post, sent last (see module docstring on ordering)."""
    return poster(f"{mattermost_url}/api/v4/posts", token, {
        "channel_id": channel_id,
        "message": (
            ":white_check_mark: Got it — recorded this answer on the issue "
            "and re-armed `ready-for-agent`. The next agent follows it."
        ),
        "root_id": thread_id,
        "props": {"remove_link_preview": "true"},
    })


def record_ruling_comment(number, answer_text, api, token=None, poster=_http_post):
    """The durable record — same wording shape as resume-parked-asks.sh's
    own ruling comment, attributed to the TUI instead of the chat sweep."""
    quoted = "\n".join(f"> {line}" for line in answer_text.splitlines()) or ">"
    body = (
        "**Human ruling — answered via the factory TUI's Inbox tab:**\n\n"
        f"{quoted}\n\n"
        "Re-armed `ready-for-agent`. Next agent: this is the recorded ruling "
        "for the decision the parked run asked about — follow it, do not re-ask."
    )
    return poster(f"{api}/issues/{number}/comments", token, {"body": body})


def answer(
    number, thread_id, answer_text, label_ids,
    api, token=None,
    mattermost_url=None, mattermost_channel_id=None, mattermost_token=None,
    mm_poster=_mattermost_post, fj_poster=_http_post,
    labels_poster=labels_mod._http_post, labels_deleter=labels_mod._http_delete,
):
    """The full write side of answering a parked ask: record, re-arm, reply,
    consume — in that order (see module docstring for why)."""
    record_ruling_comment(number, answer_text, api, token, fj_poster)
    labels_mod.arm(number, label_ids, api=api, token=token, poster=labels_poster, deleter=labels_deleter)
    post_reply(mattermost_url, mattermost_channel_id, mattermost_token, thread_id, answer_text, mm_poster)
    consume_thread(mattermost_url, mattermost_channel_id, mattermost_token, thread_id, mm_poster)
