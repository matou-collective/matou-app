#!/usr/bin/env bash
# Offline test for ci-sweep.sh (#548). curl is shimmed on PATH: it serves canned
# actions/tasks, branch-commit and per-sha status listings, and logs any
# workflow_dispatch POST to $DISPATCH_LOG so the assertions can see which shas
# the sweep fired for. Mirrors tests/pr-e2e-sweep-test.sh.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sweep="$(cd "$here/.." && pwd)/ci-sweep.sh"
fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/statuses"

cat > "$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
url="" data=""
while [ $# -gt 0 ]; do
  case "$1" in
    -X) shift 2 ;;
    -d) data="$2"; shift 2 ;;
    -H|--max-time) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  *actions/tasks*) cat "$TASKS_JSON" ;;
  *dispatches*) printf '%s\n' "$(printf '%s' "$data" | jq -r '.inputs.sha')" >> "$DISPATCH_LOG" ;;
  *statuses/*)
    sha="${url##*/statuses/}"; sha="${sha%%\?*}"
    if [ -f "$STATUS_DIR/$sha.json" ]; then cat "$STATUS_DIR/$sha.json"; else echo '[]'; fi ;;
  *commits*) cat "$COMMITS_JSON" ;;
  *) echo '[]' ;;
esac
SH
chmod +x "$tmp/bin/curl"

export PATH="$tmp/bin:$PATH" FORGEJO_TOKEN=dummy \
  FORGEJO_API=http://x/api/v1/repos/Acme/widget \
  TASKS_JSON="$tmp/tasks.json" COMMITS_JSON="$tmp/commits.json" \
  STATUS_DIR="$tmp/statuses" DISPATCH_LOG="$tmp/dispatch.log"

echo '{"workflow_runs":[]}' > "$tmp/tasks.json"
# newest-first, as the API returns them
printf '[{"sha":"ccc3"},{"sha":"bbb2"},{"sha":"aaa1"}]\n' > "$tmp/commits.json"
deferred() { printf '[{"context":"ci / capacity-deferred","status":"pending"}]\n' > "$STATUS_DIR/$1.json"; }
resolved() { printf '[{"context":"ci / capacity-deferred","status":"success"},{"context":"ci / capacity-deferred","status":"pending"}]\n' > "$STATUS_DIR/$1.json"; }

# --- 1. a deferred sha is re-dispatched ---
: > "$tmp/dispatch.log"; rm -f "$STATUS_DIR"/*.json; deferred bbb2
out="$(bash "$sweep")"
grep -qx 'bbb2' "$tmp/dispatch.log" || fail "the deferred sha must be dispatched:
$out
dispatched: $(cat "$tmp/dispatch.log")"
[ "$(wc -l < "$tmp/dispatch.log")" = 1 ] || fail "only the deferred sha may be dispatched:
$(cat "$tmp/dispatch.log")"
pass=$((pass+1))

# --- 2. nothing owed -> no dispatch ---
: > "$tmp/dispatch.log"; rm -f "$STATUS_DIR"/*.json
out="$(bash "$sweep")"
[ ! -s "$tmp/dispatch.log" ] || fail "a sha with no deferral marker must not be dispatched"
grep -q 'nothing to do' <<<"$out" || fail "the quiet path must say so: $out"
pass=$((pass+1))

# --- 3. a sha already re-run (newest status success) is retired ---
: > "$tmp/dispatch.log"; rm -f "$STATUS_DIR"/*.json; resolved bbb2
out="$(bash "$sweep")"
[ ! -s "$tmp/dispatch.log" ] || fail "a resolved sha must not be dispatched again — the sweep must be idempotent:
$out"
pass=$((pass+1))

# --- 4. ci already in flight -> stand down (never pile on) ---
: > "$tmp/dispatch.log"; rm -f "$STATUS_DIR"/*.json; deferred bbb2
echo '{"workflow_runs":[{"name":"checks","status":"running"}]}' > "$tmp/tasks.json"
out="$(bash "$sweep")"
[ ! -s "$tmp/dispatch.log" ] || fail "the sweep must not dispatch while a ci run is in flight"
grep -q 'standing down' <<<"$out" || fail "the stand-down must say so: $out"
echo '{"workflow_runs":[]}' > "$tmp/tasks.json"
pass=$((pass+1))

# --- 5. oldest first, capped at CI_SWEEP_MAX ---
: > "$tmp/dispatch.log"; rm -f "$STATUS_DIR"/*.json; deferred aaa1; deferred bbb2; deferred ccc3
out="$(bash "$sweep")"
[ "$(cat "$tmp/dispatch.log")" = "aaa1" ] \
  || fail "the budget must go to the OLDEST owed sha first, got: $(cat "$tmp/dispatch.log")"
: > "$tmp/dispatch.log"
CI_SWEEP_MAX=2 bash "$sweep" >/dev/null
[ "$(cat "$tmp/dispatch.log")" = "aaa1
bbb2" ] || fail "CI_SWEEP_MAX must cap the dispatches, oldest first, got: $(cat "$tmp/dispatch.log")"
pass=$((pass+1))

# --- 6. fail CLOSED when the tasks API is unavailable ---
: > "$tmp/dispatch.log"; rm -f "$STATUS_DIR"/*.json; deferred bbb2
cat > "$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
for a in "$@"; do case "$a" in *actions/tasks*) exit 22 ;; esac; done
echo '[]'
SH
chmod +x "$tmp/bin/curl"
# 2>&1: the fail-closed reason is a stderr line (it is a degradation, not a result).
out="$(bash "$sweep" 2>&1)"
[ ! -s "$tmp/dispatch.log" ] || fail "a degraded tasks API must not dispatch blind (fail closed)"
grep -q 'skipping this tick' <<<"$out" || fail "the closed path must say why: $out"
pass=$((pass+1))

echo "ci-sweep: $pass scenarios passed"
