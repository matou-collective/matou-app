#!/usr/bin/env bash
# Offline test for the DISPATCHED-leg workdir-lock wait (#388).
#
# Before #388 swarm.yml took the per-repo workdir lock with `flock -n` and
# exited 0 on a miss — fine when the cron/backstop was the scheduler ("the next
# poll re-fires"), but under the dispatcher (ADR 0009) a dispatched leg is the
# ONLY run that will work its ticket until the marker expires (~600s). A short
# same-repo BACKSTOP leg that held the lock for 30–100s threw the dispatched leg
# away in 5s, nothing told the dispatcher, and the ticket waited out the full
# marker TTL before a second dispatch worked it (~10 min + one wasted run).
#
# The fix: a leg with SWARM_TICKET set WAITS a bounded SWARM_DISPATCH_LOCK_WAIT
# (default 150s) for the lock with `flock -w` — the backstop is short, so the
# wait almost always wins and the ticket is worked in THIS run. A cron/`closed`
# leg (SWARM_TICKET empty) keeps `flock -n` and never camps (idss #238). A
# dispatched leg that still times out deletes its own `fleet-dispatch host=…`
# marker comment (#351) so the dispatcher re-offers on its next pass.
#
# This pins all four paths. The decision block is kept byte-identical to the one
# in onboarding/templates/workflows/swarm.yml.tmpl; the template is
# vendor-excluded, so a consumer's .sandcastle/tests/ runs the embedded copy
# alone, while a factory-root run also drift-checks it against the template.
# Run: bash tests/swarm-dispatch-lock-wait-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0

tmp="$(mktemp -d)"
REPO_SLUG="test-org/wd388-$$"
lock="/tmp/matou-workdir-$(printf '%s' "$REPO_SLUG" | tr '/' '-').lock"
holder=""
cleanup() { [ -n "$holder" ] && kill "$holder" 2>/dev/null || true; rm -rf "$tmp" "$lock" 2>/dev/null || true; }
trap cleanup EXIT
mkdir -p "$tmp/bin"
rm -f "$lock"

# --- the decision block, verbatim from swarm.yml.tmpl (#388), de-indented by
#     its 10-space template base. KEEP byte-identical to the template. ---
snippet="$tmp/snippet.sh"
cat > "$snippet" <<'BLOCK'
workdir_lock="/tmp/matou-workdir-$(printf '%s' "$REPO_SLUG" | tr '/' '-').lock"
exec 8>"$workdir_lock"
# #388: a DISPATCHED leg (SWARM_TICKET set) is the ONLY run that will work
# its ticket until the dispatch marker expires (~FLEET_QUEUE_MARK_TTL=600s),
# so a short-lived same-repo BACKSTOP leg that holds this lock for 30–100s
# (a `closed`/cron tick that only stands down, #384's sibling — it is not
# placed by the dispatcher and so cannot be avoided by #384's held-repos
# rule) must not throw the dispatched leg away. A dispatched leg therefore
# WAITS a bounded SWARM_DISPATCH_LOCK_WAIT (default 150s) for the lock with
# `flock -w`: the backstop is short, so the wait almost always wins and the
# ticket is worked in THIS run — no second dispatch ~10 min later. It holds
# a heavy slot (fd 9, still open) while it waits; that is the accepted cost.
# A cron/`closed` leg is NOT placed by the dispatcher and the next
# cron/backstop re-fires it, so it keeps `flock -n` and NEVER camps
# (idss #238 — the never-camp rule was about polls, not a placed run). If a
# dispatched leg STILL can't get the lock before the deadline, it deletes
# its own dispatch marker so the dispatcher re-offers on its next ~17s pass
# instead of after the full marker TTL; #384 then keeps the re-offer off a
# host that genuinely runs this repo. FORGEJO_API already includes
# /repos/<slug>, so the marker (a `fleet-dispatch host=…` comment, #351) is
# deleted by its comment id; best-effort, a tracker error never changes the
# clean yield exit (the marker's own TTL still frees the ticket as before).
release_dispatch_marker() { # release_dispatch_marker <ticket>
  local n="$1" ids id
  [ -n "${n:-}" ] && [ -n "${FORGEJO_TOKEN:-}" ] && [ -n "${FORGEJO_API:-}" ] || return 0
  ids="$(curl -sf -H "Authorization: token $FORGEJO_TOKEN" "$FORGEJO_API/issues/$n/comments" 2>/dev/null |
    jq -r '[ .[]? | select((.body // "") | test("^fleet-dispatch host=")) | .id ] | .[]' 2>/dev/null)" || return 0
  for id in $ids; do
    curl -sf -X DELETE -H "Authorization: token $FORGEJO_TOKEN" "$FORGEJO_API/issues/comments/$id" >/dev/null 2>&1 || true
  done
}
if [ -n "${SWARM_TICKET:-}" ]; then
  if ! flock -w "${SWARM_DISPATCH_LOCK_WAIT:-150}" 8; then
    echo "swarm: workdir $workdir still busy after waiting ${SWARM_DISPATCH_LOCK_WAIT:-150}s for dispatched ticket #$SWARM_TICKET — releasing its dispatch marker so the dispatcher can re-offer; the next pass re-fires"
    release_dispatch_marker "$SWARM_TICKET"
    exit 0
  fi
