"""Every per-repo/per-host value the TUI reads is resolved here, from the
consumer's identity layer and the harness libs that own each default — so
these tests build a FAKE harness directory (real bash, fake files) and assert
the resolution, never a value baked into the TUI.
"""

import os

from data import identity


def _write(path, text):
    path.write_text(text)
    return str(path)


def _harness(tmp_path, identity_sh=None, libs=True):
    """A minimal stand-in for a consumer's .sandcastle/ — the identity file
    plus the three libs that own the host-state defaults."""
    if identity_sh is None:
        identity_sh = (
            ': "${FORGEJO_API:=https://forge.example.invalid/api/v1/repos/Owner/repo}"\n'
            ': "${REPO_SLUG:=Owner/repo}"\n'
            ': "${HEAL_WORKDIR:=/srv/checkouts/repo}"\n'
            ': "${RUNNER_HOST:=host-a}"\n'
        )
    _write(tmp_path / "swarm-identity.sh", identity_sh)
    if libs:
        _write(tmp_path / "limit-lib.sh",
               'CLAUDE_LIMIT_MARKER="${CLAUDE_LIMIT_MARKER:-/tmp/fake-claude-limit}"\n'
               'CLAUDE_ACTIVE_MARKER="${CLAUDE_ACTIVE_MARKER:-/tmp/fake-claude-active}"\n')
        _write(tmp_path / "cancel-lib.sh",
               'SWARM_CANCEL_DIR="${SWARM_CANCEL_DIR:-$HOME/fake/cancel-request}"\n')
        _write(tmp_path / "swarm-db-lib.sh",
               ': "${SWARM_DB:=$HOME/fake/swarm.db}"\n')
    return str(tmp_path)


def test_values_come_from_the_identity_file_and_libs(tmp_path):
    ident = identity.load(harness_dir=_harness(tmp_path), env={"HOME": "/home/someone"})
    assert ident.forgejo_api == "https://forge.example.invalid/api/v1/repos/Owner/repo"
    assert ident.repo_slug == "Owner/repo"
    assert ident.runner_host == "host-a"
    assert ident.limit_marker == "/tmp/fake-claude-limit"
    assert ident.active_marker == "/tmp/fake-claude-active"
    assert ident.cancel_dir == "/home/someone/fake/cancel-request"
    assert ident.swarm_db == "/home/someone/fake/swarm.db"


def test_healer_state_derives_from_the_repo_checkout(tmp_path):
    # Mirrors heal.sh's own HEALER_STATE default off HEAL_WORKDIR.
    ident = identity.load(harness_dir=_harness(tmp_path), env={})
    assert ident.healer_state == "/srv/checkouts/repo/.sandcastle/.state/healer"


def test_environment_overrides_every_resolved_value(tmp_path):
    env = {
        "FORGEJO_API": "https://other.example.invalid/api/v1/repos/Other/thing",
        "HEALER_STATE": "/var/state/healer",
        "CLAUDE_LIMIT_MARKER": "/tmp/other-limit",
        "SWARM_DB": "/var/state/swarm.db",
    }
    ident = identity.load(harness_dir=_harness(tmp_path), env=env)
    assert ident.forgejo_api == "https://other.example.invalid/api/v1/repos/Other/thing"
    assert ident.healer_state == "/var/state/healer"
    assert ident.limit_marker == "/tmp/other-limit"
    assert ident.swarm_db == "/var/state/swarm.db"


def test_drive_status_file_is_absent_unless_the_identity_layer_declares_it(tmp_path):
    # The drive-status record is written by a consumer's own rehearsal
    # machinery, not by the harness — the factory has no default to offer.
    assert identity.load(harness_dir=_harness(tmp_path), env={}).drive_status_file is None
    declared = _harness(
        tmp_path,
        identity_sh=': "${FORGEJO_API:=https://forge.example.invalid/api/v1/repos/Owner/repo}"\n'
                    ': "${DRIVE_STATUS_FILE:=/tmp/fake-drive-status.json}"\n',
    )
    assert identity.load(harness_dir=declared, env={}).drive_status_file == "/tmp/fake-drive-status.json"


def test_swarm_workflow_defaults_to_the_harness_workflow_file(tmp_path):
    assert identity.load(harness_dir=_harness(tmp_path), env={}).swarm_workflow == "swarm.yml"
    assert identity.load(
        harness_dir=_harness(tmp_path), env={"SWARM_WORKFLOW_FILE": "other.yml"},
    ).swarm_workflow == "other.yml"


def test_worker_classes_overlay_is_found_beside_the_identity_file(tmp_path):
    harness = _harness(tmp_path)
    assert identity.load(harness_dir=harness, env={}).worker_classes_overlay is None
    overlay = _write(tmp_path / "worker-classes.local.json", "{}")
    assert identity.load(harness_dir=harness, env={}).worker_classes_overlay == overlay


def test_chat_config_comes_from_the_environment_and_the_mounted_secret(tmp_path):
    env = {"MATTERMOST_URL": "https://chat.example.invalid", "MATTERMOST_CHANNEL_ID": "chan1",
           "MATTERMOST_BOT_TOKEN": "tok"}
    ident = identity.load(harness_dir=_harness(tmp_path), env=env)
    assert (ident.mattermost_url, ident.mattermost_channel_id, ident.mattermost_token) == (
        "https://chat.example.invalid", "chan1", "tok")

    secret = _write(tmp_path / "bot-token", "from-file\n")
    ident = identity.load(harness_dir=_harness(tmp_path), env={}, token_file=secret)
    assert ident.mattermost_token == "from-file"
    assert ident.mattermost_url is None


def test_a_missing_identity_layer_degrades_to_unset_not_a_crash(tmp_path):
    empty = str(tmp_path / "nothing")
    ident = identity.load(harness_dir=empty, env={})
    assert ident.forgejo_api is None
    assert ident.healer_state is None
    assert ident.swarm_db is None
    assert ident.configured is False


def test_this_repos_own_layer_resolves(tmp_path):
    """Fidelity against the real sibling identity file — the same posture the
    swarm.db tests take by shelling the real swarm-db.py. Asserts SHAPE, never
    a repo's literal values (no product string may live under tui/)."""
    ident = identity.load(env={})
    assert ident.configured is True
    assert ident.forgejo_api.startswith("https://")
    assert "/api/v1/repos/" in ident.forgejo_api
    assert ident.repo_slug.count("/") == 1
    assert ident.healer_state.endswith(os.path.join(".state", "healer"))
    assert ident.limit_marker.startswith("/tmp/")
    assert ident.swarm_db.endswith(".db")
