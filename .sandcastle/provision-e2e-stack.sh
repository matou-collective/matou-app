#!/usr/bin/env bash
# provision-e2e-stack.sh — this repo's E2E-STACK PROVISION HOOK (matou-app#57).
#
# The seam the dev-factory host-onboarding pipeline calls once per repo in a
# host's coverage (Matou/dev-factory#6: `onboard-host` invokes each repo's
# .sandcastle/provision-e2e-stack.sh if present). The factory core cannot know
# what "the e2e stack" IS for this product — no KERIA/witness specifics belong
# in a vendored harness file — so the factory provides the hook and THIS repo,
# the product, fills it. Same ownership split as swarm-identity.sh (the
# consumer's declarative identity) and E2E_TIER (the consumer's driver tier):
# per-repo, NOT vendored, deliberately absent from FACTORY_MANIFEST.
#
# WHY it exists: only matou-workstation carried the product e2e stack, so
# pr-e2e / smoke-drive / swarm-smoke stayed pinned `runs-on: matou-workstation`
# after PR #55 moved every harness-only flow to the `swarm` pool — one machine
# the bottleneck on every agent PR's e2e verdict. This script stands the stack
# up on ANY enrolled host so a second host (elitebook-03) can take those flows.
#
# WHAT the e2e drives need on a bare pool host (run-pr-e2e.sh / the smoke
# driver at scripts/smoke-drive/run-smoke-drive.sh):
#   1. the matou-infrastructure checkout (the KERIA/witness + any-sync compose)
#   2. docker + the KERIA/witness images the test compose boots
#   3. the any-sync test network config (generate-config-test → .env.test et al
#      + the any-sync images). run-pr-e2e's `make clean-test setup-test` runs
#      clean-test FIRST and clean-test needs .env.test, which only a prior
#      generate-config-test creates — a first-run host is chicken-and-egg
#      without it (matou-app#437).
#   4. the ~/swarm-e2e/<slug> checkout the drives run from
#   5. chromium for Playwright
#   6. a Go toolchain to build the backend — on the RUNNER UNIT's PATH (not the
#      invoking shell's: a nix-profile go the login shell sees is invisible to
#      a runner job) or at ~/go-sdk/go, the deterministic fallback
#      run-pr-e2e.sh uses (matou-app#437)
#   7. proof the compose actually stands a witness up here (OOBI reachable)
#
# CONTRACT (matou-app#57):
#   - idempotent: safe on every host enrolment AND every re-run; it converges,
#     never duplicates. On an already-provisioned host a full run is a NO-OP
#     (every clause probes first and skips when already satisfied).
#   - loud on failure: the FIRST unmet clause prints exactly what failed and
#     the script exits non-zero. No silent partial success.
#   - --check: probe only, never converge — what a host preflight runs.
#   - secrets come from the SAME env the workflows pass (FORGEJO_TOKEN,
#     DIGITALOCEAN_ACCESS_TOKEN, ...). Never from a prompt, never hard-coded.
#
# SHARED-HOST SAFETY: the *test* KERI stack (ports 4901-4903 / test witness,
# compose project matou-keri-test, matou-test-* volumes) is ephemeral — the
# drives bring it up with `clean-test start-and-wait-test` and tear it down
# after. It is port- and volume-isolated from the *dev* stack a workstation
# keeps resident, so provisioning never disturbs dev. This script NEVER runs
# `clean-test` (that wipes test volumes a concurrent drive may own); it only
# ever brings the stack UP if it is not already up, and tears down ONLY what it
# started (leaving a drive-owned stack untouched).
#
# Usage:
#   provision-e2e-stack.sh            converge every clause, then verify
#   provision-e2e-stack.sh --check    probe every clause; converge nothing
#   provision-e2e-stack.sh -h|--help
#
# Env (all optional; defaults from swarm-identity.sh / the host layout):
#   REPO_SLUG                owner/repo (default: swarm-identity.sh)
#   FORGEJO_TOKEN            clone token for the ~/swarm-e2e checkout (only used
#                            if that checkout is missing)
#   FORGEJO_API             repo API base (default: swarm-identity.sh) — its
#                            host is the clone host
#   MATOU_INFRA_DIR          infra checkout (default $HOME/matou/matou-infrastructure)
#   MATOU_INFRA_REPO         infra clone URL (default the git@gitlab.com infra repo)
#   MATOU_INFRA_REF          ref to check out on a FRESH clone (default: the
#                            remote's default branch). An existing checkout's
#                            branch is never touched.
#   WITNESS_OOBI_URL         witness OOBI probe URL (default: WITNESS_PORT_0
#                            from $INFRA/keri/.env.test, stock 6642)
#   DIGITALOCEAN_ACCESS_TOKEN  forwarded to sub-makes if set; not required by
#                            the local KERIA/witness/any-sync stack.
#   PROVISION_E2E_KEEP_STACK=1  leave a stack this script started up (default:
#                            tear down what we started, so the host is left as
#                            found and a re-run stays a no-op).
#   PROVISION_RUNNER_PATH    the PATH a runner JOB gets, used to probe the
#                            toolchains (go). Default: the forgejo-runner unit's
#                            Environment=PATH (systemctl show), else systemd's
#                            service default — never the invoking shell's PATH.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# swarm-identity.sh supplies REPO_SLUG / FORGEJO_API defaults for host-mode runs
# (workflows set them explicitly, which always wins). Safe to source twice.
# shellcheck source=swarm-identity.sh
[ -f "$here/swarm-identity.sh" ] && . "$here/swarm-identity.sh"

