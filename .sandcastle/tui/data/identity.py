"""identity.py — the TUI's single seam onto the consumer's identity layer.

The factory core carries no repo names, hosts or product paths (CLAUDE.md's
blast-radius rule), and this TUI is vendored into every consumer — so no
module under tui/ may declare a default for a per-repo or per-host value.
They are all resolved HERE, once, at start-up, and injected into the data
readers as plain arguments.

Resolution is deliberately not a Python re-derivation of the harness's own
defaults: the sibling shell files that OWN each value are sourced and asked
for it, so the TUI cannot drift from the scripts it is monitoring.

    swarm-identity.sh   FORGEJO_API, REPO_SLUG, HEAL_WORKDIR, RUNNER_HOST
                        (and DRIVE_STATUS_FILE where a consumer declares one)
    limit-lib.sh        CLAUDE_LIMIT_MARKER, CLAUDE_ACTIVE_MARKER
    cancel-lib.sh       SWARM_CANCEL_DIR
    swarm-db-lib.sh     SWARM_DB

Each of those is a `${VAR:-default}` assignment, so the process environment
keeps its usual precedence for free — exporting CLAUDE_LIMIT_MARKER before
starting the TUI moves the TUI's marker exactly as it moves the harness's.
Two values have no shell owner to ask and are mirrored here with the source
named beside them: HEALER_STATE (heal.sh, which is an entry point and must
never be sourced) and the Mattermost secret file (ask-human.sh).

Anything a consumer has not declared resolves to None rather than to a
guess, and the screens that need it say so — a monitor that invents a path
would show a confidently empty panel instead of an honest gap.
"""

import os
import subprocess

# The harness dir is the directory this tui/ sits in: a consumer's
# .sandcastle/, or the factory's own root when run from a checkout of it.
_HERE = os.path.dirname(os.path.abspath(__file__))
TUI_DIR = os.path.dirname(_HERE)

# ask-human.sh's own env-then-bind-mount fallback for the chat credential.
DEFAULT_MATTERMOST_TOKEN_FILE = "/run/secrets/mattermost_bot_token"

# The workflow claim-lib.sh's rearm_dispatch re-arms. A harness constant (the
# onboarding templates render it), not a per-repo value — overridable anyway.
DEFAULT_SWARM_WORKFLOW = "swarm.yml"

WORKER_CLASSES_OVERLAY_NAME = "worker-classes.local.json"

# Sourced in this order; a later file may reference an earlier one's values.
_SOURCES = ("swarm-identity.sh", "limit-lib.sh", "cancel-lib.sh", "swarm-db-lib.sh")

_KEYS = (
    "FORGEJO_API", "REPO_SLUG", "HEAL_WORKDIR", "RUNNER_HOST", "DRIVE_STATUS_FILE",
    "CLAUDE_LIMIT_MARKER", "CLAUDE_ACTIVE_MARKER", "SWARM_CANCEL_DIR", "SWARM_DB",
)


class Identity:
    """One resolved snapshot. Plain attributes — tests construct it directly
    rather than shelling out."""

    __slots__ = (
        "harness_dir", "forgejo_api", "repo_slug", "heal_workdir", "runner_host",
        "healer_state", "limit_marker", "active_marker", "cancel_dir", "swarm_db",
        "drive_status_file", "swarm_workflow", "worker_classes_overlay",
        "mattermost_url", "mattermost_channel_id", "mattermost_token",
    )

    def __init__(
        self, harness_dir=None, forgejo_api=None, repo_slug=None, heal_workdir=None,
        runner_host=None, healer_state=None, limit_marker=None, active_marker=None,
        cancel_dir=None, swarm_db=None, drive_status_file=None,
        swarm_workflow=DEFAULT_SWARM_WORKFLOW, worker_classes_overlay=None,
        mattermost_url=None, mattermost_channel_id=None, mattermost_token=None,
    ):
        self.harness_dir = harness_dir
        self.forgejo_api = forgejo_api
        self.repo_slug = repo_slug
        self.heal_workdir = heal_workdir
        self.runner_host = runner_host
        self.healer_state = healer_state
        self.limit_marker = limit_marker
        self.active_marker = active_marker
        self.cancel_dir = cancel_dir
        self.swarm_db = swarm_db
        self.drive_status_file = drive_status_file
        self.swarm_workflow = swarm_workflow
        self.worker_classes_overlay = worker_classes_overlay
        self.mattermost_url = mattermost_url
        self.mattermost_channel_id = mattermost_channel_id
        self.mattermost_token = mattermost_token

    @property
    def configured(self):
        """Whether an identity layer was found at all — the Monitor's title
        line and every network tab key their "not configured" message off
        this rather than guessing why a value is missing."""
        return bool(self.forgejo_api)

    @property
    def chat_configured(self):
        return bool(self.mattermost_url and self.mattermost_channel_id and self.mattermost_token)


