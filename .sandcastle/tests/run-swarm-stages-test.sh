#!/usr/bin/env bash
# Offline test for run-swarm.sh AS AN ORCHESTRATOR (#2).
#
# Every stage's logic now lives in its own library with its own test; what is
# left for this file to prove is the thing no per-seam test can — that
# run-swarm.sh still WIRES those seams, in the documented order, and has not
# quietly regrown any of them inline. Two halves:
#
#   1. a real whole-script run, offline, as far as the empty-ready-set exit —
#      which genuinely executes sourcing all 15 libs, the identity contract, the
#      drive-yield gate, trap arming, the verdict, the preflight + policy gates,
#      the janitor, the ready set, and the EXIT trap's runlog line;
#   2. structural assertions that each seam's entry point is called and that the
#      call order matches the header's stage list.
#
# Run: bash .sandcastle/tests/run-swarm-stages-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sc="$here/.."
rs="$sc/run-swarm.sh"

fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"

# ── half 1: a real run, offline, to the empty-ready-set exit ──────────────
# curl answers the only two tracker calls this path makes: the janitor's sweep
# (nothing stale) and policy_validate's label list (the core loop-in labels are
# minted, so the DEFAULT policy validates).
cat > "$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
url=""
for a in "$@"; do case "$a" in http*) url="$a" ;; esac; done
echo "$url" >> "${CURL_LOG:?}"
case "$url" in
  */labels*) echo '[{"id":1,"name":"ready-for-human"},{"id":2,"name":"agent-blocked"},{"id":3,"name":"needs-info"}]' ;;
  *) echo '[]' ;;
esac
SH
chmod +x "$tmp/bin/curl"

cat > "$tmp/preflight" <<'SH'
#!/usr/bin/env bash
echo "PREFLIGHT OK: (stub)"
SH
cat > "$tmp/list-ready-empty" <<'SH'
#!/usr/bin/env bash
printf '[]'
SH
chmod +x "$tmp/preflight" "$tmp/list-ready-empty"

verdict="$tmp/verdict.txt"; runlog="$tmp/runlog.txt"; curl_log="$tmp/curl.log"

run_swarm() { # run_swarm [extra env assignments...] -> stdout+stderr, sets RC
  RC=0
  out="$(env -u MATTERMOST_URL -u MATTERMOST_BOT_TOKEN -u MATTERMOST_CHANNEL_ID \
    -u GITHUB_ACTIONS -u RUN_URL \
    PATH="$tmp/bin:$PATH" \
    FORGEJO_TOKEN=dummy FORGEJO_API=http://x/api/v1/repos/Acme/widget \
    REPO_SLUG=Acme/widget SWARM_HOST=box1 \
    HOST_CAPACITY_DRIVE_WANTED="$tmp/no-such-reservation" \
    SWARM_DRIVE_DEFER_COUNT="$tmp/defer" \
    SWARM_VERDICT_PATH="$verdict" SWARM_RUNLOG="$runlog" \
    SWARM_DEBOUNCE_STAMP="$tmp/stamp" \
    SWARM_DB="$tmp/swarm.db" \
    PREFLIGHT_SCRIPT="$tmp/preflight" \
    CURL_LOG="$curl_log" \
    "$@" bash "$rs" 2>&1)" || RC=$?
}

rm -f "$verdict" "$runlog" "$tmp/stamp"; : > "$curl_log"
run_swarm SCHEDULE_LIST_READY="$tmp/list-ready-empty"
[ "$RC" = 0 ] || fail "an empty ready set is a clean exit 0, got $RC:
$out"
grep -q 'PREFLIGHT OK: (stub)' <<<"$out" || fail "the preflight gate must have run: $out"
grep -q 'policy: defaults (LANDING=push MERGE_AUTHORITY=human)' <<<"$out" \
  || fail "the policy gate must have run and logged its knobs: $out"
grep -q 'run-swarm: no ready tasks' <<<"$out" || fail "an empty set must say so: $out"
[ ! -f "$verdict" ] || fail "a clean exit must leave no verdict: $(cat "$verdict")"
pass=$((pass+1))

# the EXIT trap fired and wrote the host-side runlog line with the NAMED reason —
# #435's whole point: the next stall is readable off disk, not off the API
grep -q 'repo=Acme/widget' "$runlog" || fail "the run must land a runlog line: $(cat "$runlog")"
grep -q 'reason=no-ready-tasks' "$runlog" || fail "the exit reason must be named, not derived: $(cat "$runlog")"
grep -q 'exit=0' "$runlog" || fail "the runlog must carry the exit code: $(cat "$runlog")"
pass=$((pass+1))

