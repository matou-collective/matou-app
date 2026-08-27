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

# worker names fold whole: the 6-hex suffix is under the hex rule's floor and
# its letters survive the number rule differently per run (2026-08-01 storm)
a="$(normalize_error_line "WorktreeError: fatal: '/x/.sandcastle/worktrees/sandcastle-worker-20260731-225724-887403' is not a working tree")"
b="$(normalize_error_line "WorktreeError: fatal: '/x/.sandcastle/worktrees/sandcastle-worker-20260801-005751-c0375b' is not a working tree")"
[ "$a" = "$b" ] || fail "normalize should equate error lines differing only in worker name"
pass=$((pass+1))

# display_error_line (#610): the human/agent-facing counterpart — strip ANSI,
# collapse whitespace, but NEVER redact digits/hashes (normalize_error_line's
# job is signature folding, not display; the reporter's evidence note needs
# the real port/timeout).
out="$(display_error_line 'connect ECONNREFUSED 127.0.0.1:443')"
[ "$out" = "connect ECONNREFUSED 127.0.0.1:443" ] || fail "display should keep the real port, got: $out"
pass=$((pass+1))

out="$(display_error_line 'Timeout: 600000ms exceeded')"
[ "$out" = "Timeout: 600000ms exceeded" ] || fail "display should keep the real timeout, got: $out"
pass=$((pass+1))

# a Playwright-style ANSI-colored line: the ESC byte + its digit-bearing CSI
# sequence must be stripped whole, not folded into visible "[Nm" junk
out="$(display_error_line "$(printf '\033[31mTimeoutError\033[0m: locator.click: Timeout 30000ms exceeded')")"
[ "$out" = "TimeoutError: locator.click: Timeout 30000ms exceeded" ] || fail "display should strip ANSI without leaving [Nm junk, got: $out"
pass=$((pass+1))

# multi-line input collapses to one line (evidence_note embeds this inline)
out="$(display_error_line "$(printf 'first line\nsecond   line')")"
[ "$out" = "first line second line" ] || fail "display should collapse to a single line, got: $out"
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

# the cap must never pre-empt the repair loop-breaker: an UNLATCHED signature
# marked repaired escalates on the repair path however many replies it spent
ledger_set "$capsig" escalated 0
ledger_set "$capsig" repaired 1
[ "$(ledger_decide "$capsig" $((now + 60)))" = "escalate-repaired" ] \
  || fail "repaired=1 must still take precedence over the reply cap"
# …and a stale incident re-investigates however many replies it accumulated
[ "$(ledger_decide "$capsig" $((now + 21601)))" = "investigate-stale" ] \
  || fail "cooldown expiry must reset the incident regardless of the cap"
pass=$((pass+1))

# --- #79: the silence latch sits above BOTH ladders ---------------------------
# escalate-repaired used to short-circuit ledger_decide ahead of the reply cap
# AND set nothing, so a repaired signature re-pinged @ben on every recurrence
# inside the cooldown — and each recurrence refreshed last_seen, so the window
# never expired either (the 2026-08-24 storm: one @ben ping per red run, one run
# every ~2 minutes). `escalated` is now consulted BEFORE `repaired`: whichever
# ladder spoke, it spoke once.
latchsig="$(compute_signature swarm 'a fault the healer already tried to repair')"
ledger_set "$latchsig" last_seen "$now"
ledger_set "$latchsig" repaired 1
[ "$(ledger_decide "$latchsig" $((now + 60)))" = "escalate-repaired" ] \
  || fail "the first recurrence after a repair attempt must still escalate once"
ledger_set "$latchsig" escalated 1
[ "$(ledger_decide "$latchsig" $((now + 60)))" = "silent" ] \
  || fail "a LATCHED repaired signature must go silent, not ping again (#79)"
[ "$(ledger_decide "$latchsig" $((now + 3600)))" = "silent" ] \
  || fail "the latch must hold for the rest of the cooldown window (#79)"
