#!/usr/bin/env bash
# Offline tests for limit-lib.sh — the Claude subscription-limit detector both
# run-swarm.sh and heal.sh consume. Run: bash .sandcastle/tests/limit-lib-test.sh
#
# The 2026-07-29 storm is the reason this file exists: the guard grepped the
# literal "hit your limit" while the agent printed "hit your WEEKLY limit", so
# the quiet-pause path was skipped and 70 queued runs went red in 92 minutes.
# Every phrasing observed in the wild is pinned below.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/../limit-lib.sh"

fail() { echo "FAIL: $1" >&2; exit 1; }
tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
pass=0

detects() { printf '%s\n' "$1" > "$tmp"; claude_limit_hit "$tmp"; }

# --- the message that actually caused the storm (verbatim from the worker log
#     main-sandcastle-worker-20260729-071816-f4dd71-worker.log) ---
detects "You've hit your weekly limit · resets Aug 1, 8am (UTC)" \
  || fail "the WEEKLY limit message must be detected (the 2026-07-29 storm)"
pass=$((pass+1))

# --- the phrasing the original guard was written for (must not regress) ---
detects "You've hit your limit · resets 3pm" \
  || fail "the plain limit message must still be detected"
pass=$((pass+1))

# --- the SECOND storm, 2026-07-29 13:17Z: an org spend limit, not a usage
#     window. The apostrophe in "org's" fell outside the first fix's
#     [A-Za-z0-9 -] character class, so the guard missed again. Enumerating
#     phrasings is a losing game — match the structure instead. ---
detects "You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/settings/usage?from=cc_cli_limit_message" \
  || fail "the ORG SPEND limit message must be detected (the 2026-07-29 13:17Z storm)"
pass=$((pass+1))

# --- other phrasings of the same refusal ---
detects "You've hit your 5-hour limit · resets 9pm" || fail "5-hour limit variant"
detects "Claude usage limit reached"                || fail "usage-limit-reached variant"
detects "you've hit your Opus weekly limit"         || fail "model-qualified variant"
detects "You've hit your team's limit"              || fail "possessive variant"
detects "some wrapper printed ?from=cc_cli_limit_message" \
  || fail "the CLI's own limit-message marker is a reliable structural signal"
pass=$((pass+1))

# --- realistic multi-line log, message buried mid-stream ---
printf '%s\n' \
  "Iteration 1/3" \
  "Setting up sandbox done (5.8s)" \
  "Agent started" \
  "You've hit your weekly limit · resets Aug 1, 8am (UTC)" \
  "Agent invocation failed: claude-code exited with code 1:" > "$tmp"
claude_limit_hit "$tmp" || fail "must find the limit line inside a full worker log"
[ "$(claude_limit_reset_hint "$tmp")" = "resets Aug 1, 8am (UTC)" ] \
  || fail "reset hint should be the 'resets …' tail, got: $(claude_limit_reset_hint "$tmp")"
pass=$((pass+1))

# --- must NOT fire on unrelated failures: a false positive would swallow a
#     real fault as a quiet pause, which is worse than the storm ---
for line in \
  "npm error Missing: prettier@3.9.6 from lock file" \
  "error: failed to push some refs to origin" \
  "Shell expression timed out after 30008ms" \
  "rate limit exceeded for the Forgejo API" \
  "TypeError: cannot read property 'limit' of undefined"
do
  detects "$line" && fail "must NOT treat this as a Claude limit: $line"
done
pass=$((pass+1))

# --- the host-global limit MARKER matrix (#253): the guard every claude caller
#     rides. absent → not parked; fresh → parked; stale → not parked; and park()
#     makes a subsequent parked() true. Point the marker at a temp path so the
#     test never touches the real /tmp/matou-swarm-claude-limit. ---
export CLAUDE_LIMIT_MARKER="$(mktemp -u)"; export CLAUDE_LIMIT_TTL=3600
rm -f "$CLAUDE_LIMIT_MARKER"
claude_limit_parked && fail "an ABSENT marker must not read as parked"
claude_limit_park
claude_limit_parked || fail "park() then parked() must read as parked (fresh marker)"
# a marker older than the TTL is stale — the window has likely reset, so retry
touch -d "2 hours ago" "$CLAUDE_LIMIT_MARKER"
claude_limit_parked && fail "a STALE marker (older than the TTL) must not read as parked"
rm -f "$CLAUDE_LIMIT_MARKER"
pass=$((pass+1))

# --- two-account failover (#510): ride over an exhausted weekly window ---
# Marker points at a temp path so the test never touches the real
# /tmp/matou-swarm-claude-active-token; TTL matrix mirrors the limit marker's.
export CLAUDE_ACTIVE_MARKER="$(mktemp -u)"; export CLAUDE_ACTIVE_TTL=3600
rm -f "$CLAUDE_ACTIVE_MARKER"

