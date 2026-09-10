#!/usr/bin/env bash
# Drives .sandcastle/provision-e2e-stack.sh (matou-app#57, #437) with a fully
# shimmed host: docker / make / curl / git / npm / npx / go / sudo / apt-get /
# systemctl are fakes on PATH, and HOME is a throwaway tree, so every clause
# path (probe-pass, converge, loud-fail, --check vs full, the witness
# bring-up/teardown) runs offline with no real containers, toolchains or sudo.
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
  # A fake GOROOT (bin/go answers `version` and `env GOROOT`) the have_go_*
  # builders copy/link from — the script must never touch a real toolchain.
  export FAKE_GOROOT="$root/fakego"; mkdir -p "$FAKE_GOROOT/bin"
  # The PATH a runner JOB gets (the forgejo-runner unit's Environment=PATH — no
  # nix profile, no ~/go/bin) is distinct from the invoking/login PATH ($SHIMBIN
  # + the real one). The script must probe toolchains with THIS one (#437).
  export RUNNERBIN="$root/runner-bin"; mkdir -p "$RUNNERBIN"
  export PROVISION_RUNNER_PATH="$RUNNERBIN"
  export REPO_SLUG="Matou/matou-app"
  export MATOU_INFRA_DIR="$HOME/matou/matou-infrastructure"
  export WITNESS_OOBI_URL="http://localhost:7642/oobi"
  export FORGEJO_TOKEN="tkn"
  unset MATOU_INFRA_REF PROVISION_E2E_KEEP_STACK DIGITALOCEAN_ACCESS_TOKEN \
        SHIM_SUDO_NOPASS SHIM_MAKE_FAIL 2>/dev/null || true
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
dir=""; [ "${1:-}" = -C ] && dir="$2"
for t in "$@"; do
  case "$t" in
    up-test)   : >"$SHIM_STATE/witness_up" ;;
    down-test) rm -f "$SHIM_STATE/witness_up" ;;
    # any-sync's generate-config-test writes .env.test (+ the network id, the
    # etc-test/ tree and pulls the any-sync images) — .env.test is the gate.
    generate-config-test) [ -n "$dir" ] && : >"$dir/.env.test" ;;
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
  # The fake toolchain: `go version` + `go env GOROOT` are all the script asks.
  cat >"$FAKE_GOROOT/bin/go" <<'SH'
#!/usr/bin/env bash
case "$*" in
  "env GOROOT") echo "$FAKE_GOROOT" ;;
  version)      echo "go version go1.25.5 linux/amd64" ;;
esac
exit 0
SH
  # No forgejo-runner unit on the sandbox host unless a check writes one.
  cat >"$SHIMBIN/systemctl" <<'SH'
