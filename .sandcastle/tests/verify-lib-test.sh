#!/usr/bin/env bash
# Offline test for verify-lib.sh — the VERIFY seam of run-swarm.sh (#2): the two
# questions asked AFTER the sandcastle run says "success" and BEFORE anything
# lands.
#
#   1. Did a worker ever actually SPAWN? (#435's green wedge) A non-empty ready
#      set that concludes green with ZERO worker births is the stall that twice
#      cost hours of pure archaeology — fail LOUD instead of green-and-empty.
#   2. Did a worker edit the MACHINERY that judges its work? (#445) Fingerprint
#      `.sandcastle/`+`.forgejo/` before and after, attribute, roll back, refuse
#      to push.
#
# runlog-lib.sh owns the wedge predicate, protected-paths-lib.sh the fingerprint
# /rollback and fence-lib.sh the container bound — each with its own test. What
# lived inline in run-swarm.sh, and lives here, is the watcher lifecycle and the
# two rulings built on those primitives.
#
# Run: bash .sandcastle/tests/verify-lib-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sc="$here/.."

fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"

. "$sc/runlog-lib.sh"
. "$sc/fence-lib.sh"
. "$sc/protected-paths-lib.sh"
. "$sc/verdict-lib.sh"
. "$sc/verify-lib.sh"

export VERIFY_NOTIFY="$tmp/bin/notify.sh"
cat > "$VERIFY_NOTIFY" <<'SH'
#!/usr/bin/env bash
printf '%s\n---\n' "$1" >> "${NOTIFY_LOG:?}"
SH
chmod +x "$VERIFY_NOTIFY"
export NOTIFY_LOG="$tmp/notify.log"
swarmdb_wedge() { printf 'wedge %s %s\n' "$1" "$2" >> "$tmp/db.log"; }
swarmdb_event() { printf 'event %s %s\n' "$3" "$4" >> "$tmp/db.log"; }
swarmdb()       { printf 'swarmdb %s\n' "$*" >> "$tmp/db.log"; }

# ── 1. counting worker births ─────────────────────────────────────────────
# Sandcastle starts each iteration's worker as `docker run -d --name
# sandcastle-<uuid>`, so a `create` event whose name begins `sandcastle-` is
# proof a worker actually spawned. The earlier unnamed nix-seed containers must
# never be counted.
cap="$tmp/births"
cat > "$cap" <<'EOF'
sandcastle-worker-20260823-101112-a1b2c3
/sandcastle-worker-20260823-101500-d4e5f6
some-unrelated-container
sandcastle-worker-20260823-101112-a1b2c3
EOF
[ "$(verify_worker_count "$cap")" = 3 ] || fail "3 sandcastle-* creations expected, got $(verify_worker_count "$cap")"
[ "$(verify_born_workers "$cap" | wc -l)" = 2 ] || fail "2 DISTINCT worker names expected"
verify_born_workers "$cap" | grep -q 'unrelated' && fail "a non-sandcastle container must never count as a worker"
: > "$cap"
[ "$(verify_worker_count "$cap")" = 0 ] || fail "an empty capture counts 0, not empty-string"
[ "$(verify_worker_count "$tmp/never-written")" = 0 ] || fail "an absent capture counts 0"
pass=$((pass+1))

# ── 2. the #435 green wedge ───────────────────────────────────────────────
run_verify() { # run_verify <capture> <ready-count> -> RC
  RC=0
  verify_workers "$1" "$2" "7,9" run-1 1700000000 Acme/widget >"$tmp/out" 2>&1 || RC=$?
}

# healthy: workers born → rc 0, and each born worker is mirrored as a FINALISED
# processes row (the contrast that makes an open wedge row legible)
rm -f "$tmp/db.log" "$NOTIFY_LOG"
printf 'sandcastle-a\nsandcastle-b\n' > "$cap"
run_verify "$cap" 2
[ "$RC" = 0 ] || fail "a run with workers must pass verify, got $RC"
[ "$(grep -c 'proc-open' "$tmp/db.log" || true)" = 2 ] || fail "each born worker needs a finalised processes row: $(cat "$tmp/db.log")"
grep -q wedge "$tmp/db.log" 2>/dev/null && fail "a healthy run must not write a wedge row"
[ ! -s "$NOTIFY_LOG" ] || fail "a healthy run announces nothing here"
[ ! -f "$cap" ] || fail "the capture file must be cleaned up"
pass=$((pass+1))

