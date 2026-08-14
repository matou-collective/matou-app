#!/usr/bin/env bash
# Scenario tests for ../list-ready-tasks.sh against the fake Forgejo API
# (fakebin/curl). No network.
#
# Usage: .sandcastle/tests/list-ready-tasks-test.sh [path-to-script]
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="${1:-$here/../list-ready-tasks.sh}"
export PATH="$here/fakebin:$PATH"
export FORGEJO_TOKEN="ftok"
export FORGEJO_API="http://fj.test/api/v1/repos/Matou/matou-app"

pass=0 fail=0

setup() {
  FAKE_DIR="$(mktemp -d)"
  export FAKE_DIR
  jq -n '[{number:11, title:"first", body:"b1", html_url:"http://x/11"},
          {number:12, title:"second", body:"b2", html_url:"http://x/12"}]' \
    >"$FAKE_DIR/issues.json"
}

check() { # check <desc> <cond>
  if eval "$2"; then pass=$((pass + 1)); else
    fail=$((fail + 1))
    echo "FAIL: $1"
  fi
}

numbers() { jq -c '[.[].number]' <<<"$1"; }

# ---- S1: no PRs, no open dependencies — every ready issue is emitted
setup
out="$(bash "$script")"
check "S1 exit 0" "[ $? -eq 0 ]"
check "S1 emits both ready issues" "[ '$(numbers "$out")' = '[11,12]' ]"

# ---- S2: an open agent PR for #11 — #11 is in review, only #12 is emitted
setup
jq -n '[{number:99, head:{ref:"agent/issue-11"}}]' >"$FAKE_DIR/pulls.json"
out="$(bash "$script")"
check "S2 drops the issue with an open agent PR" "[ '$(numbers "$out")' = '[12]' ]"

# ---- S3: an open PR on a NON-agent branch never hides an issue
setup
jq -n '[{number:99, head:{ref:"fix/issue-11-manual"}}]' >"$FAKE_DIR/pulls.json"
out="$(bash "$script")"
check "S3 non-agent PR branches are ignored" "[ '$(numbers "$out")' = '[11,12]' ]"

# ---- S4: an open dependency still blocks (pre-existing behaviour intact)
setup
jq -n '[{number:5, state:"open"}]' >"$FAKE_DIR/deps-12.json"
out="$(bash "$script")"
check "S4 open dependency still blocks" "[ '$(numbers "$out")' = '[11]' ]"

# ---- S5: agent PR for an issue outside the ready set changes nothing
setup
jq -n '[{number:99, head:{ref:"agent/issue-777"}}]' >"$FAKE_DIR/pulls.json"
out="$(bash "$script")"
check "S5 unrelated agent PR changes nothing" "[ '$(numbers "$out")' = '[11,12]' ]"

# ---- S6: a ticket already claimed by another host (agent-working, #250
# multi-host pool sync) is hidden from the queue even though it is otherwise
# ready-for-agent and unblocked
setup
jq -n '[{number:11, title:"first", body:"b1", html_url:"http://x/11",
         labels:[{name:"agent-working"}]},
        {number:12, title:"second", body:"b2", html_url:"http://x/12"}]' \
  >"$FAKE_DIR/issues.json"
out="$(bash "$script")"
check "S6 agent-working tickets are hidden from the queue" "[ '$(numbers "$out")' = '[12]' ]"

echo "list-ready-tasks: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
