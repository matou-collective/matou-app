#!/usr/bin/env bash
# Claude subscription-limit detection — ONE definition, consumed by both
# run-swarm.sh (the quiet-pause guard) and heal.sh (the healer's own agent
# call). Shared deliberately: the 2026-07-29 storm happened because the two
# scripts each carried their own copy of the literal string "hit your limit"
# while the agent printed "You've hit your WEEKLY limit", so the pause path
# was skipped and 70 queued runs went red in 92 minutes.
#
# Pure: no network, no side effects. Tested offline by tests/limit-lib-test.sh,
# which pins every phrasing observed in the wild.

# Match the STRUCTURE, never a list of phrasings. Enumerating cost us two
# storms in one day: the first fix's [A-Za-z0-9 -] class covered "weekly" and
# "5-hour" but not the apostrophe in "You've hit your org's monthly spend
# limit", so 2026-07-29 13:17Z slipped through the same hole. Anything of the
# shape "hit your <whatever> limit" is the refusal, whatever the qualifier:
#   "You've hit your limit · resets 3pm"
#   "You've hit your weekly limit · resets Aug 1, 8am (UTC)"
#   "You've hit your org's monthly spend limit · ask your admin to raise it"
# Plus two independent structural markers: the CLI stamps its own limit
# messages with a cc_cli_limit_message link, and older builds say "usage
# limit reached".
#
# Still deliberately anchored on "hit your" rather than a bare "limit" — a
# false positive would swallow a real fault as a quiet pause, which is worse
# than the storm this fixes. tests/limit-lib-test.sh pins both directions.
CLAUDE_LIMIT_RE="hit your .*limit|usage limit reached|cc_cli_limit_message"

# claude_limit_hit <file> — 0 iff the log shows a subscription-limit refusal.
claude_limit_hit() { grep -qiE "$CLAUDE_LIMIT_RE" "$1"; }

# TRANSIENT API faults (idss phase-7 "freshness tax" report, finding 5): on
# 2026-09-03 the in-drive healer's claude call died with `API Error: 529
# {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`.
# Nothing classified it — not a limit, not an auth failure — so the call read
# as an "unparseable verdict", the reporter's headless fallback filed one
# unparseable ticket and one with its conclusion inverted, and a human session
# spent its time correcting them before a worker could start. A 529 is a
# minute of waiting, not a diagnosis: the caller retries ONCE after
# CLAUDE_TRANSIENT_RETRY_DELAY before falling through. The pattern is the
# CLI's OWN error framing (`API Error: 5xx`, the API's overloaded_error /
# api_error types, "Internal server error") — never a bare status number, so
# a drive log that QUOTES a 503 from the product under test is not a transient
# (the callers also only consult this when no verdict parsed, belt and braces).
CLAUDE_TRANSIENT_RE='API Error: 5[0-9]{2}|"type": *"overloaded_error"|"type": *"api_error"|overloaded_error|Internal server error'
CLAUDE_TRANSIENT_RETRY_DELAY="${CLAUDE_TRANSIENT_RETRY_DELAY:-60}"

# claude_transient_hit <file>... — 0 iff any (non-empty) file shows a transient
# API fault. Multi-file like claude_auth_failed: the CLI puts the API error on
# stderr, but on 2026-08-14 a refusal arrived on stdout, so check both.
claude_transient_hit() { local f; for f in "$@"; do [ -s "$f" ] && grep -qiE "$CLAUDE_TRANSIENT_RE" "$f" && return 0; done; return 1; }

# claude_limit_reset_hint <file> — what to tell the operator. A usage-window
# refusal carries its own "resets …" tail; a spend limit carries none, so fall
# back to the limit line itself ("ask your admin to raise it at …") rather
# than the useless "reset time unknown" the caller would otherwise print.
claude_limit_reset_hint() {
  local hint
  hint="$(grep -oiE "resets[^\"]*" "$1" | head -1)"
  [ -n "$hint" ] || hint="$(grep -oiE "[^\"]*$CLAUDE_LIMIT_RE[^\"]*" "$1" | head -1 | sed 's/^ *//')"
  printf '%s' "$hint"
}

# ── Host-global limit MARKER, and the guard every claude caller rides ─────────
#
# The subscription window is ONE thing per host (#238 made the marker
# deliberately HOST-GLOBAL — one host, one subscription). run-swarm.sh's worker
# guard writes it on the first limit refusal; every claude caller — the workers,
# run-triage.sh and the healer (#253) — consults it FIRST, so the first hit parks
# the whole host instead of each caller reddening or going blind on its own
# refusal. Marker path is repo-agnostic on purpose (this lib is byte-identical
# across repos): a limit in one repo parks the other's callers too.
CLAUDE_LIMIT_MARKER="${CLAUDE_LIMIT_MARKER:-/tmp/matou-swarm-claude-limit}"
# How long a marker is trusted as "still parked". Matches run-swarm.sh's
# hourly notice-dedupe window: during an ongoing outage each limit hit re-touches
# the marker (posting the hourly notice), so it stays fresh; once claude stops
# refusing nothing re-touches it and it goes stale, and the next caller retries.
CLAUDE_LIMIT_TTL="${CLAUDE_LIMIT_TTL:-3600}"

