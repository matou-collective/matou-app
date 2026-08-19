#!/usr/bin/env bash
# Zero-token, zero-network preflight for the swarm (#446, learning L5). Same
# spirit as preflight-triage.sh: run at the very top of run-swarm.sh, BEFORE a
# single worker spawns.
#
# Several swarm guards fail SILENTLY — if the guard itself breaks, it simply
# never fires, and we only learn during an incident: the 2026-07-29 limit-grep
# storm (wording drift → 70 red runs / 92 min), GOTCHAS §17 (`${VAR:?}` inside
# `$(...)` silently disabling the rail-6 backstop), GOTCHAS §16 (healer
# signature collapse). SSSF's rule: nothing spawns against a half-valid config;
# health checks assert on OUTPUT/CONTENT, never on exit codes or existence.
#
# So for every such guard we feed it a canned fixture it MUST fire on. Silence
# = instant red, named, run aborts before spawning workers. A green preflight
# costs a couple of seconds and no network / no agent.
#
# Fixtures live in tests/fixtures/ — each a real captured artifact (or a
# documented minimal synthesis), dated. Same-commit law: when a guard's target
# format changes, its fixture changes in the same commit (as GOTCHAS entries).
#
# Exit 0 + "preflight-swarm: all N guards fired" on success. On any failure it
# prints one `PREFLIGHT RED: <guard> — <why>` line per broken guard and exits 1.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIX="$here/tests/fixtures"
# shellcheck source=limit-lib.sh
. "$here/limit-lib.sh"
# shellcheck source=heal-lib.sh
. "$here/heal-lib.sh"
# shellcheck source=verdict-lib.sh
. "$here/verdict-lib.sh"
# shellcheck source=rehearsal-heal-lib.sh
. "$here/rehearsal-heal-lib.sh"
# shellcheck source=close-report-lib.sh
. "$here/close-report-lib.sh"
# shellcheck source=env-allowlist-lib.sh
. "$here/env-allowlist-lib.sh"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# The content-not-existence check the whole preflight exists to enforce: a
# mounted secret must be a NON-EMPTY file, never merely present (a 0-byte
# forgejo_token auth-fails every call — GOTCHAS §4 class). run-swarm can adopt
# this same predicate for its live secrets; here we self-test it on fixtures.
secret_present() { [ -s "$1" ]; }

# ── Guards ───────────────────────────────────────────────────────────────────
# Each guard echoes a reason and returns non-zero when it did NOT fire on its
# fixture (i.e. the guard is silently broken).

guard_limit_detection() {
  # Positive: the detector MUST match a real usage-limit block. A wording drift
  # that breaks this is the 2026-07-29 storm — caught here in 5 seconds.
  claude_limit_hit "$FIX/claude-usage-limit.txt" || {
    echo "limit-detection: CLAUDE_LIMIT_RE failed to match a real usage-limit block — the pause guard would miss the limit and red every queued run (2026-07-29 storm)"
    return 1; }
  # Negative: a normal worker log MUST NOT match — a broadened grep would
  # swallow a genuine fault as a quiet pause, worse than the storm it fixes.
  printf 'building app\nerror: test failed\ncompilation aborted\n' > "$TMP/normal.log"
  if claude_limit_hit "$TMP/normal.log"; then
    echo "limit-detection: CLAUDE_LIMIT_RE matched a NON-limit log — a false pause would swallow a real fault"
    return 1; fi
  # The reset hint must recover something to tell the operator.
  [ -n "$(claude_limit_reset_hint "$FIX/claude-usage-limit.txt")" ] || {
    echo "limit-detection: claude_limit_reset_hint empty on a real limit block"
    return 1; }
  return 0
}

