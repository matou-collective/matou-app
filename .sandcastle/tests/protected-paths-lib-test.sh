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
# The gitignored runtime-artifact trees under .sandcastle/ are runtime, not
# machinery (#273): the harness writes the per-run worker log and checks out the
# worker's own worktree there AFTER the before-snapshot, so fingerprinting them
# made every worker-bearing run a #445 false positive.
pp_is_protected ".sandcastle/logs/main-sandcastle-worker-20261017-000511-9f4faa-worker.log" \
  && fail "the harness's own worker log is NOT machinery"; ok
pp_is_protected ".sandcastle/.state/last-run" \
  && fail ".sandcastle/.state/ is a runtime tree, NOT machinery"; ok
pp_is_protected ".sandcastle/worktrees/sandcastle-worker-20261017-000511-fbb876/run-swarm.sh" \
  && fail "a worker's own worktree checkout is NOT the shared machinery"; ok
pp_is_protected ".sandcastle/worktrees/sandcastle-worker-20261017-000511-fbb876/.sandcastle/protected-paths-lib.sh" \
  && fail "a nested copy inside a worker worktree is NOT the shared machinery"; ok
pp_is_protected ".sandcastle/run-swarm.sh" \
  || fail "machinery under .sandcastle/ stays protected"; ok

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

# --- #273: the three runtime trees survive a run; machinery still caught ----
root="$(newroot)"
pp_snapshot "$root" "$before"
# the harness plants its own runtime artifacts mid-run...
mkdir -p "$root/.sandcastle/logs" "$root/.sandcastle/.state" \
         "$root/.sandcastle/worktrees/sandcastle-worker-x/.sandcastle"
printf 'tail\n' > "$root/.sandcastle/logs/main-sandcastle-worker-x-worker.log"
printf 'state\n' > "$root/.sandcastle/.state/last-run"
printf 'copy\n' > "$root/.sandcastle/worktrees/sandcastle-worker-x/run-swarm.sh"
printf 'copy\n' > "$root/.sandcastle/worktrees/sandcastle-worker-x/.sandcastle/protected-paths-lib.sh"
# ...and the worker ALSO plants a real script under the shared machinery
printf 'rm -rf /\n' > "$root/.sandcastle/evil.sh"
pp_snapshot "$root" "$after"
got="$(pp_attributed "$before" "$after")"
[ "$got" = "$(printf 'appeared\t.sandcastle/evil.sh')" ] \
  || fail "only the shared-machinery script is attributed (got: $got)"; ok
pp_enforce "$root" "$before" "$after" >/dev/null 2>&1 \
  && fail "a real machinery edit must still fail the run"; ok
[ -e "$root/.sandcastle/logs/main-sandcastle-worker-x-worker.log" ] \
  || fail "the worker log must not be rolled back"; ok
[ -e "$root/.sandcastle/.state/last-run" ] || fail ".state/ must not be rolled back"; ok
[ -e "$root/.sandcastle/worktrees/sandcastle-worker-x/run-swarm.sh" ] \
  || fail "a live worker's worktree checkout must not be deleted"; ok
[ -e "$root/.sandcastle/evil.sh" ] && fail "the machinery edit must be rolled back"; ok
rm -rf "$root"

# --- #284(a): the benign cache/runtime trees under .sandcastle/ are exempt ---
# `pnpm-store/`, `nix-store/` and `__pycache__/` (top-level + per-subpackage) are
# gitignored host-side caches `.sandcastle/.gitignore` declares never-committed —
# the same runtime class as logs/.state/worktrees, mounted/regenerated under the
# protected tree. Fingerprinting them re-opens the #445 false positive. Machinery
# under .sandcastle/ stays caught even when a cache tree churns in the same run.
pp_is_protected ".sandcastle/pnpm-store/v3/tmp/_tmp_abc" \
  && fail ".sandcastle/pnpm-store/ is a host-side cache, NOT machinery"; ok
pp_is_protected ".sandcastle/nix-store/abc123-foo/bin/x" \
  && fail ".sandcastle/nix-store/ is a host-side cache, NOT machinery"; ok
pp_is_protected ".sandcastle/__pycache__/swarm_db.cpython-312.pyc" \
  && fail ".sandcastle/__pycache__/ is regenerated bytecode, NOT machinery"; ok
pp_is_protected ".sandcastle/tui/__pycache__/board.cpython-312.pyc" \
  && fail "a per-subpackage __pycache__/ is regenerated bytecode, NOT machinery"; ok
pp_is_protected ".sandcastle/run-swarm.sh" \
  || fail "machinery under .sandcastle/ stays protected alongside the caches"; ok
# A worker-bearing run churns all three caches AND edits real machinery: only the
# machinery edit is attributed and rolled back; the caches survive.
root="$(newroot)"
pp_snapshot "$root" "$before"
mkdir -p "$root/.sandcastle/pnpm-store/v3" "$root/.sandcastle/nix-store/abc-foo" \
         "$root/.sandcastle/__pycache__" "$root/.sandcastle/tui/__pycache__"
printf 'pkg\n'  > "$root/.sandcastle/pnpm-store/v3/index"
printf 'elf\n'  > "$root/.sandcastle/nix-store/abc-foo/bin"
printf 'pyc\n'  > "$root/.sandcastle/__pycache__/swarm_db.cpython-312.pyc"
printf 'pyc\n'  > "$root/.sandcastle/tui/__pycache__/board.cpython-312.pyc"
printf 'rm -rf /\n' > "$root/.sandcastle/evil.sh"
pp_snapshot "$root" "$after"
got="$(pp_attributed "$before" "$after")"
[ "$got" = "$(printf 'appeared\t.sandcastle/evil.sh')" ] \
  || fail "only the machinery edit is attributed; the caches are exempt (got: $got)"; ok
