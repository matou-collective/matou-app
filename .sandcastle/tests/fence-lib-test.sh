#!/usr/bin/env bash
# Scenario tests for ../fence-lib.sh (#568): the D3 container fence.
# Post-rootful-cutover, sandcastle worker containers are cgroup SIBLINGS of
# the postgres-HA etcd voter at equal weight; fence-lib applies bounded
# weights to each worker container at birth via `docker update` (a running-
# container operation — no restart, no daemon config). No network, no docker:
# a stub `docker` records its argv.
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

pass=0 fail=0
check() { if eval "$2"; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: $1"; fi; }

setup() {
  FENCE_DIR="$(mktemp -d)"; export FENCE_DIR
  mkdir -p "$FENCE_DIR/bin"
  cat >"$FENCE_DIR/bin/docker" <<'EOF'
#!/usr/bin/env bash
echo "$*" >>"$FENCE_DIR/docker-calls.log"
[ "${DOCKER_UPDATE_FAIL:-0}" = 1 ] && exit 1
exit 0
EOF
  chmod +x "$FENCE_DIR/bin/docker"
  PATH="$FENCE_DIR/bin:$PATH"
  unset SWARM_FENCE DOCKER_UPDATE_FAIL 2>/dev/null || true
  # shellcheck source=../fence-lib.sh
  . "$here/../fence-lib.sh"
}

# T1: a sandcastle-* container gets the full D3 bound set in one update
setup
swarm_fence_container "sandcastle-abc123" >/dev/null 2>&1
call="$(cat "$FENCE_DIR/docker-calls.log" 2>/dev/null || true)"
check "update targets the container" 'grep -q "update .*sandcastle-abc123" <<<"$call"'
check "cpu-shares 320 (systemd-driver cpu.weight ~41)" 'grep -q -- "--cpu-shares 320" <<<"$call"'
check "memory hard cap 10g" 'grep -q -- "--memory 10g" <<<"$call"'
# live elitebook-03 lesson (2026-08-15): docker update refuses --memory
# unless --memory-swap moves with it ("Memory limit should be smaller than
# already set memoryswap limit"); equal values = cap with no extra swap
check "memory-swap rides the memory cap" 'grep -q -- "--memory-swap 10g" <<<"$call"'
check "memory reservation 8g" 'grep -q -- "--memory-reservation 8g" <<<"$call"'
check "pids limit 2048" 'grep -q -- "--pids-limit 2048" <<<"$call"'
check "exactly one docker call" '[ "$(wc -l <"$FENCE_DIR/docker-calls.log")" = 1 ]'

# T2: docker-events names may carry a leading slash — still fenced
setup
swarm_fence_container "/sandcastle-slash" >/dev/null 2>&1
check "leading slash stripped" 'grep -q "update .*--pids-limit 2048 sandcastle-slash$" "$FENCE_DIR/docker-calls.log"'

# T3: non-worker containers are NEVER touched (the etcd voter must keep
# its default weight — fencing it would invert D3)
setup
swarm_fence_container "postgres-ha-etcd" >/dev/null 2>&1
swarm_fence_container "redis-ha" >/dev/null 2>&1
check "non-sandcastle names skipped" '[ ! -f "$FENCE_DIR/docker-calls.log" ]'

# T4: kill switch SWARM_FENCE=0
setup
SWARM_FENCE=0 swarm_fence_container "sandcastle-off" >/dev/null 2>&1
check "fence disabled by SWARM_FENCE=0" '[ ! -f "$FENCE_DIR/docker-calls.log" ]'

# T5: a failed docker update is LOUD (warn) but never red (rc 0) — the
# fence is best-effort; a worker must not die because limits could not apply
setup
export DOCKER_UPDATE_FAIL=1
out="$(swarm_fence_container "sandcastle-failing" 2>&1)"; rc=$?
unset DOCKER_UPDATE_FAIL
check "failed update keeps rc 0" '[ "$rc" = 0 ]'
check "failed update warns" 'grep -qi "WARN.*sandcastle-failing" <<<"$out"'

# T6: the watch loop fences each unique birth once and self-terminates
# when the births file disappears (no orphan pollers)
setup
births="$FENCE_DIR/births"
: >"$births"
SWARM_FENCE_WATCH_INTERVAL=0.1 swarm_fence_watch "$births" >/dev/null 2>&1 &
watch_pid=$!
{ echo "sandcastle-w1"; echo "not-a-worker"; } >>"$births"
sleep 0.4
echo "sandcastle-w1" >>"$births"   # duplicate — must not re-fence
echo "sandcastle-w2" >>"$births"
sleep 0.4
rm -f "$births"
waited=0
while kill -0 "$watch_pid" 2>/dev/null && [ "$waited" -lt 30 ]; do sleep 0.1; waited=$((waited + 1)); done
check "watch exits when births file is removed" '! kill -0 "$watch_pid" 2>/dev/null'
check "w1 fenced exactly once" '[ "$(grep -c "sandcastle-w1$" "$FENCE_DIR/docker-calls.log")" = 1 ]'
check "w2 fenced" 'grep -q "sandcastle-w2$" "$FENCE_DIR/docker-calls.log"'
check "non-worker birth ignored by watch" '! grep -q "not-a-worker" "$FENCE_DIR/docker-calls.log"'
kill "$watch_pid" 2>/dev/null || true

echo "fence-lib-test: $pass passed, $fail failed"
[ "$fail" = 0 ]
