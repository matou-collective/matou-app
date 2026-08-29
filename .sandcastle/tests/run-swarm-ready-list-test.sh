#!/usr/bin/env bash
# Offline test for the ready-list read's transient-5xx robustness and death
# attribution (#52) — sibling of run-swarm-cold-store-test.sh /
# run-swarm-env-guard-test.sh.
#
# Incident run 421 reddened with `stage=preflight self-tests (#446) exit=22` and
# an EMPTY error block while preflight had actually PASSED: a transient Forgejo
# 5xx made `curl -sf` in list-ready-tasks.sh exit 22, which propagated up through
# `set -e` and killed run-swarm while VERDICT_STAGE was still the preflight
# marker. That is GOTCHAS #7's implicit-`set -e` sibling — the FATAL-to-stderr
# guards were re-keyed there, this death-inside-a-`$(...)`-assignment was not.
# Two defects compounded: (a) the ready-list read had no retry/backoff and no
# `--max-time`; (b) the death was mis-keyed to preflight with no evidence.
#
# This drives the REAL list-ready-tasks.sh through schedule_list_ready_or_verdict
# with a shimmed curl, proving BOTH halves: a persistent 503 re-keys the death to
# the "list ready tasks" stage with a non-empty error line the healer recovers
# (never the stale preflight marker), and a transient blip — on the ready-list
# read AND on the 10-wide dependency read — is absorbed by the retry.
#
# Run: bash .sandcastle/tests/run-swarm-ready-list-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sc="$here/.."
. "$sc/verdict-lib.sh"
. "$sc/heal-lib.sh"          # seam_verdict_signal — the healer's reader
. "$sc/host-capacity-lib.sh"
. "$sc/model-lib.sh"
. "$sc/schedule-lib.sh"      # schedule_list_ready_or_verdict → real list-ready-tasks.sh

fail() { echo "FAIL: $1" >&2; exit 1; }
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
pass=0

export FORGEJO_TOKEN="ftok"
export FORGEJO_API="http://fj.test/api/v1/repos/Matou/dev-factory"
# Fast, deterministic retries: no backoff sleep, three attempts.
export LIST_READY_BACKOFF=0 LIST_READY_RETRIES=3
export FAKE_CURL_DIR="$tmp"

# A shimmed curl on PATH, driving the REAL list-ready-tasks.sh. Two countdown
# files simulate a degraded forge: while >0 the matching endpoint answers the way
# `curl -sf` answers an HTTP ≥400 (rc 22, no body) and decrements; at 0 it serves
# canned JSON. `curl-fails` covers the ready-for-agent + standing-drive listings;
# `deps-fails` covers the 10-wide dependency GET specifically.
bin="$tmp/bin"; mkdir -p "$bin"
cat > "$bin/curl" <<'SH'
#!/usr/bin/env bash
url=""
while [ $# -gt 0 ]; do
  case "$1" in
    --max-time|-H|-o|-w|-d|-X) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
maybe_fail() {  # <countdown-file> -> rc 1 (and decrement) while the count is >0
  local f="$FAKE_CURL_DIR/$1" n
  [ -f "$f" ] || return 0
  n="$(cat "$f")"
  [ "$n" -gt 0 ] || return 0
  echo $((n - 1)) >"$f"
  return 1
}
printf '%s\n' "$url" >>"$FAKE_CURL_DIR/urls.log"
case "$url" in
  */dependencies*)
    maybe_fail deps-fails || exit 22
    printf '%s' '[]' ;;
  *labels=ready-for-agent*)
    maybe_fail curl-fails || exit 22
    printf '%s' '[{"number":7,"title":"seven","labels":[{"name":"ready-for-agent"}],"html_url":"u/7","body":"b"}]' ;;
  *labels=standing-drive*)
    maybe_fail curl-fails || exit 22
    printf '%s' '[]' ;;
  *)
    printf '%s' '[]' ;;
esac
SH
chmod +x "$bin/curl"
export PATH="$bin:$PATH"

vp="$tmp/verdict.txt"; of="$tmp/ready.json"

