#!/usr/bin/env bash
# Offline test for provision-lib.sh — the PROVISION seam of run-swarm.sh (#2),
# the second of the two stages the 2026-08-15 factory-reengineering survey named
# as having no library. It owns everything a worker container needs to EXIST
# before one is spawned:
#
#   .env manifest → secret files → pnpm store → mount dirs → install → image
#   → persistent nix store seed
#
# Three of run-swarm.sh's tests used to pin pieces of this stage as verbatim
# COPIES of the block (nix-store-test.sh, run-swarm-env-guard-test.sh,
# run-swarm-cold-store-test.sh). The logic lives here now; those tests drive the
# real functions, and this one covers the rest of the stage.
#
# Run: bash .sandcastle/tests/provision-lib-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sc="$here/.."
. "$sc/env-allowlist-lib.sh"
. "$sc/verdict-lib.sh"
. "$sc/provision-lib.sh"

fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

# A workdir shaped like a .sandcastle/ checkout: the real .env.example beside it.
workdir() { local d="$tmp/$1"; mkdir -p "$d"; cp "$sc/.env.example" "$d/.env.example"; printf '%s' "$d"; }

# ── 1. the sandcastle image name ───────────────────────────────────────────
# The seed must target the SAME image the workers run — @ai-hero/sandcastle's
# defaultImageName (basename, lowercased, [^a-z0-9_.-] -> '-', empty -> "local").
# A drift in either direction silently seeds the wrong image's store.
[ "$(provision_image_name /srv/ci/idss)"        = "sandcastle:idss" ]      || fail "plain checkout name"
[ "$(provision_image_name /srv/ci/matou-app)"   = "sandcastle:matou-app" ] || fail "hyphen preserved (allowed char)"
[ "$(provision_image_name /home/dev/IDSS)"      = "sandcastle:idss" ]      || fail "uppercase lowercased"
[ "$(provision_image_name '/tmp/My Repo!')"     = "sandcastle:my-repo-" ]  || fail "space and bang become '-'"
[ "$(provision_image_name /var/lib/repo_1.2)"   = "sandcastle:repo_1.2" ]  || fail "underscore and dot are allowed"
[ "$(provision_image_name /srv/ci/idss/)"       = "sandcastle:idss" ]      || fail "trailing slash stripped"
pass=$((pass+1))

# ── 2. the mount dirs main.mts REQUIRES ────────────────────────────────────
# Sandcastle throws "Mount hostPath does not exist" and never spawns a worker if
# worktrees/ is missing — a genuinely new host (elitebook-03, 2026-08-12) hit
# this on every dispatch, crash-looping with no worker ever born and no claim.
d="$(workdir mounts)"
provision_store_dirs "$d" || fail "store dirs must be created"
[ -d "$d/secrets" ] || fail "secrets/ must exist"
[ "$(stat -c %a "$d/secrets")" = 700 ] || fail "secrets/ must be 0700, got $(stat -c %a "$d/secrets")"
[ -d "$d/pnpm-store" ] || fail "pnpm-store/ must exist"
provision_mount_dirs "$d" || fail "mount dirs must be created"
[ -d "$d/nix-store" ] || fail "nix-store/ must exist"
[ -d "$d/worktrees" ] || fail "worktrees/ must exist (main.mts mounts it MANDATORY)"
pass=$((pass+1))

# ── 3. the secret FILES (never .env — the 2026-07-11 breach vector) ────────
# Sandcastle forwards every .env key as a `docker run -e` value, which lands in
# `docker inspect .Config.Env`. Tokens ship as read-only mounted files instead.
FORGEJO_TOKEN=tok-fj MATTERMOST_BOT_TOKEN=tok-mm DIGITALOCEAN_ACCESS_TOKEN="" \
  provision_write_secrets "$d"
