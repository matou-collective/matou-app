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
