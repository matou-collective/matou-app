#!/usr/bin/env bash
# Offline test for the triage yield-starvation signal (#110): a triage yield is
# `exit 0` (a green run), so N consecutive yields for a repo with untriaged
# issues are invisible — Matou/coa starved 12 tickets across 12 green yields with
# no signal. triage-yield-signal.sh (over triage-yield-lib.sh) bumps a per-repo
# consecutive-yield counter and, at the threshold, posts ONE comment on the
# oldest untriaged issue plus a Mattermost notice, once per episode; a yield with
# nothing untriaged resets the counter; run-triage.sh resets it on a real pass.
# Run: bash .sandcastle/tests/triage-yield-signal-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
count="$tmp/yield-count"
postlog="$tmp/post-log"

# ── Part 1: the pure counter lib ───────────────────────────────────────────
( set -euo pipefail
  export TRIAGE_YIELD_COUNT="$count"
  . "$root/triage-yield-lib.sh"
  rm -f "$count" "$count.signalled"
  [ "$(triage_yield_bump)" = 1 ] || fail "lib: first bump must read 1"
  [ "$(triage_yield_bump)" = 2 ] || fail "lib: second bump must read 2"
  [ "$(cat "$count")" = 2 ]      || fail "lib: the counter file must persist the value"
  : > "$count.signalled"
  triage_yield_reset
  [ ! -e "$count" ]              || fail "lib: reset must remove the counter"
  [ ! -e "$count.signalled" ]   || fail "lib: reset must clear the episode marker"
  # a mangled counter clamps to 0, so the next bump reads 1 (never wedges set -e)
  printf 'garbage' > "$count"
  [ "$(triage_yield_bump)" = 1 ] || fail "lib: a non-numeric counter must clamp to 0 then bump to 1"
) || exit 1
pass=$((pass+1))

# A curl shim: answers preflight's #20 permission probe and its issue page, and
# LOGS any comment POST (so a threshold signal is provable offline). $N_UNTRIAGED
# controls how many untriaged issues the page carries (#7 the oldest, #9 next).
cat > "$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
url="${*: -1}"
case "$url" in
  */issues/*/comments) printf '%s\n' "$url" >> "$POST_LOG"; echo '{"id":1}' ;;
  *state=open*)
    case "${N_UNTRIAGED:-0}" in
      0) echo '[]' ;;
      1) echo '[{"number":7,"title":"first","html_url":"http://x/7","labels":[]}]' ;;
      *) echo '[{"number":9,"title":"nine","html_url":"http://x/9","labels":[]},{"number":7,"title":"first","html_url":"http://x/7","labels":[]}]' ;;
    esac ;;
  */repos/x/y) echo '{"permissions":{"push":true}}' ;;
  *) echo '[]' ;;
esac
SH
chmod +x "$tmp/bin/curl"

# A SECOND bin dir whose `curl` FAILS every call (HTTP-error exit 22) — a
# persistent Forgejo outage makes preflight red; the signal must then leave the
# counter untouched (no false reset on missing information).
mkdir -p "$tmp/bindown"
cat > "$tmp/bindown/curl" <<'SH'
#!/usr/bin/env bash
exit 22
SH
chmod +x "$tmp/bindown/curl"

run_signal() {
  env -u MATTERMOST_URL -u MATTERMOST_BOT_TOKEN -u MATTERMOST_CHANNEL_ID \
    PATH="$tmp/bin:$PATH" \
    FORGEJO_TOKEN=dummy FORGEJO_API=http://x/api/v1/repos/x/y \
    TRIAGE_YIELD_COUNT="$count" POST_LOG="$postlog" \
    "$@" bash "$root/triage-yield-signal.sh" "${REASON:-slots-busy}"
}

# ── Part 2: nothing untriaged resets the counter, never signals ────────────
rm -f "$count" "$count.signalled" "$postlog"
echo 2 > "$count"
run_signal N_UNTRIAGED=0 >/dev/null 2>&1 || fail "a yield must always exit 0"
[ ! -e "$count" ] || fail "a yield with an empty queue must RESET the counter (not starvation)"
[ ! -e "$postlog" ] || fail "a yield with nothing untriaged must never post a comment"
pass=$((pass+1))

