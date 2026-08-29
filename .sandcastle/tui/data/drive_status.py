"""drive_status.py — read the live rehearsal-drive status record: the
in-flight drive's PID/target/box identity. File ABSENCE is the "no drive
in flight" signal — mirrors the executor's own flock check, so a missing file
is not an error here.

The record is written by a consumer's own rehearsal machinery, not by the
harness, so the factory has NO default path to offer: the file is read at
whatever `DRIVE_STATUS_FILE` the consumer's identity layer declares
(data/identity.py), and a consumer that declares none simply has no drive
panel to show.

Which is also why the box accessors below read TWO key spellings (#53). The
factory calls the machine a drive stands up a **box** (CONTEXT.md) rather than
one provider's product name for one shape — but this record's keys are the
CONSUMER's schema, not ours, and the topology is pull-only (ADR 0001), so a
rename here cannot reach the writer: it would just blank the panel for every
repo already writing the old spelling. The neutral `box_*` is therefore
PREFERRED and the legacy spelling still honoured — additive, never a flag day
(GOTCHAS 20).
"""

import json

# The legacy, provider-shaped key prefix a consumer may still be writing. The
# one place in the harness allowed to name it: read so an existing writer's
# panel keeps working, never written, never offered as the factory's own.
LEGACY_BOX_PREFIX = "droplet_"  # box-vocabulary-waiver (#53)


def box_name(status):
    """The name of the box this drive stood up, or None."""
    return _box_field(status, "name")


def box_ip(status):
    """The IP of the box this drive stood up, or None."""
    return _box_field(status, "ip")


def _box_field(status, field):
    if not status:
        return None
    return (status.get(f"box_{field}")
            or status.get(f"{LEGACY_BOX_PREFIX}{field}")
            or None)


def read_drive_status_at(path):
    """None when no drive is in flight (file absent), no path is configured,
    or the file is unreadable/malformed — best-effort mirror, same posture as
    the writer."""
    if not path:
        return None
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
