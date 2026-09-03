#!/usr/bin/env bash
# Drives .sandcastle/provision-e2e-stack.sh (matou-app#57) with a fully shimmed
# host: docker / make / curl / git / npm / npx are fakes on PATH, and HOME is a
# throwaway tree, so every clause path (probe-pass, converge, loud-fail, --check
# vs full, the witness bring-up/teardown) runs offline with no real containers.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/../provision-e2e-stack.sh"
fail() { echo "FAIL: $1" >&2; exit 1; }

# A fresh sandbox host: fake HOME, fake bin dir, a shim state dir the fakes read.
new_host() {
  root="$(mktemp -d)"; TMP_ROOTS+=("$root")
  export HOME="$root/home"; mkdir -p "$HOME"
  export SHIMBIN="$root/bin"; mkdir -p "$SHIMBIN"
  export SHIM_STATE="$root/state"; mkdir -p "$SHIM_STATE"
  export SHIM_IMAGES=""   # space-list of docker images that "exist"
  export REPO_SLUG="Matou/matou-app"
  export MATOU_INFRA_DIR="$HOME/matou/matou-infrastructure"
  export WITNESS_OOBI_URL="http://localhost:7642/oobi"
  export FORGEJO_TOKEN="tkn"
  unset MATOU_INFRA_REF PROVISION_E2E_KEEP_STACK DIGITALOCEAN_ACCESS_TOKEN 2>/dev/null || true
  _write_shims
}
TMP_ROOTS=(); cleanup() { for d in "${TMP_ROOTS[@]:-}"; do rm -rf "$d"; done; }
trap cleanup EXIT

_write_shims() {
  cat >"$SHIMBIN/docker" <<'SH'
#!/usr/bin/env bash
case "$1 $2" in
  "info "*|"info") exit 0 ;;
  "image inspect") for i in $SHIM_IMAGES; do [ "$i" = "$3" ] && exit 0; done; exit 1 ;;
  "pull "*) echo "$2" >>"$SHIM_STATE/pulled"; SHIM_IMAGES="$SHIM_IMAGES $2"; exit 0 ;;
esac
exit 0
SH
  cat >"$SHIMBIN/make" <<'SH'
#!/usr/bin/env bash
# args look like: -C <dir> <targets...>
echo "$*" >>"$SHIM_STATE/make.log"
for t in "$@"; do
  case "$t" in
    up-test)   : >"$SHIM_STATE/witness_up" ;;
    down-test) rm -f "$SHIM_STATE/witness_up" ;;
  esac
done
[ -n "${SHIM_MAKE_FAIL:-}" ] && exit 1
exit 0
SH
  cat >"$SHIMBIN/curl" <<'SH'
#!/usr/bin/env bash
# the OOBI probe, faithful to real curl: on a connection failure it prints the
# http_code "000" AND exits non-zero (7). 200 + exit 0 iff the stack is "up".
if [ -f "$SHIM_STATE/witness_up" ]; then echo 200; exit 0; else echo 000; exit 7; fi
SH
  cat >"$SHIMBIN/git" <<'SH'
#!/usr/bin/env bash
if [ "$1" = clone ]; then
  dest="${@: -1}"
  mkdir -p "$dest/keri" "$dest/any-sync"
  # infra clone gets Makefiles; a repo (workdir) clone gets a .git + frontend
  case "$dest" in
    *matou-infrastructure) : >"$dest/keri/Makefile"; : >"$dest/any-sync/Makefile" ;;
    *) mkdir -p "$dest/.git" "$dest/frontend/node_modules" ;;
  esac
  exit 0
fi
if [ "$1" = -C ]; then
  case "$3" in checkout) exit 0 ;; rev-parse) echo "main"; exit 0 ;; esac
fi
exit 0
SH
  cat >"$SHIMBIN/npm" <<'SH'
#!/usr/bin/env bash
exit 0
SH
  cat >"$SHIMBIN/npx" <<'SH'
#!/usr/bin/env bash
# npx --no-install playwright --version   |   npx playwright install chromium
for a in "$@"; do case "$a" in
  --version) echo "Version 1.57.0"; exit 0 ;;
  install)   mkdir -p "$HOME/.cache/ms-playwright/chromium-1234"; exit 0 ;;
