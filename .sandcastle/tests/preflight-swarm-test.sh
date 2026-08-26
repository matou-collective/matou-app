#!/usr/bin/env bash
# Offline test for preflight-swarm.sh (#446 AC): a green preflight passes fast,
# and deliberately breaking a guard turns preflight RED with that guard NAMED —
# the exact demonstration the acceptance criteria demand. No network, no agent.
# Run: bash .sandcastle/tests/preflight-swarm-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SC="$here/.."
fail() { echo "FAIL: $1" >&2; exit 1; }

# The offline guards must not reach the network. guard_issue_write_permission
# (#20) is skipped when no bot token is present, so run these scenarios with
# FORGEJO_TOKEN unset — scenario 4 exercises the probe on its own with a shim.
unset FORGEJO_TOKEN 2>/dev/null || true

# ── 1. Green path: all guards fire on the real fixtures against the real libs.
out="$(bash "$SC/preflight-swarm.sh" 2>&1)" || fail "green preflight must pass on the current guards; got:
$out"
grep -q 'all 9 guards fired' <<<"$out" || fail "green preflight did not report all guards fired:
$out"

# A copy of the harness we can mangle without touching the real scripts. Only
# what preflight sources + its fixtures; secrets are deliberately NOT copied.
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/sc/tests"
cp "$SC"/*.sh "$tmp/sc/"
cp -r "$SC/tests/fixtures" "$tmp/sc/tests/fixtures"

# The mangled copy must still pass BEFORE we break anything (proves the copy is
# faithful and any red below is caused by our mangle, not the copy).
bash "$tmp/sc/preflight-swarm.sh" >/dev/null 2>&1 || fail "the unmodified copy should pass — copy is not faithful"

# ── 2. Mangle the limit grep (the 2026-07-29 storm's root cause) → RED, named.
#      Point CLAUDE_LIMIT_RE at a string the real limit block cannot contain.
sed -i 's#^CLAUDE_LIMIT_RE=.*#CLAUDE_LIMIT_RE="ZZ_NEVER_MATCHES_ZZ"#' "$tmp/sc/limit-lib.sh"
if bash "$tmp/sc/preflight-swarm.sh" >"$tmp/o1" 2>&1; then
  fail "a mangled limit grep must turn preflight RED; it passed:
$(cat "$tmp/o1")"
fi
grep -q 'PREFLIGHT RED: limit_detection' "$tmp/o1" \
  || fail "preflight red did not NAME the broken limit guard:
$(cat "$tmp/o1")"
# Restore for the next scenario.
cp "$SC/limit-lib.sh" "$tmp/sc/limit-lib.sh"

# ── 2b. Mangle the auth grep (#632's incident) → RED, named. Point
#      CLAUDE_AUTH_RE at a string the real auth refusal cannot contain.
sed -i 's#^CLAUDE_AUTH_RE=.*#CLAUDE_AUTH_RE="ZZ_NEVER_MATCHES_ZZ"#' "$tmp/sc/limit-lib.sh"
if bash "$tmp/sc/preflight-swarm.sh" >"$tmp/o1b" 2>&1; then
  fail "a mangled auth grep must turn preflight RED; it passed:
$(cat "$tmp/o1b")"
fi
grep -q 'PREFLIGHT RED: auth_detection' "$tmp/o1b" \
  || fail "preflight red did not NAME the broken auth guard:
$(cat "$tmp/o1b")"
# Restore for the next scenario.
cp "$SC/limit-lib.sh" "$tmp/sc/limit-lib.sh"

# ── 3. Disable a healer rail (GOTCHAS §17 class: a rail that silently no-ops).
#      Neuter the rail-6 mechanical-failure counter so two marks count to 0.
cat >> "$tmp/sc/rehearsal-heal-lib.sh" <<'SH'
heal_fail_mark() { :; }   # §17-style silent no-op, injected by the test
SH
if bash "$tmp/sc/preflight-swarm.sh" >"$tmp/o2" 2>&1; then
  fail "a silently-disabled rail must turn preflight RED; it passed:
$(cat "$tmp/o2")"
fi
grep -q 'PREFLIGHT RED: healer_rails' "$tmp/o2" \
  || fail "preflight red did not NAME the broken rails guard:
$(cat "$tmp/o2")"

# ── 4. The #20 issue-write permission probe. With a bot token present, a repo
#      whose permissions block denies write must red preflight NAMED — the exact
#      #19 gap (repo.code write but not repo.issues) that made a failed close
#      look green. A curl shim answers the repo-root GET; no other guard calls
#      curl, so the shim only steers the probe.
mkdir -p "$tmp/bin"
cat > "$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
# only the probe's repo-root GET matters; echo a permissions block per PROBE_PUSH
for a in "$@"; do case "$a" in http*) : ;; esac; done
echo "{\"permissions\":{\"push\":${PROBE_PUSH:-true}}}"
SH
chmod +x "$tmp/bin/curl"

if env PATH="$tmp/bin:$PATH" FORGEJO_TOKEN=bot FORGEJO_API=http://x/api/v1/repos/x/y \
    PROBE_PUSH=false bash "$SC/preflight-swarm.sh" >"$tmp/o3" 2>&1; then
  fail "a bot without issue-write permission must turn preflight RED; it passed:
$(cat "$tmp/o3")"
fi
grep -q 'PREFLIGHT RED: issue_write_permission' "$tmp/o3" \
  || fail "preflight red did not NAME the issue-write-permission guard:
$(cat "$tmp/o3")"

env PATH="$tmp/bin:$PATH" FORGEJO_TOKEN=bot FORGEJO_API=http://x/api/v1/repos/x/y \
  PROBE_PUSH=true bash "$SC/preflight-swarm.sh" >"$tmp/o4" 2>&1 \
  || fail "a bot WITH write permission must pass the probe:
$(cat "$tmp/o4")"

echo "preflight-swarm: 5 scenarios passed (green; mangled limit grep named; mangled auth grep named; disabled rail named; read-only-issues bot named)"