REPO_SLUG="${REPO_SLUG:-Matou/matou-app}"
INFRA="${MATOU_INFRA_DIR:-$HOME/matou/matou-infrastructure}"
INFRA_REPO="${MATOU_INFRA_REPO:-git@gitlab.com:matou-collective/matou-infrastructure.git}"
INFRA_REF="${MATOU_INFRA_REF:-}"
# Explicit override wins; otherwise resolved at probe time from the infra
# checkout's committed keri/.env.test (WITNESS_PORT_0, stock 6642) — a fresh
# host has no drifted .env.test, so a hardcoded port would probe the wrong one.
WITNESS_OOBI_URL="${WITNESS_OOBI_URL:-}"
WITNESS_DEMO_IMAGE="weboftrust/keri-witness-demo:1.1.0"
WORKDIR="$HOME/swarm-e2e/$REPO_SLUG"
ANYSYNC="$INFRA/any-sync"
ANYSYNC_ENV="$ANYSYNC/.env.test"
# The deterministic Go toolchain path run-pr-e2e.sh falls back to when `go` is
# not on the (runner unit's, non-login) PATH: `export PATH="$HOME/go-sdk/go/bin"`.
GO_SDK="$HOME/go-sdk/go"
# Go version to auto-install ONLY if none is found on the box to link. Matches
# backend/go.mod's `go` directive floor; override with PROVISION_GO_VERSION.
GO_VERSION="${PROVISION_GO_VERSION:-1.25.5}"
# What a systemd service gets when its unit sets no PATH (systemd's compiled-in
# DefaultPath): no nix profile, no ~/.local/bin, no ~/go/bin. The last-resort
# probe PATH when neither PROVISION_RUNNER_PATH nor a forgejo-runner unit says
# otherwise — deliberately stricter than the invoking shell's.
RUNNER_PATH_DEFAULT="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

CHECK_ONLY=0
case "${1:-}" in
  --check) CHECK_ONLY=1 ;;
  -h|--help) sed -n '2,70p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
  "") ;;
  *) echo "provision-e2e-stack: unknown arg '$1' (use --check or --help)" >&2; exit 2 ;;
esac

mode="provision"; [ "$CHECK_ONLY" = 1 ] && mode="check"
echo "provision-e2e-stack: mode=$mode host=$(hostname 2>/dev/null || echo unknown) slug=$REPO_SLUG"

