#!/usr/bin/env bash
# rearm_dispatch posts a workflow_dispatch for swarm.yml.
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$here/fakebin:$PATH"
export FORGEJO_TOKEN="ftok" FORGEJO_API="http://fj.test/api/v1/repos/Matou/ourcloud"
FAKE_DIR="$(mktemp -d)"; export FAKE_DIR
. "$here/../claim-lib.sh"
rearm_dispatch >/dev/null 2>&1 || true
if ! grep -q "POST .*actions/workflows/swarm.yml/dispatches" "$FAKE_DIR/calls.log"; then
  echo "FAIL: dispatch endpoint not called"; echo "pass=0 fail=1"; exit 1
fi
# #470 M-5: the endpoint alone isn't the contract — Forgejo 422s a dispatch
# without {"ref": ...}; pin the body on the wire.
if ! grep -q '"ref": *"main"' "$FAKE_DIR/forgejo.log"; then
  echo "FAIL: dispatch body missing {ref: main}"; echo "pass=1 fail=1"; exit 1
fi
echo "pass=2 fail=0"