guard_healer_signature() {
  # The healer keys an incident signature on the run's real failing stage +
  # first error line. If seam_verdict_signal returns EMPTY, every distinct fault
  # collapses onto the workflow-name-only signature (GOTCHAS §16 class).
  local signal
  signal="$(seam_verdict_signal "$FIX/swarm-verdict-fail.txt")"
  [ -n "$signal" ] || {
    echo "healer-signature: seam_verdict_signal produced EMPTY signal from a real failing verdict — every fault would dedup onto one signature (GOTCHAS §16)"
    return 1; }
  # normalize_error_line must still fold the per-run worker suffix, or the same
  # fault mints a fresh signature every run (the 2026-08-01 WorktreeError storm).
  local n1 n2
  n1="$(normalize_error_line 'worktree error at sandcastle-worker-20260811-233726-abc123: fatal')"
  n2="$(normalize_error_line 'worktree error at sandcastle-worker-20260810-101010-def456: fatal')"
  [ "$n1" = "$n2" ] || {
    echo "healer-signature: normalize_error_line no longer folds worker names — one fault mints a new signature every run (2026-08-01 storm)"
    return 1; }
  # A signature must be non-empty and stable for identical input.
  local s1 s2
  s1="$(compute_signature swarm "$signal")"
  s2="$(compute_signature swarm "$signal")"
  [ -n "$s1" ] && [ "$s1" = "$s2" ] || {
    echo "healer-signature: compute_signature empty or non-deterministic for identical input"
    return 1; }
  return 0
}

guard_healer_rails() {
  # Each rehearsal-healer rail (rehearsal-heal-lib.sh:heal_rails) evaluated
  # against a checkout that VIOLATES it — the rail MUST trip (return non-zero).
  # Catches the §17 class where a shell quirk silently disables a rail. The
  # checkout is a documented minimal synthesis (a throwaway git repo), built
  # here so the fixture stays a real git object, not a mocked diff.
  local co="$TMP/rails-co"
  rm -rf "$co"; mkdir -p "$co"
  git -C "$co" init -q
  git -C "$co" config user.email preflight@local
  git -C "$co" config user.name preflight
  echo base > "$co/a.txt"; git -C "$co" add .; git -C "$co" commit -qm base >/dev/null
  local pre; pre="$(git -C "$co" rev-parse HEAD)"

  # rail: "claimed healed but committed nothing" (head == pre)
  if heal_rails "$co" "$pre" >/dev/null 2>&1; then
    echo "rails: the 'committed nothing' rail did not trip (an empty heal was accepted)"; return 1; fi

  # rail: multiple commits. heal_rails resets to pre on trip.
  echo x >> "$co/a.txt"; git -C "$co" commit -aqm c1 >/dev/null
  echo y >> "$co/a.txt"; git -C "$co" commit -aqm c2 >/dev/null
  if heal_rails "$co" "$pre" >/dev/null 2>&1; then
    echo "rails: the multi-commit rail did not trip (>1 commit accepted)"; return 1; fi

  # rail: diff cap (>3 files). One commit, four new files.
  local f; for f in f1 f2 f3 f4; do echo z > "$co/$f"; done
  git -C "$co" add .; git -C "$co" commit -qm fourfiles >/dev/null
  if heal_rails "$co" "$pre" >/dev/null 2>&1; then
    echo "rails: the diff-cap rail did not trip (>3 files accepted)"; return 1; fi

  # rail: self-modification (edits the healer's own harness). One file, one line.
  mkdir -p "$co/.sandcastle"; echo "tampered" > "$co/.sandcastle/rehearsal-heal-lib.sh"
  git -C "$co" add .; git -C "$co" commit -qm selfmod >/dev/null
  if heal_rails "$co" "$pre" >/dev/null 2>&1; then
    echo "rails: the self-modification rail did not trip (a commit touching .sandcastle/rehearsal-* was accepted)"; return 1; fi

  # rail-6 backstop counter (GOTCHAS §17): two mechanical failures must count to
  # 2. Run in a subshell with REHEARSAL_STATE set — if the `${VAR:?}`-inside-$()
  # quirk (or a no-op'd counter) has crept back, the count silently stays 0.
  local st="$TMP/rehearsal-state"; rm -rf "$st"; mkdir -p "$st"
  if ! REHEARSAL_STATE="$st" bash -c '
      set -euo pipefail
      . "'"$here"'/rehearsal-heal-lib.sh"
      heal_fail_mark sigPF; heal_fail_mark sigPF
      [ "$(heal_fail_count sigPF)" = 2 ]'; then
    echo "rails: the rail-6 mechanical-failure counter did not reach 2 after two marks (GOTCHAS §17: :? inside \$() silently no-ops the backstop)"
    return 1; fi
  return 0
}

