#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
n="$here/../notify-mattermost.sh"
fail() { echo "FAIL: $1" >&2; exit 1; }

# chat not wired up: message to stderr, NOTHING on stdout, exit 0 — with and
# without a root_id arg (the new second positional must not break this path)
out="$(env -u MATTERMOST_URL -u MATTERMOST_BOT_TOKEN -u MATTERMOST_CHANNEL_ID bash "$n" "hello" 2>/dev/null)"
[ -z "$out" ] || fail "stdout must stay empty when chat is unset"
out="$(env -u MATTERMOST_URL -u MATTERMOST_BOT_TOKEN -u MATTERMOST_CHANNEL_ID bash "$n" "hello" "rootid123" 2>/dev/null)"
[ -z "$out" ] || fail "stdout must stay empty when chat is unset (threaded form)"

# chat unset: the message is DATA, echoed to stderr VERBATIM — a leading
# ':shortcode:' (or a '-'-prefixed / backslash-bearing message) must survive
# byte-for-byte, never be swallowed/interpreted as an echo flag or escape (#27).
shortcode=":hourglass_flowing_sand: **session-runner parked — Claude limit** while holding #27; done."
err="$(env -u MATTERMOST_URL -u MATTERMOST_BOT_TOKEN -u MATTERMOST_CHANNEL_ID bash "$n" "$shortcode" 2>&1 >/dev/null)"
grep -qF -- "$shortcode" <<<"$err" || fail "the message must reach stderr verbatim (got: $err)"
grep -q "command not found" <<<"$err" && fail "no part of the message may be evaluated as a command (got: $err)"

# no message → usage error
if bash "$n" >/dev/null 2>&1; then fail "no-arg call must fail"; fi

echo "notify: 4 checks passed"
