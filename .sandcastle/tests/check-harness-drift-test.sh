#!/usr/bin/env bash
# Offline test for check-harness-drift.sh's pull-based model (ADR 0180 /
# #571): no real network — FACTORY_REPO points at a local bare git repo, so
# the real git fetch/clone/checkout code paths run for real, just against a
# throwaway local remote instead of git.matou.nz.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/../check-harness-drift.sh"
fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

# A throwaway "factory" repo with two files at commit A, then a commit B.
factory_src="$tmp/factory-src"
mkdir -p "$factory_src"
git init -q "$factory_src"
git -C "$factory_src" config user.email t@t.test
git -C "$factory_src" config user.name t
echo 'echo one' >"$factory_src/one.sh"
echo 'echo two' >"$factory_src/two.sh"
git -C "$factory_src" add -A && git -C "$factory_src" commit -q -m A
rev_a="$(git -C "$factory_src" rev-parse HEAD)"
echo 'echo two v2' >"$factory_src/two.sh"
git -C "$factory_src" add -A && git -C "$factory_src" commit -q -m B
# Plumbing update-ref (not the porcelain `branch -f`), so this works
# regardless of whether "main" happens to already be the checked-out branch.
git -C "$factory_src" update-ref refs/heads/main HEAD
export FACTORY_REPO="$factory_src"

# A throwaway .sandcastle-shaped consumer dir, vendored at rev_a. The script
# under test derives its own directory from BASH_SOURCE (not $PWD), so it is
# copied IN here — this runs the exact same script content, just resolving
# "here" against $sc instead of the real .sandcastle/.
sc="$tmp/sandcastle"; mkdir -p "$sc"
cp "$script" "$sc/check-harness-drift.sh"
cp "$factory_src/one.sh" "$sc/"
printf 'echo two\n' >"$sc/two.sh"   # rev_a's content
printf '%s\n' "$rev_a" >"$sc/FACTORY_REF"
printf 'one.sh\ntwo.sh\n' >"$sc/FACTORY_MANIFEST"

# run <out-file> <err-file> — never trips `set -e`: the caller reads $rc.
run() { rc=0; (cd "$sc" && bash ./check-harness-drift.sh) >"$1" 2>"$2" || rc=$?; }

# T1: no FACTORY_REF -> green, "nothing to enforce"
rm "$sc/FACTORY_REF"
run "$tmp/out" "$tmp/err"
[ "$rc" -eq 0 ] || fail "no FACTORY_REF should exit 0: $(cat "$tmp/err")"
grep -q "nothing to enforce" "$tmp/out" || fail "no FACTORY_REF should say nothing to enforce"
pass=$((pass+1))

# T2: in sync -> green
printf '%s\n' "$rev_a" >"$sc/FACTORY_REF"
run "$tmp/out" "$tmp/err"
[ "$rc" -eq 0 ] || fail "in-sync copies should exit 0: $(cat "$tmp/err")"
grep -q "^check-harness-drift: OK" "$tmp/out" || fail "in-sync copies should print OK: $(cat "$tmp/out")"
pass=$((pass+1))

# T2b: leaked GIT_DIR (#129 / matou-app#232,#233). Reached from git-hooks/pre-push
# the script runs inside git's hook environment with GIT_DIR exported — in a
# sandbox worker it points at a linked-worktree admin dir (no work tree). With it
# left set, `git init "$work"` IGNORES "$work" and re-initialises GIT_DIR's repo,
# writing core.bare=true into the shared parent .git and breaking every later
# checkout. Fabricate that admin dir by hand (git worktree add is fenced in the
# sandbox, #239) and prove the run leaves the parent repo's core.bare untouched
# AND still completes its own drift check against $work.
parent="$tmp/parent"
git init -q "$parent"
git -C "$parent" config user.email t@t.test
git -C "$parent" config user.name t
echo hi >"$parent/f"; git -C "$parent" add -A; git -C "$parent" commit -q -m seed
# A linked-worktree admin dir under the shared common .git, with no work tree.
wtadmin="$parent/.git/worktrees/wt"
mkdir -p "$wtadmin"
printf '%s\n' "$parent/.git" >"$wtadmin/commondir"
printf '%s\n' "$parent/wt/.git" >"$wtadmin/gitdir"
printf 'ref: refs/heads/main\n' >"$wtadmin/HEAD"
[ "$(git -C "$parent" config --get core.bare)" = false ] || fail "T2b precondition: parent must start non-bare"
( cd "$sc" && export GIT_DIR="$wtadmin" && bash ./check-harness-drift.sh ) >"$tmp/out" 2>"$tmp/err" || true
bare="$(git -C "$parent" config --get core.bare 2>/dev/null || echo unset)"
[ "$bare" != true ] || fail "T2b: a leaked GIT_DIR must not re-init the parent repo as bare (core.bare=$bare): $(cat "$tmp/err")"
grep -q "^check-harness-drift: OK" "$tmp/out" || fail "T2b: the drift check must still run against its own \$work under a leaked GIT_DIR: $(cat "$tmp/out")$(cat "$tmp/err")"
pass=$((pass+1))