guard_verdict_parsing() {
  # A canned verdict artifact must parse to the expected fields, AND the writer
  # must (a) produce an artifact on a non-zero exit and (b) stay silent on a
  # clean exit — a verdict on disk always belongs to a real failure.
  grep -q '^stage=' "$FIX/swarm-verdict-fail.txt" || {
    echo "verdict-parsing: canned verdict artifact has no stage= field (format drift)"; return 1; }
  grep -q '^exit=' "$FIX/swarm-verdict-fail.txt" || {
    echo "verdict-parsing: canned verdict artifact has no exit= field (format drift)"; return 1; }

  local errlog="$TMP/errlog" vp="$TMP/verdict.txt" vp2="$TMP/verdict-clean.txt"
  printf 'compiling\nerror: undefined symbol foo\nboom\n' > "$errlog"
  ( verdict_begin "$vp";  verdict_stage "build stage" "$errlog"; verdict_write 3 )
  [ -f "$vp" ] || {
    echo "verdict-parsing: verdict_write produced NO artifact on a non-zero exit — a fault would leave the healer blind"; return 1; }
  grep -q '^stage=build stage' "$vp" || {
    echo "verdict-parsing: verdict_write did not record the stage field"; return 1; }
  grep -q '^exit=3' "$vp" || {
    echo "verdict-parsing: verdict_write did not record the exit code"; return 1; }
  ( verdict_begin "$vp2"; verdict_stage "clean"; verdict_write 0 )
  [ ! -f "$vp2" ] || {
    echo "verdict-parsing: verdict_write wrote a verdict on a CLEAN (exit 0) run — a green run would masquerade as a fault"; return 1; }
  # The healer's parser recovers the error line from what the writer produced.
  seam_verdict_signal "$vp" | grep -q 'undefined symbol' || {
    echo "verdict-parsing: seam_verdict_signal did not recover the error line from a fresh verdict"; return 1; }
  return 0
}

guard_secrets_content() {
  # Content, not existence: an EMPTY secret must be REJECTED; a non-empty one
  # accepted. (A blank forgejo_token is present-but-useless — GOTCHAS §4.)
  if secret_present "$FIX/secret-empty.txt"; then
    echo "secrets-content: an EMPTY secret passed the presence check — existence-not-content (a blank forgejo_token auth-fails every call, GOTCHAS §4)"; return 1; fi
  secret_present "$FIX/secret-nonempty.txt" || {
    echo "secrets-content: a non-empty secret FAILED the presence check — the guard rejects valid secrets"; return 1; }
  return 0
}

guard_secrets_allowlist() {
  # #593 (part 1 of #592): a stray *TOKEN|SECRET|KEY|PASS-shaped key in a
  # host-mode .sandcastle/.env would ship into every worker as a docker run -e
  # value (docker inspect .Config.Env — the 2026-07-11 breach vector, the #578
  # leak class). Feed env_allowlist_violations a throwaway .env it MUST refuse
  # and a clean allowlist-only one it MUST pass (the guard_healer_rails
  # throwaway-fixture pattern — no file on disk for this one).
  local bad="$TMP/env-allowlist-bad" good="$TMP/env-allowlist-good"
  cat > "$bad" <<'EOF'
CLAUDE_CODE_OAUTH_TOKEN=sk-test-not-real
FORGEJO_API=
FOO_TOKEN=leaked
EOF
  local violations
  violations="$(env_allowlist_violations "$bad")"
  [ "$violations" = "FOO_TOKEN" ] || {
    echo "secrets-allowlist: a stray FOO_TOKEN in .env did NOT trip the guard (env_allowlist_violations returned: '$violations') — a docker-inspect leak (#578 class) would ship silently"
    return 1; }

  cat > "$good" <<'EOF'
CLAUDE_CODE_OAUTH_TOKEN=sk-test-not-real
FORGEJO_API=
MATTERMOST_URL=
MATTERMOST_CHANNEL_ID=
BASH_DEFAULT_TIMEOUT_MS=1500000
BASH_MAX_TIMEOUT_MS=1800000
REHEARSAL_DRIVE_ISSUE=523
REHEARSAL_DRIVE_TARGET=selfhosted
SWARM_HOST=
SWARM_RUN_ID=
EOF
  violations="$(env_allowlist_violations "$good")"
  [ -z "$violations" ] || {
    echo "secrets-allowlist: a clean allowlist-only .env was REJECTED (flagged: $violations) — the guard would refuse every legitimate host run"
    return 1; }
  return 0
}

