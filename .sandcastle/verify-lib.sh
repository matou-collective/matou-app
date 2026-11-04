#!/usr/bin/env bash
# verify-lib.sh — the VERIFY seam of run-swarm.sh (#2): the two questions asked
# AFTER the sandcastle run says "success" and BEFORE anything lands.
#
#   1. Did a worker ever actually SPAWN? (#435's green wedge.) A non-empty ready
#      set that concludes green with ZERO worker births is never legitimate —
#      even a task the agent immediately blocks spawns a container to decide so.
#      The swarm twice went hours green-and-empty on exactly this, and both stall
#      windows were pure archaeology.
#   2. Did a worker edit the MACHINERY that judges its work? (#445.) Fingerprint
#      `.sandcastle/`+`.forgejo/` before and after, attribute every change to the
#      workers, roll it back, and refuse to push.
#
# runlog-lib.sh owns the wedge PREDICATE, protected-paths-lib.sh the
# fingerprint/rollback, fence-lib.sh the D3 container bound — each with its own
# test. What lived inline in run-swarm.sh, and lives here, is the birth-watcher
# lifecycle and the two rulings built on those primitives.
#
# Callers must have sourced runlog-lib.sh, fence-lib.sh, protected-paths-lib.sh,
# verdict-lib.sh and swarm-db-lib.sh. Offline-tested by tests/verify-lib-test.sh
# with a shimmed docker/git/notify.

if [ -z "${__SWARM_VERIFY_LIB:-}" ]; then
__SWARM_VERIFY_LIB=1

_VERIFY_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERIFY_NOTIFY="${VERIFY_NOTIFY:-$_VERIFY_HERE/notify-mattermost.sh}"

# The background watchers, owned here so run-swarm's EXIT trap has one pair of
# names to clean up rather than two bare locals.
VERIFY_EVENTS_PID=""
VERIFY_FENCE_PID=""
# Whether a birth watcher is actually running. Cleared by verify_watch_start when
# docker is absent, which makes verify_workers SKIP the wedge check rather than
# read "0 births" as a wedge and false-fail — a build/run that needed docker has
# already failed loud by then. Starts at 1 so a caller that never starts a
# watcher (a unit test driving verify_workers directly) still gets the check.
VERIFY_WATCHING=1
# The protected-path snapshots (#445); both live under the one per-run dir
# VERIFY_PP_RUNDIR, which the EXIT trap removes in a single rm (#761).
VERIFY_PP_RUNDIR=""
VERIFY_PP_BEFORE=""
VERIFY_PP_AFTER=""
# Non-empty (a human-readable reason) when the before-snapshot was not SOUND —
# truncated by a blob-copy failure or aborted mid-fingerprint (#321). Trusting a
# truncated baseline would false-attribute untouched machinery as `appeared` and
# roll REAL machinery back; verify_protected_paths degrades to unenforced (loud)
# instead. Set by verify_pp_snapshot, cleared there and on the enforcement-off path.
VERIFY_PP_BEFORE_TRUNCATED=""
# Set to 1 by verify_protected_paths when a worker breached the boundary (#193).
# The landing seam reads it as a last-line-of-defense: the host NEVER pushes a
# flagged breach to main, even if a caller reaches landing without the run-swarm
# ordering's `|| exit 1`. Cleared at the top of each verify_protected_paths call.
VERIFY_PP_VIOLATION=""

_verify_notify() { bash "$VERIFY_NOTIFY" "$1" || true; }

# ── the worker-birth watcher (#435) ───────────────────────────────────────
# Sandcastle starts each iteration's worker as `docker run -d --name
# sandcastle-<uuid>` (verified against @ai-hero/sandcastle's docker sandbox), so
# a `create` event whose name begins `sandcastle-` is proof a worker actually
# spawned. A LIVE stream survives a 3h run where a post-hoc `docker events
# --since` query could age out of the daemon's event buffer.
#
# verify_watch_start <capture-file> <since-epoch>
# Sets VERIFY_EVENTS_PID / VERIFY_FENCE_PID (both empty when docker is absent —
# we simply skip the wedge check rather than false-fail; a build/run that needed
# docker already failed loud). We hold the global lock, so the only sandcastle-*
# births now are ours; the nix-seed `docker run --rm` containers are unnamed.
verify_watch_start() {
  local capture="$1" since="$2"
  VERIFY_EVENTS_PID=""; VERIFY_FENCE_PID=""; VERIFY_WATCHING=""
  command -v docker >/dev/null 2>&1 || return 0
  VERIFY_WATCHING=1
  # --since replays events from the run's start too, so a worker born in the
  # millisecond before the stream attaches is still caught (no startup race);
  # the name filter keeps the earlier unnamed nix-seed containers out.
  docker events --since "$since" --filter 'type=container' --filter 'event=create' \
    --format '{{.Actor.Attributes.name}}' >"$capture" 2>/dev/null &
  VERIFY_EVENTS_PID=$!
  # D3 container fence (#568): bound each worker container the moment its birth
  # lands in the capture — `docker update`, so the in-flight worker is never
  # restarted. Polls the same file the wedge check reads (no second events
  # stream) and self-terminates when the file is cleaned.
  swarm_fence_watch "$capture" &
  VERIFY_FENCE_PID=$!
}

