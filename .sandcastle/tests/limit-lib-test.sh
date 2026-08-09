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

echo "limit-lib: $pass groups passed"