elif ! flock -n 8; then
  echo "swarm: workdir $workdir busy with another job for this repo — yielding; the cron/backstop re-fires"
  exit 0
fi
BLOCK

# --- drift guard (factory root only; the template is vendor-excluded) ---
tmpl="$here/../onboarding/templates/workflows/swarm.yml.tmpl"
if [ -f "$tmpl" ]; then
  extracted="$tmp/extracted.sh"
  awk '/workdir_lock="\/tmp\/matou-workdir/{f=1} f{if($0 ~ /^[[:space:]]*cd "\$workdir"$/) exit; print}' \
    "$tmpl" | sed 's/^          //' > "$extracted"
  diff -u "$extracted" "$snippet" \
    || fail "the #388 workdir-lock block has drifted from swarm.yml.tmpl — update this test in the same commit"
  pass=$((pass+1))
fi

# --- a curl shim: GET returns a marker comment (id 111) + a non-marker comment
#     (id 222); every call is logged so we can assert what was deleted. ---
cat > "$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
log="${CURL_LOG:?}"; method=GET; url=""; prev=""
for a in "$@"; do
  [ "$prev" = "-X" ] && method="$a"
  case "$a" in http://*|https://*) url="$a";; esac
  prev="$a"
done
echo "$method $url" >> "$log"
if [ "$method" = GET ]; then
  printf '%s' '[{"id":111,"body":"fleet-dispatch host=bens-mac-04\n(automated note)"},{"id":222,"body":"swarm-claim host=x run=1"}]'
fi
exit 0
SH
chmod +x "$tmp/bin/curl"

# run_block <extra KEY=VALUE env...> : run the snippet in its own process; stdout
# is captured, exit code returned, marker-release curl calls logged to curl.log.
run_block() {
  : > "$tmp/curl.log"
  env PATH="$tmp/bin:$PATH" CURL_LOG="$tmp/curl.log" \
      REPO_SLUG="$REPO_SLUG" workdir="/tmp/wd-$$" \
      FORGEJO_TOKEN="t" FORGEJO_API="http://fake/api/v1/repos/test/repo" \
      "$@" \
      bash -c 'set -euo pipefail; source "$1"; echo PROCEEDED' _ "$snippet"
}

# hold the workdir lock for <secs> in a background process, then wait until it is
# actually held (so a scenario never races the holder's acquire).
hold_lock() { # hold_lock <secs>
  rm -f "$tmp/ready"
  ( exec 8>"$lock"; flock -x 8; echo held > "$tmp/ready"; exec sleep "$1" ) &
  holder=$!
  for _ in $(seq 1 50); do [ -s "$tmp/ready" ] && break; sleep 0.1; done
  [ -s "$tmp/ready" ] || fail "the lock holder never acquired — test setup broken"
}
release_holder() { if [ -n "$holder" ]; then kill "$holder" 2>/dev/null || true; wait "$holder" 2>/dev/null || true; fi; holder=""; }

