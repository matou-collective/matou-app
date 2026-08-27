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

# display_error_line <line> — the human/agent-facing counterpart to
# normalize_error_line: strip ANSI escapes and collapse to one line, but keep
# digits/hashes intact. normalize_error_line's fold is for compute_signature
# only; applying it to the evidence text too was destroying the exact
# port/timeout a human/agent needs to diagnose, and garbling Playwright's
# ANSI color codes into literal "[Nm" junk (idss #610).
display_error_line() {
  printf '%s' "$1" |
    tr '\n' ' ' |
    sed -E 's/\x1b\[[0-9;]*[a-zA-Z]//g; s/[[:space:]]+/ /g' |
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
#   silent             — already escalated for this incident (by EITHER ladder);
#                        post nothing
#
# Two independent brakes, because they stop different things: escalate-repaired
# stops the healer repairing the same fault twice, escalate-noisy stops it
# TALKING about the same fault forever. Dry-run never sets `repaired`, so only
# the second one could have stopped the 2026-07-29 storm.
#
# The `escalated` latch is read FIRST, above both (#79). It used to live inside
# the reply-cap branch only, below the `repaired` short-circuit — so a signature
# marked repaired bypassed the TALKING brake entirely: every recurrence inside
# the cooldown returned escalate-repaired, the reply counter never moved, and
# each incident refreshed last_seen so the window never expired. That is the
# 2026-08-24 storm: one @ben ping per red run, a run every ~2 minutes, for a
# fault already ticketed. Whichever ladder speaks, it speaks once per window.
ledger_decide() {
  local sig="$1" now="$2" last repaired replies
  last="$(ledger_get "$sig" last_seen)"
  if [ -z "$last" ]; then echo investigate; return; fi
  if [ $((now - last)) -gt "$HEAL_COOLDOWN" ]; then echo investigate-stale; return; fi
  if [ "$(ledger_get "$sig" escalated)" = "1" ]; then echo silent; return; fi
  repaired="$(ledger_get "$sig" repaired)"
  if [ "${repaired:-0}" = "1" ]; then echo escalate-repaired; return; fi
  replies="$(ledger_get "$sig" replies | grep -E '^[0-9]+$' || echo 0)"
  if [ "${replies:-0}" -ge "$HEAL_MAX_REPLIES" ]; then echo escalate-noisy; return; fi
  echo reply-recurring
}

# action_is_ticket_only <action-taken> — 0 iff the diagnosis's ACTION-TAKEN line
# describes ONLY ticket filing, so nothing on the host or in the repo changed.
#
# Filing a ticket is the RIGHT action for a product-class fault, but it is not a
# repair (#79): the fault WILL recur until the fix lands, and each recurrence
# carries no new information. heal.sh records such an outcome as `ticketed`
# instead of `repaired`, which keeps its recurrences on the normal reply-cap
# ladder rather than the once-and-quiet repair loop-breaker. On 2026-08-24 the
# healer's only action was "filed ready-for-agent ticket #77" and the signature
# was marked repaired — the routing this classifier fixes.
#
# The line is one sentence of prose written by the diagnosis agent, so decide it
# in two greps rather than by parsing: it is ticket-only iff it names a FILING
# (a filing verb followed by a ticket noun or a bare `#N`) and names no verb
# that CHANGED something. "filed ticket #77 and restarted the runner" is
# therefore a repair; "filed a ticket (#77) — product-class, no code touched"
# is not. Both misreadings are now bounded — a ticket-only outcome read as a
# repair pings once and latches (the fix above), a repair read as ticket-only
# rides the reply cap to one escalation — so this classifier only ever chooses
# WHICH bounded ladder speaks, never whether the healer can storm.
ACTION_FILED_RE='\b(file|files|filed|filing|open|opens|opened|opening|create|creates|created|creating|raise|raises|raised|log|logs|logged|report|reports|reported|ticket|tickets|ticketed)\b.*(\b(ticket|issue|bug)\b|#[0-9]+)'
ACTION_CHANGED_RE='\b(commit|commits|committed|push|pushed|merge|merged|revert|reverted|restart|restarted|reset|resets|remove|removed|delete|deleted|clean|cleaned|clear|cleared|prune|pruned|kill|killed|rebuild|rebuilt|rebase|rebased|bump|bumped|install|installed|reinstalled|patch|patched|fix|fixed|repair|repaired|edit|edited|write|wrote|change|changed|update|updated|move|moved|chmod|freed|unstuck|disable|disabled|enable|enabled|stop|stopped|start|started|ran|reran|re-ran)\b'
action_is_ticket_only() {
  local act="$1"
  [ -n "$act" ] && [ "$act" != "none" ] || return 1
  act="$(printf '%s' "$act" | tr '[:upper:]' '[:lower:]')"
  printf '%s' "$act" | grep -qE "$ACTION_FILED_RE" || return 1
  printf '%s' "$act" | grep -qE "$ACTION_CHANGED_RE" && return 1
  return 0
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