# DIGITALOCEAN_ACCESS_TOKEN rides through to any sub-make that wants it, taken
# from THIS process's env (the same env the workflows export) — never a literal
# here. The local KERIA/witness/any-sync stack does not need it, so its absence
# is not a failure; it is exported only so a host whose infra DOES touch droplet
# state picks up the current value.
[ -n "${DIGITALOCEAN_ACCESS_TOKEN:-}" ] && export DIGITALOCEAN_ACCESS_TOKEN

# ── clause plumbing ────────────────────────────────────────────────────────
# fail <clause> <message...> — the loud, exact, non-zero exit the contract
# requires. Names the clause so a host preflight log says WHICH prerequisite is
# missing, not just "something failed".
fail() {
  local clause="$1"; shift
  echo "provision-e2e-stack: FAILED clause [$clause] — $*" >&2
  exit 1
}
ok()   { echo "provision-e2e-stack:   ✓ [$1] $2"; }
note() { echo "provision-e2e-stack:   · $*"; }

# Set the first time any clause does REAL work (a clone / pull / build / install).
# It is what tells the witness clause whether this is a fresh provisioning (worth
# actually standing the stack up to prove OOBI) or a re-run where nothing changed
# (leave the ephemeral stack alone — the contract's "a re-run is a no-op").
CONVERGED=0
converged() { CONVERGED=1; }

# _resolve_runner_path — the PATH a runner JOB actually gets, which is what every
# toolchain probe must use (matou-app#437: a login-shell `command -v go` was
# green on elitebook-03 through the swarm user's nix profile while the runner
# unit — Environment=PATH=/home/swarm/.local/bin:/usr/local/bin:/usr/bin:
# /usr/sbin:/bin — could not see go, so the drive died on `make build`).
# Precedence: PROVISION_RUNNER_PATH (explicit) > the forgejo-runner unit's
# Environment=PATH (system unit, then a user unit) > RUNNER_PATH_DEFAULT.
# Resolved once (a plain call, not inside $(...), so the memo sticks) and the
# source is reported, so a preflight log shows exactly what was probed.
RUNNER_PATH=""; RUNNER_PATH_SRC=""
_unit_path() {  # [systemctl args...] — the PATH= pair of the unit's Environment=
  # Environment= holds space-separated KEY=VALUE pairs; take the PATH one wherever
  # it sits (\(.* \)\{0,1\} anchors on a preceding space so GOPATH= can't match).
  systemctl "$@" show -p Environment 'forgejo-runner*' 2>/dev/null \
    | sed -n 's/^Environment=\(.* \)\{0,1\}PATH=\([^ ]*\).*/\2/p' | head -1
}
_resolve_runner_path() {
  [ -n "$RUNNER_PATH" ] && return 0
  local p
  if [ -n "${PROVISION_RUNNER_PATH:-}" ]; then
    RUNNER_PATH="$PROVISION_RUNNER_PATH"; RUNNER_PATH_SRC="PROVISION_RUNNER_PATH"
  elif p="$(_unit_path)" && [ -n "$p" ]; then
    RUNNER_PATH="$p"; RUNNER_PATH_SRC="forgejo-runner unit"
  elif p="$(_unit_path --user)" && [ -n "$p" ]; then
    RUNNER_PATH="$p"; RUNNER_PATH_SRC="forgejo-runner user unit"
  else
    RUNNER_PATH="$RUNNER_PATH_DEFAULT"; RUNNER_PATH_SRC="systemd service default; no forgejo-runner unit found"
  fi
  note "toolchain probes use the runner job's PATH ($RUNNER_PATH_SRC): $RUNNER_PATH"
}
# _on_runner_path <cmd> — `command -v` under the runner's PATH, not this shell's.
_on_runner_path() { _resolve_runner_path; PATH="$RUNNER_PATH" command -v "$1" 2>/dev/null; }

