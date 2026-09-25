#!/usr/bin/env bash
# preflight-lib.sh — the PREFLIGHT seam of run-swarm.sh (#2): the two gates that
# fire BEFORE any real work — before the janitor mutates a label, before pnpm
# install, before a worker spawns.
#
#   1. the self-tests (#446, learning L5) — every silently-failing guard (limit
#      grep, healer signature/rails, verdict parsing, secrets-as-content) is
#      fired against a canned fixture it MUST match. A guard that has quietly
#      broken (a mangled limit grep, a §17 `:?`-in-$() rail no-op) reds HERE in
#      seconds, NAMED, instead of during an incident. Zero token; the only
#      network call is the #20 issue-write permission probe (one cheap GET).
#   2. the per-repo POLICY (#12, ADR 0002) — an invalid swarm-policy.sh fails
#      LOUD here, like swarm_resolve_model, never a silent misconfiguration.
#
# preflight-swarm.sh owns the guards themselves (and its own test) and
# policy-lib.sh the loader/validator; what lived inline in run-swarm.sh, and
# lives here, is the gating: both fail CLOSED — the run aborts and posts the
# failing guard, and NO worker is spawned. The runlog line comes from the EXIT
# trap via SWARM_EXIT_REASON.
#
# Callers must have sourced policy-lib.sh and verdict-lib.sh. Offline-tested by
# tests/preflight-lib-test.sh.

if [ -z "${__SWARM_PREFLIGHT_LIB:-}" ]; then
__SWARM_PREFLIGHT_LIB=1

_PREFLIGHT_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFLIGHT_SCRIPT="${PREFLIGHT_SCRIPT:-$_PREFLIGHT_HERE/preflight-swarm.sh}"
PREFLIGHT_NOTIFY="${PREFLIGHT_NOTIFY:-$_PREFLIGHT_HERE/notify-mattermost.sh}"

_preflight_notify() { bash "$PREFLIGHT_NOTIFY" "$1" || true; }

