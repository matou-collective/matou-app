#!/usr/bin/env bash
# Run Sandcastle over the ready tasks, land the results, and post a Mattermost
# summary. Run from the repo checkout root; assumes the origin remote is
# authenticated for push (the workflow checkout sets this up).
#
# THE ORCHESTRATOR, and nothing else. Since #2 this file is a thin sequence of
# calls into one library per seam — the shape the 2026-08-15 factory-
# reengineering survey named when it called run-swarm.sh the patch magnet (598
# lines, 22 distinct responsibilities, 12 exit points hand-maintaining
# SWARM_EXIT_REASON):
#
#   preflight   preflight-lib.sh   self-tests, policy, model — all fail CLOSED
#   identity    identity-lib.sh    identity_apply, the #31 contract seam
#   schedule    schedule-lib.sh    drive yield, janitor, ready set, debounce
#   provision   provision-lib.sh   .env, secrets, stores, install, image, nix
#   execute     execute-lib.sh     the worker loop + cancel/auth/limit failover
#   verify      verify-lib.sh      worker births (#435), protected paths (#445)
#   land        landing-lib.sh     landing_stage — push ladder or PR-per-issue
#   report      report-lib.sh      sweep, run summary, D5 self-rearm
#
# Each library is independently unit-tested offline (tests/<name>-lib-test.sh),
# which is the point: before #2, three of these stages' logic could only be
# tested by keeping a byte-for-byte COPY of the block beside it (debounce-test.sh,
# nix-store-test.sh, run-swarm-env-guard-test.sh) — a copy free to drift from its
# original silently. Everything the run decides now lives in exactly one place.
#
# What stays HERE is what genuinely belongs to the orchestrator: the run's own
# identity (repo tag, run id), the EXIT/signal traps that finalise every trace,
# and the ORDER of the stages.
#
# Env: FORGEJO_TOKEN, FORGEJO_API, CLAUDE_CODE_OAUTH_TOKEN (+ optional
#      CLAUDE_CODE_OAUTH_TOKEN_B standby — #510 failover, host/org env ONLY,
#      never .sandcastle/.env and never forwarded to workers),
#      MATTERMOST_URL/MATTERMOST_BOT_TOKEN/MATTERMOST_CHANNEL_ID (optional),
#      REPO_SLUG (optional),
#      RUN_URL (optional Actions run link).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# ── primitive libs (shared with the healer, the session runner, the reporter) ──
# shellcheck source=limit-lib.sh
. "$here/limit-lib.sh"
# shellcheck source=fence-lib.sh
. "$here/fence-lib.sh"
# shellcheck source=sweep-lib.sh
. "$here/sweep-lib.sh"
# shellcheck source=verdict-lib.sh
. "$here/verdict-lib.sh"
# shellcheck source=runlog-lib.sh
. "$here/runlog-lib.sh"
# shellcheck source=model-lib.sh
. "$here/model-lib.sh"
# shellcheck source=swarm-db-lib.sh
# swarm.db trace MIRROR (#447): best-effort SQLite front-end. Every writer
# swallows its own failure — a mirror we cannot write must never red a run.
. "$here/swarm-db-lib.sh"
# shellcheck source=cancel-lib.sh
. "$here/cancel-lib.sh"
# shellcheck source=protected-paths-lib.sh
. "$here/protected-paths-lib.sh"
# shellcheck source=env-allowlist-lib.sh
. "$here/env-allowlist-lib.sh"
# shellcheck source=host-capacity-lib.sh
. "$here/host-capacity-lib.sh"
# shellcheck source=policy-lib.sh
. "$here/policy-lib.sh"
# shellcheck source=claim-lib.sh
. "$here/claim-lib.sh"
# ── the per-seam stage libs (#2) ──────────────────────────────────────────────
# shellcheck source=preflight-lib.sh
. "$here/preflight-lib.sh"
# shellcheck source=schedule-lib.sh
. "$here/schedule-lib.sh"
# shellcheck source=provision-lib.sh
. "$here/provision-lib.sh"
# shellcheck source=execute-lib.sh
. "$here/execute-lib.sh"
# shellcheck source=verify-lib.sh
. "$here/verify-lib.sh"
# shellcheck source=landing-lib.sh
. "$here/landing-lib.sh"
# shellcheck source=report-lib.sh
. "$here/report-lib.sh"

