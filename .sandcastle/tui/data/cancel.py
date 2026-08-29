"""cancel.py — the TUI's write side of the operator-cancel kill-path (#612,
ADR 0186). The ONLY write action in an otherwise read-only monitor.

Mirrors .sandcastle/cancel-lib.sh's marker-file protocol exactly (same
directory default, same "one file per run_id, content is the reason" shape)
so main.mts's poll and this writer agree without a shared library — Python
and bash can't literally share cancel-lib.sh, so the protocol itself (not
the code) is the contract. If the marker shape ever changes, both sides
change together; tests/test_cancel.py and .sandcastle/tests/cancel-lib-test.sh
pin it from either end.
"""

import os


def request_cancel(run_id, reason="", cancel_dir_path=None):
    """Write the marker main.mts polls for. Idempotent — a second request
    just overwrites the reason, matching cancel-lib.sh's swarm_cancel_request.
    `cancel_dir_path` is cancel-lib.sh's own $SWARM_CANCEL_DIR, resolved by
    data/identity.py — this module never guesses a host path."""
    if not cancel_dir_path:
        raise ValueError("request_cancel: no cancel dir — the identity layer resolved none")
    os.makedirs(cancel_dir_path, exist_ok=True)
    with open(os.path.join(cancel_dir_path, run_id), "w") as f:
        f.write(reason or "")