def default_harness_dir():
    return os.path.dirname(TUI_DIR)


def _shell_values(harness_dir, env):
    """Source whichever of the harness files exist and report the resolved
    values. A missing bash, a missing dir, or a lib that refuses to source
    yields {} — the TUI degrades to "not configured", it never crashes on a
    half-installed checkout."""
    harness_dir = os.path.abspath(harness_dir)
    script = ['cd -- "$1" 2>/dev/null || exit 0']
    for name in _SOURCES:
        script.append(f'[ -f "$1/{name}" ] && . "$1/{name}"')
    for key in _KEYS:
        script.append(f'printf "{key}=%s\\0" "${{{key}-}}"')
    # The child runs with EXACTLY the caller's env (plus a PATH to find bash
    # itself), so an offline test can prove the resolution without a host
    # value leaking in through inheritance.
    run_env = dict(env)
    run_env.setdefault("PATH", os.environ.get("PATH", "/usr/bin:/bin"))
    try:
        proc = subprocess.run(
            ["bash", "-c", "\n".join(script), "_", harness_dir],
            capture_output=True, text=True, timeout=15, env=run_env,
        )
    except (OSError, subprocess.SubprocessError):
        return {}
    values = {}
    for field in proc.stdout.split("\0"):
        key, sep, value = field.partition("=")
        if sep and key in _KEYS and value != "":
            values[key] = value
    return values


def load(harness_dir=None, env=None, token_file=DEFAULT_MATTERMOST_TOKEN_FILE, shell=_shell_values):
    """Resolve the whole layer. `env` is the process environment by default;
    tests pass an explicit dict so no host value can leak into an offline
    run."""
    env = os.environ if env is None else env
    harness_dir = harness_dir or default_harness_dir()
    values = shell(harness_dir, env)

    def val(key):
        return env.get(key) or values.get(key) or None

    heal_workdir = val("HEAL_WORKDIR")
    healer_state = env.get("HEALER_STATE") or None
    if healer_state is None and heal_workdir:
        # heal.sh: HEALER_STATE="${HEALER_STATE:-$WORKDIR/.sandcastle/.state/healer}"
        healer_state = os.path.join(heal_workdir, ".sandcastle", ".state", "healer")

    overlay = env.get("WORKER_CLASSES_OVERLAY") or os.path.join(
        harness_dir, WORKER_CLASSES_OVERLAY_NAME)
    if not os.path.isfile(overlay):
        overlay = None

    return Identity(
        harness_dir=harness_dir,
        forgejo_api=val("FORGEJO_API"),
        repo_slug=val("REPO_SLUG"),
        heal_workdir=heal_workdir,
        runner_host=val("RUNNER_HOST"),
        healer_state=healer_state,
        limit_marker=val("CLAUDE_LIMIT_MARKER"),
        active_marker=val("CLAUDE_ACTIVE_MARKER"),
        cancel_dir=val("SWARM_CANCEL_DIR"),
        swarm_db=val("SWARM_DB"),
        drive_status_file=val("DRIVE_STATUS_FILE"),
        swarm_workflow=env.get("SWARM_WORKFLOW_FILE") or DEFAULT_SWARM_WORKFLOW,
        worker_classes_overlay=overlay,
        mattermost_url=env.get("MATTERMOST_URL") or None,
        mattermost_channel_id=env.get("MATTERMOST_CHANNEL_ID") or None,
        mattermost_token=mattermost_token(env, token_file),
    )


def mattermost_token(env=None, token_file=DEFAULT_MATTERMOST_TOKEN_FILE):
    """MATTERMOST_BOT_TOKEN, falling back to the bind-mounted secrets file —
    mirrors ask-human.sh's own env-then-file fallback exactly."""
    env = os.environ if env is None else env
    token = env.get("MATTERMOST_BOT_TOKEN")
    if token:
        return token
    try:
        with open(token_file) as f:
            return f.read().strip() or None
    except OSError:
        return None
