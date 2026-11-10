#!/usr/bin/env bash
# Offline test for the swarm yield-starvation signal (#213): a swarm yield is
# `exit 0` (a green run), so N consecutive both-slots-busy losses for a repo with
# ready tickets are invisible — a low-traffic repo starves behind two long drains
# on every host with no signal. swarm-yield-signal.sh (over swarm-yield-lib.sh)
# bumps a per-repo consecutive-yield counter and, at the threshold, writes this
# repo's want-file AND posts ONE comment on the oldest ready issue plus a
# Mattermost notice, once per episode; a yield with nothing ready resets the
# counter; run-swarm.sh resets it (counter + marker + want-file) on a real claim.
# Run: bash .sandcastle/tests/swarm-yield-signal-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
count="$tmp/yield-count"
wantfile="$tmp/repo-wanted"
postlog="$tmp/post-log"

# ── Part 1: the pure counter lib ───────────────────────────────────────────
( set -euo pipefail
  export SWARM_YIELD_COUNT="$count" SWARM_REPO_WANTED="$wantfile"
  . "$root/swarm-yield-lib.sh"
  rm -f "$count" "$count.signalled" "$wantfile"
  [ "$(swarm_yield_bump)" = 1 ] || fail "lib: first bump must read 1"
  [ "$(swarm_yield_bump)" = 2 ] || fail "lib: second bump must read 2"
  [ "$(cat "$count")" = 2 ]     || fail "lib: the counter file must persist the value"
  # the counter / marker / want-file paths are seam-overridable and distinct
  [ "$(swarm_yield_count_path)" = "$count" ]      || fail "lib: SWARM_YIELD_COUNT must override the counter path"
  [ "$(swarm_yield_signalled_path)" = "$count.signalled" ] || fail "lib: the episode marker sits beside the counter"
  [ "$(swarm_repo_wanted_path)" = "$wantfile" ]   || fail "lib: SWARM_REPO_WANTED must override the want-file path"
  : > "$count.signalled"; : > "$wantfile"
  swarm_yield_reset
  [ ! -e "$count" ]             || fail "lib: reset must remove the counter"
  [ ! -e "$count.signalled" ]  || fail "lib: reset must clear the episode marker"
  [ ! -e "$wantfile" ]         || fail "lib: reset must drop this repo's want-file (no longer starving)"
  # a mangled counter clamps to 0, so the next bump reads 1 (never wedges set -e)
  printf 'garbage' > "$count"
  [ "$(swarm_yield_bump)" = 1 ] || fail "lib: a non-numeric counter must clamp to 0 then bump to 1"
  # per-repo key: two repos never share a streak (#574 clobber lesson)
  ( export REPO_SLUG=Acme/one; unset SWARM_YIELD_COUNT; p1="$(swarm_yield_count_path)"
    export REPO_SLUG=Acme/two; p2="$(swarm_yield_count_path)"
    [ "$p1" != "$p2" ] || fail "lib: two repos must not share a swarm-yield counter path" )
) || exit 1
pass=$((pass+1))

