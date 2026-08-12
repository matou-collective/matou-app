#!/usr/bin/env bash
# rearm_dispatch posts a workflow_dispatch for swarm.yml.
#
# claim-lib.sh itself is a #250 mechanical sync from ourcloud (canonical —
# see .sandcastle/harness-manifest); this test file is NOT synced (tests are
# deliberately off the manifest) but exercises matou-app's own copy of the
# file against matou-app's own fakebin, ported from ourcloud's version.
# run-swarm.sh here does not yet call rearm_dispatch (matou-app's run-swarm.sh
# has no worker_ran-equivalent gate to hang self-rearm off safely — #250
# Task 8 left that for a follow-up); this test covers the primitive itself,
# which the synced claim-lib.sh already carries.
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$here/fakebin:$PATH"
export FORGEJO_TOKEN="ftok" FORGEJO_API="http://fj.test/api/v1/repos/Matou/matou-app"
FAKE_DIR="$(mktemp -d)"; export FAKE_DIR
. "$here/../claim-lib.sh"
rearm_dispatch >/dev/null 2>&1 || true
if grep -q "POST .*actions/workflows/swarm.yml/dispatches" "$FAKE_DIR/calls.log"; then
  echo "pass=1 fail=0"
else
  echo "FAIL: dispatch endpoint not called"; echo "pass=0 fail=1"; exit 1
fi
