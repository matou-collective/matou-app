#!/usr/bin/env bash
# provision-lib.sh — the PROVISION seam of run-swarm.sh (#2).
#
# The second of the two stages the 2026-08-15 factory-reengineering survey named
# as having no library of its own (schedule-lib.sh is the first). It owns
# everything a worker container needs to EXIST, in the order a run needs it:
#
#   .env manifest → secret files → pnpm store guard → mount dirs
#   → pnpm install → image build → persistent nix store seed
#
# Three separate run-swarm tests used to pin pieces of this stage as verbatim
# COPIES of the block — tests/nix-store-test.sh (image name + seed decision),
# tests/run-swarm-env-guard-test.sh (.env materialize) and
# tests/run-swarm-cold-store-test.sh (the cold-store FATAL's verdict keying).
# That is three chances for an original to drift from its pin silently; the
# logic lives here now and those tests drive the real functions.
#
# Every failure path in this stage is one a worker cannot recover from, so each
# one names its OWN verdict stage and captures its FATAL as the run's error line
# (#9): without that the EXIT trap attributes the death to the last stage set —
# still "preflight self-tests" — with an EMPTY error block, and the healer keys
# its signature on the wrong stage and escalates CLASS unknown (elitebook-03 ×
# matou-app did exactly that on every tick for 20 h).
#
# Callers must have sourced verdict-lib.sh and env-allowlist-lib.sh. No network.
# Offline-tested by tests/provision-lib-test.sh with shimmed docker/pnpm.

if [ -z "${__SWARM_PROVISION_LIB:-}" ]; then
__SWARM_PROVISION_LIB=1

# ── the .env forwarding manifest (#593, part 1 of #592) ────────────────────
# Sandcastle's sandbox-forwarding manifest is .sandcastle/.env (git-ignored). In
# CI it doesn't exist — materialize it from the example so its empty values fall
# back to the env the workflow provides. Under Actions (GITHUB_ACTIONS set)
# refresh it every run so example changes propagate; never overwrite a
# developer's real .env on a host run.
#
# provision_env_materialize <sandcastle-dir> -> rc 1 on an allowlist violation.
# The CI branch always refreshes from .env.example, so it is structurally clean
# and the guard never fires there. A host-mode .env is a developer's own file,
# never regenerated, so it can drift a stray secret-shaped key into the
# `docker -e` forward (docker inspect .Config.Env — the 2026-07-11 breach
# vector, the #578 leak class) silently. Fail closed instead.
provision_env_materialize() {
  local dir="$1" violations fatal
  if [ -n "${GITHUB_ACTIONS:-}" ] || [ ! -f "$dir/.env" ]; then
    cp -f "$dir/.env.example" "$dir/.env"
    return 0
  fi
  violations="$(env_allowlist_violations "$dir/.env")"
  [ -n "$violations" ] || return 0
  # Name the stage and capture the FATAL (#9), so the death is not mis-keyed to
  # "preflight self-tests" with an empty error block.
  verdict_stage "env allowlist check (#593)"
  fatal="run-swarm: FATAL — $dir/.env carries key(s) beyond the allowlist: $(printf '%s' "$violations" | tr '\n' ' ')"
  echo "$fatal" >&2
  echo "run-swarm: sandcastle forwards every .env key as a docker run -e value (docker inspect .Config.Env — the 2026-07-11 breach vector, #578 leak class). Move secret-shaped keys to .sandcastle/secrets/ (see secrets/README.md) or add them to ENV_ALLOWLIST_KEYS in env-allowlist-lib.sh if they are genuinely non-secret." >&2
  verdict_error "$fatal"
  return 1
}

# ── the host mounts main.mts binds into every worker ───────────────────────

# provision_store_dirs <sandcastle-dir> — the secrets dir and the persistent
# pnpm store. Created BEFORE the cold-store guard, which reads the latter.
# The sandbox's pnpm store (main.mts mounts it at /home/agent/.pnpm-store)
# survives across runs so workers install in seconds instead of re-downloading
# the registry every iteration.
provision_store_dirs() {
  mkdir -p "$1/secrets" && chmod 700 "$1/secrets"
  mkdir -p "$1/pnpm-store"
}