# T3: a vendored file hand-edited locally -> red, names the file
echo 'echo tampered' >>"$sc/two.sh"
run "$tmp/out" "$tmp/err"
[ "$rc" -eq 1 ] || fail "hand-edited local copy should exit 1"
grep -q "DRIFT: .sandcastle/two.sh was edited directly here" "$tmp/err" || fail "should name the drifted file: $(cat "$tmp/err")"
printf 'echo two\n' >"$sc/two.sh"  # restore
pass=$((pass+1))

# T4: a manifest file missing locally -> red, says re-vendor
rm "$sc/two.sh"
run "$tmp/out" "$tmp/err"
[ "$rc" -eq 1 ] || fail "a missing vendored file should exit 1"
grep -q "DRIFT: two.sh is missing here" "$tmp/err" || fail "should say the file is missing: $(cat "$tmp/err")"
printf 'echo two\n' >"$sc/two.sh"  # restore (rev_a's content)
pass=$((pass+1))

# T5: pinned at rev_a, vendored copy matches rev_a exactly even though the
# factory has since moved to rev_b — this must be green (a stale pin is not
# drift; ADR 0180: "drift becomes behind a tagged release", advisory only).
run "$tmp/out" "$tmp/err"
[ "$rc" -eq 0 ] || fail "a stale-but-matching pin should exit 0: $(cat "$tmp/err")"
grep -q "NOTE — FACTORY_REF is 1 commit(s) behind" "$tmp/out" || fail "should note the pin is 1 commit behind main (advisory): $(cat "$tmp/out")"
pass=$((pass+1))

# T6: identity-layer advisory (#31) — swarm-identity.sh is NOT vendored, so a
# pin can start REQUIRING a newer identity contract than this repo regenerated.
# The drift check WARNs (never fails a drift-clean run) so it is visible.
echo 'IDENTITY_CONTRACT=2' >"$factory_src/identity-lib.sh"   # pin needs contract 2
git -C "$factory_src" add -A && git -C "$factory_src" commit -q -m C
rev_c="$(git -C "$factory_src" rev-parse HEAD)"
git -C "$factory_src" update-ref refs/heads/main HEAD
cp "$factory_src/one.sh" "$factory_src/two.sh" "$factory_src/identity-lib.sh" "$sc/"  # vendored, byte-identical
printf 'one.sh\ntwo.sh\nidentity-lib.sh\n' >"$sc/FACTORY_MANIFEST"
printf '%s\n' "$rev_c" >"$sc/FACTORY_REF"
printf 'SWARM_IDENTITY_CONTRACT=1\n' >"$sc/swarm-identity.sh"  # behind (need 2)
run "$tmp/out" "$tmp/err"
[ "$rc" -eq 0 ] || fail "a behind identity layer must not fail the drift check: $(cat "$tmp/err")"
grep -q "^check-harness-drift: OK" "$tmp/out" || fail "T6 should still be drift-clean: $(cat "$tmp/out")"
grep -q "WARNING: identity layer behind" "$tmp/out" || fail "T6 should warn the identity layer is behind: $(cat "$tmp/out")"
grep -q "needs identity contract 2" "$tmp/out" || fail "T6 warning should name the required contract: $(cat "$tmp/out")"
# At/ahead of the required contract -> no warning.
printf 'SWARM_IDENTITY_CONTRACT=2\n' >"$sc/swarm-identity.sh"
run "$tmp/out" "$tmp/err"
[ "$rc" -eq 0 ] || fail "an at-contract identity layer must be green: $(cat "$tmp/err")"
grep -q "WARNING: identity layer behind" "$tmp/out" && fail "an at-contract identity layer must NOT warn: $(cat "$tmp/out")"
pass=$((pass+1))

# T7: stale-rendered-prompt advisory (#1) — .sandcastle/prompts/*.md (vendored,
# drift-clean) is the skeleton; .sandcastle/<file>.md is the consumer-rendered
# output. If the render output no longer matches what the skeleton +
# identity + enrichments would produce, NOTE it — never fail the check.
mkdir -p "$sc/prompts" "$sc/prompt-enrichments"
cp "$here/../prompt-render-lib.sh" "$sc/prompt-render-lib.sh"
# #14: the render pipeline generates {{HANDOFF_RULES}} from the policy layer,
# so its two vendored siblings must be beside it (they always are in a real
# .sandcastle/ — both are in vendor-manifest).
cp "$here/../policy-lib.sh" "$sc/policy-lib.sh"
cp "$here/../forgejo-lib.sh" "$sc/forgejo-lib.sh"
printf 'hello {{REPO_SLUG}}\n{{ENRICH:bit}}\n' >"$sc/prompts/greeting.md"
printf 'a fact\n' >"$sc/prompt-enrichments/bit.md"
printf ': "${FORGEJO_API:=https://git.matou.nz/api/v1/repos/Matou/x}"\n: "${REPO_SLUG:=Matou/x}"\n: "${RUNNER_HOST:=some-host}"\n' >"$sc/swarm-identity.sh"
printf 'one.sh\ntwo.sh\nidentity-lib.sh\nprompts/greeting.md\n' >"$sc/FACTORY_MANIFEST"
cp "$factory_src/one.sh" "$factory_src/two.sh" "$factory_src/identity-lib.sh" "$sc/"
mkdir -p "$factory_src/prompts"; cp "$sc/prompts/greeting.md" "$factory_src/prompts/greeting.md"
git -C "$factory_src" add -A && git -C "$factory_src" commit -q -m D
rev_d="$(git -C "$factory_src" rev-parse HEAD)"
git -C "$factory_src" update-ref refs/heads/main HEAD
printf '%s\n' "$rev_d" >"$sc/FACTORY_REF"
printf 'one.sh\ntwo.sh\nidentity-lib.sh\nprompts/greeting.md\n' >"$sc/FACTORY_MANIFEST"