[ "$(cat "$d/secrets/forgejo_token")" = tok-fj ] || fail "forgejo token file"
[ "$(stat -c %a "$d/secrets/forgejo_token")" = 600 ] || fail "a secret file must be 0600"
[ "$(cat "$d/secrets/mattermost_bot_token")" = tok-mm ] || fail "mattermost token file"
[ ! -e "$d/secrets/digitalocean_access_token" ] \
  || fail "an UNSET secret must not be written (a task that never needs it just won't find the file)"
grep -rqF tok-fj "$d/.env" 2>/dev/null && fail "a token must NEVER be written into .env"
pass=$((pass+1))

# ── 4. the cold pnpm-store guard (#489 / GOTCHAS #20) ─────────────────────
# A fresh host's EMPTY store makes every worker's frozen install fetch the whole
# tree inside the sandbox, which fails (exit 243) — zero workers born, anonymous
# ~29s reds every tick. Refuse loudly up front, keyed on this guard's OWN stage
# with the FATAL as its error line (#9), never the stale preflight stage with an
# empty error block.
d="$(workdir cold)"; provision_store_dirs "$d"
vp="$tmp/cold-verdict.txt"
verdict_begin "$vp"
verdict_stage "preflight self-tests (#446)"   # the stale stage the #9 fix overwrites
if SWARM_ALLOW_COLD_STORE=0 provision_pnpm_store_guard "$d" 2>"$tmp/cold.err"; then
  fail "an EMPTY pnpm store must be refused"
fi
grep -q 'is EMPTY' "$tmp/cold.err" || fail "the refusal must name the fault: $(cat "$tmp/cold.err")"
grep -q 'seed it from an established host' "$tmp/cold.err" || fail "the refusal must name the fix"
# The guard leaves SWARM_EXIT_REASON UNSET on purpose so the runlog reason stays
# the died-in:<stage> form; the healer classifies off the verdict file.
verdict_write 1
grep -q '^stage=pnpm store warm check (#489)$' "$vp" || fail "verdict must re-key to THIS guard's stage:
$(cat "$vp")"
grep -q 'pnpm store .* is EMPTY' "$vp" || fail "the FATAL must be captured as the error line:
$(cat "$vp")"
pass=$((pass+1))

# a WARM store passes, and the deliberate-cold-start override passes an empty one
d="$(workdir warm)"; provision_store_dirs "$d"; : > "$d/pnpm-store/.modules.yaml"
SWARM_ALLOW_COLD_STORE=0 provision_pnpm_store_guard "$d" || fail "a warm store must pass"
d="$(workdir override)"; provision_store_dirs "$d"
SWARM_ALLOW_COLD_STORE=1 provision_pnpm_store_guard "$d" \
  || fail "SWARM_ALLOW_COLD_STORE=1 must pass an empty store"
pass=$((pass+1))

# ── 5. the .env manifest materialize + allowlist guard (#593) ─────────────
# CI always refreshes from .env.example (so it is structurally clean and the
# guard never fires there); a host-mode .env is a developer's own file, never
# regenerated, so it can drift a stray secret-shaped key into the docker -e
# forward silently. Fail closed instead.
d="$(workdir ci-bad)"; printf 'FOO_TOKEN=leaked\n' > "$d/.env"
verdict_begin "$tmp/ci-verdict.txt"
GITHUB_ACTIONS=true provision_env_materialize "$d" \
  || fail "CI-mode must never refuse, even over a .env carrying a stray secret"
diff -q "$d/.env" "$d/.env.example" >/dev/null || fail "CI-mode must overwrite .env from .env.example"
[ ! -f "$tmp/ci-verdict.txt" ] || fail "CI-mode must not write a verdict (it never refuses)"

d="$(workdir host-first)"
env -u GITHUB_ACTIONS bash -c ". '$sc/env-allowlist-lib.sh'; . '$sc/verdict-lib.sh'; . '$sc/provision-lib.sh'; provision_env_materialize '$d'" \
  || fail "host-mode with no .env yet must materialize, not refuse"