guard_close_report() {
  # The close-report claim gates (close-report-lib.sh, #444) are a silent-failure
  # guard: if cr_violations breaks and returns EMPTY at rc 0, a worker's false
  # claim (a fabricated SHA, a claimed-passing test that exited non-zero, a
  # reasonless refusal) sails through and the ticket closes green-and-wrong. So
  # feed it envelopes it MUST refuse, plus one it must pass — over a throwaway
  # repo (a real git object, not a mocked diff), the guard_healer_rails pattern.
  local co="$TMP/cr-co"
  rm -rf "$co"; mkdir -p "$co"
  git -C "$co" init -q
  git -C "$co" config user.email preflight@local
  git -C "$co" config user.name preflight
  echo a > "$co/src.go"; git -C "$co" add .; git -C "$co" commit -qm base >/dev/null
  local sha; sha="$(git -C "$co" rev-parse HEAD)"

  # honest envelope over the real commit → clean pass (no false positives).
  local good
  good="$(jq -n --arg s "$sha" '{issue:1,status:"success",commits:[$s],changed_files:["src.go"],tests:[{command:"t",exit_code:0}],summary:"ok",blockers:[]}')"
  if ! cr_violations "$good" "$co" HEAD >/dev/null 2>&1; then
    echo "close-report: cr_violations REFUSED an honest envelope over a real commit — the gate false-positives and would block every clean close"
    return 1; fi

  # fabricated SHA → must refuse (gate 1).
  local bad
  bad="$(jq -n '{issue:1,status:"success",commits:["deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"],changed_files:["src.go"],summary:"lie"}')"
  if cr_violations "$bad" "$co" HEAD >/dev/null 2>&1; then
    echo "close-report: cr_violations ACCEPTED a fabricated SHA — a false-green close would sail through (the #444 root)"
    return 1; fi

  # claimed-passing test that exited non-zero → must refuse (gate 4).
  bad="$(jq -n --arg s "$sha" '{issue:1,status:"success",commits:[$s],changed_files:["src.go"],tests:[{command:"go test",exit_code:1}],summary:"lie"}')"
  if cr_violations "$bad" "$co" HEAD >/dev/null 2>&1; then
    echo "close-report: cr_violations ACCEPTED a status:success with a test that exited 1 — a faulted leg would read green"
    return 1; fi

  # reasonless refusal → must refuse (gate 5, 'label refusals loud').
  bad="$(jq -n '{issue:1,status:"refused",summary:"nope"}')"
  if cr_violations "$bad" "$co" HEAD >/dev/null 2>&1; then
    echo "close-report: cr_violations ACCEPTED a refusal with no reason — a silent refusal is the 165115Z fault"
    return 1; fi
  return 0
}

# ── Runner ───────────────────────────────────────────────────────────────────
GUARDS=(
  guard_limit_detection
  guard_healer_signature
  guard_healer_rails
  guard_verdict_parsing
  guard_secrets_content
  guard_secrets_allowlist
  guard_close_report
)

failed=0
for g in "${GUARDS[@]}"; do
  if reason="$("$g")"; then
    echo "preflight-swarm: ${g#guard_} OK"
  else
    echo "PREFLIGHT RED: ${g#guard_} — $reason" >&2
    failed=$((failed + 1))
  fi
done

if [ "$failed" -ne 0 ]; then
  echo "preflight-swarm: $failed guard(s) did NOT fire on their fixture — aborting before any worker spawns" >&2
  exit 1
fi
echo "preflight-swarm: all ${#GUARDS[@]} guards fired"