# _witness_oobi_url — the probe URL: the explicit WITNESS_OOBI_URL override, or
# the port the infra checkout's test compose will actually bind (WITNESS_PORT_0
# in keri/.env.test; stock 6642). Resolved at call time because a fresh run
# clones the infra checkout only in clause 1.
_witness_oobi_url() {
  if [ -n "$WITNESS_OOBI_URL" ]; then echo "$WITNESS_OOBI_URL"; return; fi
  local port
  port="$(sed -n 's/^WITNESS_PORT_0=//p' "$INFRA/keri/.env.test" 2>/dev/null | head -1)"
  echo "http://localhost:${port:-6642}/oobi"
}

# _witness_http_code — the OOBI probe. "Reachable" = the witness answered with
# ANY HTTP status (000 = nothing listening / connection refused). Mirrors the
# compose healthcheck (`curl -f .../oobi`) but tolerant of a non-2xx OOBI index.
_witness_http_code() {
  # curl prints the code (000 when nothing answered) on stdout and exits non-zero
  # on a connection failure — capture stdout only; do NOT `|| echo 000`, which
  # would append a SECOND 000 and read as a (non-000) "reachable" false positive.
  local code
  code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$(_witness_oobi_url)" 2>/dev/null)"
  echo "${code:-000}"
}
_witness_reachable() { [ "$(_witness_http_code)" != 000 ]; }

# ── clause 1: the matou-infrastructure checkout ────────────────────────────
ensure_infra() {
  if [ -f "$INFRA/keri/Makefile" ] && [ -f "$INFRA/any-sync/Makefile" ]; then
    ok infra "checkout present at $INFRA"
    return 0
  fi
  if [ "$CHECK_ONLY" = 1 ]; then
    fail infra "no matou-infrastructure checkout at $INFRA (keri/ + any-sync/ Makefiles). Run without --check to clone it."
  fi
  converged; note "cloning matou-infrastructure into $INFRA (from $INFRA_REPO)"
  mkdir -p "$(dirname "$INFRA")"
  if ! git clone "$INFRA_REPO" "$INFRA"; then
    fail infra "clone of $INFRA_REPO failed — the host needs SSH access to that remote (a host-level credential this script cannot supply; enrol the host's SSH key on the infra remote, or set MATOU_INFRA_DIR to an existing checkout)."
  fi
  if [ -n "$INFRA_REF" ]; then
    git -C "$INFRA" checkout "$INFRA_REF" \
      || fail infra "checked out clone but ref '$INFRA_REF' (MATOU_INFRA_REF) does not exist in $INFRA_REPO"
  fi
  [ -f "$INFRA/keri/Makefile" ] && [ -f "$INFRA/any-sync/Makefile" ] \
    || fail infra "clone succeeded but keri/ + any-sync/ Makefiles are absent — wrong ref? (on $(git -C "$INFRA" rev-parse --abbrev-ref HEAD 2>/dev/null))"
  ok infra "cloned at $INFRA ($(git -C "$INFRA" rev-parse --abbrev-ref HEAD 2>/dev/null))"
}

# ── clause 2: docker + the KERIA/witness images the test compose boots ─────
ensure_docker_images() {
  docker info >/dev/null 2>&1 || fail docker "docker daemon not reachable (\`docker info\` failed) — the test compose cannot boot"
  if docker image inspect "$WITNESS_DEMO_IMAGE" >/dev/null 2>&1; then
    ok docker "witness image $WITNESS_DEMO_IMAGE present"
  else
    if [ "$CHECK_ONLY" = 1 ]; then
      fail docker "witness image $WITNESS_DEMO_IMAGE not pulled. Run without --check to pull it."
    fi
    converged; note "pulling $WITNESS_DEMO_IMAGE"
    docker pull "$WITNESS_DEMO_IMAGE" || fail docker "docker pull $WITNESS_DEMO_IMAGE failed"
    ok docker "witness image $WITNESS_DEMO_IMAGE pulled"
  fi
  # The patched KERIA image is built from the infra checkout. Its presence is a
  # convenience (the drive's own `build-test` rebuilds as needed); we build it
  # ahead of time in full mode so the first drive on a fresh host is not the one
  # paying a cold docker build, but we never FAIL --check on its absence.
  if docker image inspect matou-keria-patched:latest >/dev/null 2>&1; then
    ok docker "KERIA patched image present"
  elif [ "$CHECK_ONLY" = 1 ]; then
    note "KERIA patched image not built yet (the first drive's \`make build-test\` will build it)"
  else
    converged; note "building the patched KERIA image (make -C $INFRA/keri build-test)"
    make -C "$INFRA/keri" build-test || fail docker "make -C $INFRA/keri build-test failed"
    ok docker "KERIA patched image built"
  fi
}