# --- 1. A PERSISTENT 503 on the ready-list: the death is re-keyed to the
#        "list ready tasks" stage with a non-empty error line the healer
#        recovers — NOT the stale preflight marker with an empty block. ---
echo 99 > "$tmp/curl-fails"; rm -f "$tmp/deps-fails"
verdict_begin "$vp"
verdict_stage "preflight self-tests (#446)"     # the last stage set before listing
rc=0; schedule_list_ready_or_verdict "$of" || rc=$?
[ "$rc" -ne 0 ] || fail "a persistent 503 on the ready-list must fail the listing"
verdict_write "$rc"                              # run-swarm's EXIT trap does this
grep -q '^stage=list ready tasks$' "$vp" || fail "death mis-keyed — not re-keyed to the list stage:
$(cat "$vp")"
err="$(sed -n '/^--- error lines ---$/,$p' "$vp" | sed '1d' | grep -E '[^[:space:]]' || true)"
[ -n "$err" ] || fail "the verdict must carry a non-empty error line:
$(cat "$vp")"
sig="$(seam_verdict_signal "$vp")"
[ -n "$sig" ] || fail "the healer got an EMPTY signal — would escalate unknown"
case "$sig" in *"preflight self-tests"*) fail "signal still keyed on the stale preflight stage: $sig";; esac
case "$sig" in "list ready tasks ::"*) : ;; *) fail "signal must name the list stage: $sig";; esac
reason="died-in:${VERDICT_STAGE:-unknown}"       # run-swarm's on_exit reason derivation
[ "$reason" = "died-in:list ready tasks" ] || fail "runlog reason mis-keyed: $reason"
pass=$((pass+1))

# --- 2. Teeth/contrast — the PRE-#52 path: the OLD `ready="$(schedule_ready_tasks)"`
#        call with the stage left at preflight reproduces the exact 20 h symptom
#        (mis-keyed to preflight, empty error block), proving the assertions above
#        have teeth. ---
echo 99 > "$tmp/curl-fails"; rm -f "$tmp/deps-fails"
verdict_begin "$vp"
verdict_stage "preflight self-tests (#446)"
rc=0; ready="$(schedule_ready_tasks 2>/dev/null)" || rc=$?
[ "$rc" -ne 0 ] || fail "the buggy variant must still see the lister fail"
verdict_write "$rc"
grep -q '^stage=preflight self-tests (#446)$' "$vp" || fail "buggy variant should mis-key to preflight:
$(cat "$vp")"
err="$(sed -n '/^--- error lines ---$/,$p' "$vp" | sed '1d' | grep -E '[^[:space:]]' || true)"
[ -z "$err" ] || fail "buggy variant should have an EMPTY error block, got: $err"
pass=$((pass+1))

# --- 3. A TRANSIENT blip on the ready-list (one 503 then healthy) is absorbed by
#        the retry: the listing succeeds and the ready set comes through. ---
echo 1 > "$tmp/curl-fails"; rm -f "$tmp/deps-fails"
verdict_begin "$vp"
verdict_stage "list ready tasks"
schedule_list_ready_or_verdict "$of" || fail "a single transient 503 must be absorbed by the retry"
verdict_write 0
[ ! -f "$vp" ] || fail "an absorbed blip must leave no verdict behind"
jq -e '.[0].number == 7' "$of" >/dev/null || fail "the ready set must come through after the retry"
[ "$(cat "$tmp/curl-fails")" = 0 ] || fail "the retry must have consumed the transient failure (count not spent)"
pass=$((pass+1))

# --- 4. A TRANSIENT blip on the 10-wide DEPENDENCY read (list-ready-tasks.sh:96)
#        is absorbed too — the blocker check retries rather than aborting the
#        whole listing. ---
rm -f "$tmp/curl-fails"; echo 1 > "$tmp/deps-fails"
verdict_begin "$vp"
verdict_stage "list ready tasks"
schedule_list_ready_or_verdict "$of" || fail "a single transient 503 on the dependency read must be absorbed"
verdict_write 0
[ ! -f "$vp" ] || fail "an absorbed dependency blip must leave no verdict behind"
jq -e '.[0].number == 7' "$of" >/dev/null || fail "the unblocked ticket must survive the dependency-read retry"
[ "$(cat "$tmp/deps-fails")" = 0 ] || fail "the dependency retry must have consumed the transient failure"
pass=$((pass+1))

echo "run-swarm-ready-list: $pass scenarios passed"