# provision_mount_dirs <sandcastle-dir> — the two remaining bind mounts.
#   nix-store/  the sandbox's persistent /nix, so the #198 Go pre-push gate
#               enters `nix develop .#go-ci` from a warm store (seconds) instead
#               of re-substituting the ADR-0040 pinned toolchain in every worker
#               container (#249). Seeded after the image build — see
#               provision_seed_nix for why a bare mount would HIDE Nix itself.
#   worktrees/  main.mts mounts this at its own host path (#239) as a MANDATORY
#               bind mount — Sandcastle throws "Mount hostPath does not exist"
#               and the run never spawns a worker if it's missing. Gitignored (it
#               holds live git worktrees), so a fresh clone never has it; a
#               genuinely new host (elitebook-03, cutover 2026-08-12) hit this on
#               every dispatch, crash-looping ~7 min with no worker ever born and
#               no claim (the crash precedes claim-next-task.sh).
provision_mount_dirs() {
  mkdir -p "$1/nix-store"
  mkdir -p "$1/worktrees"
}

# ── the secret FILES ───────────────────────────────────────────────────────
# FORGEJO_TOKEN/MATTERMOST_BOT_TOKEN/DIGITALOCEAN_ACCESS_TOKEN are NOT in .env —
# Sandcastle forwards every key .env declares as a `docker run -e` value, which
# lands in `docker inspect .Config.Env` (the 2026-07-11 breach vector). They ship
# into the sandbox as read-only files instead (main.mts's `mounts`, consumed per
# .sandcastle/secrets/README.md). Materialized from THIS process's own env (CI:
# Actions secrets; host: whatever the operator exported) so every run picks up
# the current value, including rotations. Each is optional — a task that never
# needs one just won't find the file.
provision_write_secrets() {
  local dir="$1"
  _provision_write_secret "$dir" forgejo_token "${FORGEJO_TOKEN:-}"
  _provision_write_secret "$dir" mattermost_bot_token "${MATTERMOST_BOT_TOKEN:-}"
  _provision_write_secret "$dir" digitalocean_access_token "${DIGITALOCEAN_ACCESS_TOKEN:-}"
}

_provision_write_secret() { # _provision_write_secret <dir> <file> <value>
  [ -n "$3" ] || return 0
  printf '%s' "$3" >"$1/secrets/$2" && chmod 600 "$1/secrets/$2"
}