esac; done
echo "Version 1.57.0"; exit 0
SH
  chmod +x "$SHIMBIN"/*
}

run() { PATH="$SHIMBIN:$PATH" bash "$script" "$@"; }

# Convenience state builders
have_infra()    { mkdir -p "$MATOU_INFRA_DIR/keri" "$MATOU_INFRA_DIR/any-sync"; : >"$MATOU_INFRA_DIR/keri/Makefile"; : >"$MATOU_INFRA_DIR/any-sync/Makefile"; }
have_workdir()  { mkdir -p "$HOME/swarm-e2e/$REPO_SLUG/.git" "$HOME/swarm-e2e/$REPO_SLUG/frontend/node_modules"; }
have_chromium() { mkdir -p "$HOME/.cache/ms-playwright/chromium-1234"; }
have_images()   { export SHIM_IMAGES="weboftrust/keri-witness-demo:1.1.0 matou-keria-patched:latest"; }

# ── 1. --help exits 0 and prints usage ─────────────────────────────────────
new_host
out="$(run --help)"; grep -q "E2E-STACK PROVISION HOOK" <<<"$out" || fail "help must print the header"

# ── 2. unknown arg → exit 2 ────────────────────────────────────────────────
new_host
rc=0; run --bogus >/dev/null 2>&1 || rc=$?
[ "$rc" = 2 ] || fail "unknown arg must exit 2 (got $rc)"

# ── 3. --check, fully provisioned, stack live → exit 0, no converge ─────────
new_host; have_infra; have_workdir; have_chromium; have_images; : >"$SHIM_STATE/witness_up"
out="$(run --check)" || fail "--check on a ready host must pass"
grep -q "OK (check)" <<<"$out" || fail "--check ready host must print OK"
[ -f "$SHIM_STATE/make.log" ] && fail "--check must NEVER invoke make (converge)"
[ -f "$SHIM_STATE/pulled" ] && fail "--check must NEVER pull images"

# ── 4. --check, ready host, stack NOT live → passes on capability ──────────
new_host; have_infra; have_workdir; have_chromium; have_images   # no witness_up
out="$(run --check)" || fail "--check must pass on a capable host even with the ephemeral stack down"
grep -q "capable of standing the witness up" <<<"$out" || fail "--check must report witness capability when stack is down"
[ -f "$SHIM_STATE/make.log" ] && fail "--check must not cycle containers"

# ── 5. --check missing infra → loud fail naming [infra], exit 1 ────────────
new_host; have_workdir; have_chromium; have_images
err="$(run --check 2>&1)" && fail "--check must fail when infra is missing"
grep -q "FAILED clause \[infra\]" <<<"$err" || fail "missing infra must name the [infra] clause (got: $err)"

# ── 6. --check missing witness image → loud fail naming [docker] ───────────
new_host; have_infra; have_workdir; have_chromium   # no images
err="$(run --check 2>&1)" && fail "--check must fail when the witness image is absent"
grep -q "FAILED clause \[docker\]" <<<"$err" || fail "missing witness image must name [docker] (got: $err)"

# ── 7. --check missing workdir → loud fail naming [workdir] ─────────────────
new_host; have_infra; have_chromium; have_images
err="$(run --check 2>&1)" && fail "--check must fail when the e2e checkout is missing"
grep -q "FAILED clause \[workdir\]" <<<"$err" || fail "missing workdir must name [workdir] (got: $err)"

# ── 8. --check missing chromium → loud fail naming [playwright] ────────────
new_host; have_infra; have_workdir; have_images   # no chromium cache
# npx --version still works, but the chromium cache is absent → probe fails
err="$(run --check 2>&1)" && fail "--check must fail when chromium is not installed"
grep -q "FAILED clause \[playwright\]" <<<"$err" || fail "missing chromium must name [playwright] (got: $err)"

# ── 9. full run on a BARE host: clones infra + workdir, pulls image, installs
#      chromium, stands the witness up, verifies OOBI, tears down what it started
new_host   # nothing present at all
out="$(run 2>&1)" || fail "full run on a bare host must converge to success (got: $out)"
[ -f "$MATOU_INFRA_DIR/keri/Makefile" ] || fail "full run must clone the infra checkout"
[ -d "$HOME/swarm-e2e/$REPO_SLUG/.git" ] || fail "full run must clone the e2e checkout"
grep -q "weboftrust/keri-witness-demo:1.1.0" "$SHIM_STATE/pulled" || fail "full run must pull the witness image"
[ -d "$HOME/.cache/ms-playwright/chromium-1234" ] || fail "full run must install chromium"
grep -q "up-test" "$SHIM_STATE/make.log" || fail "full run must bring the test stack up"
grep -q "down-test" "$SHIM_STATE/make.log" || fail "full run must tear down the stack it started"
[ -f "$SHIM_STATE/witness_up" ] && fail "after teardown the shimmed stack must be down"
grep -q "OK (provision)" <<<"$out" || fail "full bare-host run must end OK"

# ── 10. full run, stack already up (a drive owns it) → witness untouched ────
new_host; have_infra; have_workdir; have_chromium; have_images; : >"$SHIM_STATE/witness_up"
out="$(run 2>&1)" || fail "full run on a ready host must pass"
grep -q "stack already up" <<<"$out" || fail "a live witness must be recognised as already up"
if [ -f "$SHIM_STATE/make.log" ] && grep -q "down-test" "$SHIM_STATE/make.log"; then
  fail "must NOT tear down a witness this script did not start (a drive may own it)"
fi

# ── 11. a full re-run of an already-provisioned host is a NO-OP: nothing is
#       cloned/pulled/built/installed and the ephemeral stack is NOT cycled ──
new_host; have_infra; have_workdir; have_chromium; have_images   # stack down
out="$(run 2>&1)" || fail "full re-run on a ready host must pass"
[ -f "$SHIM_STATE/make.log" ] && fail "a no-change re-run must NOT cycle the stack (make called)"
[ -f "$SHIM_STATE/pulled" ] && fail "a no-change re-run must NOT pull images"
grep -q "capable of standing the witness up" <<<"$out" || fail "a no-op re-run must pass the witness clause on capability"

# ── 12. PROVISION_E2E_VERIFY_LIVE=1 forces the live bring-up on a ready host;
#       PROVISION_E2E_KEEP_STACK=1 then leaves that script-started stack up ───
new_host; have_infra; have_workdir; have_chromium; have_images   # stack down
out="$(PROVISION_E2E_VERIFY_LIVE=1 PROVISION_E2E_KEEP_STACK=1 run 2>&1)" || fail "forced-live keep-stack run must pass"
grep -q "up-test" "$SHIM_STATE/make.log" || fail "forced-live run must bring the stack up"
grep -q "down-test" "$SHIM_STATE/make.log" && fail "KEEP_STACK=1 must NOT tear the stack down"
[ -f "$SHIM_STATE/witness_up" ] || fail "KEEP_STACK=1 must leave the witness up"

# ── 13. forced live verify, witness never answers OOBI after bring-up → loud
#       [witness] fail (and it tears down the stack it started) ──────────────
new_host; have_infra; have_workdir; have_chromium; have_images
# make "up-test" but a broken compose that never marks the witness up:
cat >"$SHIMBIN/make" <<'SH'
#!/usr/bin/env bash
echo "$*" >>"$SHIM_STATE/make.log"   # never touches witness_up
exit 0
SH
chmod +x "$SHIMBIN/make"
err="$(PROVISION_E2E_VERIFY_LIVE=1 run 2>&1)" && fail "forced-live run must fail when the witness never answers OOBI"
grep -q "FAILED clause \[witness\]" <<<"$err" || fail "a dead witness must name [witness] (got: $err)"

# ── 14. full run, workdir missing AND FORGEJO_TOKEN unset → loud [workdir] ──
new_host; have_infra; have_chromium; have_images   # workdir absent
err="$(env -u FORGEJO_TOKEN PATH="$SHIMBIN:$PATH" bash "$script" 2>&1)" && fail "must fail cloning workdir with no token"
grep -q "FAILED clause \[workdir\]" <<<"$err" || fail "no token + missing workdir must name [workdir] (got: $err)"
grep -qi "FORGEJO_TOKEN" <<<"$err" || fail "the failure must point at FORGEJO_TOKEN (got: $err)"

echo "provision-e2e-stack: 14 checks passed"