# ── clause 3: the any-sync test network config (matou-app#437) ──────────────
# run-pr-e2e.sh runs `make -C any-sync clean-test setup-test`; clean-test runs
# FIRST and reads .env.test, which only a prior generate-config-test creates
# (setup-test → generate-config-test → scripts/generate-config.sh). A bare host
# has no .env.test, no storage-test network id and ZERO any-sync images, so the
# very first drive dies in clean-test. generate-config-test is idempotent and
# stands up both the config AND the any-sync images as a unit, so .env.test's
# presence is the honest gate: no host has it without having pulled the images.
#
# It also runs BEFORE verify_witness on purpose: keri/docker-compose.yml
# bind-mounts ../any-sync/etc-test, and Docker auto-creates that path root-owned
# if it is absent when the keri stack comes up — the leftover that blocked the
# next unprivileged clean-config in run 13605. Generating the config here makes
# etc-test exist (swarm-owned) before anything mounts it.
_fix_etc_test_owner() {
  # Reclaim a root-owned etc-test/ (top dir only — its generated subdirs are
  # root-owned by design; any-sync's Makefile chowns them on `start`). Converge
  # only: --check probes, never mutates.
  [ "$CHECK_ONLY" = 1 ] && return 0
  local d="$ANYSYNC/etc-test"
  [ -d "$d" ] || return 0
  local owner me; owner="$(stat -c '%U' "$d" 2>/dev/null)"; me="$(id -un 2>/dev/null)"
  [ -z "$owner" ] || [ "$owner" = "$me" ] && return 0
  note "etc-test/ is owned by '$owner', not '$me' — reclaiming top dir (sudo -n chown)"
  sudo -n chown "$me:$(id -gn)" "$d" 2>/dev/null \
    || note "could not chown $d without a password — if a drive's clean-config fails, a human must: sudo chown -R $me $d"
}
ensure_anysync_config() {
  _fix_etc_test_owner
  if [ -f "$ANYSYNC_ENV" ]; then
    ok anysync "test network config present ($ANYSYNC_ENV)"
    return 0
  fi
  if [ "$CHECK_ONLY" = 1 ]; then
    fail anysync "no any-sync test config at $ANYSYNC_ENV — generate-config-test has never run on this host (so no .env.test, no network id, no any-sync images), and run-pr-e2e's \`make clean-test setup-test\` dies in clean-test without it. Run without --check to generate it."
  fi
  converged; note "generating the any-sync test network config + images (make -C $ANYSYNC generate-config-test)"
  make -C "$ANYSYNC" generate-config-test || fail anysync "make -C $ANYSYNC generate-config-test failed"
  [ -f "$ANYSYNC_ENV" ] || fail anysync "generate-config-test ran but $ANYSYNC_ENV is still absent"
  _fix_etc_test_owner
  ok anysync "test network config generated ($ANYSYNC_ENV)"
}

