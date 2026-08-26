#!/usr/bin/env bash
# Offline tests for protected-paths-lib.sh — the outcome boundary around swarm
# workers (#445). No git repo, no network: snapshots are sha256 of working-tree
# bytes, so the fixtures are plain directories a "worker" mutates between two
# snapshots. Run: bash .sandcastle/tests/protected-paths-lib-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/../protected-paths-lib.sh"

fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0
ok() { pass=$((pass+1)); }

# A fresh fake worktree with the protected dirs present and one non-protected
# app file. Echoes the root.
newroot() {
  local root; root="$(mktemp -d)"
  mkdir -p "$root/.sandcastle" "$root/.forgejo/workflows" "$root/dashboard/src"
  printf 'machinery\n'      > "$root/.sandcastle/run-swarm.sh"
  printf 'name: ci\n'       > "$root/.forgejo/workflows/ci.yml"
  printf 'export const x\n' > "$root/dashboard/src/app.ts"
  printf '%s' "$root"
}

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
before="$tmp/before"; after="$tmp/after"

# --- pp_is_protected: the declared boundary --------------------------------
pp_is_protected ".sandcastle/run-swarm.sh"     || fail ".sandcastle/ is protected"; ok
pp_is_protected ".forgejo/workflows/ci.yml"    || fail ".forgejo/ is protected"; ok
pp_is_protected ".git/hooks/pre-push"          || fail ".git/ admin is declared protected"; ok
pp_is_protected "./.sandcastle/x"              || fail "a leading ./ is normalised"; ok
pp_is_protected "dashboard/src/app.ts"         && fail "app code is NOT protected"; ok
pp_is_protected "docs/adr/0042.md"             && fail "docs are NOT protected"; ok
# healer evidence dirs are runtime, not machinery — exempt even though they can
# sit under a protected-looking absolute path.
pp_is_protected "/tmp/matou-heal-idss.abc/diagnosis.md" && fail "healer evidence is exempt"; ok
PP_EXEMPT_GLOBS=".sandcastle/runtime/*" pp_is_protected ".sandcastle/runtime/x" \
  && fail "an extra exempt glob wins over the protected dir"; ok

# --- acceptance #1: worker WRITES into .sandcastle/ → rolled back + named ---
root="$(newroot)"
pp_snapshot "$root" "$before"
# the "worker" plants a script under the machinery
printf 'rm -rf /\n' > "$root/.sandcastle/evil.sh"
pp_snapshot "$root" "$after"

att="$(pp_attributed "$before" "$after")"
printf '%s\n' "$att" | grep -qx "$(printf 'appeared\t.sandcastle/evil.sh')" \
  || fail "a created protected file must be attributed as appeared, got: $att"; ok

out="$(pp_enforce "$root" "$before" "$after" 2>"$tmp/err")" && fail "enforce must FAIL on a violation"; ok
printf '%s\n' "$out" | grep -qx ".sandcastle/evil.sh" || fail "enforce stdout must name the path, got: $out"; ok
grep -q ".sandcastle/evil.sh" "$tmp/err" || fail "the failure banner must name the path"; ok
grep -qi "file a ready-for-session issue instead" "$tmp/err" || fail "the banner must point to the escape path"; ok
[ ! -e "$root/.sandcastle/evil.sh" ] || fail "the created protected file must be rolled back (deleted)"; ok
rm -rf "$root"

# --- acceptance #2: revert-detection — a protected file the worker changes ---
# The worker takes a protected file that carried a pre-existing (dirty) change
# and reverts it to a different content. Content differs before→after, so it is
# attributed and reported (this is the `git checkout` revert L3 names), and the
# rollback restores the PRE-RUN bytes.
root="$(newroot)"
printf 'name: ci\n# pending work from another session\n' > "$root/.forgejo/workflows/ci.yml"
pp_snapshot "$root" "$before"
# worker reverts the pending change back to the committed baseline
printf 'name: ci\n' > "$root/.forgejo/workflows/ci.yml"
pp_snapshot "$root" "$after"