: "${FORGEJO_TOKEN:?}"
: "${FORGEJO_API:?}"
repo_slug="${REPO_SLUG:-${FORGEJO_API##*/repos/}}"
# One runner now serves TWO repos. Any /tmp state that is per-repo must carry the
# repo in its name, or the two repos clobber each other's stamps (#238). Slashes
# aren't valid in a path segment, so flatten the slug: "Owner/repo" -> "Owner-repo".
repo_tag="${repo_slug//\//-}"

# ── identity ────────────────────────────────────────────────────────────────
# Factory git identity (#19): every headless commit path stamps GIT_AUTHOR_*/
# GIT_COMMITTER_* from ONE place (swarm-identity.sh) so commits record which
# machinery made them instead of inheriting the host user's ~/.gitconfig. Pin
# REPO_SLUG to THIS run's repo (the runner serves several) before sourcing, and
# source AFTER the FORGEJO_API guard above so swarm-identity's `:=` defaults can
# never mask a missing API. identity_apply fails LOUD with the regenerate command
# if a pin bump needs a newer identity layer than this consumer regenerated,
# instead of dying later on `command not found` (#31). `worker` covers this
# host's reconcile/rescue commits AND the value main.mts forwards into each
# worker container.
export REPO_SLUG="$repo_slug"
# shellcheck source=identity-lib.sh
. "$here/identity-lib.sh"
# shellcheck source=swarm-identity.sh
. "${SWARM_IDENTITY_FILE:-$here/swarm-identity.sh}"
identity_apply worker || exit 2

# ── schedule: yield to a ready rehearsal drive (#663/#664/#30) ──────────────
# Placed BEFORE the EXIT trap / verdict / preflight below so a yield is a clean
# exit 0, not a recorded run: a worker already INSIDE a ticket is a different
# process (a live sibling run) and finishes untouched.
if schedule_drive_yield "${SWARM_DRIVE_DEFER_COUNT:-/tmp/matou-swarm-drive-defer-count}"; then
  exit 0
fi

# ── the run's own trace ─────────────────────────────────────────────────────
# Drop a stage/exit verdict on failure so the healer keys the incident signature
# on the run's REAL failing stage, not on worker chain-of-thought prose (#235).
# Cleared here so a verdict on disk always belongs to this run. The EXIT trap is
# armed NOW — before `pnpm install` (the #142 lockfile break) and the image build
# — so those early failures leave a verdict too; the worktree sweep only runs
# once the run is far enough in to have created worktrees (SWEEP_ARMED, below).
# #574: repo-tagged default — two repos share this host (#238) and would stomp
# each other's verdict file without it.
verdict_begin "${SWARM_VERDICT_PATH:-/tmp/matou-$repo_tag-swarm-verdict.txt}"
verdict_stage "startup (list ready tasks, debounce)"
SWEEP_ARMED=""
# Host-side exit-reason log (#435). Every exit path lands ONE line here so the
# next green-and-empty stall is readable off disk instead of an Actions job log
# the REST API hangs on. Initialised now — before the trap arms — so an early
# `set -e` death still logs (reason falls back to the current verdict stage).
run_started="$(date +%s)"
ready_nums=""            # set once the ready set is known
stamp=""                 # the per-repo debounce stamp path, set below
stamp_written=""         # this run WROTE a fresh debounce stamp (took the run path)
worker_ran=""            # a worker container was confirmed born this run
worker_births=""         # the birth-watcher capture file (cleaned on every exit)
SWARM_EXIT_REASON=""     # set at each intentional exit; else derived from the stage
# The swarm.db run id (#447): unique per run, per repo, per host. SWARM_RUN_ID is
# the Actions run number when present; the pid keeps a cron/host run unique too.
run_db_id="${repo_tag}-${SWARM_RUN_ID:-$run_started}-$$"
swarm_trigger="${SWARM_TRIGGER:-${GITHUB_EVENT_NAME:-unknown}}"
# The executing pool host + runner name (#377). `swarm` is a multi-host runner
# pool, so every trace this run leaves — the on-failure verdict, the host runlog
# row, the swarm.db rows — must say WHICH box it ran on: without it a healer on
# the OTHER host gathers only empty local artefacts and files an undiagnosable
# ticket (#358). SWARM_HOST is the pool-claim name (it survives a container,
# where `hostname` is a random id); `hostname` is the bare-host fallback. The
# runner name comes from the Actions-provided RUNNER_NAME (swarm.yml forwards
# `runner.name`), else the runner's own .runner registration file, else unknown.
swarm_exec_host="${SWARM_HOST:-$(hostname 2>/dev/null || echo unknown)}"
swarm_exec_runner="${RUNNER_NAME:-}"
[ -z "$swarm_exec_runner" ] && [ -f "${SWARM_RUNNER_FILE:-$HOME/.runner}" ] \
  && swarm_exec_runner="$(jq -r '.name // empty' "${SWARM_RUNNER_FILE:-$HOME/.runner}" 2>/dev/null || true)"