[ -f "$d/.env" ] || fail "host-mode first run should have created .env"

d="$(workdir host-clean)"
printf 'CLAUDE_CODE_OAUTH_TOKEN=sk-test\nFORGEJO_API=https://example\n' > "$d/.env"
before="$(cat "$d/.env")"
env -u GITHUB_ACTIONS bash -c ". '$sc/env-allowlist-lib.sh'; . '$sc/verdict-lib.sh'; . '$sc/provision-lib.sh'; provision_env_materialize '$d'" \
  || fail "host-mode with a clean .env must pass"
[ "$before" = "$(cat "$d/.env")" ] || fail "a clean host .env must be left UNTOUCHED, never materialized over"
pass=$((pass+1))

d="$(workdir host-bad)"
printf 'CLAUDE_CODE_OAUTH_TOKEN=sk-test\nFOO_TOKEN=leaked\n' > "$d/.env"
before="$(cat "$d/.env")"
vp="$tmp/env-verdict.txt"
if env -u GITHUB_ACTIONS SWARM_VERDICT_PATH="$vp" bash -c "
    . '$sc/env-allowlist-lib.sh'; . '$sc/verdict-lib.sh'; . '$sc/provision-lib.sh'
    verdict_begin '$vp'; verdict_stage 'preflight self-tests (#446)'
    provision_env_materialize '$d' || { verdict_write 1; exit 1; }" 2>"$tmp/env.err"; then
  fail "host-mode with a stray FOO_TOKEN must be refused"
fi
grep -q FOO_TOKEN "$tmp/env.err" || fail "the refusal must name the offending key: $(cat "$tmp/env.err")"
[ "$before" = "$(cat "$d/.env")" ] || fail "a refused .env must be left untouched, never silently rewritten"
grep -q '^stage=env allowlist check (#593)$' "$vp" || fail "verdict stage not re-keyed to the allowlist guard:
$(cat "$vp")"
grep -q FOO_TOKEN "$vp" || fail "the FATAL naming the key was not captured as the error line:
$(cat "$vp")"
pass=$((pass+1))

# ── 6. the persistent nix store seed (#249) ───────────────────────────────
# Unlike the pnpm store, /nix holds Nix ITSELF, so bind-mounting an empty host
# dir over it would hide the install and break every worker's gate. Seed once
# from the freshly built image, then never again.
[ "$(provision_should_seed_nix "$tmp/never-created")" = seed ] || fail "an absent store must seed"
mkdir -p "$tmp/empty";   [ "$(provision_should_seed_nix "$tmp/empty")"   = seed ] || fail "an empty store must seed"
mkdir -p "$tmp/warm-nix/store"; : > "$tmp/warm-nix/store/keep"
[ "$(provision_should_seed_nix "$tmp/warm-nix")" = skip ] || fail "a warm store must not re-seed"
mkdir -p "$tmp/dotonly"; : > "$tmp/dotonly/.reginfo"
[ "$(provision_should_seed_nix "$tmp/dotonly")" = skip ] || fail "a dotfile counts as content (ls -A) — warm, not empty"
pass=$((pass+1))

# the seed itself, with docker + timeout shimmed: a cold store copies the
# image's closure and then pre-warms .#go-ci
mkdir -p "$tmp/bin"
cat > "$tmp/bin/docker" <<'SH'
#!/usr/bin/env bash
echo "docker $*" >> "${DOCKER_LOG:?}"
case "$*" in *go-ci*) exit "${GOCI_RC:-0}" ;; esac
exit "${SEED_RC:-0}"
SH
cat > "$tmp/bin/timeout" <<'SH'
#!/usr/bin/env bash
shift; exec "$@"
SH
chmod +x "$tmp/bin/docker" "$tmp/bin/timeout"

