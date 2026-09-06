#!/usr/bin/env bash
# Offline test for pr-e2e-sweep.sh (#278). curl is shimmed on PATH: it serves
# canned actions/tasks, open-PR, and per-PR comment listings, and logs any
# workflow_dispatch POST to $DISPATCH_LOG so the assertions can see which PRs
# the sweep fired for.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/comments"

# GET actions/tasks -> $TASKS_JSON; GET pulls?state=open -> $PULLS_JSON;
# GET issues/<n>/comments -> $COMMENTS_DIR/<n>.json (or [] if absent);
# POST .../dispatches -> record the pr_number from -d payload to $DISPATCH_LOG.
cat > "$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
url="" method=GET data=""
while [ $# -gt 0 ]; do
  case "$1" in
    -X) method="$2"; shift 2 ;;
    -d) method=POST; data="$2"; shift 2 ;;
    -H|--max-time) shift 2 ;;
    -sf|-s|-f) shift ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  *actions/tasks*) cat "$TASKS_JSON" ;;
  *dispatches*)
    n="$(printf '%s' "$data" | jq -r '.inputs.pr_number')"
    printf '%s\n' "$n" >> "$DISPATCH_LOG" ;;
  *pulls?state=open*|*"pulls?state=open"*) cat "$PULLS_JSON" ;;
  */issues/*/comments*)
    n="${url#*/issues/}"; n="${n%%/comments*}"
    f="$COMMENTS_DIR/$n.json"; [ -f "$f" ] && cat "$f" || echo '[]' ;;
  *) echo "fake curl: unhandled $method $url" >&2; exit 22 ;;
esac
SH
chmod +x "$tmp/bin/curl"

run_sweep() {
  : > "$tmp/dispatch.log"
  env PATH="$tmp/bin:$PATH" FORGEJO_TOKEN=dummy \
    FORGEJO_API=http://x/api/v1/repos/Matou/matou-app \
    TASKS_JSON="$tmp/tasks.json" PULLS_JSON="$tmp/pulls.json" \
    COMMENTS_DIR="$tmp/comments" DISPATCH_LOG="$tmp/dispatch.log" \
    "${@:2}" bash "$here/../pr-e2e-sweep.sh" >"$tmp/out" 2>&1 || fail "sweep exited non-zero: $1
$(cat "$tmp/out")"
}
dispatched_prs() { sort -n "$tmp/dispatch.log" 2>/dev/null | tr '\n' ' '; }

no_inflight='{"workflow_runs":[]}'

# --- in-flight feature-e2e SUPPRESSES the whole tick -------------------------
echo '{"workflow_runs":[{"name":"feature-e2e","status":"running"}]}' > "$tmp/tasks.json"
echo '[{"number":10,"head":{"sha":"aaa"}}]' > "$tmp/pulls.json"
run_sweep "inflight running"
[ -z "$(dispatched_prs)" ] || fail "a running feature-e2e must suppress the whole tick (got: $(dispatched_prs))"
pass=$((pass+1))

# a WAITING feature-e2e (queued) also suppresses
echo '{"workflow_runs":[{"name":"feature-e2e","status":"waiting"}]}' > "$tmp/tasks.json"
run_sweep "inflight waiting"
[ -z "$(dispatched_prs)" ] || fail "a waiting feature-e2e must suppress the tick"
pass=$((pass+1))

# a matrix-suffixed name is still recognised as feature-e2e
echo '{"workflow_runs":[{"name":"feature-e2e (1)","status":"running"}]}' > "$tmp/tasks.json"
run_sweep "inflight matrix"
[ -z "$(dispatched_prs)" ] || fail "feature-e2e (1) must count as in-flight"
pass=$((pass+1))

# an UNRELATED workflow in flight does NOT suppress
echo '{"workflow_runs":[{"name":"swarm (1)","status":"running"}]}' > "$tmp/tasks.json"
echo '[{"number":10,"head":{"sha":"aaa"}}]' > "$tmp/pulls.json"
: > "$tmp/comments/10.json"; echo '[]' > "$tmp/comments/10.json"
run_sweep "unrelated inflight"
[ "$(dispatched_prs)" = "10 " ] || fail "an unrelated in-flight run must not suppress the sweep (got: $(dispatched_prs))"
pass=$((pass+1))