# ── clause 4: the ~/swarm-e2e/<slug> checkout the drives run from ───────────
ensure_workdir() {
  if [ -d "$WORKDIR/.git" ]; then
    ok workdir "checkout present at $WORKDIR"
    return 0
  fi
  if [ "$CHECK_ONLY" = 1 ]; then
    fail workdir "no e2e checkout at $WORKDIR. Run without --check to clone it."
  fi
  [ -n "${FORGEJO_TOKEN:-}" ] || fail workdir "FORGEJO_TOKEN is unset — cannot clone $REPO_SLUG into $WORKDIR (the workflows export it as \$FORGEJO_TOKEN)"
  local host url
  host="${FORGEJO_API#*://}"; host="${host%%/*}"; host="${host:-git.matou.nz}"
  url="https://swarm:${FORGEJO_TOKEN}@${host}/${REPO_SLUG}.git"
  converged; note "cloning $REPO_SLUG into $WORKDIR"
  mkdir -p "$WORKDIR"
  git clone "$url" "$WORKDIR" || fail workdir "clone of $REPO_SLUG into $WORKDIR failed"
  ok workdir "cloned at $WORKDIR"
}

# ── clause 5: chromium for Playwright ──────────────────────────────────────
# Probe: `npx playwright --version` resolves AND a chromium browser is in the
# shared ~/.cache/ms-playwright. Converge from the e2e checkout's frontend (the
# same tree the drives run `npx playwright install chromium` in), so the browser
# version matches the pinned Playwright.
_frontend_dir() {
  if   [ -d "$WORKDIR/frontend" ];        then echo "$WORKDIR/frontend"
  elif [ -d "$here/../frontend" ];        then ( cd "$here/../frontend" && pwd )
  else return 1; fi
}
_chromium_installed() {
  local cache="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
  compgen -G "$cache/chromium-*" >/dev/null 2>&1
}
ensure_playwright() {
  local fe; fe="$(_frontend_dir)" || fail playwright "no frontend/ dir (looked in $WORKDIR and the repo checkout) — cannot resolve Playwright"
  if ( cd "$fe" && npx --no-install playwright --version ) >/dev/null 2>&1 && _chromium_installed; then
    ok playwright "$(cd "$fe" && npx --no-install playwright --version 2>/dev/null), chromium installed"
    return 0
  fi
  if [ "$CHECK_ONLY" = 1 ]; then
    fail playwright "Playwright/chromium not ready in $fe (\`npx playwright --version\` + chromium in ~/.cache/ms-playwright). Run without --check to install."
  fi
  if [ ! -d "$fe/node_modules" ]; then
    note "installing frontend deps (npm ci in $fe)"
    ( cd "$fe" && npm ci ) || fail playwright "npm ci failed in $fe"
  fi
  converged; note "installing chromium for Playwright"
  ( cd "$fe" && npx playwright install chromium ) || fail playwright "npx playwright install chromium failed in $fe"
  ( cd "$fe" && npx --no-install playwright --version ) >/dev/null 2>&1 && _chromium_installed \
    || fail playwright "installed but the probe (npx playwright --version + chromium cache) still fails in $fe"
  ok playwright "$(cd "$fe" && npx --no-install playwright --version 2>/dev/null), chromium installed"
}