seed_run() { # seed_run <nix-store> <seed_rc> <goci_rc>
  DOCKER_LOG="$tmp/docker.log" SEED_RC="$2" GOCI_RC="$3" \
    PATH="$tmp/bin:$PATH" SANDCASTLE_IMAGE=sandcastle:test \
    bash -c ". '$sc/verdict-lib.sh'; . '$sc/provision-lib.sh'; provision_seed_nix '$1' '$tmp/ws'"
}

: > "$tmp/docker.log"
out="$(seed_run "$tmp/warm-nix" 0 0)" || fail "a warm store seed must be a no-op, not a failure"
[ -s "$tmp/docker.log" ] && fail "a warm store must not touch docker at all: $(cat "$tmp/docker.log")"
[ -z "$out" ] || fail "a warm store must say nothing: $out"

mkdir -p "$tmp/cold-nix"; : > "$tmp/docker.log"
out="$(seed_run "$tmp/cold-nix" 0 0)" || fail "a cold seed must succeed"
grep -q 'seeding cold nix store from sandcastle:test' <<<"$out" || fail "the seed must name the image: $out"
grep -q 'nix store warmed with .#go-ci' <<<"$out" || fail "a successful pre-warm must be reported: $out"
grep -q -- '-a /nix/. /seed-nix/' "$tmp/docker.log" || fail "the seed must copy the image's whole /nix closure"
grep -q -- '--user' "$tmp/docker.log" || fail "the seed must run as this host user's uid:gid (AC #2)"
pass=$((pass+1))

# NON-FATAL both ways, matching the nix-install posture: a failed pre-warm, or a
# failed seed outright, leaves the gate to fail closed and the next run to retry
# — it must never red the run.
: > "$tmp/docker.log"
out="$(seed_run "$tmp/cold-nix" 0 1)" || fail "a failed .#go-ci pre-warm must NOT fail the run"
grep -q 'pre-warm skipped' <<<"$out" || fail "a failed pre-warm must be reported, not silent: $out"
: > "$tmp/docker.log"
out="$(seed_run "$tmp/cold-nix" 1 0)" || fail "a failed seed must NOT fail the run"
grep -q 'nix store seed failed' <<<"$out" || fail "a failed seed must be reported: $out"
pass=$((pass+1))

# ── 7. install + build-image ──────────────────────────────────────────────
# pnpm-only, matching the repo standard (flake.nix: "no npm/yarn"): the
# 2026-07-27 outage was `npm ci` here tripping over a package-lock.json that
# #142's package.json change never updated.
cat > "$tmp/bin/pnpm" <<'SH'
#!/usr/bin/env bash
echo "pnpm $*" >> "${PNPM_LOG:?}"
exit "${PNPM_RC:-0}"
SH
chmod +x "$tmp/bin/pnpm"
: > "$tmp/pnpm.log"
PNPM_LOG="$tmp/pnpm.log" PATH="$tmp/bin:$PATH" \
  bash -c ". '$sc/verdict-lib.sh'; . '$sc/provision-lib.sh'; provision_install_and_build" \
  || fail "install+build must succeed when pnpm does"
grep -qx 'pnpm install --frozen-lockfile' "$tmp/pnpm.log" || fail "install must be pnpm, frozen: $(cat "$tmp/pnpm.log")"
grep -qx 'pnpm exec sandcastle docker build-image' "$tmp/pnpm.log" || fail "the image build must run: $(cat "$tmp/pnpm.log")"
grep -qE '^(npm|yarn) ' "$tmp/pnpm.log" && fail "npm/yarn must never be used (flake.nix: 'no npm/yarn')"
: > "$tmp/pnpm.log"
if PNPM_LOG="$tmp/pnpm.log" PNPM_RC=1 PATH="$tmp/bin:$PATH" \
    bash -c ". '$sc/verdict-lib.sh'; . '$sc/provision-lib.sh'; provision_install_and_build"; then
  fail "a failing install must fail the stage (the #142 lockfile break must be loud)"
fi
pass=$((pass+1))

echo "provision-lib: $pass groups passed"