# verify_watch_stop — stop both watchers and CLEAR their pids, so run-swarm's
# EXIT trap never re-kills a dead pid.
verify_watch_stop() {
  local p
  for p in "$VERIFY_EVENTS_PID" "$VERIFY_FENCE_PID"; do
    [ -n "$p" ] || continue
    kill "$p" 2>/dev/null || true
    wait "$p" 2>/dev/null || true
  done
  VERIFY_EVENTS_PID=""; VERIFY_FENCE_PID=""
}

# verify_worker_count <capture> -> how many sandcastle-* containers were created.
verify_worker_count() {
  local n; n="$(grep -cE '^/?sandcastle-' "$1" 2>/dev/null || true)"
  printf '%s' "${n:-0}"
}

# verify_born_workers <capture> -> the DISTINCT worker container names.
verify_born_workers() {
  grep -oE 'sandcastle-[a-zA-Z0-9_.-]+' "$1" 2>/dev/null | sort -u || true
}

# verify_workers <capture> <ready-count> <ready-nums> <run-db-id> <run-started> <repo-slug>
#   rc 0  workers were born (or docker was unavailable to verify) — proceed
#   rc 1  #435's green wedge: fail LOUD, with a fresh verdict signature for the
#         healer, so the EXIT trap clears the debounce stamp and the next trigger
#         retries at once instead of coalescing the wedge away
# Consumes and removes the capture file either way.
verify_workers() {
  local capture="$1" ready_count="$2" ready_nums="$3" run_db_id="$4" run_started="$5" repo_slug="$6"
  local workers born wname
  # No watcher ran (no docker): there is nothing to count, so skip the check
  # rather than read an empty capture as a wedge.
  [ -n "${VERIFY_WATCHING:-}" ] || { rm -f "$capture"; return 0; }
  workers="$(verify_worker_count "$capture")"
  # Capture the distinct born-worker names BEFORE removing the file (they become
  # finalised processes rows on the healthy path below).
  born="$(verify_born_workers "$capture")"
  rm -f "$capture"

  if [ "$(worker_wedge "$ready_count" 0 "$workers")" = wedge ]; then
    SWARM_EXIT_REASON="no-worker-spawned"
    verdict_stage "sandcastle run concluded success but spawned NO worker (#435 green wedge)"
    # The #435 answer in swarm.db: the wedge is an UNFINALISED processes row (no
    # end, no events of its own) — a hung agent emits nothing, so the row IS the
    # evidence. `swarm-db.sh open-processes` surfaces it.
    swarmdb_wedge "$run_db_id" "$ready_nums"
    _verify_notify ":rotating_light: **Swarm run concluded success but spawned no worker** in \`$repo_slug\` — $ready_count ready task(s) went untouched (#435 green wedge). Failing loud; the debounce stamp is cleared so the next trigger retries."
    return 1
  fi

  # Healthy run: mirror each born worker as a FINALISED processes row (it spawned
  # and the sandcastle run returned, so it is done) — the contrast that makes an
  # open wedge row legible.
  while read -r wname; do
    [ -n "$wname" ] || continue
    swarmdb proc-open --run "$run_db_id" --kind worker --ref "$wname" \
      --command "sandcastle worker container" --started "$run_started" --ended "$(date +%s)"
  done <<<"$born"
  return 0
}

# ── the protected-path boundary (#445) ────────────────────────────────────
# Enforcement defaults ON (#193). It was staged OFF while push-mode workers
# pushed `main` from the sandbox themselves: a rollback then reverted the host
# working tree AFTER the breach was already on origin/main — cosmetic. #193 moved
# the push-to-main off the sandbox (the worker pushes a per-run branch; the HOST
# lands `main` only after this boundary runs), so the rollback now genuinely
# keeps a machinery edit off `main`. Machinery changes route through the
# session-gated escape path (a worker files a `ready-for-session` issue; an
# interactive session rules it, escalating to `ready-for-human` only on a
# one-way door — ADR 0174), which prompt.md rule 9 already instructs.
#
# The per-repo opt-out (#208) is the closed-vocabulary swarm-policy.sh key
# PROTECTED_PATH_ENFORCE=off (GOTCHAS 17: a consumer declares it only after the
# pin that knows it), exported by policy_load as
# SWARM_POLICY_PROTECTED_PATH_ENFORCE — the sanctioned surface for a consumer
# that still carries machinery tickets landing directly. An explicit PP_ENFORCE
# in the environment still wins (break-glass / the offline test seam).