[ -n "$swarm_exec_runner" ] || swarm_exec_runner=unknown
# One row per run — written NOW so even a run that dies in early startup, or is
# killed before it lists tasks, leaves a started-but-open trace (finalised by the
# EXIT trap below). Best-effort; migrates the db idempotently on first touch.
swarmdb_run_start "$run_db_id" "$repo_slug" "$swarm_trigger" "$run_started"
# Stamp the executing host onto this run's swarm.db trace (#377) so a fleet
# reader (or a healer on another box) can attribute the run to a host without
# cross-referencing the Actions job log. Best-effort like every mirror write.
swarmdb_event "$run_db_id" "" host "host=$swarm_exec_host runner=$swarm_exec_runner"
# Label the host-capacity slot the workflow won for this run (slot-aware
# fleet). The workflow holds the flock inline and exports the path; the issue
# is not known here (claims happen in the sandbox), so ref=run and the fleet
# monitor reads the issue from this run's swarm.db attempts.
host_capacity_holder_write "${HOST_CAPACITY_HELD_SLOT:-}" ticket run "$repo_slug" swarm-worker "$run_db_id"

on_exit() {
  local ec=$?
  verify_watch_stop
  [ -n "$worker_births" ] && rm -f "$worker_births" 2>/dev/null || true
  rm -rf "${VERIFY_PP_BEFORE:-}" "${VERIFY_PP_AFTER:-}" 2>/dev/null || true   # #445 snapshots
  verdict_write "$ec"
  # Stamp the executing host onto the on-failure verdict (#377). verdict_write
  # only wrote a file on a NON-zero exit, so a clean run leaves none and this is
  # a no-op there. Prepend the host/runner lines (BEFORE stage=) so the healer's
  # stage/error parser — which keys on `stage=` and the `--- error lines ---`
  # block — is untouched, while a healer that finds this verdict on another pool
  # host can name the box the fault ran on instead of reading an empty bundle.
  if [ -s "${VERDICT_PATH:-/nonexistent}" ]; then
    { echo "host=$swarm_exec_host"; echo "runner=$swarm_exec_runner"; cat "$VERDICT_PATH"; } \
      > "$VERDICT_PATH.hoststamp" 2>/dev/null \
      && mv "$VERDICT_PATH.hoststamp" "$VERDICT_PATH" 2>/dev/null \
      || rm -f "$VERDICT_PATH.hoststamp" 2>/dev/null || true
  fi
  local reason="${SWARM_EXIT_REASON:-}"
  [ -n "$reason" ] || reason="died-in:${VERDICT_STAGE:-unknown}"
  # #377: the host runlog row carries the executing host + runner too, appended
  # after runlog_line's pinned format (so runlog-lib's unit test is unaffected).
  runlog_append "${SWARM_RUNLOG:-$HOME/swarm/logs/run-swarm-verdicts.log}" \
    "$(runlog_line "$run_started" "$(date +%s)" "$repo_slug" "$ready_nums" "$reason" "$ec") host=$swarm_exec_host runner=$swarm_exec_runner"
  # Mirror the finalised verdict into swarm.db, closing the run row and any open
  # attempt (kills-finalise invariant: nothing reads 'running' forever). Runs on
  # EVERY exit path including the SIGTERM/SIGINT route below.
  swarmdb_run_end "$run_db_id" "$reason" "$reason" "$ec" "$(date +%s)"
  # Release the ticket holder labelled above (slot-aware fleet) — harmless
  # rm -f when HOST_CAPACITY_HELD_SLOT was never set.
  host_capacity_holder_clear "${HOST_CAPACITY_HELD_SLOT:-/nonexistent}"
  # Invalidate the debounce stamp when this run wrote a fresh one but never
  # confirmed a worker (#435): a stamp left by a run that died quietly — or one
  # that concluded green-and-empty — would coalesce away the very next genuine
  # retry. A run that DID spawn a worker keeps its stamp so a burst of identical
  # triggers still coalesces. The coalesce path never sets stamp_written, so its
  # existing stamp is preserved and debouncing keeps working.
  if [ -n "$stamp_written" ] && [ -z "$worker_ran" ] && [ -n "$stamp" ]; then
    rm -f "$stamp"
  fi
  # From here on the run could have created worktrees (SWEEP_ARMED, set below).
  if [ -n "$SWEEP_ARMED" ]; then report_sweep "$PWD" "$repo_slug"; fi
}
trap on_exit EXIT
# Kills finalise the trace (#447, invariant 2). Actions cancellation and the
# 180-minute timeout send SIGTERM (then SIGKILL); by default bash would die
# WITHOUT running the EXIT trap, leaving the run's swarm.db + runlog rows reading
# 'running' forever. Route both signals through a clean exit so on_exit fires and
# finalises. 143 = 128+SIGTERM, 130 = 128+SIGINT (the conventional codes).
# `(exit "$2")` sets $? so on_exit's `local ec=$?` reads the signal code, not the
# last command's; `trap - EXIT` stops the final `exit` from re-running on_exit.
on_signal() { SWARM_EXIT_REASON="killed:$1"; trap - EXIT; (exit "$2"); on_exit; exit "$2"; }
trap 'on_signal SIGTERM 143' TERM
trap 'on_signal SIGINT 130' INT