# A curl shim: answers the ready-for-agent listing (count set by $N_READY, the
# oldest #7, next #9) and LOGS any comment POST (so a threshold signal is
# provable offline).
cat > "$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
url="${*: -1}"
case "$url" in
  */issues/*/comments) printf '%s\n' "$url" >> "$POST_LOG"; echo '{"id":1}' ;;
  *labels=ready-for-agent*)
    case "${N_READY:-0}" in
      0) echo '[]' ;;
      1) echo '[{"number":7,"title":"first","html_url":"http://x/7"}]' ;;
      *) echo '[{"number":9,"title":"nine","html_url":"http://x/9"},{"number":7,"title":"first","html_url":"http://x/7"}]' ;;
    esac ;;
  *) echo '[]' ;;
esac
SH
chmod +x "$tmp/bin/curl"

# A SECOND bin dir whose `curl` FAILS every call (HTTP-error exit 22) — a
# persistent Forgejo outage makes the ready-set read fail; the signal must then
# leave the counter untouched (no false reset on missing information).
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
    SWARM_YIELD_COUNT="$count" SWARM_REPO_WANTED="$wantfile" POST_LOG="$postlog" \
    "$@" bash "$root/swarm-yield-signal.sh" "${REASON:-slots-busy}"
}

# ── Part 2: nothing ready resets the counter, never signals or wants ───────
rm -f "$count" "$count.signalled" "$wantfile" "$postlog"
echo 2 > "$count"
run_signal N_READY=0 >/dev/null 2>&1 || fail "a yield must always exit 0"
[ ! -e "$count" ] || fail "a yield with an empty queue must RESET the counter (not starvation)"
[ ! -e "$wantfile" ] || fail "a yield with nothing ready must never write the want-file"
[ ! -e "$postlog" ] || fail "a yield with nothing ready must never post a comment"
pass=$((pass+1))

# ── Part 3: below the threshold bumps but does not signal or want ──────────
rm -f "$count" "$count.signalled" "$wantfile" "$postlog"
out="$(run_signal N_READY=2 SWARM_YIELD_THRESHOLD=3 2>&1)" || fail "a below-threshold yield must exit 0"
[ "$(cat "$count")" = 1 ] || fail "the first yield with ready tickets must bump to 1, got: $(cat "$count" 2>/dev/null)"
[ ! -e "$wantfile" ] || fail "a below-threshold yield must not write the want-file"
[ ! -e "$postlog" ] || fail "a below-threshold yield must not post a comment"
grep -q "1 consecutive with 2 ready" <<<"$out" || fail "the yield line must carry the counts, got: $out"
run_signal N_READY=2 SWARM_YIELD_THRESHOLD=3 >/dev/null 2>&1
[ "$(cat "$count")" = 2 ] || fail "a second consecutive yield must climb to 2"
[ ! -e "$wantfile" ] || fail "still below threshold — no want-file yet"
pass=$((pass+1))

# ── Part 4: at the threshold, write the want-file AND comment on the OLDEST ──
#            ready issue, once. The counter is at 2; the third yield reaches 3.
out="$(run_signal N_READY=2 SWARM_YIELD_THRESHOLD=3 REASON=slots-busy 2>&1)" \
  || fail "the threshold yield must still exit 0 (never red)"
[ "$(cat "$count")" = 3 ] || fail "the counter must reach 3 at the threshold"
[ -e "$wantfile" ] || fail "the threshold must write this repo's want-file"
[ -e "$postlog" ] || fail "the threshold must post a comment on the oldest ready issue"
grep -q '/issues/7/comments' "$postlog" \
  || fail "the comment must land on the OLDEST (lowest-numbered) ready issue #7, got: $(cat "$postlog")"
grep -q '/issues/9/comments' "$postlog" \
  && fail "the comment must not land on a newer issue (#9)"
[ -e "$count.signalled" ] || fail "the threshold must create the once-per-episode marker"
pass=$((pass+1))

# ── Part 5: past the threshold, no repeat comment, but the want-file refreshes ─
: > "$postlog"   # forget the first post
rm -f "$wantfile"  # prove the next tick re-writes it (keeps mtime live)
out="$(run_signal N_READY=2 SWARM_YIELD_THRESHOLD=3 2>&1)" || fail "a post-threshold yield must exit 0"
[ "$(cat "$count")" = 4 ] || fail "the counter keeps climbing past the threshold"
[ -e "$wantfile" ] || fail "every tick past the threshold must (re)write the want-file so its mtime stays live"
[ ! -s "$postlog" ] || fail "a starving repo must be COMMENTED once per episode, not every tick, got: $(cat "$postlog")"
grep -q "already signalled this episode" <<<"$out" || fail "the repeat-suppression must be reported, got: $out"
pass=$((pass+1))

# ── Part 6: a read failure leaves the counter untouched (no false reset) ────
echo 4 > "$count"; : > "$count.signalled"; : > "$postlog"; rm -f "$wantfile"
out="$(env -u MATTERMOST_URL -u MATTERMOST_BOT_TOKEN -u MATTERMOST_CHANNEL_ID \
  PATH="$tmp/bindown:$PATH" \
  FORGEJO_TOKEN=dummy FORGEJO_API=http://x/api/v1/repos/x/y \
  SWARM_YIELD_COUNT="$count" SWARM_REPO_WANTED="$wantfile" POST_LOG="$postlog" \
  bash "$root/swarm-yield-signal.sh" slots-busy 2>&1)" \
  || fail "a read-down yield must still exit 0"
grep -q "ready-set read unavailable" <<<"$out" || fail "a read failure must be reported, got: $out"
[ "$(cat "$count")" = 4 ] || fail "a read failure must NOT change the counter, got: $(cat "$count" 2>/dev/null)"
[ ! -e "$wantfile" ] || fail "a read failure must not write the want-file"
[ ! -s "$postlog" ] || fail "a read failure must not post"
pass=$((pass+1))

echo "swarm-yield-signal: $pass scenarios passed"