# _verify_pp_enforced — rc 0 iff the protected-path boundary is active this run.
_verify_pp_enforced() {
  if [ -n "${PP_ENFORCE:-}" ]; then
    [ "$PP_ENFORCE" = 1 ]
  else
    [ "${SWARM_POLICY_PROTECTED_PATH_ENFORCE:-on}" != off ]
  fi
}

# _verify_pp_tmproot — the per-host parent dir under which EVERY run's before/
# after protected-path snapshot lives. Rooting them in one place (rather than two
# bare `mktemp -d` dirs) is what makes an orphan reapable: a run SIGKILLed between
# the two snapshots leaks its dir — no EXIT trap catches SIGKILL — and before #761
# those were 2.7G+2.4G of cp'd cache blobs that survived two days and walled the
# /tmp tmpfs user quota. Overridable (VERIFY_PP_TMPROOT) for the offline test.
_verify_pp_tmproot() { printf '%s' "${VERIFY_PP_TMPROOT:-${TMPDIR:-/tmp}/matou-pp-snapshots}"; }

# _verify_pp_reap — best-effort removal of snapshot dirs orphaned by a DEAD run:
# a `run-<pid>-*` child of the tmproot whose owning run-swarm PID is no longer
# alive. PID reuse only DELAYS a reap (a live unrelated PID keeps the dir one more
# cycle); it never reaps a running peer's snapshot. Never reds a run.
_verify_pp_reap() {
  local root d pid
  root="$(_verify_pp_tmproot)"
  [ -d "$root" ] || return 0
  for d in "$root"/run-*; do
    [ -d "$d" ] || continue
    pid="${d##*/run-}"; pid="${pid%%-*}"
    case "$pid" in ''|*[!0-9]*) continue ;; esac
    kill -0 "$pid" 2>/dev/null && continue   # owner still alive — its own run owns it
    rm -rf "$d" 2>/dev/null || true
  done
}

# verify_pp_snapshot <workspace> — fingerprint the machinery NOW, before a single
# worker runs. Snapshotting here — after the pre-existing dirty state is whatever
# it is — means another session's uncommitted work is the baseline we compare
# against and is never rolled back as collateral. Best-effort: a snapshot we
# cannot take never reds the run (verify_protected_paths then finds nothing to
# compare and no-ops). The before/after dirs share ONE per-run dir
# (VERIFY_PP_RUNDIR) so the run teardown reaps both with a single rm, and any dir
# an earlier dead run orphaned is reaped on entry here (#761).
verify_pp_snapshot() {
  VERIFY_PP_BEFORE=""
  VERIFY_PP_BEFORE_TRUNCATED=""
  _verify_pp_enforced || return 0
  _verify_pp_reap
  local root; root="$(_verify_pp_tmproot)"
  mkdir -p "$root" 2>/dev/null || true
  VERIFY_PP_RUNDIR="$(mktemp -d "$root/run-$$-XXXXXX" 2>/dev/null || mktemp -d)"
  VERIFY_PP_BEFORE="$VERIFY_PP_RUNDIR/before"
  pp_snapshot "$1" "$VERIFY_PP_BEFORE" 2>/dev/null || true
  # #321: a before-snapshot truncated by a /tmp space/quota wall (a counted
  # blob-copy failure) or aborted mid-fingerprint (an absent completion marker)
  # may be missing machinery that is really present — which verify_protected_paths
  # would misread as `appeared` and ROLL BACK (deleting real machinery no worker
  # touched). Mark it so the boundary degrades to unenforced, never a false RED.
  if command -v pp_snapshot_sound >/dev/null 2>&1 && ! pp_snapshot_sound "$VERIFY_PP_BEFORE"; then
    if [ -f "$VERIFY_PP_BEFORE/blob_failures" ]; then
      VERIFY_PP_BEFORE_TRUNCATED="$(pp_blob_failures "$VERIFY_PP_BEFORE") blob-copy failure(s)"
    else
      VERIFY_PP_BEFORE_TRUNCATED="fingerprint did not complete"
    fi
  fi
}