# ── limit-park gate (#103) ──────────────────────────────────────────────────
# A host already parked on a Claude usage limit must touch NOTHING on the
# tracker. Before this gate a parked run still listed, claimed (`agent-working`
# on), paid the refusal, released (`agent-working` off) every ready ticket —
# and each toggle was an `issues` event that queued another run under the
# concurrency group, which re-toggled them again: one park cycle over four
# tickets fanned out into 2,700 queued no-op runs across four repos
# (2026-08-26). A FRESH marker (younger than CLAUDE_LIMIT_TTL) exits here, after
# the trap is armed so the verdict/runlog/swarm.db row still say
# `claude-limit-parked`; a STALE marker falls through so execute-lib's
# claude_limit_sweep can stamp the unpark edge and retry the account.
if claude_limit_parked; then
  echo "run-swarm: Claude usage limit — host parked $(( $(date +%s) - $(stat -c %Y "$CLAUDE_LIMIT_MARKER") ))s ago; touching nothing (no list, no claim)"
  SWARM_EXIT_REASON="claude-limit-parked"
  exit 0
fi

# ── preflight ───────────────────────────────────────────────────────────────
preflight_gate "$repo_slug" || exit 1
# SWARM_POLICY_FILE is the test-only seam the in-sandbox scripts already honour
# (claim-next-task.sh, list-ready-tasks.sh, close-report.sh); unset in production
# → the consumer's real swarm-policy.sh.
preflight_policy_gate "$repo_slug" "${SWARM_POLICY_FILE:-}" || exit 1

# ── schedule ────────────────────────────────────────────────────────────────
# The janitor runs BEFORE listing so re-armed tickets rejoin this very run's queue.
schedule_janitor_rearm
# #52: the ready-list read is a Forgejo GET on the happy path — a transient 5xx/
# timeout that outlives list-ready-tasks.sh's retries must NOT die keyed on the
# stale "preflight self-tests (#446)" stage with an empty error block (GOTCHAS
# #7's implicit-`set -e` sibling). schedule-lib names the stage and captures the
# failing read as the verdict's error line; it needs the run's own shell's
# VERDICT_* (the EXIT trap reads them), so it takes an out-file, not `$(...)`.
ready_file="$(mktemp)"
if ! schedule_list_ready_or_verdict "$ready_file"; then rm -f "$ready_file"; exit 1; fi
ready="$(cat "$ready_file")"
rm -f "$ready_file"
ready_nums="$(schedule_ready_nums "$ready")"
n="$(schedule_ready_count "$ready")"
if [ "$n" -eq 0 ]; then
  # pr-mode + agent-after-green (#114): even with ZERO ready tasks, an orphaned
  # green agent PR — a worker SIGKILLed after opening its PR, before close-report
  # — must still land. Its issue is HIDDEN from the ready list (an open agent PR
  # looks in-flight), so a no-ready-tasks tick is the ONLY tick that can act. The
  # janitor above already stripped agent-working off dead claims, so the sweep
  # skips any PR whose issue still carries a live claim. A no-op (empty output)
  # under push-mode / MERGE_AUTHORITY=human, preserving today's behaviour there.
  swept="$(landing_sweep_orphans || true)"
  if [ -n "$swept" ]; then
    echo "run-swarm: no ready tasks, but the landing sweep acted on unclaimed agent PR(s):"
    printf '%s\n' "$swept"
    SWARM_EXIT_REASON="landing-swept"
  else
    echo "run-swarm: no ready tasks"
    SWARM_EXIT_REASON="no-ready-tasks"
  fi
  exit 0