# the drive-reservation gate short-circuits BEFORE any of that — no tracker call,
# no verdict, no runlog line (proven end-to-end in run-swarm-drive-yield-test.sh;
# asserted here as the FIRST stage in the sequence)
rm -f "$verdict" "$runlog" "$tmp/defer"; : > "$curl_log"
: > "$tmp/drive-wanted"
run_swarm SCHEDULE_LIST_READY="$tmp/list-ready-empty" HOST_CAPACITY_DRIVE_WANTED="$tmp/drive-wanted"
[ "$RC" = 0 ] || fail "a drive yield must exit 0, got $RC: $out"
grep -q 'yielding this run to a ready drive' <<<"$out" || fail "the yield must be reported: $out"
[ ! -s "$curl_log" ] || fail "the yield must precede EVERY tracker call: $(cat "$curl_log")"
[ ! -s "$runlog" ] 2>/dev/null || fail "a yield is not a recorded run: $(cat "$runlog")"
pass=$((pass+1))

# a red preflight aborts BEFORE the janitor mutates a label or a worker spawns
cat > "$tmp/preflight-red" <<'SH'
#!/usr/bin/env bash
echo "PREFLIGHT RED: a guard did not fire"
exit 1
SH
chmod +x "$tmp/preflight-red"
rm -f "$verdict" "$runlog"; : > "$curl_log"
run_swarm SCHEDULE_LIST_READY="$tmp/list-ready-empty" PREFLIGHT_SCRIPT="$tmp/preflight-red"
[ "$RC" = 1 ] || fail "a red preflight must red the run, got $RC: $out"
grep -q 'reason=preflight-red' "$runlog" || fail "the runlog must name the preflight refusal: $(cat "$runlog")"
grep -q 'no ready tasks' <<<"$out" && fail "a red preflight must abort BEFORE listing / claiming"
grep -q '^stage=preflight self-tests' "$verdict" || fail "the verdict must key on the preflight stage:
$(cat "$verdict")"
pass=$((pass+1))

# ── half 2: the orchestrator is still a SEQUENCE, in order ────────────────
# One entry point per seam, each in its own library. If a stage's logic is ever
# pasted back inline, its call disappears and this reds.
# First non-comment line calling <fn> (the header's own stage list is prose).
stage_line() {
  grep -nE "(^|[^[:alnum:]_])$1($|[^[:alnum:]_])" "$rs" \
    | grep -vE '^[0-9]+:[[:space:]]*#' | head -1 | cut -d: -f1
}

prev=0
for stage in \
    'identity_apply worker' \
    'schedule_drive_yield' \
    'preflight_gate' \
    'preflight_policy_gate' \
    'schedule_janitor_rearm' \
    'schedule_list_ready_or_verdict' \
    'schedule_debounce_decide' \
    'preflight_model_gate' \
    'provision_env_materialize' \
    'provision_pnpm_store_guard' \
    'provision_write_secrets' \
    'provision_install_and_build' \
    'provision_seed_nix' \
    'verify_pp_snapshot' \
    'verify_watch_start' \
    'execute_sandcastle_run' \
    'verify_workers' \
    'verify_protected_paths' \
    'landing_stage' \
    'report_post_summary' \
    'report_self_rearm'; do
  ln="$(stage_line "${stage%% *}" || true)"
  [ -n "$ln" ] || fail "run-swarm.sh no longer calls the $stage seam"
  [ "$ln" -gt "$prev" ] || fail "$stage is out of order (line $ln, previous stage at $prev)"
  prev="$ln"
done
pass=$((pass+1))

# every seam library it depends on is sourced
for lib in preflight schedule provision execute verify landing report; do
  grep -q "^\. \"\$here/$lib-lib.sh\"$" "$rs" || fail "run-swarm.sh must source $lib-lib.sh"
done
pass=$((pass+1))

# …and stays THIN. The 2026-08-15 survey measured 598 lines / 22 responsibilities
# as the patch-magnet threshold; the decomposition's whole point is that this
# file cannot drift back there unnoticed. Generous ceiling — this is a ratchet
# against regrowth, not a golf score.
lines="$(grep -cvE '^[[:space:]]*(#|$)' "$rs")"
[ "$lines" -lt 200 ] || fail "run-swarm.sh has regrown to $lines code lines — a stage has moved back inline"
pass=$((pass+1))

# the EXIT trap still finalises every trace (verdict, runlog, swarm.db, the #435
# stamp invalidation) and the kill route still runs it
for want in 'trap on_exit EXIT' 'on_signal SIGTERM 143' 'on_signal SIGINT 130' \
            'verdict_write "$ec"' 'runlog_append' 'swarmdb_run_end' 'report_sweep'; do
  grep -qF "$want" "$rs" || fail "the run's own trace lost: $want"
done
pass=$((pass+1))

echo "run-swarm-stages: $pass groups passed"
