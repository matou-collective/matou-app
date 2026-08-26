#!/usr/bin/env bash
# Offline seam test for run-swarm.sh's limit-park gate (#103). A host whose
# Claude limit marker is FRESH must exit 0 BEFORE any tracker read or write —
# no ready-list GET, no `agent-working` POST/DELETE — while still leaving a
# `claude-limit-parked` row in the runlog (the trap is armed by then). A STALE
# marker (mtime older than CLAUDE_LIMIT_TTL) must NOT gate: the run proceeds so
# execute-lib's claude_limit_sweep can stamp the unpark edge and retry.
#
# Why it matters: before the gate a parked run still claimed and released every
# ready ticket, and each label toggle was an `issues` event that queued another
# swarm run under the per-repo concurrency group — 2,700 waiting no-op runs
# across four repos on 2026-08-26. Sibling of run-swarm-drive-yield-test.sh.
# Run: bash .sandcastle/tests/run-swarm-limit-park-gate-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
# shellcheck source=test-env.sh
. "$here/test-env.sh"; test_env_hermetic "$tmp"

# A curl that logs every call — the parked path must touch NOTHING.
cat > "$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
echo "$*" >> "${CURL_LOG:?}"
echo '[]'
SH
chmod +x "$tmp/bin/curl"

marker="$tmp/claude-limit"
curl_log="$tmp/curl.log"

run_swarm() {
  env -u MATTERMOST_URL -u MATTERMOST_BOT_TOKEN -u MATTERMOST_CHANNEL_ID \
    -u GITHUB_ACTIONS \
    PATH="$tmp/bin:$PATH" \
    FORGEJO_TOKEN=dummy FORGEJO_API=http://x/api/v1/repos/x/y \
    REPO_SLUG=Acme/widget SWARM_HOST=box1 \
    HOST_CAPACITY_DRIVE_WANTED="$tmp/no-drive" \
    SWARM_DRIVE_DEFER_COUNT="$tmp/swarm-defer-count" \
    CLAUDE_LIMIT_MARKER="$marker" CLAUDE_LIMIT_TTL=3600 \
    CURL_LOG="$curl_log" \
    "$@" bash "$here/../run-swarm.sh"
}

# --- 1. a FRESH marker: exit 0, no API call at all, runlog says parked. ---
: > "$curl_log"; echo "account=A" > "$marker"
out="$(run_swarm 2>&1)" || fail "a parked host must exit 0 (got: $out)"
grep -q "host parked" <<<"$out" || fail "the gate must say the host is parked (got: $out)"
grep -q "no list, no claim" <<<"$out" || fail "the gate must say it touches nothing (got: $out)"
[ -s "$curl_log" ] && fail "a parked run must make NO tracker call — not even the ready list (curl log: $(cat "$curl_log"))"
grep -q "reason=claude-limit-parked" "$SWARM_RUNLOG" || fail "the runlog must record claude-limit-parked (got: $(cat "$SWARM_RUNLOG" 2>/dev/null))"
pass=$((pass+1))

# --- 2. a STALE marker does NOT gate: the run goes on to list ready tasks
#        (the curl log fills) and dies downstream on this offline box. ---
: > "$curl_log"; : > "$SWARM_RUNLOG"; touch -d '2 hours ago' "$marker"
out2="$(run_swarm 2>&1 || true)"
grep -q "host parked" <<<"$out2" && fail "a stale marker must not gate (got: $out2)"
grep -q "reason=claude-limit-parked" "$SWARM_RUNLOG" && fail "a stale marker must not be recorded as a park (got: $(cat "$SWARM_RUNLOG"))"
pass=$((pass+1))

# --- 3. no marker at all: same as stale — never gated. ---
: > "$curl_log"; : > "$SWARM_RUNLOG"; rm -f "$marker"
out3="$(run_swarm 2>&1 || true)"
grep -q "host parked" <<<"$out3" && fail "no marker must not gate (got: $out3)"
pass=$((pass+1))

echo "run-swarm-limit-park-gate: $pass passed"