# claude_limit_parked — 0 iff the host is known-parked: the global marker exists,
# is fresher than the TTL, AND carries the exhausted account letter. A stale
# marker (the window has likely reset) is ignored, so a caller tries claude
# again rather than parking forever. An EMPTY (letter-less) marker is ignored
# too, loudly: every current park path stamps A/B (#100), so nothing in this
# codebase writes one — the 2026-08-30 00:13Z marker was a stray writer (a
# stale pin or a bare touch), and honouring it parked the whole fleet for its
# TTL on a refusal that never happened (#788 flipped ready-for-human on a red
# the reporter therefore never diagnosed). A genuine hit overwrites the stray
# file with the letter (claude_limit_park's parked() gate reads false for it)
# and parks exactly as before.
claude_limit_parked() {
  [ -f "$CLAUDE_LIMIT_MARKER" ] || return 1
  if [ ! -s "$CLAUDE_LIMIT_MARKER" ]; then
    echo "limit-lib: WARN letter-less limit marker at $CLAUDE_LIMIT_MARKER — no current park path writes one (a stale pin? a stray touch?); distrusting it, NOT parking" >&2
    return 1
  fi
  [ $(( $(date +%s) - $(stat -c %Y "$CLAUDE_LIMIT_MARKER") )) -le "$CLAUDE_LIMIT_TTL" ]
}

# ── Limit-park HISTORY (#100) ─────────────────────────────────────────────────
#
# The marker above is LIVE-ONLY: it says "parked now", but when the park began,
# when it lifted, and which account was exhausted are gone once it clears — so
# real lost capacity per account per week (the budget/second-account decision,
# the Loss tab's calibration input) was unmeasured. The park edges are recorded
# as swarm.db `limit-pause` events (an envisioned kind in swarm-db.py's schema),
# stamped with the account letter, so a paired park→unpark spans the lost window.
#
# Recording is BEST-EFFORT and DECOUPLED: this lib stays sourceable on its own
# (run-triage/heal/preflight source it WITHOUT swarm-db-lib), so the write is a
# no-op wherever swarmdb_event is not defined — a caller with the mirror (a
# worker run, a session tick) records the edge; one without still parks. The
# marker now CARRIES the exhausted account letter as its content (it was empty),
# so the exit observer can attribute the window it closes; freshness is still by
# mtime, so no reader that only stats the marker changes.

# _claude_limit_event <park|unpark> <account> <run_id> <evidence> — append a
# `limit-pause` edge to the swarm.db mirror. A no-op where swarm-db-lib.sh was
# not sourced (swarmdb_event undefined), so limit-lib carries no hard dependency.
_claude_limit_event() {
  declare -F swarmdb_event >/dev/null 2>&1 || return 0
  swarmdb_event "$3" "" limit-pause "$1 account=$2" "$4"
}

# claude_limit_park [run_id] [evidence] — mark the host parked (write the active
# account into the global marker, then keep it fresh) so every other caller
# yields until the window resets. Called after a caller classifies its own claude
# refusal as a limit hit. Idempotent: on the ENTRY EDGE (not already parked) it
# stamps the marker with the exhausted account and records ONE park event; while
# already parked it only re-touches the marker (keeping the live window fresh and
# preserving the original entry account), so re-hits during one outage add no
# duplicate edge.
claude_limit_park() {
  local run="${1:-${SWARM_RUN_ID:-limit-park}}" evidence="${2:-$CLAUDE_LIMIT_MARKER}" acct
  if claude_limit_parked; then
    touch "$CLAUDE_LIMIT_MARKER"
    return 0
  fi
  acct="$(claude_active_account)"
  printf '%s' "$acct" > "$CLAUDE_LIMIT_MARKER"
  _claude_limit_event park "$acct" "$run" "$evidence"
}