att="$(pp_attributed "$before" "$after")"
printf '%s\n' "$att" | grep -qx "$(printf 'changed\t.forgejo/workflows/ci.yml')" \
  || fail "a reverted/modified protected file must be attributed as changed, got: $att"; ok
pp_enforce "$root" "$before" "$after" >/dev/null 2>"$tmp/err" && fail "enforce must FAIL on a revert"; ok
grep -q ".forgejo/workflows/ci.yml" "$tmp/err" || fail "the revert must be named in the banner"; ok
# rolled back to the PRE-RUN bytes (the other session's pending work survives)
grep -q "pending work from another session" "$root/.forgejo/workflows/ci.yml" \
  || fail "rollback must restore the pre-run content of a reverted protected file"; ok
rm -rf "$root"

# --- acceptance #3/#4: pre-existing dirty paths are provably untouched -------
# A protected file AND a non-protected file both carry pre-existing changes the
# worker never touches. The worker's only change is elsewhere under .sandcastle.
# Enforce must roll back ONLY the worker's introduction and leave both
# pre-existing dirty files byte-for-byte intact.
root="$(newroot)"
printf 'machinery\n# another session is editing this\n' > "$root/.sandcastle/run-swarm.sh"
printf 'export const x\n// another session app edit\n'   > "$root/dashboard/src/app.ts"
protected_before="$(_pp_digest "$root/.sandcastle/run-swarm.sh")"
app_before="$(_pp_digest "$root/dashboard/src/app.ts")"
pp_snapshot "$root" "$before"
# worker only plants a new file; it does NOT touch the two dirty files
printf 'x\n' > "$root/.sandcastle/planted.sh"
pp_snapshot "$root" "$after"

pp_enforce "$root" "$before" "$after" >/dev/null 2>&1 && fail "the planted file is still a violation"; ok
[ ! -e "$root/.sandcastle/planted.sh" ] || fail "the planted file must be rolled back"; ok
[ "$(_pp_digest "$root/.sandcastle/run-swarm.sh")" = "$protected_before" ] \
  || fail "a pre-existing dirty PROTECTED file the worker did not touch must be untouched by rollback"; ok
[ "$(_pp_digest "$root/dashboard/src/app.ts")" = "$app_before" ] \
  || fail "a pre-existing dirty non-protected file must be untouched by rollback"; ok
ok
rm -rf "$root"

# --- clean run: worker touches only its own scope → boundary is silent ------
root="$(newroot)"
pp_snapshot "$root" "$before"
printf 'export const x\n// legit slice work\n' > "$root/dashboard/src/app.ts"   # in-scope
mkdir -p "$root/dashboard/src/lib"; printf 'y\n' > "$root/dashboard/src/lib/new.ts"
pp_snapshot "$root" "$after"
[ -z "$(pp_attributed "$before" "$after")" ] || fail "in-scope work must attribute no protected change"; ok
pp_enforce "$root" "$before" "$after" >/dev/null 2>&1 || fail "a clean run must pass the boundary"; ok
rm -rf "$root"

# --- exempt runtime under a protected dir is not attributed -----------------
root="$(newroot)"
PP_EXEMPT_GLOBS=".sandcastle/evidence/*" pp_snapshot "$root" "$before"
mkdir -p "$root/.sandcastle/evidence"; printf 'log\n' > "$root/.sandcastle/evidence/run.log"
PP_EXEMPT_GLOBS=".sandcastle/evidence/*" pp_snapshot "$root" "$after"
[ -z "$(PP_EXEMPT_GLOBS='.sandcastle/evidence/*' pp_attributed "$before" "$after")" ] \
  || fail "an exempt runtime path under a protected dir must not be attributed"; ok
[ -e "$root/.sandcastle/evidence/run.log" ] || fail "an exempt path must not be rolled back"; ok
rm -rf "$root"

echo "protected-paths-lib: $pass checks passed"