# ── Part 3: below the threshold bumps but does not signal ───────────────────
rm -f "$count" "$count.signalled" "$postlog"
out="$(run_signal N_UNTRIAGED=2 TRIAGE_YIELD_THRESHOLD=3 2>&1)" || fail "a below-threshold yield must exit 0"
[ "$(cat "$count")" = 1 ] || fail "the first yield with untriaged issues must bump to 1, got: $(cat "$count" 2>/dev/null)"
[ ! -e "$postlog" ] || fail "a below-threshold yield must not post a comment"
grep -q "1 consecutive with 2 untriaged" <<<"$out" || fail "the yield line must carry the counts, got: $out"
run_signal N_UNTRIAGED=2 TRIAGE_YIELD_THRESHOLD=3 >/dev/null 2>&1
[ "$(cat "$count")" = 2 ] || fail "a second consecutive yield must climb to 2"
[ ! -e "$postlog" ] || fail "still below threshold — no comment yet"
pass=$((pass+1))

# ── Part 4: at the threshold, comment on the OLDEST untriaged issue, once ────
# the counter is at 2; the third yield reaches the threshold of 3 → signal.
out="$(run_signal N_UNTRIAGED=2 TRIAGE_YIELD_THRESHOLD=3 REASON=drive-reserved 2>&1)" \
  || fail "the threshold yield must still exit 0 (never red)"
[ "$(cat "$count")" = 3 ] || fail "the counter must reach 3 at the threshold"
[ -e "$postlog" ] || fail "the threshold must post a comment on the oldest untriaged issue"
grep -q '/issues/7/comments' "$postlog" \
  || fail "the comment must land on the OLDEST (lowest-numbered) untriaged issue #7, got: $(cat "$postlog")"
grep -q '/issues/9/comments' "$postlog" \
  && fail "the comment must not land on a newer issue (#9)"
[ -e "$count.signalled" ] || fail "the threshold must create the once-per-episode marker"
pass=$((pass+1))

# ── Part 5: past the threshold, no repeat while the episode marker stands ────
: > "$postlog"   # forget the first post
out="$(run_signal N_UNTRIAGED=2 TRIAGE_YIELD_THRESHOLD=3 2>&1)" || fail "a post-threshold yield must exit 0"
[ "$(cat "$count")" = 4 ] || fail "the counter keeps climbing past the threshold"
[ ! -s "$postlog" ] || fail "a starving repo must be signalled ONCE per episode, not every tick, got: $(cat "$postlog")"
grep -q "already signalled this episode" <<<"$out" || fail "the repeat-suppression must be reported, got: $out"
pass=$((pass+1))

# ── Part 6: a preflight failure leaves the counter untouched (no false reset) ─
echo 4 > "$count"; : > "$count.signalled"; : > "$postlog"
out="$(env -u MATTERMOST_URL -u MATTERMOST_BOT_TOKEN -u MATTERMOST_CHANNEL_ID \
  PATH="$tmp/bindown:$PATH" \
  FORGEJO_TOKEN=dummy FORGEJO_API=http://x/api/v1/repos/x/y \
  TRIAGE_YIELD_COUNT="$count" POST_LOG="$postlog" \
  PREFLIGHT_RETRIES=1 PREFLIGHT_BACKOFF=0 \
  bash "$root/triage-yield-signal.sh" slots-busy 2>&1)" \
  || fail "a preflight-down yield must still exit 0"
grep -q "preflight unavailable" <<<"$out" || fail "a preflight failure must be reported, got: $out"
[ "$(cat "$count")" = 4 ] || fail "a preflight failure must NOT change the counter, got: $(cat "$count" 2>/dev/null)"
[ ! -s "$postlog" ] || fail "a preflight failure must not post"
pass=$((pass+1))

echo "triage-yield-signal: $pass scenarios passed"