# the latch is per WINDOW, not forever: past the cooldown the incident is new
# again (heal.sh clears the ladder state on investigate-stale)
[ "$(ledger_decide "$latchsig" $((now + 21601)))" = "investigate-stale" ] \
  || fail "the latch must not survive cooldown expiry (#79)"
pass=$((pass+1))

# --- #79: filing a ticket is not a repair ------------------------------------
# The 2026-08-24 diagnosis's only action was "filed ready-for-agent ticket #77"
# — no code, no config, nothing on the host changed. Marking that `repaired`
# routed every later recurrence into the (then latch-less) escalate-repaired
# branch. action_is_ticket_only is the classifier heal.sh uses to keep a
# diagnosis-only outcome on the normal reply-cap ladder.
for a in \
  'filed ready-for-agent ticket #77' \
  'filed issue #77 for the product-class fault' \
  'opened ticket #12' \
  'Filed a ticket (#77) — the fault is product-class, no code touched' \
  'filed ticket #77 and filed ticket #78' \
  'logged issue #5'
do
  action_is_ticket_only "$a" || fail "should classify as ticket-only: $a"
done
for a in \
  'committed a fix' \
  'none' \
  '' \
  'removed the stale worktree and filed ticket #77' \
  'filed ticket #77 and restarted the forgejo-runner' \
  'cleaned /tmp/heal-fix' \
  'logged the failing stage in the run log'
do
  action_is_ticket_only "$a" && fail "should NOT classify as ticket-only: $a"
done
pass=$((pass+1))

# --- #197: ci signatures are stage/fault-aware over the seam verdict ----------
# The seam script writes a verdict (failing stage + first error lines); the
# signal folds it into "<stage> :: <error>" so compute_signature tracks the
# actual fault. A moved fault (the #193 SA4010 → #195 revive case that masked
# for 40 minutes) must yield a DIFFERENT signature; the same fault the same one.
vdir="$(mktemp -d)"
printf 'stage=Go: build/vet/test/lint\nexit=1\n--- error lines ---\nwiring_test.go:41:2: err shadows builtin (revive)\n' > "$vdir/revive"
printf 'stage=Go: build/vet/test/lint\nexit=1\n--- error lines ---\nconfig.go:88:3: this value of x is never used (SA4010) (staticcheck)\n' > "$vdir/staticcheck"
printf 'stage=TypeScript: build/test/lint\nexit=1\n--- error lines ---\nwiring_test.go:41:2: err shadows builtin (revive)\n' > "$vdir/ts-stage"
sigRevive="$(compute_signature ci "$(seam_verdict_signal "$vdir/revive")")"
sigStatic="$(compute_signature ci "$(seam_verdict_signal "$vdir/staticcheck")")"
sigTsStage="$(compute_signature ci "$(seam_verdict_signal "$vdir/ts-stage")")"
[ "$sigRevive" != "$sigStatic" ] || fail "a moved fault (same stage, different error) → different ci signature"
[ "$sigRevive" != "$sigTsStage" ] || fail "same error in a different failing stage → different ci signature"
# the same fault recurring → the same signature (behaviour unchanged, AC2)
cp "$vdir/revive" "$vdir/revive-again"
[ "$sigRevive" = "$(compute_signature ci "$(seam_verdict_signal "$vdir/revive-again")")" ] \
  || fail "same stage+fault → same ci signature"
# run-specific jitter (line numbers) inside one fault still collapses
sed 's/:41:2:/:57:9:/' "$vdir/revive" > "$vdir/revive-jitter"
[ "$sigRevive" = "$(compute_signature ci "$(seam_verdict_signal "$vdir/revive-jitter")")" ] \
  || fail "line-number jitter within one fault must normalize to the same signature"
# missing / empty verdict → empty signal (the degrade path; AC3)
[ -z "$(seam_verdict_signal "$vdir/nope")" ] || fail "missing verdict → empty signal"
printf 'stage=\nexit=1\n--- error lines ---\n' > "$vdir/empty"
[ -z "$(seam_verdict_signal "$vdir/empty")" ] || fail "verdict with no stage/error → empty signal"
rm -rf "$vdir"
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