# verify_protected_paths <workspace> <run-db-id> <repo-slug>
#   rc 0  the machinery is untouched (or enforcement is off) — the boundary is silent
#   rc 1  a worker changed machinery: pp_enforce has already ROLLED BACK the
#         change in the working tree; we fail WITHOUT pushing so the breach never
#         reaches main, and park HEAD on a rescue branch for a human to triage.
verify_protected_paths() {
  local workspace="$1" run_db_id="$2" repo_slug="$3" banner paths rescue degraded=""
  VERIFY_PP_VIOLATION=""
  _verify_pp_enforced && command -v pp_enforce >/dev/null 2>&1 || return 0
  # #321: degrade safely when a snapshot is not SOUND. A truncated BEFORE-snapshot
  # (flagged in verify_pp_snapshot) would read untouched machinery as `appeared`
  # and roll it back; a truncated AFTER-snapshot would read present machinery as
  # `vanished` and red a clean run. In either case we cannot trust the comparison,
  # so the boundary NO-OPS this run (unenforced, not a false RED) and logs loud —
  # git-fence remains the backstop and the next run re-enforces (ADR 0174: a
  # revertible, test-proven fail-OPEN on a detected I/O fault, not a posture change).
  if [ -n "${VERIFY_PP_BEFORE_TRUNCATED:-}" ]; then
    degraded="before-snapshot — $VERIFY_PP_BEFORE_TRUNCATED"
  fi
  # Share the per-run dir with the before-snapshot so one teardown rm reaps both;
  # fall back to a bare mktemp only if the snapshot stage never set it (#761).
  if [ -n "${VERIFY_PP_RUNDIR:-}" ]; then
    VERIFY_PP_AFTER="$VERIFY_PP_RUNDIR/after"
  else
    VERIFY_PP_AFTER="$(mktemp -d)"
  fi
  if [ -z "$degraded" ]; then
    pp_snapshot "$workspace" "$VERIFY_PP_AFTER" 2>/dev/null || true
    if command -v pp_snapshot_sound >/dev/null 2>&1 && ! pp_snapshot_sound "$VERIFY_PP_AFTER"; then
      if [ -f "$VERIFY_PP_AFTER/blob_failures" ]; then
        degraded="after-snapshot — $(pp_blob_failures "$VERIFY_PP_AFTER") blob-copy failure(s)"
      else
        degraded="after-snapshot — fingerprint did not complete"
      fi
    fi
  fi
  if [ -n "$degraded" ]; then
    {
      echo "protected-path boundary DEGRADED (#321): a snapshot was not sound ($degraded)."
      echo "A truncated fingerprint (a /tmp space/quota wall, or an aborted snapshot) would"
      echo "false-attribute untouched machinery and roll REAL machinery back. The boundary is"
      echo "UNENFORCED for this run (git-fence remains the backstop); check the host's /tmp."
    } >&2
    swarmdb_event "$run_db_id" "" protected-path-degraded \
      "protected-path snapshot not sound ($degraded) — boundary unenforced this run, check host /tmp" \
      "" 2>/dev/null || true
    _verify_notify ":warning: **Swarm protected-path boundary DEGRADED** in \`$repo_slug\` (#321): a snapshot was not sound ($degraded) — likely a host \`/tmp\` space/quota wall. The boundary ran UNENFORCED this run (no false rollback, no false RED); \`git-fence\` remained the backstop and the next run re-enforces. Check the host's \`/tmp\`."
    return 0
  fi
  banner="$(mktemp)"
  if paths="$(pp_enforce "$workspace" "$VERIFY_PP_BEFORE" "$VERIFY_PP_AFTER" 2>"$banner")" \
     && [ -z "$paths" ]; then
    rm -f "$banner"
    return 0   # machinery untouched — the boundary is silent
  fi
  cat "$banner" >&2   # the loud banner (paths + escape path) into the job log
  rm -f "$banner"
  VERIFY_PP_VIOLATION=1   # the landing seam's last-line-of-defense reads this (#193)
  verdict_stage "protected-path violation — a worker edited machinery (#445)"
  swarmdb_event "$run_db_id" "" protected-path-violation \
    "worker changed protected machinery — rolled back, run failed" \
    "$(printf '%s' "$paths" | tr '\n' ' ')" 2>/dev/null || true
  rescue="sandcastle/rescue-$(date -u +%Y%m%d-%H%M%S)"
  git push origin "HEAD:refs/heads/$rescue" 2>/dev/null || true
  _verify_notify ":rotating_light: **Swarm run RED — protected-path violation** in \`$repo_slug\` (#445). A worker changed machinery that judges its work; it was rolled back and NOT pushed to main. Paths:
$(printf '%s' "$paths" | sed 's/^/- `/; s/$/`/')
The worker must instead file a \`ready-for-session\` issue for any machinery change (escape path — ADR 0174). Commits parked on \`$rescue\` for a human to triage."
  SWARM_EXIT_REASON="protected-path-violation"
  return 1
}

fi
