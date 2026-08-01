#!/usr/bin/env bash
# Pure helpers for the swarm healer (.sandcastle/heal.sh): error-line
# normalization, incident signatures, the ledger policy, and watchdog
# detection. No network; the only side effects are ledger files under
# $HEALER_STATE. Unit-tested offline by tests/heal-lib-test.sh.
# Design: docs/superpowers/specs/2026-07-27-self-healing-swarm-design.md.

# Cooldown for "same incident" decisions, seconds.
HEAL_COOLDOWN="${HEAL_COOLDOWN:-21600}"

# How many "still failing" replies one incident may post inside a cooldown
# before the healer escalates once and goes quiet. The second brake, kept
# independent of `repaired`: in dry-run `repaired` never reaches 1 (a dry run
# changes nothing), so escalate-repaired alone could not stop the 2026-07-29
# storm — 70 identical replies in 92 minutes.
HEAL_MAX_REPLIES="${HEAL_MAX_REPLIES:-3}"

# normalize_error_line <line> — strip run-specific noise (hex hashes,
# numbers, timestamps collapse via the number rule, whitespace runs) so the
# same fault produces the same text run-to-run. Worker names fold first: their
# random suffix is 6 hex chars — below the 7-char hex rule — and letters in it
# survive the number rule differently per run (`887403`→N, `c0375b`→cNb), which
# minted a fresh signature for one recurring fault every run (the 2026-08-01
# WorktreeError storm: dedup never engaged, one Mattermost post per run).
normalize_error_line() {
  printf '%s' "$1" |
    sed -E 's/sandcastle-worker-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}/sandcastle-worker-W/g; s/[0-9a-f]{7,40}/H/g; s/[0-9]+/N/g; s/[[:space:]]+/ /g' |
    cut -c1-200
}

# compute_signature <workflow> <error-line> — 12-char stable incident id.
compute_signature() {
  printf '%s|%s' "$1" "$(normalize_error_line "$2")" | sha1sum | cut -c1-12
}

# seam_verdict_signal <verdict-file> — read a seam-verdict.txt artifact
# (scripts/seam-smoke.sh writes it on failure to a well-known host path, #197)
# and echo a single "<failing-stage> :: <first-error-line>" string for the
# incident signature. This is how a `ci` failure — which has no readable log
# API — carries the *actual* fault into compute_signature, so a moved fault
# yields a new signature and re-triggers investigation instead of matching the
# degraded workflow-name-only signature. Empty when the file is missing or
# carries no stage/error (the caller degrades and says so — AC3).
seam_verdict_signal() {
  local f="$1" stage err
  [ -f "$f" ] || return 0
  stage="$(sed -n 's/^stage=//p' "$f" | head -1)"
  err="$(sed -n '/^--- error lines ---$/,$p' "$f" | sed '1d' | grep -E '[^[:space:]]' | head -1)"
  [ -z "$stage$err" ] && return 0
  printf '%s :: %s' "$stage" "$err"
}

# The ledger: one file per signature, key=value lines. Keys: workflow,
# first_seen, last_seen, attempts, repaired, thread_id.
ledger_path() { echo "$HEALER_STATE/$1"; }

ledger_get() { # <sig> <key>
  local f; f="$(ledger_path "$1")"
  [ -f "$f" ] && sed -n "s/^$2=//p" "$f" | tail -1
  return 0
}

ledger_set() { # <sig> <key> <value>
  local f; f="$(ledger_path "$1")"
  mkdir -p "$HEALER_STATE"
  touch "$f"
  grep -v "^$2=" "$f" > "$f.tmp" || true
  echo "$2=$3" >> "$f.tmp"
  mv "$f.tmp" "$f"
}

# ledger_decide <sig> <now-epoch> — the incident policy (spec §ledger):
#   investigate        — never seen
#   investigate-stale  — seen, but outside the cooldown window
#   reply-recurring    — inside cooldown, no repair attempted yet, under the cap
#   escalate-repaired  — inside cooldown AND a repair was already attempted:
#                        the loop-breaker; the healer never repairs twice.
#   escalate-noisy     — inside cooldown and the reply cap is spent: say so once
#   silent             — already escalated for this incident; post nothing
#
# Two independent brakes, because they stop different things: escalate-repaired
# stops the healer repairing the same fault twice, escalate-noisy stops it
# TALKING about the same fault forever. Dry-run never sets `repaired`, so only
# the second one could have stopped the 2026-07-29 storm.
ledger_decide() {
  local sig="$1" now="$2" last repaired replies
  last="$(ledger_get "$sig" last_seen)"
  if [ -z "$last" ]; then echo investigate; return; fi
  if [ $((now - last)) -gt "$HEAL_COOLDOWN" ]; then echo investigate-stale; return; fi
  repaired="$(ledger_get "$sig" repaired)"
  if [ "${repaired:-0}" = "1" ]; then echo escalate-repaired; return; fi
  replies="$(ledger_get "$sig" replies | grep -E '^[0-9]+$' || echo 0)"
  if [ "${replies:-0}" -ge "$HEAL_MAX_REPLIES" ]; then
    if [ "$(ledger_get "$sig" escalated)" = "1" ]; then echo silent; else echo escalate-noisy; fi
    return
  fi
  echo reply-recurring
}

# watchdog_detect <runs-json-path> — reads a Forgejo actions/tasks payload
# and emits "<workflow>\t<kind>" per suspicious workflow:
#   always-red — every terminal run in the window failed (≥2 runs)
#   streak     — the two most recent terminal runs both failed
# The healer workflow is excluded (no self-detection, spec §wiring).
watchdog_detect() {
  jq -r '
    [.workflow_runs[]
      | select(.status == "success" or .status == "failure")
      | select(.name != "healer")
      | {name, status, n: .run_number}]
    | group_by(.name)[]
    | (sort_by(-.n)) as $runs
    | select(($runs | length) >= 2)
    | if ([$runs[] | select(.status == "failure")] | length) == ($runs | length)
        then "\($runs[0].name)\talways-red"
      elif ($runs[0].status == "failure" and $runs[1].status == "failure")
        then "\($runs[0].name)\tstreak"
      else empty end
  ' "$1"
}