# preflight_gate <repo-slug> — run the self-tests. rc 1 (SWARM_EXIT_REASON set)
# when a guard did not fire on its fixture; the captured output is printed either
# way so a green preflight is still visible in the job log.
preflight_gate() {
  local repo_slug="$1" out red
  verdict_stage "preflight self-tests (#446)"
  if out="$(bash "$PREFLIGHT_SCRIPT" 2>&1)"; then
    printf '%s\n' "$out"
    return 0
  fi
  printf '%s\n' "$out"
  red="$(printf '%s\n' "$out" | grep 'PREFLIGHT RED' | head -20 || true)"
  # #9: the guard FATALs to stderr, never to an errlog file, so without this the
  # verdict's `--- error lines ---` block is EMPTY and the healer keys its
  # signature on the bare stage name — which is exactly what run 20865 handed it
  # (a whole investigation off `stage=preflight self-tests (#446) exit=1` with
  # nothing under it, GOTCHAS #217). Record the failing guard line(s) so the
  # verdict, the runlog and the healer all name the cause.
  verdict_error "$(printf '%s' "${red:-preflight-swarm.sh exited non-zero without a PREFLIGHT RED line}" | tr '\n' ' ')"
  _preflight_notify ":rotating_light: **Swarm preflight RED** in \`$repo_slug\` — a silent-failure guard did not fire on its fixture; NO worker was spawned. Fix before the swarm can run:
\`\`\`
$red
\`\`\`"
  SWARM_EXIT_REASON="preflight-red"
  return 1
}

# preflight_policy_gate <repo-slug> [policy-file] — load + validate the consumer's
# swarm-policy.sh (landing / merge-authority / loop-in-label knobs, defaulting to
# today's byte-identical behaviour when absent) and echo which of the two it got.
# rc 1 (SWARM_EXIT_REASON set) on an invalid policy — policy_validate has already
# named the offending key on stderr.
preflight_policy_gate() {
  local repo_slug="$1" file="${2:-}"
  policy_load ${file:+"$file"}
  if ! policy_validate ${file:+"$file"}; then
    verdict_stage "policy validation (#12)"
    _preflight_notify ":no_entry: **Swarm aborted — invalid \`swarm-policy.sh\`** in \`$repo_slug\`. Fix the named policy key; no worker was spawned."
    SWARM_EXIT_REASON="invalid-policy"
    return 1
  fi
  if [ "${SWARM_POLICY_FILE_PRESENT:-false}" = true ]; then
    echo "run-swarm: policy: LANDING=$SWARM_POLICY_LANDING MERGE_AUTHORITY=$SWARM_POLICY_MERGE_AUTHORITY"
  else
    echo "run-swarm: policy: defaults (LANDING=$SWARM_POLICY_LANDING MERGE_AUTHORITY=$SWARM_POLICY_MERGE_AUTHORITY)"
  fi
}

# preflight_model_gate <repo-slug> <ready-json> — resolve THIS run's model from
# the first ready ticket's model-<name> label (schedule-lib's seam) and export it
# for main.mts. An unknown model fails LOUD now, before a single worker spawns,
# never a silent fall back to the default. rc 1 on refusal.
preflight_model_gate() {
  local repo_slug="$1" ready="$2" first resolved
  first="$(schedule_first_model "$ready")"
  if ! resolved="$(schedule_resolve_run_model "$ready")"; then
    verdict_stage "swarm model resolution (#448 fail-fast)"
    _preflight_notify ":no_entry: **Swarm aborted — unknown model** \`${first:-?}\` on the first ready ticket in \`$repo_slug\`. Fix its \`model-*\` label; no worker was spawned."
    SWARM_EXIT_REASON="unknown-model"
    return 1
  fi
  SWARM_MODEL="$resolved"
  export SWARM_MODEL
  schedule_model_note "$ready" "$SWARM_MODEL"
}

# preflight_landing_gate <repo-slug> <ready-json> — resolve THIS run's landing
# (idss ADR 0267) and mirror it to the sandbox. An unknown `landing-*` label on
# ANY ready ticket fails LOUD now, before a single worker spawns — the
# swarm_resolve_model discipline. The signal file is what list-ready-tasks.sh
# reads inside every sandbox (/run/host-signals/run-landing, the drive-yield
# channel). rc 1 on refusal.
preflight_landing_gate() {
  local repo_slug="$1" ready="$2" bad named
  bad="$(schedule_bad_landing_labels "$ready")"
  if [ -n "$bad" ]; then
    verdict_stage "ticket landing resolution (fail-fast)"
    named="$(printf '%s\n' "$bad" | awk '{printf "%s#%s `%s`", (NR>1 ? ", " : ""), $1, $2}')"
    _preflight_notify ":no_entry: **Swarm aborted — unknown landing label** in \`$repo_slug\`: $named. The only allowed override is \`landing-pr\`. Fix the label; no worker was spawned."
    SWARM_EXIT_REASON="unknown-landing"
    return 1
  fi
  SWARM_RUN_LANDING="$(schedule_run_landing "$ready")"
  export SWARM_RUN_LANDING
  if [ -n "${SWARM_HOST_SIGNALS_DIR:-}" ]; then
    if ! { mkdir -p "$SWARM_HOST_SIGNALS_DIR" && printf '%s\n' "$SWARM_RUN_LANDING" > "$SWARM_HOST_SIGNALS_DIR/run-landing"; } 2>/dev/null; then
      verdict_stage "ticket landing resolution (fail-fast)"
      _preflight_notify ":no_entry: **Swarm aborted — could not write the run-landing signal** to \`$SWARM_HOST_SIGNALS_DIR\` in \`$repo_slug\`. Without it a sandbox hides every PR-landing ticket; no worker was spawned."
      SWARM_EXIT_REASON="landing-signal-unwritable"
      return 1
    fi
  fi
  echo "run-swarm: landing for this run: $SWARM_RUN_LANDING$([ "${SWARM_RUN_LANDING%% *}" = pr ] && printf ' (the head ticket carries landing-pr — it is worked alone)')"
}

fi