#!/usr/bin/env bash
exit 0
SH
  chmod +x "$SHIMBIN"/* "$FAKE_GOROOT/bin/go"
}

run() { PATH="$SHIMBIN:$PATH" bash "$script" "$@"; }

# Convenience state builders
have_infra()    { mkdir -p "$MATOU_INFRA_DIR/keri" "$MATOU_INFRA_DIR/any-sync"; : >"$MATOU_INFRA_DIR/keri/Makefile"; : >"$MATOU_INFRA_DIR/any-sync/Makefile"; }
have_anysync()  { mkdir -p "$MATOU_INFRA_DIR/any-sync"; : >"$MATOU_INFRA_DIR/any-sync/.env.test"; }
have_workdir()  { mkdir -p "$HOME/swarm-e2e/$REPO_SLUG/.git" "$HOME/swarm-e2e/$REPO_SLUG/frontend/node_modules"; }
have_chromium() { mkdir -p "$HOME/.cache/ms-playwright/chromium-1234"; }
have_images()   { export SHIM_IMAGES="weboftrust/keri-witness-demo:1.1.0 matou-keria-patched:latest"; }
have_go_login()  { cp "$FAKE_GOROOT/bin/go" "$SHIMBIN/go"; }    # go on the invoking (login) PATH only
have_go_runner() { cp "$FAKE_GOROOT/bin/go" "$RUNNERBIN/go"; }  # go on the runner unit's PATH
have_go_sdk()    { mkdir -p "$HOME/go-sdk"; ln -s "$FAKE_GOROOT" "$HOME/go-sdk/go"; }   # run-pr-e2e's fallback
have_go()        { have_go_runner; }
# Everything a drive needs; individual checks knock one clause out of this.
ready_host()    { have_infra; have_anysync; have_workdir; have_chromium; have_images; have_go; }

# ── 1. --help exits 0 and prints usage ─────────────────────────────────────
new_host
out="$(run --help)"; grep -q "E2E-STACK PROVISION HOOK" <<<"$out" || fail "help must print the header"

# ── 2. unknown arg → exit 2 ────────────────────────────────────────────────
new_host
rc=0; run --bogus >/dev/null 2>&1 || rc=$?
[ "$rc" = 2 ] || fail "unknown arg must exit 2 (got $rc)"

# ── 3. --check, fully provisioned, stack live → exit 0, no converge ─────────
new_host; ready_host; : >"$SHIM_STATE/witness_up"
out="$(run --check)" || fail "--check on a ready host must pass"
grep -q "OK (check)" <<<"$out" || fail "--check ready host must print OK"
[ -f "$SHIM_STATE/make.log" ] && fail "--check must NEVER invoke make (converge)"
[ -f "$SHIM_STATE/pulled" ] && fail "--check must NEVER pull images"

# ── 4. --check, ready host, stack NOT live → passes on capability ──────────
new_host; ready_host   # no witness_up
out="$(run --check)" || fail "--check must pass on a capable host even with the ephemeral stack down"
grep -q "capable of standing the witness up" <<<"$out" || fail "--check must report witness capability when stack is down"
[ -f "$SHIM_STATE/make.log" ] && fail "--check must not cycle containers"

# ── 5. --check missing infra → loud fail naming [infra], exit 1 ────────────
new_host; ready_host; rm -rf "$MATOU_INFRA_DIR"
err="$(run --check 2>&1)" && fail "--check must fail when infra is missing"
grep -q "FAILED clause \[infra\]" <<<"$err" || fail "missing infra must name the [infra] clause (got: $err)"

# ── 6. --check missing witness image → loud fail naming [docker] ───────────
new_host; ready_host; export SHIM_IMAGES=""   # no images
err="$(run --check 2>&1)" && fail "--check must fail when the witness image is absent"
grep -q "FAILED clause \[docker\]" <<<"$err" || fail "missing witness image must name [docker] (got: $err)"

# ── 7. --check missing workdir → loud fail naming [workdir] ─────────────────
new_host; ready_host; rm -rf "$HOME/swarm-e2e"
err="$(run --check 2>&1)" && fail "--check must fail when the e2e checkout is missing"
grep -q "FAILED clause \[workdir\]" <<<"$err" || fail "missing workdir must name [workdir] (got: $err)"

# ── 8. --check missing chromium → loud fail naming [playwright] ────────────
new_host; ready_host; rm -rf "$HOME/.cache/ms-playwright"   # no chromium cache
# npx --version still works, but the chromium cache is absent → probe fails
err="$(run --check 2>&1)" && fail "--check must fail when chromium is not installed"
grep -q "FAILED clause \[playwright\]" <<<"$err" || fail "missing chromium must name [playwright] (got: $err)"

# ── 9. full run on a BARE host: clones infra + workdir, pulls image, generates
#      the any-sync test config, installs chromium, links the box's go into
#      ~/go-sdk/go, stands the witness up, verifies OOBI, tears down what it
#      started. (The box has a go the login shell sees — ben's -03 case.)
new_host; have_go_login   # nothing else present at all
out="$(run 2>&1)" || fail "full run on a bare host must converge to success (got: $out)"
[ -f "$MATOU_INFRA_DIR/keri/Makefile" ] || fail "full run must clone the infra checkout"
[ -d "$HOME/swarm-e2e/$REPO_SLUG/.git" ] || fail "full run must clone the e2e checkout"
grep -q "weboftrust/keri-witness-demo:1.1.0" "$SHIM_STATE/pulled" || fail "full run must pull the witness image"
grep -q "generate-config-test" "$SHIM_STATE/make.log" || fail "full run must generate the any-sync test config"
[ -f "$MATOU_INFRA_DIR/any-sync/.env.test" ] || fail "full run must leave .env.test behind"
[ -d "$HOME/.cache/ms-playwright/chromium-1234" ] || fail "full run must install chromium"
[ -x "$HOME/go-sdk/go/bin/go" ] || fail "full run must populate ~/go-sdk/go (run-pr-e2e's fallback)"
grep -q "up-test" "$SHIM_STATE/make.log" || fail "full run must bring the test stack up"
grep -q "down-test" "$SHIM_STATE/make.log" || fail "full run must tear down the stack it started"
[ -f "$SHIM_STATE/witness_up" ] && fail "after teardown the shimmed stack must be down"
grep -q "OK (provision)" <<<"$out" || fail "full bare-host run must end OK"

# ── 9b. clause ORDER on the bare host: the any-sync config is generated BEFORE
#       the keri stack comes up (keri compose bind-mounts any-sync/etc-test —
#       absent, docker creates it root-owned; the run-13605 leftover) ────────
gen_line="$(grep -n "generate-config-test" "$SHIM_STATE/make.log" | head -1 | cut -d: -f1)"
up_line="$(grep -n "up-test" "$SHIM_STATE/make.log" | head -1 | cut -d: -f1)"
[ "$gen_line" -lt "$up_line" ] || fail "generate-config-test must run before up-test (got make.log: $(cat "$SHIM_STATE/make.log"))"

# ── 10. full run, stack already up (a drive owns it) → witness untouched ────
new_host; ready_host; : >"$SHIM_STATE/witness_up"
out="$(run 2>&1)" || fail "full run on a ready host must pass"
grep -q "stack already up" <<<"$out" || fail "a live witness must be recognised as already up"
if [ -f "$SHIM_STATE/make.log" ] && grep -q "down-test" "$SHIM_STATE/make.log"; then
  fail "must NOT tear down a witness this script did not start (a drive may own it)"
fi

# ── 11. a full re-run of an already-provisioned host is a NO-OP: nothing is
#       cloned/pulled/built/installed and the ephemeral stack is NOT cycled ──
new_host; ready_host; have_go_sdk   # stack down
out="$(run 2>&1)" || fail "full re-run on a ready host must pass"
[ -f "$SHIM_STATE/make.log" ] && fail "a no-change re-run must NOT cycle the stack (make called)"
[ -f "$SHIM_STATE/pulled" ] && fail "a no-change re-run must NOT pull images"
grep -q "capable of standing the witness up" <<<"$out" || fail "a no-op re-run must pass the witness clause on capability"

# ── 12. PROVISION_E2E_VERIFY_LIVE=1 forces the live bring-up on a ready host;
#       PROVISION_E2E_KEEP_STACK=1 then leaves that script-started stack up ───
new_host; ready_host   # stack down
out="$(PROVISION_E2E_VERIFY_LIVE=1 PROVISION_E2E_KEEP_STACK=1 run 2>&1)" || fail "forced-live keep-stack run must pass"
grep -q "up-test" "$SHIM_STATE/make.log" || fail "forced-live run must bring the stack up"
grep -q "down-test" "$SHIM_STATE/make.log" && fail "KEEP_STACK=1 must NOT tear the stack down"
[ -f "$SHIM_STATE/witness_up" ] || fail "KEEP_STACK=1 must leave the witness up"

# ── 13. forced live verify, witness never answers OOBI after bring-up → loud
#       [witness] fail (and it tears down the stack it started) ──────────────
new_host; ready_host
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
new_host; ready_host; rm -rf "$HOME/swarm-e2e"   # workdir absent
err="$(env -u FORGEJO_TOKEN PATH="$SHIMBIN:$PATH" bash "$script" 2>&1)" && fail "must fail cloning workdir with no token"
grep -q "FAILED clause \[workdir\]" <<<"$err" || fail "no token + missing workdir must name [workdir] (got: $err)"
grep -qi "FORGEJO_TOKEN" <<<"$err" || fail "the failure must point at FORGEJO_TOKEN (got: $err)"

# ── 15. --check, no any-sync test config → loud [anysync], and it never
#       converges (the #437 contradiction: -03 was "green" without .env.test) ─
new_host; ready_host; rm -f "$MATOU_INFRA_DIR/any-sync/.env.test"
err="$(run --check 2>&1)" && fail "--check must fail when the any-sync test config is absent"
grep -q "FAILED clause \[anysync\]" <<<"$err" || fail "missing .env.test must name [anysync] (got: $err)"
grep -q "generate-config-test" <<<"$err" || fail "the [anysync] failure must name the make target a human runs (got: $err)"
[ -f "$SHIM_STATE/make.log" ] && fail "--check must not run generate-config-test"

# ── 16. full run, no any-sync config → runs generate-config-test (idempotent
#       target), then passes; a failing target is a loud [anysync] ───────────
new_host; ready_host; rm -f "$MATOU_INFRA_DIR/any-sync/.env.test"
out="$(run 2>&1)" || fail "converge must generate the any-sync test config (got: $out)"
grep -q -- "-C $MATOU_INFRA_DIR/any-sync generate-config-test" "$SHIM_STATE/make.log" || fail "converge must run make -C any-sync generate-config-test"
[ -f "$MATOU_INFRA_DIR/any-sync/.env.test" ] || fail "converge must leave .env.test in place"
new_host; ready_host; rm -f "$MATOU_INFRA_DIR/any-sync/.env.test"
err="$(SHIM_MAKE_FAIL=1 run 2>&1)" && fail "a failing generate-config-test must fail the run"
grep -q "FAILED clause \[anysync\]" <<<"$err" || fail "a failing generate-config-test must name [anysync] (got: $err)"

# ── 17. THE #437 FALSE GREEN: go on the login shell's PATH, none on the runner
#       unit's PATH, no ~/go-sdk → --check must FAIL [go] (ben, PR #438 review:
#       a login-shell `command -v go` passed -03 while the runner job could not
#       see go) ────────────────────────────────────────────────────────────────
new_host; ready_host; rm -f "$RUNNERBIN/go"; have_go_login
err="$(run --check 2>&1)" && fail "--check must fail when go is only on the login PATH (the runner job cannot see it)"
grep -q "FAILED clause \[go\]" <<<"$err" || fail "login-only go must name [go] (got: $err)"
grep -q "go-sdk/go/bin" <<<"$err" || fail "the [go] failure must name the ~/go-sdk fallback path (got: $err)"
grep -q "$RUNNERBIN" <<<"$err" || fail "the [go] failure must show the runner PATH it probed (got: $err)"

# ── 18. --check passes on go at ~/go-sdk/go/bin alone (run-pr-e2e's fallback) ─
new_host; ready_host; rm -f "$RUNNERBIN/go"; have_go_sdk
out="$(run --check 2>&1)" || fail "--check must pass with go only at ~/go-sdk/go/bin (got: $out)"
grep -q "\[go\] toolchain present (go1.25.5 at $HOME/go-sdk/go/bin/go)" <<<"$out" || fail "[go] must report the go-sdk toolchain (got: $out)"

# ── 19. --check passes on go on the runner's PATH, and reports THAT binary ──
new_host; ready_host   # have_go = runner PATH
out="$(run --check 2>&1)" || fail "--check must pass with go on the runner PATH (got: $out)"
grep -q "\[go\] toolchain present (go1.25.5 at $RUNNERBIN/go)" <<<"$out" || fail "[go] must report the runner-PATH go (got: $out)"

# ── 20. converge with a login-shell-only go links its GOROOT into ~/go-sdk/go
#       (the drive's fallback) — never a download when the box has a toolchain ─
new_host; ready_host; rm -f "$RUNNERBIN/go"; have_go_login   # no ~/go-sdk
out="$(run 2>&1)" || fail "converge must pass on a host with a login-shell-only go (got: $out)"
[ -L "$HOME/go-sdk/go" ] || fail "converge must symlink ~/go-sdk/go"
[ "$(readlink "$HOME/go-sdk/go")" = "$FAKE_GOROOT" ] || fail "~/go-sdk/go must point at the found go's GOROOT (got: $(readlink "$HOME/go-sdk/go"))"
[ -x "$HOME/go-sdk/go/bin/go" ] || fail "~/go-sdk/go/bin/go must resolve through the link"
grep -q "\[go\] linked toolchain" <<<"$out" || fail "converge must report the link (got: $out)"
# and a --check straight after is green on the go-sdk leg
out="$(run --check 2>&1)" || fail "--check after the link converge must pass (got: $out)"
grep -q "\[go\] toolchain present (go1.25.5 at $HOME/go-sdk/go/bin/go)" <<<"$out" || fail "post-converge --check must see the go-sdk toolchain (got: $out)"

# ── 21. no PROVISION_RUNNER_PATH: the probe PATH is read from the forgejo-runner
#       unit's Environment= (PATH not the first pair; the -03 shape) ──────────
new_host; ready_host; rm -f "$RUNNERBIN/go"; unset PROVISION_RUNNER_PATH
unitbin="$root/unit-bin"; mkdir -p "$unitbin"; cp "$FAKE_GOROOT/bin/go" "$unitbin/go"
cat >"$SHIMBIN/systemctl" <<SH
#!/usr/bin/env bash
case "\$*" in *forgejo-runner*) echo "Environment=HOME=/home/swarm PATH=$unitbin:/usr/local/bin:/usr/bin:/bin GOFLAGS=-mod=mod" ;; esac
exit 0
SH
chmod +x "$SHIMBIN/systemctl"
out="$(run --check 2>&1)" || fail "--check must pass with go on the unit's PATH (got: $out)"
grep -q "\[go\] toolchain present (go1.25.5 at $unitbin/go)" <<<"$out" || fail "[go] must probe with the runner unit's PATH (got: $out)"
grep -q "forgejo-runner unit" <<<"$out" || fail "the probe must say the PATH came from the unit (got: $out)"

# ── 22. no PROVISION_RUNNER_PATH and no runner unit: the probe falls back to a
#       STRIPPED PATH (systemd's service default) — never the invoking shell's,
#       so a go that only the login shell resolves is never reported ─────────
new_host; ready_host; rm -f "$RUNNERBIN/go"; have_go_login; unset PROVISION_RUNNER_PATH   # systemctl shim: no unit
out="$(run --check 2>&1)" || true
grep -q "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" <<<"$out" || fail "without a unit the probe must use the stripped default PATH (got: $out)"
grep -q "$SHIMBIN/go" <<<"$out" && fail "the stripped probe must never resolve the login-shell go (got: $out)"

echo "provision-e2e-stack: 22 checks passed"
