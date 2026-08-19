# fence-lib.sh — the D3 container fence (#568). Sourced by run-swarm.sh.
#
# Since the 2026-08-12 rootful-docker cutover, worker containers no longer
# live under the fenced user-1500.slice: with the system docker daemon
# (systemd cgroup driver) every container — the postgres-HA etcd voter AND
# each sandcastle-* worker — is its own scope directly under system.slice,
# all at the default cpu.weight=100. D3's contract ("the etcd voter always
# wins") therefore needs per-container bounds on the workers, applied here
# via `docker update` the moment a worker is born: a running-container
# operation — no restart, no daemon config change, works identically on
# rootful and rootless daemons (best-effort on the latter, loud when the
# cgroup controllers aren't delegated).
#
# The values mirror the retired user-slice fence (user-slice-fence.conf.j2
# in the fleet repo). --cpu-shares 320 was calibrated LIVE on elitebook-03
# (2026-08-15): with the systemd cgroup driver, docker's shares→cpu.weight
# conversion is log-scaled, and 320 lands cpu.weight=41 — the same ~40 the
# runner unit's own fence carries (ourcloud #467 / fleet 9f1d196). Note
# 1024 (the daemon default) is treated as UNSET and writes nothing.
# Kill switch: SWARM_FENCE=0.

SWARM_FENCE="${SWARM_FENCE:-1}"
SWARM_FENCE_CPU_SHARES="${SWARM_FENCE_CPU_SHARES:-320}"    # cpu.weight ~41
SWARM_FENCE_MEMORY="${SWARM_FENCE_MEMORY:-10g}"            # was MemoryMax=10G
SWARM_FENCE_MEMORY_RESERVATION="${SWARM_FENCE_MEMORY_RESERVATION:-8g}"  # was MemoryHigh=8G
SWARM_FENCE_PIDS="${SWARM_FENCE_PIDS:-2048}"               # was TasksMax=2048
SWARM_FENCE_WATCH_INTERVAL="${SWARM_FENCE_WATCH_INTERVAL:-2}"

# swarm_fence_container <name> — bound one WORKER container. Only
# sandcastle-* names are touched: fencing anything else (the etcd voter,
# redis, garage) would invert D3. Never red: a worker must not die because
# limits could not apply — but the miss is loud so it cannot rot silently.
swarm_fence_container() {
  local name="${1#/}"   # docker events names may carry a leading slash
  [ "$SWARM_FENCE" = 1 ] || return 0
  case "$name" in sandcastle-*) ;; *) return 0 ;; esac
  # --memory-swap moves WITH --memory (equal values = hard cap, no extra
  # swap): live elitebook-03 refused a bare --memory update ("Memory limit
  # should be smaller than already set memoryswap limit", 2026-08-15).
  if docker update \
       --cpu-shares "$SWARM_FENCE_CPU_SHARES" \
       --memory "$SWARM_FENCE_MEMORY" \
       --memory-swap "$SWARM_FENCE_MEMORY" \
       --memory-reservation "$SWARM_FENCE_MEMORY_RESERVATION" \
       --pids-limit "$SWARM_FENCE_PIDS" \
       "$name" >/dev/null 2>&1; then
    echo "run-swarm: D3 fence applied to $name (#568)"
  else
    echo "run-swarm: WARN — D3 fence NOT applied to $name (docker update failed; the worker runs unfenced) (#568)" >&2
  fi
  return 0
}

# swarm_fence_watch <births-file> — poll the worker-birth capture file the
# #435 `docker events` stream appends to, fencing each unique name once.
# Polling (not tail -F) so the watcher self-terminates when the births file
# is cleaned up — no orphan pollers surviving the run.
swarm_fence_watch() {
  local births="$1" seen=" " name
  while [ -f "$births" ]; do
    while IFS= read -r name; do
      [ -n "$name" ] || continue
      case "$seen" in *" $name "*) continue ;; esac
      seen="$seen$name "
      swarm_fence_container "$name"
    done <"$births"
    sleep "$SWARM_FENCE_WATCH_INTERVAL"
  done
}