# no standby token: selection is a NO-OP (single-account hosts unchanged) and
# failover REFUSES — the caller falls through to today's quiet park.
unset CLAUDE_CODE_OAUTH_TOKEN_B CLAUDE_TOKEN_PRIMARY 2>/dev/null || true
export CLAUDE_CODE_OAUTH_TOKEN="tok-A"
claude_select_token
[ "$CLAUDE_CODE_OAUTH_TOKEN" = "tok-A" ] || fail "select without a standby must be a no-op"
claude_failover && fail "failover without a standby token must refuse"
pass=$((pass+1))

# standby present: the active account defaults to A; a failover flips the
# marker to B and re-exports the standby token; a second failover flips back.
export CLAUDE_CODE_OAUTH_TOKEN_B="tok-B"
claude_select_token
[ "$(claude_active_account)" = "A" ] || fail "active account must default to A"
[ "$CLAUDE_CODE_OAUTH_TOKEN" = "tok-A" ] || fail "select on A must keep the primary token"
claude_failover || fail "failover with a standby must succeed"
[ "$(claude_active_account)" = "B" ] || fail "failover must mark B active"
[ "$CLAUDE_CODE_OAUTH_TOKEN" = "tok-B" ] || fail "failover must export the standby token"
claude_failover || fail "second failover must succeed"
[ "$(claude_active_account)" = "A" ] || fail "second failover must flip back to A"
[ "$CLAUDE_CODE_OAUTH_TOKEN" = "tok-A" ] || fail "second failover must restore the primary token"
pass=$((pass+1))

# a FRESH B marker steers a NEW caller straight to the standby — no failed
# attempt paid first (the marker's whole purpose). Simulate a fresh shell by
# clearing the primary snapshot and re-exporting the env as cron would.
claude_mark_active B
unset CLAUDE_TOKEN_PRIMARY
export CLAUDE_CODE_OAUTH_TOKEN="tok-A"
claude_select_token
[ "$CLAUDE_CODE_OAUTH_TOKEN" = "tok-B" ] || fail "a fresh B marker must start the caller on the standby token"
pass=$((pass+1))

# a STALE marker never pins the host to the standby forever (AC-4): older than
# the TTL → the active account falls back to A, re-probing the primary.
touch -d "2 hours ago" "$CLAUDE_ACTIVE_MARKER"
unset CLAUDE_TOKEN_PRIMARY
export CLAUDE_CODE_OAUTH_TOKEN="tok-A"
claude_select_token
[ "$(claude_active_account)" = "A" ] || fail "a stale marker must fall back to account A"
[ "$CLAUDE_CODE_OAUTH_TOKEN" = "tok-A" ] || fail "a stale marker must re-select the primary token"
rm -f "$CLAUDE_ACTIVE_MARKER"
pass=$((pass+1))

# --- Claude auth-refusal detection (#632): a DEAD TOKEN is a different
#     refusal shape than a usage-limit hit and must never be confused with
#     one in either direction -- a false "limit" read waits out a window that
#     will never reset, and a false "auth" read fails over a token that isn't
#     actually dead. ---
auth_detects() { printf '%s\n' "$1" > "$tmp"; claude_auth_failed "$tmp"; }

for line in \
  "Not logged in · Please run /login" \
  "Failed to authenticate: OAuth session expired and could not be refreshed" \
  "Invalid API key · check your credentials" \
  "authentication_error: token is invalid"
do
  auth_detects "$line" || fail "must detect this as a Claude auth refusal: $line"
done
pass=$((pass+1))

# must NOT fire on a usage-limit refusal, and a usage-limit refusal must NOT
# fire on the auth detector -- the two guards must stay mutually exclusive.
printf '%s\n' "You've hit your weekly limit · resets Aug 1, 8am (UTC)" > "$tmp"
claude_auth_failed "$tmp" && fail "a usage-limit message must NOT read as an auth refusal"
claude_limit_hit "$tmp" || fail "sanity: this fixture should still read as a limit hit"
pass=$((pass+1))

# must NOT fire on an unrelated failure
auth_detects "npm error Missing: prettier@3.9.6 from lock file" \
  && fail "must NOT treat an unrelated failure as a Claude auth refusal"
pass=$((pass+1))

# claude_auth_failed checks every file argument (the caller's multi-file
# err+out grep pattern); an EMPTY file must never match (the [ -s ] guard).
empty="$(mktemp)"
printf '%s\n' "Failed to authenticate: OAuth session expired" > "$tmp"
claude_auth_failed "$empty" "$tmp" || fail "must find a match among multiple file args"
rm -f "$empty"
: > "$tmp"
claude_auth_failed "$tmp" && fail "an empty file must never match"
pass=$((pass+1))

echo "limit-lib: $pass groups passed"