pp_enforce "$root" "$before" "$after" >/dev/null 2>&1 \
  && fail "a real machinery edit must still fail the run alongside cache churn"; ok
[ -e "$root/.sandcastle/pnpm-store/v3/index" ] || fail "pnpm-store/ must not be rolled back"; ok
[ -e "$root/.sandcastle/nix-store/abc-foo/bin" ] || fail "nix-store/ must not be rolled back"; ok
[ -e "$root/.sandcastle/__pycache__/swarm_db.cpython-312.pyc" ] || fail "__pycache__/ must not be rolled back"; ok
[ -e "$root/.sandcastle/tui/__pycache__/board.cpython-312.pyc" ] || fail "a nested __pycache__/ must not be rolled back"; ok
[ -e "$root/.sandcastle/evil.sh" ] && fail "the machinery edit must be rolled back"; ok
rm -rf "$root"

# --- the exemptions are PATTERNS, not whatever the cwd happens to contain ----
# Run 22813: run-swarm calls the boundary with cwd = the repo root, where
# `.sandcastle/.state/` really exists. Unquoted word-splitting of the exemption
# list also glob-expands it, so `.sandcastle/.state/*` collapsed to the one
# literal entry `.sandcastle/.state/healer` and every file BENEATH it became
# protected again — the boundary attributed and rolled back the healer's own
# ledger as a worker edit. These checks run FROM a root that contains all three
# runtime trees, which is the condition the earlier #273/#278 checks (run from a
# clean cwd, where the patterns stayed literal) could not see.
cwdroot="$tmp/cwdroot"
mkdir -p "$cwdroot/.sandcastle/.state/healer" "$cwdroot/.sandcastle/logs" \
         "$cwdroot/.sandcastle/worktrees/sandcastle-worker-20261017-053155-dec00d"
printf 'ledger\n' > "$cwdroot/.sandcastle/.state/healer/0ef3e1e7d379"
printf 'tail\n'   > "$cwdroot/.sandcastle/logs/main-sandcastle-worker-x-worker.log"
printf 'copy\n'   > "$cwdroot/.sandcastle/worktrees/sandcastle-worker-20261017-053155-dec00d/run-swarm.sh"
(
  cd "$cwdroot"
  pp_is_protected ".sandcastle/.state/healer/0ef3e1e7d379" \
    && { echo "FAIL: a file under .state/ stays exempt when the cwd holds .state/healer (run 22813)" >&2; exit 1; }
  pp_is_protected ".sandcastle/logs/main-sandcastle-worker-x-worker.log" \
    && { echo "FAIL: the worker log stays exempt when the cwd holds logs/" >&2; exit 1; }
  pp_is_protected ".sandcastle/worktrees/sandcastle-worker-20261017-053155-dec00d/run-swarm.sh" \
    && { echo "FAIL: the worker checkout stays exempt when the cwd holds worktrees/" >&2; exit 1; }
  pp_is_protected ".sandcastle/run-swarm.sh" \
    || { echo "FAIL: machinery stays protected from inside such a cwd" >&2; exit 1; }
  # A glob in PP_PROTECTED_DIRS must not be rewritten by the cwd either.
  PP_PROTECTED_DIRS=".sandcastle" pp_is_protected ".sandcastle/run-swarm.sh" \
    || { echo "FAIL: PP_PROTECTED_DIRS survives splitting from a populated cwd" >&2; exit 1; }
) || fail "exemption patterns must survive word-splitting regardless of cwd contents"
ok; ok; ok; ok; ok

# ...and end-to-end: a run whose cwd IS the snapshotted root must not attribute
# the harness's own runtime artifacts (the exact shape of run 22813).
(
  cd "$cwdroot"
  pp_snapshot "$cwdroot" "$before"
  printf 'ledger-updated\n' > "$cwdroot/.sandcastle/.state/healer/0ef3e1e7d379"
  printf 'rm -rf /\n'       > "$cwdroot/.sandcastle/evil.sh"
  pp_snapshot "$cwdroot" "$after"
  got="$(pp_attributed "$before" "$after")"
  [ "$got" = "$(printf 'appeared\t.sandcastle/evil.sh')" ] \
    || { echo "FAIL: only the machinery edit is attributed from a populated cwd (got: $got)" >&2; exit 1; }
  pp_enforce "$cwdroot" "$before" "$after" >/dev/null 2>&1 \
    && { echo "FAIL: the machinery edit must still fail the run" >&2; exit 1; }
  [ "$(cat "$cwdroot/.sandcastle/.state/healer/0ef3e1e7d379")" = "ledger-updated" ] \
    || { echo "FAIL: the healer ledger must NOT be rolled back" >&2; exit 1; }
  [ -e "$cwdroot/.sandcastle/evil.sh" ] \
    && { echo "FAIL: the machinery edit must be rolled back" >&2; exit 1; }
  exit 0
) || fail "a run whose cwd is the snapshotted root must not attribute runtime artifacts (run 22813)"
ok; ok; ok; ok
rm -rf "$cwdroot"

echo "protected-paths-lib: $pass checks passed"
