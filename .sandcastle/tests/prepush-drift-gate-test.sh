#!/usr/bin/env bash
# Offline test for the pre-push factory-drift gate (idss #932).
#
# Drives REAL `git push`es to a local bare remote so git actually invokes the
# hook with genuine pre-push stdin. No network: check-harness-drift.sh is
# replaced by a stub whose verdict is chosen per-case via $STUB_DRIFT_MODE, and
# which records each invocation in $STUB_MARKER — so the test can assert that the
# (networked) drift check runs ONLY when the push touches a FACTORY_MANIFEST path.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
fac="$(cd "$here/.." && pwd)"     # dev-factory root: source of the hook + gate libs

fail() { echo "FAIL: $*" >&2; [ -f "${OUT:-}" ] && { echo "--- push output ---"; cat "$OUT"; }; exit 1; }

tmp="$(mktemp -d "${TMPDIR:-/tmp}/prepush-drift.XXXXXX")"; trap 'rm -rf "$tmp"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export GIT_CONFIG_NOSYSTEM=1 HOME="$tmp"

git init -q --bare "$tmp/origin.git"
git clone -q "$tmp/origin.git" "$tmp/work"
cd "$tmp/work"

mkdir -p .sandcastle/git-hooks
cp "$fac/git-hooks/pre-push" .sandcastle/git-hooks/pre-push
cp "$fac/gate-lib.sh"        .sandcastle/gate-lib.sh
cp "$fac/gate.sh"            .sandcastle/gate.sh
chmod +x .sandcastle/git-hooks/pre-push
printf 'gate.sh\n'  > .sandcastle/FACTORY_MANIFEST   # the one vendored path this test edits
printf 'deadbeef\n' > .sandcastle/FACTORY_REF

# Stub drift checker (no network). Mode from $STUB_DRIFT_MODE; records each call.
cat > .sandcastle/check-harness-drift.sh <<'STUB'
#!/usr/bin/env bash
[ -n "${STUB_MARKER:-}" ] && : > "$STUB_MARKER"
case "${STUB_DRIFT_MODE:-ok}" in
  drift) echo "DRIFT: .sandcastle/gate.sh was edited directly here"; exit 1 ;;
  infra) echo "fatal: could not fetch the factory" >&2; exit 1 ;;      # non-zero, NO drift marker
  *)     echo "check-harness-drift: OK"; exit 0 ;;
esac
STUB
chmod +x .sandcastle/check-harness-drift.sh

git config core.hooksPath .sandcastle/git-hooks
echo seed > README.md
git add -A && git commit -qm seed
git branch -M main
git push -q origin main || fail "seed push should succeed"

marker="$tmp/called"; OUT="$tmp/out"
push() { rm -f "$marker"; STUB_MARKER="$marker" STUB_DRIFT_MODE="$1" git push origin main >"$OUT" 2>&1; }

# 1) A change that touches NO manifest path passes, and the drift check is never
#    run (even in drift mode) — the cheap local pre-filter gates the network call.
echo a >> README.md; git commit -qam c1
push drift || fail "1: a non-manifest push must pass"
[ -f "$marker" ] && fail "1: drift check must NOT run when no manifest path is touched"

# 2) A manifest-path change that has DRIFTED is blocked pre-push; check ran.
echo '# edit' >> .sandcastle/gate.sh; git commit -qam c2
push drift && fail "2: a drifted vendored-file push must be BLOCKED"
[ -f "$marker" ] || fail "2: drift check must run when a manifest path is touched"
grep -q 'pre-push BLOCKED (#932)' "$OUT" || fail "2: the block message must name #932 and the remedy"
git reset -q --hard origin/main   # origin never received c2

# 3) A manifest-path change that is IN SYNC passes; check ran.
echo '# edit2' >> .sandcastle/gate.sh; git commit -qam c3
push ok || fail "3: an in-sync vendored change must pass"
[ -f "$marker" ] || fail "3: drift check must run"

# 4) An infra error from the drift check FAILS OPEN (push proceeds); check ran.
echo '# edit3' >> .sandcastle/gate.sh; git commit -qam c4
push infra || fail "4: an infra error must fail OPEN so a network blip never blocks a push"
[ -f "$marker" ] || fail "4: drift check must run"

# 5) The sandbox Go gate still fires and propagates its exit (the exec->pipe change).
echo 'package x' > foo.go; git add foo.go; git commit -qm c5
FACTORY_SANDBOX=1 GATE_GO_CMD='exit 7' git push origin main >"$OUT" 2>&1 \
  && fail "5: the sandbox Go gate must still block on a failing Go stage"
git reset -q --hard origin/main
echo 'package y' > foo.go; git add foo.go; git commit -qm c5b
FACTORY_SANDBOX=1 GATE_GO_CMD='true' git push origin main >"$OUT" 2>&1 \
  || fail "5b: a passing Go gate must allow the push"

echo "prepush-drift-gate-test: PASS"