# the wedge: a NON-empty ready set, sandcastle green, ZERO births → fail loud
rm -f "$tmp/db.log" "$NOTIFY_LOG"; : > "$cap"
SWARM_EXIT_REASON=""
run_verify "$cap" 2
[ "$RC" = 1 ] || fail "a green run with no worker must fail LOUD, got $RC"
[ "$SWARM_EXIT_REASON" = "no-worker-spawned" ] || fail "the wedge's reason must be named, got '$SWARM_EXIT_REASON'"
grep -q '435 green wedge' <<<"${VERDICT_STAGE:-}" || fail "the verdict stage must key on the wedge, got '${VERDICT_STAGE:-}'"
grep -q 'wedge run-1 7,9' "$tmp/db.log" || fail "the wedge must leave its swarm.db evidence: $(cat "$tmp/db.log")"
grep -q 'spawned no worker' "$NOTIFY_LOG" || fail "the wedge must alarm: $(cat "$NOTIFY_LOG")"
grep -q 'debounce stamp is cleared' "$NOTIFY_LOG" || fail "the notice must say the next trigger retries"
pass=$((pass+1))

# an EMPTY ready set is not this wedge (run-swarm exits before verify), and a
# capture that never existed (docker unavailable) is not a wedge either — a
# build/run that needed docker already failed loud
rm -f "$tmp/db.log" "$NOTIFY_LOG"; : > "$cap"
run_verify "$cap" 0
[ "$RC" = 0 ] || fail "an empty ready set must never be read as a wedge"
grep -q wedge "$tmp/db.log" 2>/dev/null && fail "an empty ready set must not write a wedge row"
pass=$((pass+1))

# ── 3. the watcher lifecycle ──────────────────────────────────────────────
# A LIVE `docker events` stream survives a 3h run where a post-hoc --since query
# could age out of the daemon's event buffer. --since replays from the run's
# start too, so a worker born in the millisecond before the stream attaches is
# still caught.
cat > "$tmp/bin/docker" <<'SH'
#!/usr/bin/env bash
echo "docker $*" >> "${DOCKER_LOG:?}"
case "${1:-}" in
  events) printf 'sandcastle-from-stream\n'; sleep 30 ;;
  *) : ;;
esac
SH
chmod +x "$tmp/bin/docker"
export DOCKER_LOG="$tmp/docker.log"
cap2="$tmp/births2"; : > "$cap2"; : > "$DOCKER_LOG"
PATH="$tmp/bin:$PATH" verify_watch_start "$cap2" 1700000000
[ -n "$VERIFY_EVENTS_PID" ] || fail "the birth watcher must be started when docker is present"
[ -n "$VERIFY_FENCE_PID" ] || fail "the D3 container fence watcher must be started alongside it (#568)"
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$cap2" ] && break; sleep 0.3; done
grep -q sandcastle-from-stream "$cap2" || fail "the stream's births must land in the capture file"
grep -q -- '--since 1700000000' "$DOCKER_LOG" || fail "the stream must replay from the run's start (no startup race)"
grep -q -- 'event=create' "$DOCKER_LOG" || fail "the stream must filter to container creations"
verify_watch_stop
[ -z "$VERIFY_EVENTS_PID" ] || fail "stopping must clear the pid so the EXIT trap never re-kills a dead one"
[ -z "$VERIFY_FENCE_PID" ] || fail "stopping must clear the fence pid too"
pass=$((pass+1))

# docker unavailable → no watcher, no false failure (the wedge check is simply
# skipped rather than reding a run)
: > "$cap2"
PATH="$tmp/empty-bin" verify_watch_start "$cap2" 1700000000 2>/dev/null || true
[ -z "$VERIFY_EVENTS_PID" ] || fail "no docker must mean no watcher, not a crash"
[ -z "$VERIFY_WATCHING" ] || fail "no docker must record that nothing is being watched"
verify_watch_stop
# …and with nothing watched, an empty capture is NOT a wedge: we simply could
# not verify. Reading "0 births" as a wedge here would red every run on a host
# without docker, where a build that needed it has already failed loud.
rm -f "$tmp/db.log" "$NOTIFY_LOG"; : > "$cap2"
run_verify "$cap2" 2
[ "$RC" = 0 ] || fail "an unverifiable run must not be called a wedge, got $RC"
[ ! -s "$NOTIFY_LOG" ] || fail "an unverifiable run must not alarm: $(cat "$NOTIFY_LOG")"
VERIFY_WATCHING=1   # restore for anything after this group
pass=$((pass+1))

