import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from data import limits  # noqa: E402


def _touch_with_age(path, age_seconds):
    path.write_text("")
    stale_time = time.time() - age_seconds
    os.utime(path, (stale_time, stale_time))


def test_limit_parked_false_when_marker_absent(tmp_path):
    assert limits.limit_parked(str(tmp_path / "no-such-marker")) is False


def test_limit_parked_true_within_ttl(tmp_path):
    marker = tmp_path / "limit"
    _touch_with_age(marker, age_seconds=10)
    assert limits.limit_parked(str(marker), ttl=3600) is True


def test_limit_parked_false_past_ttl(tmp_path):
    marker = tmp_path / "limit"
    _touch_with_age(marker, age_seconds=7200)
    assert limits.limit_parked(str(marker), ttl=3600) is False


def test_active_account_defaults_to_a_when_marker_absent(tmp_path):
    assert limits.active_account(str(tmp_path / "no-such-marker")) == "A"


def test_active_account_b_when_content_b(tmp_path):
    marker = tmp_path / "active"
    marker.write_text("B")
    assert limits.active_account(str(marker)) == "B"


def test_active_account_is_sticky_when_aged(tmp_path):
    """Ben's 2026-08-26 ruling: the account marker has no TTL. An aged B is
    still B — only an explicit failover hands the account back."""
    marker = tmp_path / "active"
    marker.write_text("B")
    aged = time.time() - 90000          # not _touch_with_age: it truncates
    os.utime(marker, (aged, aged))
    assert limits.active_account(str(marker)) == "B"


def test_active_account_a_when_content_is_a(tmp_path):
    marker = tmp_path / "active"
    marker.write_text("A")
    assert limits.active_account(str(marker)) == "A"