fi
echo "run-swarm: $n ready task(s):"
schedule_ready_listing "$ready"
swarmdb_event "$run_db_id" "" ready-set "$n ready task(s)" "[$ready_nums]"

stamp="$(schedule_stamp_path "$repo_tag")"
debounce="$(schedule_debounce_decide "$ready" "$stamp" "$SWARM_DEBOUNCE")"
if [ "${debounce%% *}" = coalesce ]; then
  echo "run-swarm: same $n ready task(s) attempted ${debounce#* }s ago — coalescing this trigger"
  SWARM_EXIT_REASON="coalesced"
  exit 0
fi
stamp_written=1   # from here a quiet death without a worker must clear the stamp (#435)

preflight_model_gate "$repo_slug" "$ready" || exit 1

# Web URL of the repo (FORGEJO_API is <server>/api/v1/repos/<slug>).
repo_web="${FORGEJO_API%%/api/*}/$repo_slug"
bash "$here/notify-mattermost.sh" ":inbox_tray: **Swarm picking up $n task(s)** in \`$repo_slug\`:
$(jq -r '.[] | "- [#\(.number) \(.title)](\(.url))"' <<<"$ready")"

# ── provision ───────────────────────────────────────────────────────────────
provision_env_materialize "$here" || { SWARM_EXIT_REASON="env-allowlist-violation"; exit 1; }
provision_store_dirs "$here"
provision_pnpm_store_guard "$here" || exit 1
provision_mount_dirs "$here"
provision_write_secrets "$here"
provision_install_and_build
provision_seed_nix "$here/nix-store" "$PWD"

# From here on the run can create worktrees, so arm the post-run sweep (the trap
# itself was installed up top so an early install/build failure still verdicts).
SWEEP_ARMED=1
start_sha="$(git rev-parse HEAD)"
verify_pp_snapshot "$PWD"

# ── execute ─────────────────────────────────────────────────────────────────
sandcastle_log="$(mktemp)"
worker_births="$(mktemp)"
verify_watch_start "$worker_births" "$run_started"
run_rc=0
execute_sandcastle_run "$sandcastle_log" "$run_db_id" "$repo_slug" "$repo_tag" || run_rc=$?
case "$run_rc" in
  0) ;;                          # workers ran — on to verify
  "$EXECUTE_RC_STOP") exit 0 ;;  # cancel / auth-dead / limit park: clean, named
  *) exit 1 ;;                   # the generic red; the log feeds verdict_write
esac

# ── verify ──────────────────────────────────────────────────────────────────
# The run said "success" — but did a worker ever actually spawn? Stop the birth
# watcher and count sandcastle-* container creations.
verify_watch_stop
verify_workers "$worker_births" "$n" "$ready_nums" "$run_db_id" "$run_started" "$repo_slug" || exit 1
worker_births=""   # consumed — keep the trap from re-removing it
worker_ran=1       # a worker was confirmed born (or docker was unavailable to verify)
verify_protected_paths "$PWD" "$run_db_id" "$repo_slug" || exit 1

# ── land ────────────────────────────────────────────────────────────────────
landing_stage "$repo_slug" "$ready" "$start_sha" || exit 1

# ── report ──────────────────────────────────────────────────────────────────
report_post_summary "$repo_slug" "$repo_web" "$n" "$start_sha" "$ready" \
  "$LANDING_OPENED_PRS" "$LANDING_MERGED_PRS"
report_self_rearm "$worker_ran"

if [ -n "${EXECUTE_YIELDED_TO_DRIVE:-}" ]; then
  SWARM_EXIT_REASON="yielded-to-drive"   # #111: finished its current task, then stood down for the drive
else
  SWARM_EXIT_REASON="completed"
fi
