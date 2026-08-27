"""worker_classes.py — read the worker-class inventory for the factory TUI's
Fleet screen.

Two layers, never one:

  * `worker-classes.json`, VENDORED beside this reader — the classes the
    harness itself ships (the swarm worker, triage, the healer, the
    session-runner, …). Factory data: it describes code that lives in this
    repo, so it travels with it and every consumer gets the same table.

  * an optional per-repo overlay (`worker-classes.local.json` in the
    consumer's identity layer, resolved by data/identity.py) — where a
    consumer declares the classes only IT runs, and WHICH HOSTS run any of
    them. Host names and product-specific workers are per-deployment facts
    and must never be written into a vendored file.

Overlay entries are merged by `id`: a new id is appended, a known id has its
named fields overridden field-by-field (so declaring `hosts` for the healer
leaves the rest of that class's description alone).

Read-only: this module never writes either file, and the Fleet screen must
never fork a second copy of the same facts.
"""

import json
import os

_TUI_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

BUNDLED_WORKER_CLASSES = os.path.join(_TUI_DIR, "worker-classes.json")


def _load_json(path):
    """{} when the file is absent or malformed — best-effort mirror, same
    posture as the other data/ readers (a missing/broken doc must never crash
    the TUI)."""
    if not path:
        return {}
    try:
        with open(path) as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def load_worker_classes(path=BUNDLED_WORKER_CLASSES):
    return _load_json(path).get("classes", [])


def load_overlay(path):
    """The consumer's own classes/host declarations, or [] when it declares
    none (the common case — a repo that just runs the standard harness)."""
    return _load_json(path).get("classes", [])


def merge_classes(classes, overlay):
    """Overlay by `id`: known id -> field-wise override, new id -> appended
    at the end, in the overlay's own order."""
    merged = [dict(c) for c in classes]
    index = {c.get("id"): c for c in merged}
    for entry in overlay:
        known = index.get(entry.get("id"))
        if known is None:
            merged.append(dict(entry))
            index[entry.get("id")] = merged[-1]
        else:
            known.update(entry)
    return merged


def fleet_rows(classes):
    """One row per (host, worker class) pair. A class whose hosts nothing has
    declared still gets one row with host "-" so it is never silently dropped
    from the fleet view — an undeclared host is a gap to see, not to hide."""
    rows = []
    for cls in classes:
        hosts = cls.get("hosts") or ["-"]
        for host in hosts:
            rows.append({
                "host": host,
                "id": cls["id"],
                "name": cls["name"],
                "trigger": cls.get("trigger") or "-",
                "lock": cls.get("lock") or "none",
                "invisible_failure": bool(cls.get("invisible_failure")),
                "stuck_signal": cls.get("stuck_signal") or "-",
            })
    return rows