# ── clause 6: a Go toolchain to build the backend (matou-app#437) ───────────
# run-pr-e2e.sh builds the backend with:
#     command -v go >/dev/null 2>&1 || export PATH="$HOME/go-sdk/go/bin:$PATH"
# so the drive needs go on the runner's PATH OR a toolchain at ~/go-sdk/go/bin.
# Probe EXACTLY that pair, and probe the first leg with the RUNNER JOB's PATH
# (_resolve_runner_path), never this shell's: `--check` over ssh runs in a login shell
# whose nix profile resolves go while the runner unit's stripped PATH does not
# — the false green that let elitebook-03 report ready (matou-app#437).
# Converge prefers LINKING an existing go (a nix/system install the runner PATH
# just doesn't export) into ~/go-sdk/go, and only downloads a pinned toolchain
# there when the box has none.
_go_binary() {
  local p
  p="$(_on_runner_path go)" && [ -n "$p" ] && { echo "$p"; return 0; }
  [ -x "$GO_SDK/bin/go" ] && { echo "$GO_SDK/bin/go"; return 0; }
  return 1
}
_find_any_go() {
  # A go on the box the runner's PATH may not export: whatever THIS (login)
  # shell resolves first — ben's exact case on -03, a nix-profile go seen over
  # ssh — then common install roots, then a fresh login shell's resolution.
  local c
  c="$(command -v go 2>/dev/null)"
  [ -n "$c" ] && [ -x "$c" ] && { echo "$c"; return 0; }
  for c in "$HOME/.nix-profile/bin/go" /nix/var/nix/profiles/default/bin/go \
           /usr/local/go/bin/go /usr/lib/go/bin/go /usr/bin/go /snap/bin/go; do
    [ -x "$c" ] && { echo "$c"; return 0; }
  done
  c="$(bash -lc 'command -v go' 2>/dev/null)"
  [ -n "$c" ] && [ -x "$c" ] && { echo "$c"; return 0; }
  return 1
}
_link_go() {  # <go-binary> — symlink its GOROOT into the ~/go-sdk fallback path
  local gobin="$1" goroot
  goroot="$("$gobin" env GOROOT 2>/dev/null)"
  [ -n "$goroot" ] && [ -x "$goroot/bin/go" ] || return 1
  mkdir -p "$(dirname "$GO_SDK")"
  ln -sfn "$goroot" "$GO_SDK" || return 1
  [ -x "$GO_SDK/bin/go" ]
}
_install_go() {
  local os arch m tmp url
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"; m="$(uname -m)"
  case "$m" in
    x86_64|amd64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) fail go "unsupported arch '$m' for Go auto-install — link or install a toolchain at $GO_SDK/bin manually" ;;
  esac
  url="https://go.dev/dl/go${GO_VERSION}.${os}-${arch}.tar.gz"
  tmp="$(mktemp -d)"
  note "downloading Go $GO_VERSION ($os-$arch) from $url"
  curl -fsSL "$url" -o "$tmp/go.tgz" || { rm -rf "$tmp"; fail go "download of $url failed — link or install a toolchain at $GO_SDK/bin manually"; }
  tar -C "$tmp" -xzf "$tmp/go.tgz"    || { rm -rf "$tmp"; fail go "extract of the Go tarball failed"; }
  mkdir -p "$(dirname "$GO_SDK")"; rm -rf "$GO_SDK"
  mv "$tmp/go" "$GO_SDK" || { rm -rf "$tmp"; fail go "could not move the Go toolchain into $GO_SDK"; }
  rm -rf "$tmp"
}
ensure_go() {
  local gobin
  _resolve_runner_path   # in THIS shell (not a $(...)), so the memo + note happen once
  if gobin="$(_go_binary)"; then
    ok go "toolchain present ($("$gobin" version 2>/dev/null | awk '{print $3}') at $gobin)"
    # Belt-and-suspenders: also populate the deterministic fallback run-pr-e2e
    # uses (~/go-sdk/go), so a runner job whose stripped PATH can't see THIS go
    # still builds the backend. Cheap, idempotent, converge-only.
    if [ "$CHECK_ONLY" != 1 ] && [ "$gobin" != "$GO_SDK/bin/go" ] && [ ! -e "$GO_SDK/bin/go" ]; then
      _link_go "$gobin" && note "also linked $GO_SDK for the runner fallback"
    fi
    return 0
  fi
  if [ "$CHECK_ONLY" = 1 ]; then
    fail go "no Go on the runner job's PATH ($RUNNER_PATH) and none at $GO_SDK/bin — run-pr-e2e.sh cannot build the backend (a go this login shell resolves does not count: the runner unit cannot see it). Run without --check to link or install one at $GO_SDK."
  fi
  local found
  if found="$(_find_any_go)" && _link_go "$found"; then
    converged; ok go "linked toolchain ($("$GO_SDK/bin/go" version 2>/dev/null | awk '{print $3}')) at $GO_SDK (go found at $found, off the runner PATH)"
    return 0
  fi
  converged; _install_go
  [ -x "$GO_SDK/bin/go" ] || fail go "installed but $GO_SDK/bin/go is still not executable"
  ok go "installed toolchain ($("$GO_SDK/bin/go" version 2>/dev/null | awk '{print $3}')) at $GO_SDK"
}

