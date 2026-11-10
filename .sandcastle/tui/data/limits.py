"""limits.py — read the host-global Claude limit/active-account markers
(limit-lib.sh). Read-only mirror of that lib's logic: the LIMIT marker is a
freshness question (TTL default 3600s, matching run-swarm.sh's notice-dedupe
window); the ACTIVE-ACCOUNT marker is sticky and has no TTL at all.

The marker paths are limit-lib.sh's own and are passed in (data/identity.py
sources them from that lib) — never re-declared here, where they could drift
from the lib that writes them.
"""

import glob
import os
import time

DEFAULT_TTL = 3600


def _fresh(path, ttl):
    if not path:
        return False
    try:
        return (time.time() - os.stat(path).st_mtime) <= ttl
    except OSError:
        return False


def limit_parked(marker, ttl=DEFAULT_TTL):
    """True iff the host is known-parked on a Claude subscription limit.

    The limit marker is keyed by the account fingerprint since #200
    (`<marker>-<fp>`), so a host may have one window open per account. The host
    is parked iff the bare base marker OR any fingerprinted sibling is fresh —
    the bare path still counts so a fingerprint-less host (pre-#200, or no token)
    reads exactly as before."""
    if not marker:
        return False
    candidates = [marker] + glob.glob(glob.escape(marker) + "-*")
    return any(_fresh(p, ttl) for p in candidates)


def active_account(marker):
    """'A' or 'B' — mirrors claude_active_account, which is STICKY (Ben's
    ruling 2026-08-26): the marker's letter stands until an explicit failover
    rewrites it, with no freshness decay. Only limit_parked above is still a
    TTL question — "parked now" is a live window; "which account" is not."""
    try:
        with open(marker) as f:
            return "B" if f.read().strip() == "B" else "A"
    except (OSError, TypeError):
        return "A"
