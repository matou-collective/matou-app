#!/usr/bin/env bash
# Offline test for run-swarm.sh's persistent-nix-store seeding (#249).
#
# Until #2 this file kept a byte-for-byte COPY of the two pure decisions from
# run-swarm.sh, because the surrounding script needs docker + a live tracker.
# They now live in provision-lib.sh (the PROVISION seam) and this test drives the
# REAL functions — the copy-and-hope pattern is what the decomposition removed.
#
#   1. provision_image_name — the seed must target the SAME image the workers
#      run. That tag is @ai-hero/sandcastle's defaultImageName; if our replica
#      ever drifts, the seed silently populates the wrong image's store (or none)
#      and every worker is cold again. This test pins the algorithm.
#   2. the empty-dir seed guard — seed ONCE (cold host), skip when already warm.
#
# Run: bash .sandcastle/tests/nix-store-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/../verdict-lib.sh"
. "$here/../provision-lib.sh"

fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0

# --- decision 1: the image tag ---------------------------------------------
# Reference oracle: defaultImageName from @ai-hero/sandcastle (dist source), the
# contract our bash replica must match. Kept beside the assertions so a drift in
# either direction reds this test.
#   dirName = basename; sanitized = lower, [^a-z0-9_.-] -> '-'; empty -> "local".
[ "$(provision_image_name /srv/ci/idss)" = "sandcastle:idss" ] \
  || fail "plain checkout name"
[ "$(provision_image_name /srv/ci/matou-app)" = "sandcastle:matou-app" ] \
  || fail "hyphen preserved (allowed char)"
[ "$(provision_image_name /home/dev/IDSS)" = "sandcastle:idss" ] \
  || fail "uppercase lowercased"
[ "$(provision_image_name '/tmp/My Repo!')" = "sandcastle:my-repo-" ] \
  || fail "space and bang become '-'"
[ "$(provision_image_name /var/lib/repo_1.2)" = "sandcastle:repo_1.2" ] \
  || fail "underscore and dot are allowed chars"
# A trailing slash: basename strips it, same as defaultImageName's trailing-slash
# regex, so the tag is stable however the checkout path is spelled.
[ "$(provision_image_name /srv/ci/idss/)" = "sandcastle:idss" ] \
  || fail "trailing slash stripped"
pass=$((pass+1))

# --- decision 2: seed once, never re-seed ----------------------------------
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT

# a never-created dir seeds (the very first run on a fresh host)
[ "$(provision_should_seed_nix "$work/absent")" = "seed" ] || fail "absent store must seed"
# an empty dir seeds (provision_mount_dirs mkdir -p'd it but nothing has
# populated it yet)
mkdir -p "$work/empty"
[ "$(provision_should_seed_nix "$work/empty")" = "seed" ] || fail "empty store must seed"
# a populated store is left alone — seeding again would clobber a warm closure
mkdir -p "$work/warm/store"; : > "$work/warm/store/keep"
[ "$(provision_should_seed_nix "$work/warm")" = "skip" ] || fail "warm store must not re-seed"
# a dotfile still counts as content (ls -A) — a store carrying only .links etc.
# is warm, not empty
mkdir -p "$work/dotonly"; : > "$work/dotonly/.reginfo"
[ "$(provision_should_seed_nix "$work/dotonly")" = "skip" ] || fail "dotfile counts as warm"
pass=$((pass+1))

echo "nix-store: $pass groups passed"
