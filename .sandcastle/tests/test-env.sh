#!/usr/bin/env bash
# tests/test-env.sh — host-state redirection for the offline suite (#58).
#
# run-swarm.sh and session-runner.sh write to HOST state by DEFAULT: the
# operator's verdicts log (~/swarm/logs/run-swarm-verdicts.log, #435), the
# workstation swarm.db (~/swarm/state/swarm.db, #447), the per-repo verdict
# file (/tmp/matou-<tag>-swarm-verdict.txt, #574) and session-runner's repo-
# scoped lock / drive-defer counter (/tmp/matou-session-runner-<slug>-*). A
# test that EXECS either script and does not redirect those paths litters the
# live host it runs on — one /tmp lock per suite run, and a fixture
# `preflight-red` row in the operator's real verdicts log every session, which
# anyone grepping for red runs reads as a real consumer failing (#58).
#
# Source this helper right after making the test's own temp dir and call
# `test_env_hermetic "$tmp"` once; it points every such path at a subdir of
# that temp dir. The PRODUCTION defaults are untouched — the fix is entirely on
# the test side (the `${VAR:-default}` forms still resolve to the live paths
# when no test sets them). A test may still override any single path afterwards
# (e.g. to a fixture value it asserts on); `env VAR=… bash script` wins over the
# exported default.
#
# Run directly (`bash tests/test-env.sh`) this file is its OWN guard: it unit-
# proves the redirect AND lints that every test which execs run-swarm.sh or
# session-runner.sh by path sources this helper — so the class stays closed:
# a future test that reaches host state without redirecting it reds the suite.

# test_env_hermetic <test-temp-dir> — export every host-state path under <dir>.
test_env_hermetic() {
  local d="${1:?test_env_hermetic: pass the test-owned temp dir}"
  mkdir -p "$d/host-env"
  export SWARM_RUNLOG="$d/host-env/run-swarm-verdicts.log"   # #435 EXIT-trap runlog
  export SWARM_DB="$d/host-env/swarm.db"                     # #447 run/attempt mirror
  export SWARM_VERDICT_PATH="$d/host-env/swarm-verdict.txt"  # #574 per-repo verdict
  # session-runner's repo-scoped /tmp derivations (lock + drive-defer counter):
  # override the PREFIX, not each path, so a test still exercises the real
  # derivation logic (test 13, #35) inside its own sandbox.
  export SESSION_RUNNER_TMP="$d/host-env"
}

# ── self-guard: only when executed directly, never when sourced ──────────────
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  set -u
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  fail() { echo "FAIL: $1" >&2; exit 1; }
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  pass=0

  # 1: the redirect points every host-state var under the given temp dir.
  test_env_hermetic "$tmp"
  for v in SWARM_RUNLOG SWARM_DB SWARM_VERDICT_PATH SESSION_RUNNER_TMP; do
    case "${!v}" in
      "$tmp"/*) : ;;
      *) fail "$v must resolve under the test temp dir, got: ${!v}" ;;
    esac
  done
  pass=$((pass+1))

  # 2: the derived session-runner lock path lands under the redirected prefix,
  #    not real /tmp — the leak this helper exists to stop (#58).
  slug="Acme-widget-$$"
  lock="$SESSION_RUNNER_TMP/matou-session-runner-$slug.lock"
  case "$lock" in "$tmp"/*) : ;; *) fail "the derived lock must be under the temp prefix, got: $lock" ;; esac
  [ -e "/tmp/matou-session-runner-$slug.lock" ] && fail "the redirect must not touch real /tmp"
  pass=$((pass+1))

  # 3: LINT — every test that EXECS run-swarm.sh / session-runner.sh by path
  #    must source this helper, so it cannot reach host state unredirected. A
  #    genuine exec is `bash …/run-swarm.sh` (not a grep, a printf into a fake
  #    tree, or a comment). This is the guard that keeps the class closed:
  #    a new host-state-touching test that forgets the helper reds here.
  self="$(basename "${BASH_SOURCE[0]}")"
  offenders=""
  for t in "$here"/*.sh; do
    b="$(basename "$t")"
    [ "$b" = "$self" ] && continue
    # Does this test genuinely exec either orchestrator by path?
    if grep -Eq 'bash[^|]*(run-swarm|session-runner)\.sh' "$t"; then
      grep -q 'test-env\.sh' "$t" || offenders="$offenders $b"
    fi
  done
  [ -z "$offenders" ] || fail "these tests exec run-swarm.sh/session-runner.sh without sourcing test-env.sh (host-state leak, #58):$offenders"
  pass=$((pass+1))

  echo "test-env: $pass checks passed"
fi