# claude_limit_sweep [run_id] — the EXIT observer: whichever swarm-db-capable
# tick first sees the marker present-but-STALE (the window has ended) records the
# paired unpark event for the account the marker names and clears the marker, so
# the exit is stamped exactly once and a later hit re-parks cleanly. A no-op when
# nothing is parked or the window is still fresh; safe to call every tick.
claude_limit_sweep() {
  local run="${1:-${SWARM_RUN_ID:-limit-park}}" acct
  [ -f "$CLAUDE_LIMIT_MARKER" ] || return 0
  claude_limit_parked && return 0
  acct="$(cat "$CLAUDE_LIMIT_MARKER" 2>/dev/null)"
  [ -n "$acct" ] || acct="?"
  _claude_limit_event unpark "$acct" "$run" "window reset"
  rm -f "$CLAUDE_LIMIT_MARKER"
}

# ── Claude auth-refusal detection (#632) ──────────────────────────────────────
#
# A DEAD TOKEN ("Not logged in · Please run /login", "Failed to authenticate:
# OAuth session expired and could not be refreshed", …) is a different shape
# of refusal than the usage-limit hit above and must never be classified as
# one: parking on a false "limit" read waits out a window that will never
# reset. It must also never fall through to a caller's generic-failure path —
# that reds the job with an incident signature that degrades to the workflow
# name alone (2f0d3a6's "near-unparseable" ruling). ONE definition, shared by
# rehearsal-report.sh's healer/reporter calls and run-swarm.sh's worker guard,
# for the same reason CLAUDE_LIMIT_RE above is shared: two copies drift.
CLAUDE_AUTH_RE="failed to authenticate|oauth session expired|not logged in|invalid api key|authentication_error"

# claude_auth_failed <file>... — 0 iff any file carries the CLI's auth refusal.
claude_auth_failed() { local f; for f in "$@"; do [ -s "$f" ] && grep -qiE "$CLAUDE_AUTH_RE" "$f" && return 0; done; return 1; }

# ── Two-account failover (#510): ride over an exhausted weekly window ─────────
#
# We hold TWO Claude accounts. The primary's token rides CLAUDE_CODE_OAUTH_TOKEN
# (the org Actions secret / host env — the ONE source of truth, the repo-level
# override was deleted 2026-08-14 and must never return); the standby's rides
# CLAUDE_CODE_OAUTH_TOKEN_B beside it. Only the SELECTED token ever lands in
# CLAUDE_CODE_OAUTH_TOKEN, so workers never see the standby credential.
#
# The active-account marker is host-global and repo-agnostic exactly like the
# limit marker above (one subscription window per ACCOUNT, shared by every
# caller on the host). Content is the account letter, and it is STICKY (Ben's
# ruling 2026-08-26, supersedes #510 AC-4's freshness fallback): whichever
# account last worked stays primary until IT takes a failover — in either
# direction. The old decay timer re-probed a hard-7d-exhausted A every hour,
# paying a guaranteed refusal per caller, and whenever that refusal coincided
# with transient pressure on B the host fully parked — the five 2026-08-25
# reporter parks on #722. Recovery needs no timer: when the resting account's
# window resets, the active one's NEXT limit refusal fails over onto it.
CLAUDE_ACTIVE_MARKER="${CLAUDE_ACTIVE_MARKER:-/tmp/matou-swarm-claude-active-token}"

# claude_standby_available — 0 iff a standby token is configured at all.
claude_standby_available() { [ -n "${CLAUDE_CODE_OAUTH_TOKEN_B:-}" ]; }

# claude_active_account — prints A or B: the marker's letter, sticky, A when
# no marker has ever been stamped.
claude_active_account() {
  if [ "$(cat "$CLAUDE_ACTIVE_MARKER" 2>/dev/null)" = "B" ]; then
    printf 'B'
  else
    printf 'A'
  fi
}

# claude_mark_active <A|B> — stamp the host's active account.
claude_mark_active() { printf '%s' "$1" > "$CLAUDE_ACTIVE_MARKER"; }

# claude_select_token — export CLAUDE_CODE_OAUTH_TOKEN per the active account.
# Call once before the first claude invocation. A no-op on single-account hosts.
# The primary token is snapshotted on first call so later flips can restore it.
claude_select_token() {
  claude_standby_available || return 0
  CLAUDE_TOKEN_PRIMARY="${CLAUDE_TOKEN_PRIMARY:-${CLAUDE_CODE_OAUTH_TOKEN:-}}"
  if [ "$(claude_active_account)" = "B" ]; then
    export CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN_B"
  else
    export CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_TOKEN_PRIMARY"
  fi
}

# claude_failover — flip to the other account, stamp the marker, re-export the
# token. 1 (and no side effects) when no standby is configured — the caller
# falls through to today's quiet park. Callers retry their claude call ONCE
# after a successful failover; a second limit refusal means BOTH accounts are
# exhausted and the normal park path applies.
claude_failover() {
  claude_standby_available || return 1
  if [ "$(claude_active_account)" = "A" ]; then
    claude_mark_active B
  else
    claude_mark_active A
  fi
  claude_select_token
}
