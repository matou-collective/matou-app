#!/usr/bin/env bash
# Offline test for claude-fence (#198) — the `claude` shim installed FIRST on
# PATH in the worker sandbox image. It delivers the Claude OAuth token from a
# read-only mounted secret FILE (main.mts mounts .sandcastle/secrets at
# /run/secrets) instead of a `docker run -e` CLAUDE_CODE_OAUTH_TOKEN that lands
# in `docker inspect .Config.Env` (the 2026-07-11 breach vector). It execs the
# real CLI transparently with every arg, the token in the child env only.
#
# Shimmed throughout — no real `claude`, no mount, no network: CLAUDE_FENCE_REAL
# points at a stub that prints the token it ran with plus its argv, and
# CLAUDE_FENCE_SECRET at a per-test file.
#
# Run: bash .sandcastle/tests/claude-fence-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fence="$here/../claude-fence"

fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

# The stub stands in for the real CLI: it records the token it saw and echoes
# its argv verbatim, so a test can assert BOTH where the token came from and
# that every argument passed through untouched.
cat > "$tmp/claude-real" <<'SH'
#!/usr/bin/env bash
printf 'TOKEN=%s\n' "${CLAUDE_CODE_OAUTH_TOKEN:-<unset>}"
printf 'ARGV=%s\n' "$*"
SH
chmod +x "$tmp/claude-real"
export CLAUDE_FENCE_REAL="$tmp/claude-real"

secret="$tmp/claude_oauth_token"
export CLAUDE_FENCE_SECRET="$secret"

# ── 1. the secret file is the source of truth, and args pass through ───────
printf '%s' file-token > "$secret"
out="$(env -u CLAUDE_CODE_OAUTH_TOKEN bash "$fence" -p --model sonnet "the prompt")"
grep -qx 'TOKEN=file-token' <<<"$out" || fail "the token must come from the mounted secret file: $out"
grep -qx 'ARGV=-p --model sonnet the prompt' <<<"$out" || fail "every arg must pass through verbatim: $out"
pass=$((pass+1))

# ── 2. the file WINS over an ambient env var (a stale -e must never override
#     the host-owned file) ─────────────────────────────────────────────────
out="$(CLAUDE_CODE_OAUTH_TOKEN=stale-env bash "$fence")"
grep -qx 'TOKEN=file-token' <<<"$out" || fail "the file must win over an ambient env token: $out"
pass=$((pass+1))

# ── 3. no file → fall back to the ambient env var, so a bare local run (no
#     mount) still works ──────────────────────────────────────────────────
rm -f "$secret"
out="$(CLAUDE_CODE_OAUTH_TOKEN=env-token bash "$fence")"
grep -qx 'TOKEN=env-token' <<<"$out" || fail "an absent file must fall back to the env token: $out"
pass=$((pass+1))

# ── 4. an EMPTY file is treated as absent (provision never writes an empty
#     token, but a 0-byte file must not blank out a working ambient token) ──
: > "$secret"
out="$(CLAUDE_CODE_OAUTH_TOKEN=env-token bash "$fence")"
grep -qx 'TOKEN=env-token' <<<"$out" || fail "an empty file must fall back, not blank the token: $out"
pass=$((pass+1))

# ── 5. no file AND no ambient token → still execs the real CLI (it decides how
#     to refuse); the shim never swallows the call ──────────────────────────
rm -f "$secret"
out="$(env -u CLAUDE_CODE_OAUTH_TOKEN bash "$fence" doctor)"
grep -qx 'TOKEN=<unset>' <<<"$out" || fail "with no token the real CLI must still run: $out"
grep -qx 'ARGV=doctor' <<<"$out" || fail "args must still pass through with no token: $out"
pass=$((pass+1))

# ── 6. #200: the shim announces the account FINGERPRINT (sha256(token)[:12]) on
#     STDERR, never stdout (stdout is the CLI's stream-json channel), and never
#     the token itself. record-run-result.sh zips this per-iteration line into
#     per-account spend attribution. ───────────────────────────────────────────
printf '%s' file-token > "$secret"
expect_fp="$(printf '%s' file-token | sha256sum | cut -c1-12)"
errf="$tmp/err"
out="$(env -u CLAUDE_CODE_OAUTH_TOKEN bash "$fence" -p 2>"$errf")"
grep -qx "claude-account-fp=$expect_fp" "$errf" \
  || fail "the fingerprint line must be printed on stderr: $(cat "$errf")"
grep -q 'claude-account-fp=' <<<"$out" \
  && fail "the fingerprint line must NOT reach stdout (it would corrupt the CLI stream)"
grep -q 'file-token' "$errf" \
  && fail "the announced fingerprint must NEVER contain the token itself"
# with no file, the AMBIENT token is fingerprinted (the bare-local-run path).
rm -f "$secret"
errf2="$tmp/err2"
out="$(CLAUDE_CODE_OAUTH_TOKEN=env-token bash "$fence" 2>"$errf2")"
grep -qx "claude-account-fp=$(printf '%s' env-token | sha256sum | cut -c1-12)" "$errf2" \
  || fail "the ambient token must be fingerprinted when no file is present: $(cat "$errf2")"
# with NO token at all, nothing is announced (and the call still runs).
errf3="$tmp/err3"
env -u CLAUDE_CODE_OAUTH_TOKEN bash "$fence" doctor 2>"$errf3" >/dev/null
grep -q 'claude-account-fp=' "$errf3" \
  && fail "with no token no fingerprint line must be announced: $(cat "$errf3")"
pass=$((pass+1))

echo "claude-fence: $pass scenarios passed"