# ── clause 7: the compose actually stands a witness up here (OOBI) ──────────
# The headline proof: a witness answering OOBI on this host means docker + the
# images + the compose + the port map all work. The test stack is ephemeral, so
# between drives nothing is resident — that is expected, NOT a failure.
#   full, fresh provisioning (something was cloned/pulled/built/installed this
#         run, or PROVISION_E2E_VERIFY_LIVE=1): bring the test keri stack up,
#         probe OOBI, and tear down what WE started — the definitive proof the
#         compose stands a witness up on THIS host.
#   full, nothing converged (a re-run of an already-provisioned host): do NOT
#         cycle containers — that keeps the contract's "a re-run is a no-op". Pass
#         on the same capability check as --check.
#   check: never cycles containers (a preflight stays light); if up → pass, else
#         pass on capability with a note (the stack is simply not resident now).
_witness_capability_ok() {
  [ -f "$INFRA/keri/Makefile" ] && docker image inspect "$WITNESS_DEMO_IMAGE" >/dev/null 2>&1
}
verify_witness() {
  if _witness_reachable; then
    ok witness "OOBI reachable at $(_witness_oobi_url) (HTTP $(_witness_http_code)) — stack already up"
    return 0
  fi
  # Passive path (--check, or a full run that changed nothing): verify the host
  # CAN stand the witness up rather than cycling the ephemeral stack.
  if [ "$CHECK_ONLY" = 1 ] || { [ "$CONVERGED" = 0 ] && [ "${PROVISION_E2E_VERIFY_LIVE:-0}" != 1 ]; }; then
    if _witness_capability_ok; then
      note "witness OOBI not live at $(_witness_oobi_url) — expected between drives (the test stack is ephemeral)"
      ok witness "host is capable of standing the witness up (infra + $WITNESS_DEMO_IMAGE present)"
      return 0
    fi
    fail witness "witness not up AND host not capable (need infra checkout + $WITNESS_DEMO_IMAGE)"
  fi

  note "standing the test KERI stack up to verify OOBI (make -C $INFRA/keri build-test up-test wait-test)"
  local started=0
  if make -C "$INFRA/keri" build-test up-test wait-test; then started=1; fi
  local rc=0
  if _witness_reachable; then
    ok witness "OOBI reachable at $(_witness_oobi_url) (HTTP $(_witness_http_code)) — the compose stands a witness up on this host"
  else
    echo "provision-e2e-stack: witness did not answer OOBI at $(_witness_oobi_url) after bring-up" >&2
    rc=1
  fi
  # Tear down ONLY what we started, unless asked to keep it. `down-test` (never
  # `clean-test`) removes the test containers but keeps volumes, and is scoped
  # to the matou-keri-test project, so the resident dev stack is untouched.
  if [ "$started" = 1 ] && [ "${PROVISION_E2E_KEEP_STACK:-0}" != 1 ]; then
    note "tearing down the test KERI stack this script started (make -C $INFRA/keri down-test)"
    make -C "$INFRA/keri" down-test >/dev/null 2>&1 || true
  fi
  [ "$rc" = 0 ] || fail witness "the test compose did not produce a reachable witness on this host"
}

# ── run every clause in dependency order ───────────────────────────────────
ensure_infra
ensure_docker_images
ensure_anysync_config
ensure_workdir
ensure_playwright
ensure_go
verify_witness

echo "provision-e2e-stack: OK ($mode) — the e2e stack is ready on $(hostname 2>/dev/null || echo this host)."
