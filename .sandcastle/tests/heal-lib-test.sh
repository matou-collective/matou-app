#!/usr/bin/env bash
# Offline tests for heal-lib.sh. Run: bash .sandcastle/tests/heal-lib-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export HEALER_STATE="$(mktemp -d)"
trap 'rm -rf "$HEALER_STATE"' EXIT
. "$here/../heal-lib.sh"

fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0

# normalize strips run-specific noise so identical faults match
a="$(normalize_error_line 'Shell expression timed out after 30008ms at 2026-07-27T07:11:43Z')"
b="$(normalize_error_line 'Shell expression timed out after 30027ms at 2026-07-27T15:46:10Z')"
[ "$a" = "$b" ] || fail "normalize should equate the two timeout lines"
pass=$((pass+1))

# hashes normalize too
a="$(normalize_error_line 'error: commit 6792c39abc123 not found')"
b="$(normalize_error_line 'error: commit d101c2c999888 not found')"
[ "$a" = "$b" ] || fail "normalize should equate differing hashes"
pass=$((pass+1))

# signatures: stable, workflow-scoped
s1="$(compute_signature swarm 'npm error Missing: prettier@3.9.6 from lock file')"
s2="$(compute_signature swarm 'npm error Missing: prettier@3.9.7 from lock file')"
s3="$(compute_signature ci 'npm error Missing: prettier@3.9.6 from lock file')"
[ "$s1" = "$s2" ] || fail "same fault, different version numbers → same signature"
[ "$s1" != "$s3" ] || fail "different workflow → different signature"
[ "${#s1}" -eq 12 ] || fail "signature is 12 chars"
pass=$((pass+1))

# ledger policy: new → investigate
now=1000000
[ "$(ledger_decide "$s1" "$now")" = "investigate" ] || fail "new sig should investigate"
ledger_set "$s1" last_seen "$now"; ledger_set "$s1" repaired 0
pass=$((pass+1))

# within cooldown, unrepaired → reply-recurring
[ "$(ledger_decide "$s1" $((now + 60)))" = "reply-recurring" ] || fail "recur in cooldown should thread-reply"
pass=$((pass+1))

# within cooldown, repaired → escalate (the loop-breaker)
ledger_set "$s1" repaired 1
[ "$(ledger_decide "$s1" $((now + 60)))" = "escalate-repaired" ] || fail "recur after repair should escalate"
pass=$((pass+1))

# past cooldown → fresh investigation
[ "$(ledger_decide "$s1" $((now + 21601)))" = "investigate-stale" ] || fail "stale sig should re-investigate"
pass=$((pass+1))

# --- the reply cap: the dry-run loop-breaker (2026-07-29 storm) ---------------
# `repaired` deliberately stays 0 in dry-run (a dry run changes nothing, so the
# repair loop-breaker must stay armed for a real attempt later — heal-test.sh
# pins that). The consequence was that an incident recurring inside the cooldown
# replied "still failing" forever: 70 identical posts over 92 minutes with no
# escalation and no way to stop. The cap is the second, independent brake.
capsig="$(compute_signature swarm 'the same fault, over and over')"
ledger_set "$capsig" last_seen "$now"
ledger_set "$capsig" repaired 0
for i in $(seq 1 "$HEAL_MAX_REPLIES"); do
  [ "$(ledger_decide "$capsig" $((now + 60)))" = "reply-recurring" ] \
    || fail "reply $i of $HEAL_MAX_REPLIES should still thread-reply"
  ledger_set "$capsig" replies "$i"
done
[ "$(ledger_decide "$capsig" $((now + 60)))" = "escalate-noisy" ] \
  || fail "past the reply cap the healer must escalate even when repaired=0"
ledger_set "$capsig" escalated 1
[ "$(ledger_decide "$capsig" $((now + 60)))" = "silent" ] \
  || fail "after escalating once the healer must go quiet, not keep posting"
pass=$((pass+1))

# the cap must never pre-empt the repair loop-breaker: repaired=1 still wins
ledger_set "$capsig" repaired 1
[ "$(ledger_decide "$capsig" $((now + 60)))" = "escalate-repaired" ] \
  || fail "repaired=1 must still take precedence over the reply cap"
# …and a stale incident re-investigates however many replies it accumulated
[ "$(ledger_decide "$capsig" $((now + 21601)))" = "investigate-stale" ] \
  || fail "cooldown expiry must reset the incident regardless of the cap"
pass=$((pass+1))

# ledger round-trip
ledger_set "$s1" thread_id abc123
[ "$(ledger_get "$s1" thread_id)" = "abc123" ] || fail "ledger get/set round-trip"
[ "$(ledger_get "$s1" repaired)" = "1" ] || fail "ledger keeps other keys on set"
pass=$((pass+1))

# watchdog: two newest failed → streak; all failed → always-red; healthy → nothing; healer excluded
out="$(watchdog_detect "$here/fixtures/runs-streak.json")"
[ "$out" = "$(printf 'swarm\tstreak')" ] || fail "streak fixture should flag swarm only, got: $out"
out="$(watchdog_detect "$here/fixtures/runs-alwaysred.json")"
[ "$out" = "$(printf 'seam\talways-red')" ] || fail "always-red fixture should flag seam only, got: $out"
out="$(watchdog_detect "$here/fixtures/runs-healthy.json")"
[ -z "$out" ] || fail "healthy fixture should flag nothing, got: $out"
pass=$((pass+1))

echo "heal-lib: $pass groups passed"
