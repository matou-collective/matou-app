#!/usr/bin/env bash
# Offline tests for env-allowlist-lib.sh (#593, part 1 of #592): the preflight
# guard that refuses a host-mode .sandcastle/.env carrying a stray
# *TOKEN|SECRET|KEY|PASS-shaped key. Sandcastle forwards every .env key into
# the sandbox as a `docker run -e` value — which lands in `docker inspect
# .Config.Env`, readable by anyone with Docker API access (the 2026-07-11
# breach vector, the #578 leak class). Run:
#   bash .sandcastle/tests/env-allowlist-lib-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/../env-allowlist-lib.sh"

fail() { echo "FAIL: $1" >&2; exit 1; }
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
pass=0

# --- a clean, allowlist-only .env (mirrors .env.example) must pass with NO
#     violations, including the two allowlisted keys that themselves LOOK
#     secret-shaped (CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY-style). ---
cat > "$tmp/clean.env" <<'EOF'
CLAUDE_CODE_OAUTH_TOKEN=sk-test-not-real
FORGEJO_API=https://example.invalid/api/v1/repos/Matou/idss
MATTERMOST_URL=https://mattermost.example
MATTERMOST_CHANNEL_ID=abc123
BASH_DEFAULT_TIMEOUT_MS=1500000
BASH_MAX_TIMEOUT_MS=1800000
REHEARSAL_DRIVE_ISSUE=523
REHEARSAL_DRIVE_TARGET=selfhosted
SWARM_HOST=
SWARM_RUN_ID=
EOF
out="$(env_allowlist_violations "$tmp/clean.env")"
[ -z "$out" ] || fail "a clean allowlist-only .env was flagged: $out"
pass=$((pass+1))

# --- the ANTHROPIC_API_KEY alternative from .env.example's commented-out
#     line must also be allowed once uncommented. ---
cat > "$tmp/apikey.env" <<'EOF'
ANTHROPIC_API_KEY=sk-ant-test-not-real
FORGEJO_API=
EOF
out="$(env_allowlist_violations "$tmp/apikey.env")"
[ -z "$out" ] || fail "ANTHROPIC_API_KEY (an allowlisted key) was flagged: $out"
pass=$((pass+1))

# --- a stray secret-shaped key must be refused (the ticket's worked example). ---
cat > "$tmp/stray.env" <<'EOF'
CLAUDE_CODE_OAUTH_TOKEN=sk-test-not-real
FORGEJO_API=
FOO_TOKEN=leaked-value
EOF
out="$(env_allowlist_violations "$tmp/stray.env")"
[ "$out" = "FOO_TOKEN" ] || fail "a stray FOO_TOKEN did not trip the guard (got: '$out')"
pass=$((pass+1))

# --- every *TOKEN|SECRET|KEY|PASS shape is caught, not just *_TOKEN. ---
cat > "$tmp/shapes.env" <<'EOF'
MY_SECRET=x
DB_PASS=x
SOME_KEY=x
EOF
out="$(env_allowlist_violations "$tmp/shapes.env" | sort | tr '\n' ' ')"
[ "$out" = "DB_PASS MY_SECRET SOME_KEY " ] || fail "not all secret shapes were caught: got '$out'"
pass=$((pass+1))

# --- a non-secret-shaped stray key (not on the allowlist, not secret-shaped)
#     is out of scope for THIS guard — it doesn't leak a credential, so it
#     must not be flagged (keeps the guard from becoming a whack-a-mole on
#     every unrelated new config key). ---
cat > "$tmp/benign.env" <<'EOF'
FORGEJO_API=
SOME_NEW_FLAG=1
EOF
out="$(env_allowlist_violations "$tmp/benign.env")"
[ -z "$out" ] || fail "a benign non-secret-shaped stray key was wrongly flagged: $out"
pass=$((pass+1))

# --- comments, blank lines, and `export KEY=` forms are handled. ---
cat > "$tmp/formats.env" <<'EOF'
# a comment
export CLAUDE_CODE_OAUTH_TOKEN=sk-test

FORGEJO_API=
export STRAY_SECRET=leak
EOF
out="$(env_allowlist_violations "$tmp/formats.env")"
[ "$out" = "STRAY_SECRET" ] || fail "comment/blank/export handling broke the parse (got: '$out')"
pass=$((pass+1))

# --- a missing file is not an error (run-swarm.sh's own logic already
#     branches on file-existence before ever calling this). ---
out="$(env_allowlist_violations "$tmp/does-not-exist.env")"
[ -z "$out" ] || fail "a missing file should produce no violations, got: $out"
pass=$((pass+1))

# --- REHEARSAL_* is an open-ended documented prefix (.env.example's
#     REHEARSAL_DRIVE_ISSUE/_TARGET today) — a future REHEARSAL_* key must
#     not need a code change to stay allowed. None of today's REHEARSAL_*
#     names are secret-shaped, so this only matters if one ever is; prove the
#     prefix itself is trusted rather than requiring exact-name enumeration. ---
cat > "$tmp/rehearsal.env" <<'EOF'
REHEARSAL_DRIVE_ISSUE=523
REHEARSAL_SOME_FUTURE_FLAG=x
EOF
out="$(env_allowlist_violations "$tmp/rehearsal.env")"
[ -z "$out" ] || fail "a REHEARSAL_*-prefixed key was flagged: $out"
pass=$((pass+1))

echo "env-allowlist-lib: $pass scenarios passed"
