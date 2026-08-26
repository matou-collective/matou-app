#!/usr/bin/env bash
# Offline test for run-swarm.sh's .env materialize / allowlist-guard block
# (#593, part 1 of #592).
#
# Until #2 this file kept a structurally-identical COPY of the block, because
# the surrounding script needs pnpm, docker and a live tracker to reach it. The
# block now lives in provision-lib.sh (the PROVISION seam) as
# provision_env_materialize, and this test drives the REAL function — with the
# same four scenarios the copy pinned.
#
# Run: bash .sandcastle/tests/run-swarm-env-guard-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sc="$here/.."
. "$sc/env-allowlist-lib.sh"
. "$sc/verdict-lib.sh"   # #9: the guard names its stage + captures the FATAL
. "$sc/provision-lib.sh"

fail() { echo "FAIL: $1" >&2; exit 1; }
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
pass=0

# A CI-mode workdir: always has the real .env.example beside it.
setup_workdir() { # setup_workdir <name>
  local d="$tmp/$1"
  mkdir -p "$d"
  cp "$sc/.env.example" "$d/.env.example"
  printf '%s' "$d"
}

# Host mode is "GITHUB_ACTIONS unset", which an inherited environment can hide,
# so the host-mode cases run in a child shell with the variable removed.
host_mode() { # host_mode <dir> [verdict-path]
  env -u GITHUB_ACTIONS bash -c "
    . '$sc/env-allowlist-lib.sh'; . '$sc/verdict-lib.sh'; . '$sc/provision-lib.sh'
    ${2:+verdict_begin '$2'; verdict_stage 'preflight self-tests (#446)';}
    provision_env_materialize '$1' || { ${2:+verdict_write 1;} exit 1; }"
}

# --- 1. CI (GITHUB_ACTIONS set) always overwrites, even over a BAD .env — the
#        guard must not fire on the CI path, per the ticket's requirement. ---
d="$(setup_workdir ci-bad)"
printf 'FOO_TOKEN=leaked\n' > "$d/.env"
verdict_begin "$tmp/ci-bad-verdict.txt"
GITHUB_ACTIONS=true provision_env_materialize "$d" \
  || fail "CI-mode must never refuse, even with a stray secret in the pre-existing .env"
[ ! -f "$tmp/ci-bad-verdict.txt" ] || fail "CI-mode must not write a verdict (it never refuses)"
diff -q "$d/.env" "$d/.env.example" >/dev/null || fail "CI-mode must overwrite .env from .env.example"
pass=$((pass+1))

# --- 2. Host-mode, first run (no .env yet) → materialize, no guard involved. ---
d="$(setup_workdir host-first)"
host_mode "$d" || fail "host-mode with no existing .env must materialize, not refuse"
[ -f "$d/.env" ] || fail "host-mode first run should have created .env"
pass=$((pass+1))

# --- 3. Host-mode, clean pre-existing .env → passes, left UNTOUCHED (never
#        clobber a developer's real .env on a host run). ---
d="$(setup_workdir host-clean)"
printf 'CLAUDE_CODE_OAUTH_TOKEN=sk-test\nFORGEJO_API=https://example\n' > "$d/.env"
before="$(cat "$d/.env")"
host_mode "$d" || fail "host-mode with a clean .env must pass"
after="$(cat "$d/.env")"
[ "$before" = "$after" ] || fail "a clean host .env must be left untouched, not materialized over"
pass=$((pass+1))

# --- 4. Host-mode, .env with a stray secret-shaped key → refused, and the
#        file is left in place (untouched) so the operator can fix it. ---
d="$(setup_workdir host-bad)"
printf 'CLAUDE_CODE_OAUTH_TOKEN=sk-test\nFOO_TOKEN=leaked\n' > "$d/.env"
before="$(cat "$d/.env")"
vp="$tmp/host-bad-verdict.txt"
if host_mode "$d" "$vp" 2>"$tmp/err"; then
  fail "host-mode with a stray FOO_TOKEN must be refused, not passed"
fi
grep -q 'FOO_TOKEN' "$tmp/err" || fail "the refusal must name the offending key:
$(cat "$tmp/err")"
after="$(cat "$d/.env")"
[ "$before" = "$after" ] || fail "a refused .env must be left untouched (never silently rewritten)"
# #9: the death must key on THIS guard's stage with the FATAL as its error line,
# not the stale "preflight self-tests" stage with an empty error block.
grep -q '^stage=env allowlist check (#593)$' "$vp" || fail "verdict stage not re-keyed to the allowlist guard:
$(cat "$vp")"
grep -q 'FOO_TOKEN' "$vp" || fail "the FATAL naming the offending key was not captured as the error line:
$(cat "$vp")"
pass=$((pass+1))

echo "run-swarm-env-guard: $pass scenarios passed"
