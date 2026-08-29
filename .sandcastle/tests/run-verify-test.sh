#!/usr/bin/env bash
# Offline test for run-verify.sh (#228): the verify poller ran entirely inline
# in verify.yml and wrote NO verdict, so the healer degraded EVERY red verify to
# the bare `verify|` signature (worker-logs.txt is always empty for a poller).
# run-verify.sh now drops a stage/exit/error verdict in the exact format
# verdict-lib.sh's other callers use, so the healer keys the incident signature
# on the real failing stage — and two failures with different causes yield two
# different signatures. No network: git sync points at a local fixture repo;
# check-verifications is pushed to fail against an unreachable Mattermost.
# Run: bash .sandcastle/tests/run-verify-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sc="$here/.."
fail() { echo "FAIL: $1" >&2; exit 1; }
. "$sc/heal-lib.sh"   # compute_signature, seam_verdict_signal

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT

# A real origin with a "main" branch, and a checked-out workdir — exactly what a
# previously-successful swarm/triage/verify run leaves behind for the next run.
origin="$work/origin.git"
git init -q --bare "$origin"
seed="$work/seed"
git init -q "$seed"
git -C "$seed" config user.email t@example.com
git -C "$seed" config user.name t
echo hi > "$seed/f"; git -C "$seed" add f; git -C "$seed" commit -qm seed
git -C "$seed" branch -M main
git -C "$seed" remote add origin "$origin"
git -C "$seed" push -q origin main
git -C "$origin" symbolic-ref HEAD refs/heads/main

workdir="$work/workdir"
git clone -q "$origin" "$workdir"

verdict="$work/verdict.txt"
run_verify() { # run_verify <git-remote-url> <mattermost-url>
  ( cd "$workdir" && \
    REPO_SLUG="x/y" FORGEJO_TOKEN=dummy \
    FORGEJO_API="https://example.invalid/api/v1/repos/x/y" \
    SERVER_URL="https://example.invalid" \
    MATTERMOST_URL="$2" MATTERMOST_BOT_TOKEN=x MATTERMOST_CHANNEL_ID=c \
    VERIFY_VERDICT_PATH="$verdict" GIT_VERIFY_REMOTE_URL="$1" \
    bash "$sc/run-verify.sh" )
}

# --- 1) a clean run leaves no verdict, and clears a stale one -----------------
# MATTERMOST_URL empty → check-verifications logs "cannot poll" and exits 0
# BEFORE any network, so the whole run is green offline.
printf 'stage=stale from a previous incident\nexit=1\n--- error lines ---\nold\n' > "$verdict"
if ! run_verify "$origin" "" >/dev/null 2>&1; then fail "a healthy poll must exit 0"; fi
[ -f "$verdict" ] && fail "a clean verify run must leave no verdict (verdict_write's contract)"

# --- 2) a git-sync failure (bad remote) writes a git-sync verdict ------------
rm -f "$verdict"
nope="$work/nonexistent/origin.git"
if run_verify "$nope" "" >/dev/null 2>&1; then fail "a nonexistent remote must fail"; fi
[ -f "$verdict" ] || fail "a git-sync failure must write a verdict"
grep -q "^stage=git sync" "$verdict" || fail "verdict must name the git-sync stage, got: $(cat "$verdict")"
grep -q "^exit=[1-9]" "$verdict" || fail "verdict must carry a non-zero exit code, got: $(cat "$verdict")"
sig_gitsync="$(compute_signature verify "$(seam_verdict_signal "$verdict")")"

# --- 3) a check-verifications failure writes a DIFFERENT-stage verdict --------
# git sync succeeds (real fixture) but Mattermost is unreachable, so
# check-verifications fails — a distinct cause from the git-sync fault above.
rm -f "$verdict"
if run_verify "$origin" "http://127.0.0.1:1" >/dev/null 2>&1; then fail "an unreachable Mattermost must fail check-verifications"; fi
[ -f "$verdict" ] || fail "a check-verifications failure must write a verdict"
grep -q "^stage=check-verifications" "$verdict" || fail "verdict must name the check-verifications stage, got: $(cat "$verdict")"
sig_checkverif="$(compute_signature verify "$(seam_verdict_signal "$verdict")")"

[ "$sig_gitsync" != "$sig_checkverif" ] || fail "two distinct verify faults (git-sync vs check-verifications) must yield DIFFERENT signatures — the whole point of #228"

echo "run-verify: 3 scenarios passed"
