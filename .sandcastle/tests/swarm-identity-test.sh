#!/usr/bin/env bash
# Offline tests for swarm-identity.sh's factory git identity (#19). Without an
# explicit identity, every headless commit path inherits the host user's
# ~/.gitconfig — on matou-workstation those commits landed authored as the host
# `dev` user (Cherese), not the factory, and `git log` lost all provenance. This
# lib is the ONE place the four GIT_* vars come from; the consuming scripts wire
# it in (session-runner-test.sh / heal-test.sh assert the live wiring). Pure
# environment, no network, no docker. Run: bash .sandcastle/tests/swarm-identity-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sc="$here/.."
fail() { echo "FAIL: $1" >&2; exit 1; }

# Source in a controlled env: pinned SWARM_HOST makes the host portion
# deterministic; a made-up slug/API proves the defaults DERIVE (no product
# literal baked in) rather than hardcode Matou.
ident() { # ident <class> — echo "NAME|COMMITTER|EMAIL|COMMITTER_EMAIL" after sourcing + calling
  env -u GIT_AUTHOR_NAME -u GIT_AUTHOR_EMAIL -u GIT_COMMITTER_NAME -u GIT_COMMITTER_EMAIL \
      -u SWARM_GIT_NAME -u SWARM_GIT_EMAIL \
    bash -c '
      . "'"$sc"'/swarm-identity.sh"
      swarm_git_identity "$1"
      printf "%s|%s|%s|%s\n" "$GIT_AUTHOR_NAME" "$GIT_COMMITTER_NAME" "$GIT_AUTHOR_EMAIL" "$GIT_COMMITTER_EMAIL"' _ "$1"
}

# 1: the base identity derives from REPO_SLUG's owner and FORGEJO_API's host —
#    no product literal, and the worker class + host land in the author name.
out="$(SWARM_HOST=box1 REPO_SLUG=Acme/widget FORGEJO_API=https://git.acme.dev/api/v1/repos/Acme/widget ident worker)"
[ "$out" = "Acme Swarm (worker@box1)|Acme Swarm (worker@box1)|swarm@acme.dev|swarm@acme.dev" ] \
  || fail "derived identity wrong: $out"
echo "ok 1 owner/host-derived identity, committer mirrors author"

# 2: the worker class names the machinery — session-runner / healer / worker.
for class in session-runner healer worker; do
  out="$(SWARM_HOST=box1 REPO_SLUG=Acme/widget FORGEJO_API=https://git.acme.dev/api/v1/repos/Acme/widget ident "$class")"
  [ "${out%%|*}" = "Acme Swarm ($class@box1)" ] || fail "class $class not named in identity: $out"
done
echo "ok 2 worker class named per path"

# 3: the FORGEJO_API host's leading git. is stripped so the email reads cleanly.
out="$(SWARM_HOST=box1 REPO_SLUG=Matou/dev-factory FORGEJO_API=https://git.matou.nz/api/v1/repos/Matou/dev-factory ident worker)"
[ "$out" = "Matou Swarm (worker@box1)|Matou Swarm (worker@box1)|swarm@matou.nz|swarm@matou.nz" ] \
  || fail "git. host prefix not stripped for the email: $out"
echo "ok 3 email host strips the git. prefix"

# 4: an operator override of SWARM_GIT_NAME/SWARM_GIT_EMAIL wins over the derived
#    default (the consumer sets its own identity without touching harness files).
out="$(SWARM_HOST=box1 SWARM_GIT_NAME='Custom Bot' SWARM_GIT_EMAIL=bot@example.org \
  REPO_SLUG=Acme/widget FORGEJO_API=https://git.acme.dev/api/v1/repos/Acme/widget \
  bash -c '. "'"$sc"'/swarm-identity.sh"; swarm_git_identity worker; printf "%s|%s\n" "$GIT_AUTHOR_NAME" "$GIT_AUTHOR_EMAIL"')"
[ "$out" = "Custom Bot (worker@box1)|bot@example.org" ] || fail "override not honoured: $out"
echo "ok 4 SWARM_GIT_NAME/EMAIL override wins"

# 5: default worker class when none is passed.
out="$(SWARM_HOST=box1 REPO_SLUG=Acme/widget FORGEJO_API=https://git.acme.dev/api/v1/repos/Acme/widget \
  bash -c '. "'"$sc"'/swarm-identity.sh"; swarm_git_identity; printf "%s\n" "$GIT_AUTHOR_NAME"')"
[ "$out" = "Acme Swarm (worker@box1)" ] || fail "default class should be worker: $out"
echo "ok 5 default class is worker"

# 6: wiring guards for the two headless commit paths that cannot run offline
#    (run-swarm.sh needs docker/pnpm; main.mts is the TS orchestrator). Assert
#    they still call the ONE place and forward it, so a refactor can't silently
#    drop the identity from those paths.
grep -q 'swarm_git_identity worker' "$sc/run-swarm.sh" \
  || fail "run-swarm.sh must stamp the worker identity for its reconcile/rescue commits"
grep -q '\. "\$here/swarm-identity.sh"' "$sc/run-swarm.sh" \
  || fail "run-swarm.sh must source swarm-identity.sh"
grep -q 'GIT_AUTHOR_NAME' "$sc/main.mts" && grep -q 'claudeCode(SWARM_MODEL, { env: factoryGitIdentityEnv() })' "$sc/main.mts" \
  || fail "main.mts must forward the factory git identity into the worker container"
echo "ok 6 run-swarm.sh + main.mts wire the identity in"

echo "swarm-identity: 6 groups passed"
