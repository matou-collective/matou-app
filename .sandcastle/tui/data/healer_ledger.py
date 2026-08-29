"""healer_ledger.py — read the healer's incident ledger (heal-lib.sh's
ledger_get/ledger_set/ledger_decide) for the factory TUI's Incidents screen.

Read-only mirror: one file per incident signature under $HEALER_STATE,
key=value lines. heal.sh writes workflow/first_seen/last_seen/attempts/
replies/escalated/repaired/thread_id (source-verified against heal.sh's own
ledger_set call sites, not copied from heal-lib.sh's key-list comment, which
lists only workflow/first_seen/last_seen/attempts/repaired/thread_id and
omits replies/escalated).

The ledger directory is heal.sh's own $HEALER_STATE, resolved by
data/identity.py off the consumer's HEAL_WORKDIR and passed in — no checkout
path is guessed here.

A signature is compute_signature's 12-char lowercase-hex sha1 prefix
(heal-lib.sh) — the filename filter below is load-bearing: a real
$HEALER_STATE directory on a live host also holds a `retired/` subdirectory
(manual triage moves incidents there; no script does it) and loose
`<sig>.chanmove-bak` files (host cruft from an ad-hoc migration, not written
by any committed script) that must never be mistaken for live incidents.
"""

import os
import re
import time

_SIGNATURE_RE = re.compile(r"^[0-9a-f]{12}$")


def _parse_ledger_file(path):
    fields = {}
    try:
        with open(path) as f:
            for line in f:
                line = line.rstrip("\n")
                if "=" not in line:
                    continue
                key, _, value = line.partition("=")
                fields[key] = value
    except OSError:
        return {}
    return fields


def load_incidents(healer_state):
    """One dict per incident signature, unsorted. [] when the directory is
    absent or unreadable — best-effort mirror, same posture as the other
    data/ readers (a missing healer state dir must never crash the TUI)."""
    try:
        names = os.listdir(healer_state or "")
    except OSError:
        return []
    incidents = []
    for name in sorted(names):
        if not _SIGNATURE_RE.match(name):
            continue
        path = os.path.join(healer_state, name)
        if not os.path.isfile(path):
            continue
        fields = _parse_ledger_file(path)
        if not fields:
            continue
        incidents.append({
            "signature": name,
            "workflow": fields.get("workflow") or "-",
            "first_seen": fields.get("first_seen"),
            "last_seen": fields.get("last_seen"),
            "attempts": fields.get("attempts") or "0",
            "replies": fields.get("replies") or "0",
            "repaired": fields.get("repaired") == "1",
            "escalated": fields.get("escalated") == "1",
            "thread_id": fields.get("thread_id") or "-",
        })
    return incidents


def _sort_key(incident):
    try:
        return int(incident["last_seen"])
    except (TypeError, ValueError):
        return -1


def incident_rows(incidents):
    """Newest last_seen first — mirrors the Monitor tab's own "recent
    first" convention."""
    return sorted(incidents, key=_sort_key, reverse=True)


def fmt_epoch(value):
    if not value:
        return "-"
    try:
        return time.strftime("%Y-%m-%d %H:%M", time.localtime(int(value)))
    except (TypeError, ValueError, OSError):
        return "-"