# ── 4. the protected-path boundary (#445) ─────────────────────────────────
# STAGED behind PP_ENFORCE, default OFF: today the ordinary swarm still runs
# machinery tickets directly, so a live rollback would revert exactly that
# legitimate work.
ws="$tmp/ws"; mkdir -p "$ws/.sandcastle" "$ws/src"
printf 'harness\n' > "$ws/.sandcastle/run-swarm.sh"
printf 'product\n' > "$ws/src/app.ts"

VERIFY_PP_BEFORE=""; PP_ENFORCE=0 verify_pp_snapshot "$ws"
[ -z "$VERIFY_PP_BEFORE" ] || fail "PP_ENFORCE off must take no snapshot at all"
PP_ENFORCE=0 verify_protected_paths "$ws" run-1 Acme/widget || fail "PP_ENFORCE off must be a silent no-op"
pass=$((pass+1))

# enforce ON, machinery untouched → silent pass
rm -f "$tmp/db.log" "$NOTIFY_LOG"
PP_ENFORCE=1 verify_pp_snapshot "$ws"
[ -n "$VERIFY_PP_BEFORE" ] || fail "PP_ENFORCE on must fingerprint the machinery before any worker runs"
printf 'product changed by the worker\n' > "$ws/src/app.ts"   # ordinary work — not protected
cat > "$tmp/bin/git" <<'SH'
#!/usr/bin/env bash
echo "git $*" >> "${GIT_LOG:?}"
SH
chmod +x "$tmp/bin/git"
export GIT_LOG="$tmp/git.log"; : > "$GIT_LOG"
PATH="$tmp/bin:$PATH" PP_ENFORCE=1 verify_protected_paths "$ws" run-1 Acme/widget \
  || fail "an untouched machinery tree must pass the boundary"
[ ! -s "$NOTIFY_LOG" ] || fail "a silent boundary must announce nothing: $(cat "$NOTIFY_LOG")"
[ ! -s "$GIT_LOG" ] || fail "a clean run must not park a rescue branch: $(cat "$GIT_LOG")"
pass=$((pass+1))

# enforce ON, a worker edited the machinery → rolled back, NOT pushed, parked
rm -f "$tmp/db.log" "$NOTIFY_LOG"; : > "$GIT_LOG"; SWARM_EXIT_REASON=""
PP_ENFORCE=1 verify_pp_snapshot "$ws"
printf 'worker edited the harness that judges it\n' > "$ws/.sandcastle/run-swarm.sh"
RC=0
PATH="$tmp/bin:$PATH" PP_ENFORCE=1 verify_protected_paths "$ws" run-1 Acme/widget >"$tmp/pp.out" 2>&1 || RC=$?
[ "$RC" = 1 ] || fail "a protected-path violation must red the run, got $RC"
[ "$SWARM_EXIT_REASON" = "protected-path-violation" ] || fail "the reason must be named, got '$SWARM_EXIT_REASON'"
[ "$(cat "$ws/.sandcastle/run-swarm.sh")" = harness ] || fail "the worker's machinery change must be ROLLED BACK"
grep -q 'protected-path violation' "$NOTIFY_LOG" || fail "the violation must alarm: $(cat "$NOTIFY_LOG")"
grep -q 'ready-for-session' "$NOTIFY_LOG" || fail "the alarm must name the escape path (ADR 0174)"
grep -q 'push origin HEAD:refs/heads/sandcastle/rescue-' "$GIT_LOG" \
  || fail "the commits must be PARKED on a rescue branch, never pushed to main: $(cat "$GIT_LOG")"
grep -q 'push origin HEAD:main' "$GIT_LOG" && fail "a breach must NEVER reach main"
grep -q 'protected-path-violation' "$tmp/db.log" || fail "the violation must be traced in swarm.db"
pass=$((pass+1))

echo "verify-lib: $pass groups passed"
