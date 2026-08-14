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

# claude_limit_parked — 0 iff the host is known-parked: the global marker exists
# and is fresher than the TTL. A stale marker (the window has likely reset) is
# ignored, so a caller tries claude again rather than parking forever.
claude_limit_parked() {
  [ -f "$CLAUDE_LIMIT_MARKER" ] || return 1
  [ $(( $(date +%s) - $(stat -c %Y "$CLAUDE_LIMIT_MARKER") )) -le "$CLAUDE_LIMIT_TTL" ]
}

# claude_limit_park — mark the host parked (touch the global marker) so every
# other caller yields until the window resets. Called after a caller classifies
# its own claude refusal as a limit hit. Idempotent.
claude_limit_park() { touch "$CLAUDE_LIMIT_MARKER"; }

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
# caller on the host). Content is the account letter. Freshness matters both
# ways (#510 AC-4): a fresh B marker steers every caller straight to the
# standby (no failed attempt paid per run), and a STALE one falls back to A so
# the host re-probes the primary after its window likely reset — a stale marker
# never pins the host to the standby forever.
CLAUDE_ACTIVE_MARKER="${CLAUDE_ACTIVE_MARKER:-/tmp/matou-swarm-claude-active-token}"
CLAUDE_ACTIVE_TTL="${CLAUDE_ACTIVE_TTL:-3600}"

# claude_standby_available — 0 iff a standby token is configured at all.
claude_standby_available() { [ -n "${CLAUDE_CODE_OAUTH_TOKEN_B:-}" ]; }

# claude_active_account — prints A or B. B only while the marker is fresh.
claude_active_account() {
  if [ -f "$CLAUDE_ACTIVE_MARKER" ] \
     && [ $(( $(date +%s) - $(stat -c %Y "$CLAUDE_ACTIVE_MARKER") )) -le "$CLAUDE_ACTIVE_TTL" ] \
     && [ "$(cat "$CLAUDE_ACTIVE_MARKER" 2>/dev/null)" = "B" ]; then
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
