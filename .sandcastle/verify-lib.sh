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
# The protected-path snapshots (#445); the EXIT trap removes both.
VERIFY_PP_BEFORE=""
VERIFY_PP_AFTER=""

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
# STAGED behind PP_ENFORCE, default OFF: today the ORDINARY swarm still runs
# machinery tickets directly, so a live rollback would revert exactly that
# legitimate work. The target model routes machinery through the session-gated
# escape path (worker files a `ready-for-session` issue; an interactive session
# rules it, escalating to `ready-for-human` only on a one-way door — ADR 0174),
# and prompt.md rule 9 already tells workers to route, not edit. The flip to
# PP_ENFORCE=1 is a one-line cutover once ordinary tickets no longer carry
# machinery changes.

# verify_pp_snapshot <workspace> — fingerprint the machinery NOW, before a single
# worker runs. Snapshotting here — after the pre-existing dirty state is whatever
# it is — means another session's uncommitted work is the baseline we compare
# against and is never rolled back as collateral. Best-effort: a snapshot we
# cannot take never reds the run (verify_protected_paths then finds nothing to
# compare and no-ops).
verify_pp_snapshot() {
  VERIFY_PP_BEFORE=""
  [ "${PP_ENFORCE:-0}" = 1 ] || return 0
  VERIFY_PP_BEFORE="$(mktemp -d)"
  pp_snapshot "$1" "$VERIFY_PP_BEFORE" 2>/dev/null || true
}

# verify_protected_paths <workspace> <run-db-id> <repo-slug>
#   rc 0  the machinery is untouched (or enforcement is off) — the boundary is silent
#   rc 1  a worker changed machinery: pp_enforce has already ROLLED BACK the
#         change in the working tree; we fail WITHOUT pushing so the breach never
#         reaches main, and park HEAD on a rescue branch for a human to triage.
verify_protected_paths() {
  local workspace="$1" run_db_id="$2" repo_slug="$3" banner paths rescue
  [ "${PP_ENFORCE:-0}" = 1 ] && command -v pp_enforce >/dev/null 2>&1 || return 0
  VERIFY_PP_AFTER="$(mktemp -d)"
  pp_snapshot "$workspace" "$VERIFY_PP_AFTER" 2>/dev/null || true
  banner="$(mktemp)"
  if paths="$(pp_enforce "$workspace" "$VERIFY_PP_BEFORE" "$VERIFY_PP_AFTER" 2>"$banner")" \
     && [ -z "$paths" ]; then
    rm -f "$banner"
    return 0   # machinery untouched — the boundary is silent
  fi
  cat "$banner" >&2   # the loud banner (paths + escape path) into the job log
  rm -f "$banner"
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