# Stale: the rendered greeting.md on disk does not match a fresh render.
printf 'hello WRONG\na fact\n' >"$sc/greeting.md"
run "$tmp/out" "$tmp/err"
[ "$rc" -eq 0 ] || fail "a stale rendered prompt must not fail the drift check: $(cat "$tmp/err")"
grep -q "^check-harness-drift: OK" "$tmp/out" || fail "T7 should still be drift-clean: $(cat "$tmp/out")"
grep -q "NOTE — rendered prompt(s) stale" "$tmp/out" || fail "T7 should note the stale render: $(cat "$tmp/out")"
grep -q "greeting.md" "$tmp/out" || fail "T7 should name the stale file: $(cat "$tmp/out")"
pass=$((pass+1))

# Fresh render -> no advisory.
printf 'hello Matou/x\na fact\n' >"$sc/greeting.md"
run "$tmp/out" "$tmp/err"
[ "$rc" -eq 0 ] || fail "a fresh render should stay green: $(cat "$tmp/err")"
grep -q "NOTE — rendered prompt(s) stale" "$tmp/out" && fail "a fresh render must not be noted as stale: $(cat "$tmp/out")"
pass=$((pass+1))

# T8: standby-token wiring advisory (#85 / GOTCHAS 30) — a consumer's WORKFLOWS
# are its own per-repo layer, so no byte-compare can reach them; the drift check
# is what runs at install and at every pin bump, so it is where a human first
# sees a park-capable step with no CLAUDE_CODE_OAUTH_TOKEN_B. Advisory only: a
# drift-clean run must stay green and still exit 0.
cp "$here/../park-wiring-lib.sh" "$sc/park-wiring-lib.sh"
repo_root="$(cd "$sc/.." && pwd)"
mkdir -p "$repo_root/.forgejo/workflows"
cat > "$repo_root/.forgejo/workflows/triage.yml" <<'YML'
name: triage
jobs:
  triage:
    steps:
      - name: Triage under global lock
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
        run: bash .sandcastle/run-triage.sh
YML
run "$tmp/out" "$tmp/err"
[ "$rc" -eq 0 ] || fail "a park-token wiring gap must not FAIL the drift check: $(cat "$tmp/err")"
grep -q "^check-harness-drift: OK" "$tmp/out" || fail "T8 should still be drift-clean: $(cat "$tmp/out")"
grep -q "WARNING: park-capable workflow step(s) carry no" "$tmp/out" \
  || fail "T8 should warn about the unwired step: $(cat "$tmp/out")"
grep -q "triage.yml: Triage under global lock" "$tmp/out" \
  || fail "T8 warning should name the offending file and step: $(cat "$tmp/out")"
pass=$((pass+1))

# Wired -> no warning.
cat > "$repo_root/.forgejo/workflows/triage.yml" <<'YML'
name: triage
jobs:
  triage:
    steps:
      - name: Triage under global lock
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          CLAUDE_CODE_OAUTH_TOKEN_B: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN_B }}
        run: bash .sandcastle/run-triage.sh
YML
run "$tmp/out" "$tmp/err"
[ "$rc" -eq 0 ] || fail "a wired workflow should stay green: $(cat "$tmp/err")"
grep -q "WARNING: park-capable workflow step" "$tmp/out" \
  && fail "a wired workflow must NOT warn: $(cat "$tmp/out")"
pass=$((pass+1))

# No workflows at all -> the check SAYS it had nothing to read. It must never
# be indistinguishable from a clean result (GOTCHAS 30 is exactly that mistake).
rm -rf "$repo_root/.forgejo"
run "$tmp/out" "$tmp/err"
[ "$rc" -eq 0 ] || fail "no workflow dir must not fail the drift check: $(cat "$tmp/err")"
grep -q "the standby-token wiring check had nothing to read" "$tmp/out" \
  || fail "an unreadable workflow set must be announced, not silently green: $(cat "$tmp/out")"
pass=$((pass+1))

echo "check-harness-drift: $pass passed"