# --- evidence gating: done verdict for the head is skipped; pending/none fire -
echo "$no_inflight" > "$tmp/tasks.json"
echo '[{"number":10,"head":{"sha":"deadbeef"}},{"number":11,"head":{"sha":"cafe"}},{"number":12,"head":{"sha":"f00d"}}]' > "$tmp/pulls.json"
# 10: a real done verdict for its head -> skip
printf '%s' '[{"body":"<!-- pr-e2e -->\n<!-- pr-e2e-meta sha=deadbeef state=done -->\nx"}]' > "$tmp/comments/10.json"
# 11: only a pending placeholder -> fire
printf '%s' '[{"body":"<!-- pr-e2e -->\n<!-- pr-e2e-meta sha=cafe state=pending -->\nx"}]' > "$tmp/comments/11.json"
# 12: no comments at all -> fire
echo '[]' > "$tmp/comments/12.json"
run_sweep "evidence gating"
[ "$(dispatched_prs)" = "11 12 " ] || fail "must dispatch only PRs whose head lacks a done verdict (got: $(dispatched_prs))"
pass=$((pass+1))

# a done verdict for a STALE sha (head moved) is not evidence -> fire
printf '%s' '[{"body":"<!-- pr-e2e -->\n<!-- pr-e2e-meta sha=OLDSHA state=done -->\nx"}]' > "$tmp/comments/10.json"
echo '[{"number":10,"head":{"sha":"deadbeef"}}]' > "$tmp/pulls.json"
run_sweep "stale verdict"
[ "$(dispatched_prs)" = "10 " ] || fail "a done verdict for a stale sha must NOT count as evidence (got: $(dispatched_prs))"
pass=$((pass+1))

# --- per-tick cap: oldest first, at most PR_E2E_SWEEP_MAX --------------------
echo "$no_inflight" > "$tmp/tasks.json"
# pulls listing is sort=oldest, so the shim returns them oldest-first already.
echo '[{"number":1,"head":{"sha":"s1"}},{"number":2,"head":{"sha":"s2"}},{"number":3,"head":{"sha":"s3"}}]' > "$tmp/pulls.json"
for n in 1 2 3; do echo '[]' > "$tmp/comments/$n.json"; done
run_sweep "cap" PR_E2E_SWEEP_MAX=2
[ "$(dispatched_prs)" = "1 2 " ] || fail "cap must dispatch the 2 oldest only (got: $(dispatched_prs))"
pass=$((pass+1))

# --- nothing to do: every head already has a verdict -> no dispatch ----------
echo "$no_inflight" > "$tmp/tasks.json"
echo '[{"number":1,"head":{"sha":"s1"}}]' > "$tmp/pulls.json"
printf '%s' '[{"body":"<!-- pr-e2e -->\n<!-- pr-e2e-meta sha=s1 state=done -->\nx"}]' > "$tmp/comments/1.json"
run_sweep "nothing to do"
[ -z "$(dispatched_prs)" ] || fail "no candidate must mean no dispatch (got: $(dispatched_prs))"
grep -q 'nothing to do' "$tmp/out" || fail "must log the nothing-to-do summary"
pass=$((pass+1))

# --- fail closed: actions/tasks unavailable -> skip, no dispatch -------------
cat > "$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
url=""; for a in "$@"; do case "$a" in http*) url="$a";; esac; done
case "$url" in *actions/tasks*) exit 22 ;; *dispatches*) echo BAD >> "$DISPATCH_LOG" ;; esac
SH
chmod +x "$tmp/bin/curl"
run_sweep "tasks api down"
[ -z "$(dispatched_prs)" ] || fail "a tasks-API failure must fail closed (no dispatch)"
grep -q 'skipping this tick' "$tmp/out" || fail "must log the skip on tasks-API failure"
pass=$((pass+1))

echo "pr-e2e-sweep: $pass scenarios passed"