# --- 1. dispatched leg, FREE lock: acquires and proceeds, no marker touched ---
if out="$(run_block SWARM_TICKET=388 SWARM_DISPATCH_LOCK_WAIT=10)"; then :; else fail "scenario 1 exited non-zero"; fi
printf '%s' "$out" | grep -q PROCEEDED || fail "a dispatched leg with a free lock must proceed, got: $out"
[ -s "$tmp/curl.log" ] && fail "a leg that acquired the lock must not touch the dispatch marker"
pass=$((pass+1))

# --- 2. dispatched leg, lock held then released inside the window: WAITS, then
#        acquires and proceeds (does NOT yield like flock -n would) ---
hold_lock 2
start="$(date +%s)"
out="$(run_block SWARM_TICKET=388 SWARM_DISPATCH_LOCK_WAIT=10)" || fail "scenario 2 exited non-zero"
elapsed="$(( $(date +%s) - start ))"
release_holder
printf '%s' "$out" | grep -q PROCEEDED || fail "a dispatched leg must wait out a short holder and proceed, got: $out"
[ "$elapsed" -ge 1 ] || fail "the dispatched leg did not actually wait (${elapsed}s) — it is still flock -n"
[ "$elapsed" -lt 10 ] || fail "the dispatched leg camped the whole window instead of acquiring on release (${elapsed}s)"
[ -s "$tmp/curl.log" ] && fail "a leg that eventually acquired must not release its marker"
pass=$((pass+1))

# --- 3. dispatched leg, lock held past the deadline: times out, RELEASES its
#        dispatch marker (deletes only the fleet-dispatch comment), yields 0 ---
hold_lock 30
start="$(date +%s)"
out="$(run_block SWARM_TICKET=388 SWARM_DISPATCH_LOCK_WAIT=1)" || fail "scenario 3 exited non-zero"
elapsed="$(( $(date +%s) - start ))"
release_holder
printf '%s' "$out" | grep -q "releasing its dispatch marker" \
  || fail "a timed-out dispatched leg must announce the marker release, got: $out"
printf '%s' "$out" | grep -q PROCEEDED && fail "a timed-out dispatched leg must NOT proceed into the run"
[ "$elapsed" -lt 10 ] || fail "the bounded wait did not bound (${elapsed}s) — flock -w is not honouring the deadline"
grep -q "DELETE .*/issues/comments/111" "$tmp/curl.log" \
  || fail "the dispatch marker comment (id 111) was not deleted; log: $(cat "$tmp/curl.log")"
grep -q "DELETE .*/issues/comments/222" "$tmp/curl.log" \
  && fail "a non-marker comment (id 222) must not be deleted"
pass=$((pass+1))

# --- 4. cron/`closed` leg (SWARM_TICKET empty), lock held: yields IMMEDIATELY
#        via flock -n (never camps), touches no marker ---
hold_lock 30
start="$(date +%s)"
out="$(run_block SWARM_TICKET=)" || fail "scenario 4 exited non-zero"
elapsed="$(( $(date +%s) - start ))"
release_holder
printf '%s' "$out" | grep -q "busy with another job" \
  || fail "a cron/closed leg must yield on a held lock, got: $out"
printf '%s' "$out" | grep -q PROCEEDED && fail "a cron/closed leg must not proceed on a held lock"
[ "$elapsed" -lt 5 ] || fail "a cron/closed leg camped ${elapsed}s instead of yielding fast — it is not flock -n"
[ -s "$tmp/curl.log" ] && fail "a cron/closed leg must never release a dispatch marker"
pass=$((pass+1))

echo "swarm-dispatch-lock-wait: $pass groups passed"
