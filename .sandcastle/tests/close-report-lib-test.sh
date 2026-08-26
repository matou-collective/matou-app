#!/usr/bin/env bash
# Offline tests for close-report-lib.sh — the deterministic claim gates a swarm
# worker's close-report envelope must pass before its ticket may close (#444).
# No network: gates run over a throwaway git repo built here, main-head pointed
# at a local branch. Proves a false claim (fabricated SHA, claimed-passing test
# that exited non-zero, changed_file not in the diff, reasonless refusal) is
# REFUSED, and that an honest envelope passes.
# Run: bash .sandcastle/tests/close-report-lib-test.sh
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/../close-report-lib.sh"

pass=0
fail() { echo "FAIL: $1" >&2; exit 1; }
ok()   { pass=$((pass + 1)); }

# Refutes: cr_violations returns non-zero AND names the given pattern.
refutes() { # refutes <msg> <pattern> <envelope>
  local v
  if v="$(cr_violations "$3" "$repo" main 2>/dev/null)"; then
    fail "$1 — expected a refusal, got a clean pass"
  fi
  grep -qi -- "$2" <<<"$v" || fail "$1 — violation did not mention [$2]; got: $v"
  ok
}
# Clean: cr_violations returns zero with no output.
clean() { # clean <msg> <envelope>
  local v
  v="$(cr_violations "$2" "$repo" main 2>/dev/null)" ||
    fail "$1 — expected a clean pass, got violations: $v"
  [ -z "$v" ] || fail "$1 — expected no output, got: $v"
  ok
}

# --- a throwaway repo with two real commits on main ------------------------
repo="$(mktemp -d)"; trap 'rm -rf "$repo"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
git -C "$repo" init -q -b main
printf 'a\n' > "$repo/src.go"; git -C "$repo" add -A; git -C "$repo" commit -qm c1
c1="$(git -C "$repo" rev-parse HEAD)"
printf 'b\n' > "$repo/src.go"; printf 'n\n' > "$repo/new.ts"
git -C "$repo" add -A; git -C "$repo" commit -qm c2
c2="$(git -C "$repo" rev-parse HEAD)"
# a commit that is NOT on main (an unpushed side branch)
git -C "$repo" checkout -q -b side
printf 'x\n' > "$repo/side.txt"; git -C "$repo" add -A; git -C "$repo" commit -qm side
side="$(git -C "$repo" rev-parse HEAD)"
git -C "$repo" checkout -q main

env_json() { # helper: build an envelope from a template with substituted shas
  cat
}

# T1 — an honest success envelope over real, reachable commits passes.
clean "honest success" "$(jq -n --arg c1 "$c1" --arg c2 "$c2" '{
  issue:444, status:"success", commits:[$c1,$c2],
  changed_files:["src.go","new.ts"],
  tests:[{command:"bash tests/x.sh",exit_code:0}],
  criteria:{"AC1":"src.go@'"$c2"'"}, summary:"did the thing", blockers:[]
}')"

# T2 — gate 1: a fabricated SHA is refused.
refutes "fabricated SHA" "not a valid commit object" "$(jq -n --arg c1 "$c1" '{
  issue:444, status:"success", commits:[$c1,"deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"],
  changed_files:["src.go"], summary:"s"
}')"

# T3 — gate 1: a real commit that is NOT reachable from main is refused.
refutes "commit off main" "not reachable from main" "$(jq -n --arg s "$side" '{
  issue:444, status:"success", commits:[$s], changed_files:["side.txt"], summary:"s"
}')"

# T3b (#13, LANDING=pr): gate 1 is mode-agnostic — the caller chooses the head.
# The `side` commit is off main but IS the head of an agent PR branch; pointing
# the gate at that head lets the same envelope pass (this is how close-report.sh
# gates a pr-mode close against the issue's open PR head, not main).
pr_side="$(cr_violations "$(jq -n --arg s "$side" '{
  issue:444, status:"success", commits:[$s], changed_files:["side.txt"], summary:"s"
}')" "$repo" side 2>/dev/null)" \
  && { [ -z "$pr_side" ] || { echo "FAIL: pr-mode gate-1 against the PR head should pass cleanly, got: $pr_side" >&2; exit 1; }; } \
  || { echo "FAIL: a commit reachable from the given (PR) head must pass gate 1" >&2; exit 1; }
ok

# T4 — gate 2: a changed_file absent from the commits' diff is refused.
refutes "phantom changed_file" "not in the diff" "$(jq -n --arg c1 "$c1" '{
  issue:444, status:"success", commits:[$c1],
  changed_files:["src.go","docs/never-touched.md"], summary:"s"
}')"

# T5 — gate 3: success with no commits and no no_code_change is refused.
refutes "green-and-empty" "no 'no_code_change'" "$(jq -n '{
  issue:444, status:"success", commits:[], changed_files:[], summary:"s"
}')"

# T6 — gate 3: success with an explicit no_code_change reason is allowed.
clean "success, no-code-change marker" "$(jq -n '{
  issue:444, status:"success", commits:[], changed_files:[],
  no_code_change:"docs already correct; nothing to change", summary:"s"
}')"

# T7 — gate 4: success with a test that exited non-zero is refused.
refutes "claimed-passing test exited 1" "exited 1" "$(jq -n --arg c1 "$c1" '{
  issue:444, status:"success", commits:[$c1], changed_files:["src.go"],
  tests:[{command:"go test ./...",exit_code:1}], summary:"s"
}')"

# T8 — gate 4: a non-integer exit_code is refused (fails closed).
refutes "non-integer exit_code" "non-integer exit_code" "$(jq -n --arg c1 "$c1" '{
  issue:444, status:"success", commits:[$c1], changed_files:["src.go"],
  tests:[{command:"go test",exit_code:"passed"}], summary:"s"
}')"

# T9 — gate 5: success carrying a non-empty blockers[] is refused.
refutes "success with unresolved blockers" "blockers" "$(jq -n --arg c1 "$c1" '{
  issue:444, status:"success", commits:[$c1], changed_files:["src.go"],
  blockers:["migration not run"], summary:"s"
}')"

# T10 — gate 5: refused/blocked with no reason is refused.
refutes "reasonless refusal" "MUST name why" "$(jq -n '{
  issue:444, status:"refused", commits:[], changed_files:[], summary:"s"
}')"
refutes "reasonless blocked" "MUST name why" "$(jq -n '{
  issue:444, status:"blocked", commits:[], changed_files:[], summary:"s"
}')"

# T11 — gate 5: a blocked/refused close WITH a reason passes the verdict gate.
clean "blocked with a reason" "$(jq -n '{
  issue:444, status:"blocked", commits:[], changed_files:[],
  reason:"waiting on ADR 0999 decision", summary:"s"
}')"

# T12 — gate 0/structural: malformed JSON and missing status are refused.
refutes "malformed JSON" "not valid JSON" 'this is not json{'
refutes "missing status"  "status is missing" "$(jq -n '{issue:444, summary:"s"}')"
refutes "bad status value" "not one of success" "$(jq -n '{issue:444, status:"done", summary:"s"}')"

echo "close-report-lib: $pass checks passed"
