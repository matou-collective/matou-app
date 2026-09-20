#!/usr/bin/env bash
# Offline test for run-swarm.sh's Mattermost-notify guard (#1424 / GOTCHAS 56).
#
# The "Swarm picking up N task(s)" post at run-swarm.sh is purely informational,
# yet it was the ONE unguarded `curl -sf` between the ready-list and provision:
# a 5xx from the chat front door exits 22, and `set -e` killed the whole run —
# a run that had claimable work never provisioned, never spawned a worker. Worse,
# the verdict was mis-keyed: nothing re-keyed the stage between the listing and
# provision, so the death was blamed on "list ready tasks" — a stage that had
# SUCCEEDED — with an empty error block (swarm run 22284, 2026-09-12).
#
# Two things this test pins, both red against the pre-#1424 file:
#   1. GUARD  — a notify that exits 22 does NOT red the run: it proceeds to
#      provision (proven by the provision seam being reached, exit 0, no verdict).
#   2. RE-KEY — when provision then faults, the verdict names "notify + provision",
#      not the stale "list ready tasks".
#
# Shape: a symlink farm of the factory root is the run's `$here` so run-swarm.sh
# sources the REAL libs, but provision-lib.sh is swapped for a stub that halts
# the run right after the notify (the EXECUTE_NOTIFY/REPORT_NOTIFY seam pattern,
# here SWARM_NOTIFY, shims the 5xx post). Everything before the listing is stubbed
# exactly as run-swarm-stages-test.sh does (curl, preflight, the ready lister).
#
# Run: bash tests/run-swarm-notify-guard-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sc="$here/.."

fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
# This test EXECS run-swarm.sh, which writes host state by default (#58/#116):
# redirect every such path under $tmp and arm the swarm.db leak tripwire. The
# per-invocation SWARM_* below stay under $tmp, so they pass the tripwire.
# shellcheck source=test-env.sh
. "$here/test-env.sh"; test_env_hermetic "$tmp"

# ── the symlink farm: $here for the run, real libs, stubbed provision-lib ──────
farm="$tmp/farm"; mkdir -p "$farm"
for entry in "$sc"/* "$sc"/.[!.]*; do
  [ -e "$entry" ] || continue
  base="$(basename "$entry")"
  case "$base" in provision-lib.sh) continue ;; esac   # stubbed below
  ln -s "$entry" "$farm/$base"
done

# provision-lib.sh stub: define only what run-swarm calls first. On the happy
# path it marks that provision was REACHED (proving the run got past the notify)
# and exits 0, halting before the real (heavy, environment-bound) provision steps.
# With PROVISION_STUB_FAIL set it returns 1 instead, so run-swarm takes its
# `|| { SWARM_EXIT_REASON=…; exit 1; }` branch and the EXIT trap writes a verdict
# — whose stage must be the re-keyed "notify + provision".
cat > "$farm/provision-lib.sh" <<'SH'
#!/usr/bin/env bash
provision_env_materialize() {
  if [ -n "${PROVISION_STUB_FAIL:-}" ]; then return 1; fi
  : > "${PROVISION_MARKER:?}"
  exit 0
}
SH

mkdir -p "$tmp/bin"
# curl answers the only two tracker calls the pre-provision path makes: the
# janitor sweep (nothing stale) and the policy label list (core loop-in labels
# minted, so the DEFAULT policy validates). Same shape as run-swarm-stages-test.
cat > "$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
url=""
for a in "$@"; do case "$a" in http*) url="$a" ;; esac; done
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
# TWO ready tickets, no model-* label → the run resolves the default model. The
# shape run-swarm reads: .number/.title for the listing, .url for the notify.
cat > "$tmp/list-ready" <<'SH'
#!/usr/bin/env bash
printf '%s' '[{"number":1410,"title":"first","url":"http://x/1410"},{"number":1409,"title":"second","url":"http://x/1409"}]'
SH
# The notify shim: a 5xx from the chat front door is a `curl -sf` exit 22.
cat > "$tmp/notify-5xx" <<'SH'
#!/usr/bin/env bash
printf 'NOTIFY-SHIM-CALLED\n' >> "${NOTIFY_LOG:?}"
exit 22
SH
chmod +x "$tmp/preflight" "$tmp/list-ready" "$tmp/notify-5xx"

verdict="$tmp/verdict.txt"; runlog="$tmp/runlog.txt"
marker="$tmp/provision-reached"; notify_log="$tmp/notify.log"

run_swarm() { # run_swarm [extra env…] -> sets RC, out
  RC=0
  out="$(env -u MATTERMOST_URL -u MATTERMOST_BOT_TOKEN -u MATTERMOST_CHANNEL_ID \
    -u GITHUB_ACTIONS -u RUN_URL -u PROVISION_STUB_FAIL \
    PATH="$tmp/bin:$PATH" \
    FORGEJO_TOKEN=dummy FORGEJO_API=http://x/api/v1/repos/Acme/widget \
    REPO_SLUG=Acme/widget SWARM_HOST=box1 \
    HOST_CAPACITY_DRIVE_WANTED="$tmp/no-such-reservation" \
    SWARM_DRIVE_DEFER_COUNT="$tmp/defer" \
    SWARM_VERDICT_PATH="$verdict" SWARM_RUNLOG="$runlog" \
    SWARM_RUNNER_FILE="$tmp/no-such-runner" \
    SWARM_DEBOUNCE_STAMP="$tmp/stamp" \
    SWARM_DB="$tmp/swarm.db" \
    PREFLIGHT_SCRIPT="$tmp/preflight" \
    SCHEDULE_LIST_READY="$tmp/list-ready" \
    SWARM_NOTIFY="$tmp/notify-5xx" \
    NOTIFY_LOG="$notify_log" \
    PROVISION_MARKER="$marker" \
    "$@" bash "$farm/run-swarm.sh" 2>&1)" || RC=$?
}

# ── 1. GUARD: a notify that exits 22 must NOT red the run ──────────────────────
rm -f "$verdict" "$runlog" "$tmp/stamp" "$marker" "$notify_log"
run_swarm
[ "$RC" = 0 ] || fail "a 5xx notify must NOT red the run — expected exit 0, got $RC:
$out"
[ -f "$notify_log" ] && grep -q 'NOTIFY-SHIM-CALLED' "$notify_log" \
  || fail "the notify shim must actually have run (else this proves nothing): $out"
[ -f "$marker" ] || fail "the run must PROCEED to provision after the failed notice — provision seam not reached:
$out"
[ ! -f "$verdict" ] || fail "a run that only lost a best-effort notice must leave no red verdict, got: $(cat "$verdict")"
pass=$((pass+1))

# ── 2. RE-KEY: a fault after the notify names "notify + provision" ─────────────
# (Not the stale "list ready tasks" the pre-#1424 file left standing.)
rm -f "$verdict" "$runlog" "$tmp/stamp" "$marker" "$notify_log"
run_swarm PROVISION_STUB_FAIL=1
[ "$RC" != 0 ] || fail "a provision fault must red the run (exit non-zero)"
[ -f "$verdict" ] || fail "a provision fault must leave a verdict on disk"
grep -q 'stage=notify + provision' "$verdict" \
  || fail "the verdict must be re-keyed to 'notify + provision', got: $(cat "$verdict")"
grep -q 'stage=list ready tasks' "$verdict" \
  && fail "the verdict must NOT be mis-keyed to the (passed) 'list ready tasks' stage, got: $(cat "$verdict")"
pass=$((pass+1))

echo "run-swarm-notify-guard: $pass scenarios passed"