# ── the cold pnpm-store guard (#489 / GOTCHAS #20) ────────────────────────
# provision_store_dirs guarantees the mount EXISTS, not that it is WARM. A fresh
# host's empty store makes every worker's frozen install fetch the whole tree
# inside the sandbox, which fails (exit 243) — zero workers born, anonymous ~29s
# reds every tick, visible only in the verdict file. Refuse loudly up front
# instead: seed the store from an established host (".forgejo/runner/README.md" →
# Fresh-host warm state; Ben's ruling 2026-08-13). SWARM_ALLOW_COLD_STORE=1
# overrides for a deliberate cold start.
#
# provision_pnpm_store_guard <sandcastle-dir> -> rc 1 on an empty store.
# Deliberately leaves SWARM_EXIT_REASON UNSET so the runlog reason stays the
# died-in:<stage> form the ticket's acceptance names ("died-in:pnpm store warm
# check (#489)") rather than a bare slug; the healer classifies off the verdict.
provision_pnpm_store_guard() {
  local dir="$1" fatal
  [ "${SWARM_ALLOW_COLD_STORE:-0}" != "1" ] || return 0
  [ -z "$(find "$dir/pnpm-store" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ] || return 0
  verdict_stage "pnpm store warm check (#489)"
  fatal="run-swarm: FATAL — pnpm store $dir/pnpm-store is EMPTY: workers cannot install (GOTCHAS #20, #489)."
  echo "$fatal" >&2
  echo "run-swarm: seed it from an established host (.forgejo/runner/README.md → 'Fresh-host warm state'), or set SWARM_ALLOW_COLD_STORE=1 for a deliberate cold start." >&2
  verdict_error "$fatal"
  return 1
}

# ── install + image ───────────────────────────────────────────────────────
# pnpm-only, matching the repo standard (flake.nix: "no npm/yarn") — the repo
# carries a single lockfile. The 2026-07-27 outage was `npm ci` here tripping
# over a package-lock.json that #142's package.json change never updated.
provision_install_and_build() {
  verdict_stage "pnpm install (frozen lockfile)"
  pnpm install --frozen-lockfile || return 1
  verdict_stage "sandcastle docker build-image"
  pnpm exec sandcastle docker build-image   # fast no-op after first build (layer cache)
}

# ── the persistent nix store seed (#249) ──────────────────────────────────

# provision_image_name <checkout-dir> -> the tag sandcastle gives this repo's
# image. Sandcastle tags it `sandcastle:<checkout-basename>`, lowercased with
# every character outside [a-z0-9_.-] replaced by '-' (empty -> "local"); see
# @ai-hero/sandcastle's defaultImageName. Replicated here so the nix-store seed
# targets the SAME image the workers run — if this replica ever drifts, the seed
# silently populates the wrong image's store (or none) and every worker is cold
# again. SANDCASTLE_IMAGE overrides.
provision_image_name() {
  local base sanitized
  base="$(basename "${1:-.}")"
  sanitized="$(printf '%s' "$base" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_.-]/-/g')"
  printf 'sandcastle:%s' "${sanitized:-local}"
}

# provision_should_seed_nix <nix-store-dir> -> "seed" | "skip"
# Seed only when the store is empty (or absent): a cold host seeds once from the
# image's /nix, a warm host reuses what's there. A dotfile still counts as
# content (ls -A) — a store carrying only .links is warm, not empty.
provision_should_seed_nix() {
  if [ -z "$(ls -A "$1" 2>/dev/null)" ]; then echo seed; else echo skip; fi
}

# provision_seed_nix <nix-store-dir> <workspace-dir>
# Unlike the pnpm store — a plain cache dir that pnpm-the-binary lives OUTSIDE of
# — /nix holds Nix ITSELF (the single-user install the Dockerfile bakes writes
# its closure to /nix/store, and ~/.nix-profile symlinks point into it).
# Bind-mounting an EMPTY host dir over /nix would therefore hide that install and
# break the `nix` command every worker's gate needs. So seed the host store from
# the freshly built image's /nix ONCE, before the first worker mounts it; from
# then on the mount persists and the Go gate's toolchain substitution accumulates
# there across containers. Runs as this host user's uid:gid — the same identity
# the worker mounts under — so the store stays agent-owned (AC #2).
#
# NON-FATAL throughout, matching the nix-install posture: if the seed fails the
# gate simply fails closed (a blocked push, main stays green) until the next run
# retries. Always rc 0.
provision_seed_nix() {
  local store="$1" workspace="$2" image seed_id
  verdict_stage "seed persistent nix store"
  [ "$(provision_should_seed_nix "$store")" = "seed" ] || return 0
  image="${SANDCASTLE_IMAGE:-$(provision_image_name "$workspace")}"
  seed_id="$(id -u):$(id -g)"
  echo "run-swarm: seeding cold nix store from $image (first run on this host)"
  # --entrypoint overrides the image's `sleep infinity` ENTRYPOINT (else it would
  # prefix the command and hang). `cp -a /nix/.` copies the image's whole Nix
  # closure — binaries and store — into the empty host mount.
  if docker run --rm --user "$seed_id" --entrypoint cp \
       -v "$store:/seed-nix" "$image" -a /nix/. /seed-nix/; then
    # Pre-warm .#go-ci so even the FIRST worker's gate finds the pinned toolchain
    # already substituted (AC #3's 'better' path), not a cold substitution on the
    # critical push path. Mount the repo + the seeded store so the closure lands
    # in the persistent dir. Best-effort under a timeout: if it can't warm (no
    # egress, flake hiccup), the first real gate populates the store instead —
    # still persistent thereafter, still AC-#3 'acceptable'.
    if timeout 900 docker run --rm --user "$seed_id" --entrypoint bash \
         -v "$store:/nix" -v "$workspace:/home/agent/workspace" \
         -w /home/agent/workspace "$image" \
         -lc 'nix develop .#go-ci --command true'; then
      echo "run-swarm: nix store warmed with .#go-ci"
    else
      echo "run-swarm: .#go-ci pre-warm skipped — the first Go gate will populate the store"
    fi
  else
    echo "run-swarm: nix store seed failed — the first worker gate will populate a cold store"
  fi
  return 0
}

fi
