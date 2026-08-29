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

# #109: a fixture forge (non-https FORGEJO_API) never posts, even with chat
# fully wired — the message degrades to would-have-sent on stderr, exit 0.
# The curl shim below would record any real POST attempt.
tmpd="$(mktemp -d)"; trap 'rm -rf "$tmpd"' EXIT
printf '#!/usr/bin/env bash\ncat >/dev/null; echo POSTED >> "%s/posted.log"; echo "{\\"id\\":\\"p1\\"}"\n' "$tmpd" > "$tmpd/curl"; chmod +x "$tmpd/curl"
err="$(PATH="$tmpd:$PATH" MATTERMOST_URL=http://mm MATTERMOST_BOT_TOKEN=t MATTERMOST_CHANNEL_ID=c \
  FORGEJO_API=http://x/api/v1/repos/x/y bash "$n" "fixture alarm" 2>&1 >/dev/null)"
[ ! -f "$tmpd/posted.log" ] || fail "a non-https FORGEJO_API (fixture) must NOT post to chat (#109)"
grep -q "would have sent" <<<"$err" && grep -q "fixture alarm" <<<"$err" || fail "the fixture refusal must surface the message as would-have-sent (got: $err)"
# …and the override lets a plain-http forge (or a shimmed test) post.
PATH="$tmpd:$PATH" MATTERMOST_URL=http://mm MATTERMOST_BOT_TOKEN=t MATTERMOST_CHANNEL_ID=c \
  FORGEJO_API=http://x/api/v1/repos/x/y NOTIFY_ALLOW_PLAIN_HTTP_FORGE=1 bash "$n" "allowed" >/dev/null 2>&1
[ -f "$tmpd/posted.log" ] || fail "NOTIFY_ALLOW_PLAIN_HTTP_FORGE=1 must let a plain-http forge post"
# …and an https forge posts as before.
rm -f "$tmpd/posted.log"
PATH="$tmpd:$PATH" MATTERMOST_URL=http://mm MATTERMOST_BOT_TOKEN=t MATTERMOST_CHANNEL_ID=c \
  FORGEJO_API=https://git.example.test/api/v1/repos/x/y bash "$n" "real" >/dev/null 2>&1
[ -f "$tmpd/posted.log" ] || fail "an https forge must post"

# no message → usage error
if bash "$n" >/dev/null 2>&1; then fail "no-arg call must fail"; fi

echo "notify: 7 checks passed"
