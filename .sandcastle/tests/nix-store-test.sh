#!/usr/bin/env bash
# Offline test for run-swarm.sh's persistent-nix-store seeding (#249). The
# surrounding script needs docker + a live tracker, so the two pure decisions the
# seed depends on are kept a byte-for-byte copy of run-swarm.sh here and exercised
# in isolation, like debounce-test.sh does for the coalescer.
#
#   1. sandcastle_image_name — the seed must target the SAME image the workers
#      run. That tag is @ai-hero/sandcastle's defaultImageName; if our replica
#      ever drifts, the seed silently populates the wrong image's store (or none)
#      and every worker is cold again. This test pins the algorithm.
#   2. the empty-dir seed guard — seed ONCE (cold host), skip when already warm.
#
# Run: bash .sandcastle/tests/nix-store-test.sh
set -euo pipefail
fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0

# --- decision 1, verbatim from run-swarm.sh -------------------------------
sandcastle_image_name() { # sandcastle_image_name <checkout-dir>
  local base sanitized
  base="$(basename "${1:-.}")"
  sanitized="$(printf '%s' "$base" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_.-]/-/g')"
  printf 'sandcastle:%s' "${sanitized:-local}"
}

# Reference oracle: defaultImageName from @ai-hero/sandcastle (dist source), the
# contract our bash replica must match. Kept beside the replica so a drift in
# either direction reds this test.
#   dirName = basename; sanitized = lower, [^a-z0-9_.-] -> '-'; empty -> "local".
[ "$(sandcastle_image_name /srv/ci/ourcloud)" = "sandcastle:ourcloud" ] \
  || fail "plain checkout name"
[ "$(sandcastle_image_name /srv/ci/matou-app)" = "sandcastle:matou-app" ] \
  || fail "hyphen preserved (allowed char)"
[ "$(sandcastle_image_name /home/dev/OurCloud)" = "sandcastle:ourcloud" ] \
  || fail "uppercase lowercased"
[ "$(sandcastle_image_name '/tmp/My Repo!')" = "sandcastle:my-repo-" ] \
  || fail "space and bang become '-'"
[ "$(sandcastle_image_name /var/lib/repo_1.2)" = "sandcastle:repo_1.2" ] \
  || fail "underscore and dot are allowed chars"
# A trailing slash: basename strips it, same as defaultImageName's trailing-slash
# regex, so the tag is stable however the checkout path is spelled.
[ "$(sandcastle_image_name /srv/ci/ourcloud/)" = "sandcastle:ourcloud" ] \
  || fail "trailing slash stripped"
pass=$((pass+1))

# --- decision 2, verbatim from run-swarm.sh -------------------------------
# Seed the persistent nix store only when it is empty (or absent): a cold host
# seeds once from the image's /nix, a warm host reuses what's there. Emitted as
# "seed" | "skip" so the test can assert both arms without a docker daemon.
should_seed_nix() { # should_seed_nix <nix-store-dir> -> "seed" | "skip"
  if [ -z "$(ls -A "$1" 2>/dev/null)" ]; then echo seed; else echo skip; fi
}

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT

# a never-created dir seeds (the very first run on a fresh host)
[ "$(should_seed_nix "$work/absent")" = "seed" ] || fail "absent store must seed"
# an empty dir seeds (run-swarm mkdir -p'd it but nothing has populated it yet)
mkdir -p "$work/empty"
[ "$(should_seed_nix "$work/empty")" = "seed" ] || fail "empty store must seed"
# a populated store is left alone — seeding again would clobber a warm closure
mkdir -p "$work/warm/store"; : > "$work/warm/store/keep"
[ "$(should_seed_nix "$work/warm")" = "skip" ] || fail "warm store must not re-seed"
# a dotfile still counts as content (ls -A) — a store carrying only .links etc.
# is warm, not empty
mkdir -p "$work/dotonly"; : > "$work/dotonly/.reginfo"
[ "$(should_seed_nix "$work/dotonly")" = "skip" ] || fail "dotfile counts as warm"
pass=$((pass+1))

echo "nix-store: $pass groups passed"
