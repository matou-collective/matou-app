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
# Pin the active-account marker too (claude_limit_park now reads it for the
# exhausted account, #100) so this test never reads the real host marker.
export CLAUDE_ACTIVE_MARKER="$(mktemp -u)"; rm -f "$CLAUDE_ACTIVE_MARKER"
rm -f "$CLAUDE_LIMIT_MARKER"
claude_limit_parked && fail "an ABSENT marker must not read as parked"
claude_limit_park
claude_limit_parked || fail "park() then parked() must read as parked (fresh marker)"
# a marker older than the TTL is stale — the window has likely reset, so retry
touch -d "2 hours ago" "$CLAUDE_LIMIT_MARKER"
claude_limit_parked && fail "a STALE marker (older than the TTL) must not read as parked"
rm -f "$CLAUDE_LIMIT_MARKER"
pass=$((pass+1))

# --- empty-marker distrust (the 2026-08-30 00:13Z false park): every current
#     park path stamps the exhausted account letter (#100), so a FRESH-but-EMPTY
#     marker was written by nothing in this codebase — a stale pin, a stray
#     touch — and must not park the fleet (it cost #788 a ready-for-human flip
#     on a red the reporter never diagnosed). parked() distrusts it, SAYS so on
#     stderr, and reads not-parked; a genuine hit then overwrites the stray file
#     with the letter and parks exactly as before. ---
rm -f "$CLAUDE_LIMIT_MARKER"; : > "$CLAUDE_LIMIT_MARKER"   # fresh AND empty
claude_limit_parked && fail "a FRESH-but-EMPTY marker must be distrusted, not parked on (no current park path writes one)"
distrust_said="$( { claude_limit_parked || true; } 2>&1 >/dev/null )"
grep -qi "letter-less" <<<"$distrust_said" \
  || fail "the distrust must be SAID — stderr names the letter-less marker (got: $distrust_said)"
claude_limit_park   # a genuine hit overwrites the stray file with the letter
claude_limit_parked || fail "a genuine park must overwrite the stray empty marker and read parked"
[ -s "$CLAUDE_LIMIT_MARKER" ] || fail "the genuine park must stamp the account letter over the empty marker"
rm -f "$CLAUDE_LIMIT_MARKER"
pass=$((pass+1))

# --- limit-park HISTORY (#100): the park edges are recorded, per account, so the
#     lost-capacity window survives the live marker clearing. limit-lib carries
#     no hard swarm-db dependency, so the record is a no-op where swarmdb_event
#     is undefined — but the park itself (marker + account content) still works. ---
export CLAUDE_ACTIVE_MARKER="$(mktemp -u)"; rm -f "$CLAUDE_ACTIVE_MARKER"
rm -f "$CLAUDE_LIMIT_MARKER"
# (a) NO mirror wired: park must still stamp the marker with the active account,
#     and neither park nor sweep may error for want of swarmdb_event.
declare -F swarmdb_event >/dev/null 2>&1 && fail "swarmdb_event must be undefined here"
claude_limit_park
claude_limit_parked || fail "park() must still park with no mirror wired"
[ "$(cat "$CLAUDE_LIMIT_MARKER")" = "A" ] || fail "the marker must carry the exhausted account letter"
claude_limit_sweep    # fresh marker → no-op, must not clear a live park
claude_limit_parked || fail "sweep must not close a still-fresh window"
rm -f "$CLAUDE_LIMIT_MARKER"
pass=$((pass+1))

# (b) mirror wired: park records ONE park edge with the account; a re-hit while
#     parked adds no duplicate; the exit observer records the paired unpark for
#     the marker's account and clears it, so a later hit re-parks cleanly.
edln="$tmp.edges"; rm -f "$edln"
swarmdb_event() { printf '%s|%s|%s\n' "$1" "$3" "$4" >> "$edln"; }
claude_mark_active B                       # exhausted account is the standby
claude_limit_park run-42
[ "$(cat "$CLAUDE_LIMIT_MARKER")" = "B" ] || fail "the marker must carry account B"
grep -q '^run-42|limit-pause|park account=B$' "$edln" \
  || fail "entry must record a limit-pause park event with the account: $(cat "$edln")"
claude_limit_park run-42                    # a re-hit inside the same window
[ "$(grep -c '|park account=B$' "$edln")" = 1 ] \
  || fail "a re-hit while parked must not record a second park edge"
# window ends: mark the marker stale, then the sweep closes it exactly once.
touch -d "2 hours ago" "$CLAUDE_LIMIT_MARKER"
claude_limit_sweep run-42
grep -q 'limit-pause|unpark account=B$' "$edln" \
  || fail "the exit observer must record the paired unpark for account B: $(cat "$edln")"
[ -f "$CLAUDE_LIMIT_MARKER" ] && fail "the sweep must clear the marker so a later hit re-parks"
claude_limit_sweep run-42                   # nothing parked now → no-op
[ "$(grep -c unpark "$edln")" = 1 ] || fail "a second sweep with no marker must record nothing"
# a fresh outage after the window reset re-parks and records a new park edge.
claude_limit_park run-99
[ "$(grep -c '|park account=B$' "$edln")" = 2 ] || fail "a later outage must record a fresh park edge"
unset -f swarmdb_event
rm -f "$CLAUDE_LIMIT_MARKER" "$CLAUDE_ACTIVE_MARKER" "$edln"
pass=$((pass+1))

# --- two-account failover (#510): ride over an exhausted weekly window ---
# Marker points at a temp path so the test never touches the real
# /tmp/matou-swarm-claude-active-token.
export CLAUDE_ACTIVE_MARKER="$(mktemp -u)"
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

# the marker is STICKY (Ben's ruling 2026-08-26, supersedes AC-4's freshness
# fallback): an AGED B marker is still B — the account only changes hands at
# an explicit failover, never by timer. The old hourly fall-back re-probed a
# hard-7d-exhausted A per caller and re-parked the host whenever that refusal
# met transient pressure on B (the five 2026-08-25 reporter parks on #722).
touch -d "25 hours ago" "$CLAUDE_ACTIVE_MARKER"
unset CLAUDE_TOKEN_PRIMARY
export CLAUDE_CODE_OAUTH_TOKEN="tok-A"
claude_select_token
[ "$(claude_active_account)" = "B" ] || fail "an aged B marker must stay B (sticky)"
[ "$CLAUDE_CODE_OAUTH_TOKEN" = "tok-B" ] || fail "sticky B must select the standby token"
# ...and symmetric: failover off the sticky B lands on A with the primary token.
claude_failover
[ "$(claude_active_account)" = "A" ] || fail "failover from sticky B must land on A"
[ "$CLAUDE_CODE_OAUTH_TOKEN" = "tok-A" ] || fail "failover to A must restore the primary token"
touch -d "25 hours ago" "$CLAUDE_ACTIVE_MARKER"
[ "$(claude_active_account)" = "A" ] || fail "an aged A marker must stay A (sticky, not a B latch)"
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

# --- claude_transient_hit (idss freshness-tax finding 5): the CLI's own 5xx /
#     overloaded framing is a transient; a product 503 quoted in a drive log,
#     a bare status number, or an empty file is NOT. ---
tr_yes() { printf '%s\n' "$1" > "$tmp"; claude_transient_hit "$tmp"; }
tr_yes 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' || fail "the 2026-09-03 529 shape"
tr_yes 'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}' || fail "500 api_error"
tr_yes 'API Error: 503 Service Unavailable' || fail "bare API Error 503"
tr_yes '  "type": "overloaded_error",' || fail "pretty-printed overloaded_error"
for line in \
  "agent-install: /get?artifact=vm-guest returned 503" \
  "curl: (22) The requested URL returned error: 503" \
  "HTTP 529 from the broker" \
  "API Error: 401 authentication_error" \
  "API Error: 429 rate_limit_error"
do
  tr_yes "$line" && fail "must NOT treat this as a transient API fault: $line"
done
: > "$tmp"; claude_transient_hit "$tmp" && fail "an empty file must never match"
printf '%s\n' 'API Error: 529 overloaded_error' > "$tmp"; empty="$(mktemp)"
claude_transient_hit "$empty" "$tmp" || fail "must find a match among multiple file args"; rm -f "$empty"
[ "$CLAUDE_TRANSIENT_RETRY_DELAY" = 60 ] || fail "default retry delay should be 60s, got $CLAUDE_TRANSIENT_RETRY_DELAY"
pass=$((pass+1))

echo "limit-lib: $pass groups passed"
