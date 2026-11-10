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
repo="$(mktemp -d)"
# Registries + tracker stubs live OUTSIDE the repo working tree: gate 2 is now
# bidirectional (#206), so anything `git add -A` sweeps into a test commit would
# become an "unlisted touched file" violation in every envelope over it.
aux="$(mktemp -d)"
trap 'rm -rf "$repo" "$aux"' EXIT
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

# ─── gate 6 (binds) + gate 7 (mirrors), #1940 ─────────────────────────────────
# A third commit adds a real non-test implementation file and a trigger file, so
# gate 6's `defined_in` and gate 7's mirror checks run over genuine diffs.
# Gate 2 is bidirectional (#206): changed_files must EQUAL the union diff, so
# each test commit touches EXACTLY the files its envelope claims. impl.go and
# internal/idp/appdoor.go therefore land in SEPARATE commits (c3 / c3b) — a
# single commit touching both would make every envelope that claims only one an
# under-claim violation.
printf 'impl\n' > "$repo/impl.go"
git -C "$repo" add -A; git -C "$repo" commit -qm c3-impl
c3="$(git -C "$repo" rev-parse HEAD)"
mkdir -p "$repo/internal/idp"
printf 'appdoor\n' > "$repo/internal/idp/appdoor.go"
git -C "$repo" add -A; git -C "$repo" commit -qm c3b-appdoor
c3b="$(git -C "$repo" rev-parse HEAD)"

# A stub tracker for gate-6 owed_by: 5001 open, 5002 closed, anything else missing.
state_stub="$aux/issue-state.sh"
cat > "$state_stub" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  5001) echo open ;;
  5002) echo closed ;;
  *)    echo missing ;;
esac
STUB
chmod +x "$state_stub"
export CR_ISSUE_STATE_CMD="$state_stub"

# A controlled registry so gate-7 mechanics do not depend on the shipped file.
reg="$aux/mirrors.tsv"
printf '# comment\ninternal/idp/appdoor.go\tinternal/idp/testdata/app-door-golden.json\npackage.json\tpnpm-lock.yaml\n' > "$reg"

# T13 — gate 6: a declared symbol with defined_in NOT in the diff and no owed_by
# is refused, naming the symbol (#1934's exact envelope).
refutes "unbound symbol, no owed_by" "mintSealingKey" "$(jq -n --arg c3 "$c3" '{
  issue:444, status:"success", commits:[$c3], changed_files:["impl.go"],
  binds:[{symbol:"mintSealingKey", defined_in:"app/src/keriweb/sealing.ts"}],
  summary:"s"
}')"

# T14 — gate 6: a symbol whose defined_in IS a non-test path in the diff passes.
clean "symbol defined in the diff" "$(jq -n --arg c3 "$c3" '{
  issue:444, status:"success", commits:[$c3], changed_files:["impl.go"],
  binds:[{symbol:"doThing", defined_in:"impl.go"}], summary:"s"
}')"

# T15 — gate 6: owed_by an OPEN issue passes (the legitimate interface-first slice).
clean "symbol owed by an open issue" "$(jq -n --arg c3 "$c3" '{
  issue:444, status:"success", commits:[$c3], changed_files:["impl.go"],
  binds:[{symbol:"unlockFromSealedBox", owed_by:5001}], summary:"s"
}')"

# T16 — gate 6: owed_by a CLOSED issue is refused.
refutes "owed by a closed issue" "CLOSED" "$(jq -n --arg c3 "$c3" '{
  issue:444, status:"success", commits:[$c3], changed_files:["impl.go"],
  binds:[{symbol:"unlockFromSealedBox", owed_by:5002}], summary:"s"
}')"

# T16b — gate 6: owed_by a non-existent issue is refused (fails closed).
refutes "owed by a missing issue" "does not exist" "$(jq -n --arg c3 "$c3" '{
  issue:444, status:"success", commits:[$c3], changed_files:["impl.go"],
  binds:[{symbol:"ghost", owed_by:9999}], summary:"s"
}')"

# T17 — gate 6: defined_in a TEST path is refused (a symbol proven only by its test).
refutes "symbol defined only in a test path" "TEST path" "$(jq -n --arg c3 "$c3" '{
  issue:444, status:"success", commits:[$c3], changed_files:["impl.go"],
  binds:[{symbol:"onlyTested", defined_in:"internal/idp/appdoor_test.go"}], summary:"s"
}')"

# T18 — gate 6: a non-list binds fails closed.
refutes "binds not a list" "binds must be an array" "$(jq -n --arg c3 "$c3" '{
  issue:444, status:"success", commits:[$c3], changed_files:["impl.go"],
  binds:"mintSealingKey", summary:"s"
}')"

# T18b — gate 6: a non-object binds entry fails closed.
refutes "binds entry not an object" "not an object" "$(jq -n --arg c3 "$c3" '{
  issue:444, status:"success", commits:[$c3], changed_files:["impl.go"],
  binds:["mintSealingKey"], summary:"s"
}')"

# T19 — gate 7: touching a registry trigger without its mirror is refused, naming both.
CR_MIRRORS_FILE="$reg" refutes "trigger without mirror" "app-door-golden.json" "$(jq -n --arg c3b "$c3b" '{
  issue:444, status:"success", commits:[$c3b], changed_files:["internal/idp/appdoor.go"],
  binds:[{symbol:"appDoor", defined_in:"internal/idp/appdoor.go"}], summary:"s"
}')"

# T20 — gate 7: the same envelope plus a non-empty mirror_waiver passes.
CR_MIRRORS_FILE="$reg" clean "trigger without mirror, but waived" "$(jq -n --arg c3b "$c3b" '{
  issue:444, status:"success", commits:[$c3b], changed_files:["internal/idp/appdoor.go"],
  binds:[{symbol:"appDoor", defined_in:"internal/idp/appdoor.go"}],
  mirror_waiver:"golden regenerated out-of-band in matou-app#999", summary:"s"
}')"

# T21 — gate 7: a malformed registry line fails closed as a violation.
badreg="$aux/mirrors-bad.tsv"
printf 'internal/idp/appdoor.go has spaces not a tab\n' > "$badreg"
CR_MIRRORS_FILE="$badreg" refutes "malformed registry line" "malformed" "$(jq -n --arg c3 "$c3" '{
  issue:444, status:"success", commits:[$c3], changed_files:["impl.go"], summary:"s"
}')"

# T22 — additive/default-open: an envelope with no binds and no trigger touched is
# unchanged — an existing passing envelope still passes even with the registry present.
CR_MIRRORS_FILE="$reg" clean "no binds, no trigger — unchanged" "$(jq -n --arg c1 "$c1" --arg c2 "$c2" '{
  issue:444, status:"success", commits:[$c1,$c2],
  changed_files:["src.go","new.ts"],
  tests:[{command:"bash tests/x.sh",exit_code:0}],
  criteria:{"AC1":"src.go"}, summary:"did the thing", blockers:[]
}')"

# T23 — the regressions this ticket exists for. Both replayed as fixtures over a
# registry seeded with the pairs idss ships (this test is vendored to every
# consumer, so it seeds its own registry rather than reading a repo-local file),
# and both refused.
# #1934: two verbs declared on the interface, the state machine built on them,
# nothing implementing them, no owed_by (signingSession.ts is not in the diff —
# as on main, nothing defined the verbs — so gate 6 refuses).
CR_MIRRORS_FILE="$reg" refutes "#1934 replayed" "mintSealingKey" "$(jq -n --arg c3 "$c3" '{
  issue:1934, status:"success", commits:[$c3], changed_files:["impl.go"],
  binds:[
    {symbol:"mintSealingKey",      defined_in:"app/src/keriweb/signingSession.ts"},
    {symbol:"unlockFromSealedBox", defined_in:"app/src/keriweb/signingSession.ts"}
  ],
  criteria:{"panel unlock":"proven by dashboard unit test over the injected bundle loader"},
  summary:"panel state machine + sealed-passcode unlock"
}')"

# #1933: the sealed-passcode relay moved appdoor.go but never the golden the
# registry pairs with it; no mirror_waiver.
CR_MIRRORS_FILE="$reg" refutes "#1933 replayed" "app-door-golden.json" "$(jq -n --arg c3b "$c3b" '{
  issue:1933, status:"success", commits:[$c3b], changed_files:["internal/idp/appdoor.go"],
  binds:[{symbol:"relaySealedPasscode", defined_in:"internal/idp/appdoor.go"}],
  summary:"sealed-passcode relay"
}')"

# ─── gate 8 (required-suites), #1943 ──────────────────────────────────────────
# Gate 4 refutes only a LISTED failing test; an agent that OMITS the changed
# area's suite from tests[] passes gate 4 clean (#1934/#1933's evidence-choosing
# root, a different hole from gates 6/7). A repo-local area-glob<TAB>suite-token
# registry (seeded here so this vendored test does not depend on a repo-local
# file, exactly as gate 7's registry is) refuses a status:success whose changed
# area's suite is absent from tests[]. The suite token carries '|'-alternatives:
# either the targeted `go test ./internal/idp/…` or a whole-module `go test ./...`
# satisfies it.
sreg="$aux/required-suites.tsv"
printf '# comment\ninternal/idp/*.go\tgo test ./internal/idp/|go test ./...\n' > "$sreg"

# T24 — gate 8: a success touching internal/idp with NO idp suite in tests[] is
# refused, naming the area (gate 4 had nothing to refute — the suite was omitted).
CR_REQUIRED_SUITES_FILE="$sreg" refutes "area touched, required suite omitted" "internal/idp" "$(jq -n --arg c3b "$c3b" '{
  issue:444, status:"success", commits:[$c3b], changed_files:["internal/idp/appdoor.go"],
  tests:[{command:"go test ./broker/...",exit_code:0}], summary:"s"
}')"

# T25 — gate 8: the same close listing the targeted suite passes.
CR_REQUIRED_SUITES_FILE="$sreg" clean "area touched, targeted suite present" "$(jq -n --arg c3b "$c3b" '{
  issue:444, status:"success", commits:[$c3b], changed_files:["internal/idp/appdoor.go"],
  tests:[{command:"go test ./internal/idp/...",exit_code:0}], summary:"s"
}')"

# T26 — gate 8: a whole-module `go test ./...` run (the '|'-alt) also satisfies it.
CR_REQUIRED_SUITES_FILE="$sreg" clean "area touched, whole-module suite satisfies the alt" "$(jq -n --arg c3b "$c3b" '{
  issue:444, status:"success", commits:[$c3b], changed_files:["internal/idp/appdoor.go"],
  tests:[{command:"go test ./...",exit_code:0}], summary:"s"
}')"

# T27 — gate 8 is success-only: a blocked close touching the area (suite not run)
# passes the required-suites gate — it is not claiming green.
CR_REQUIRED_SUITES_FILE="$sreg" clean "blocked close touching the area is exempt" "$(jq -n --arg c3b "$c3b" '{
  issue:444, status:"blocked", commits:[$c3b], changed_files:["internal/idp/appdoor.go"],
  reason:"idp suite needs a toolchain this box lacks", summary:"s"
}')"

# T28 — gate 8: a malformed registry line fails closed as a violation (every close).
sbad="$aux/required-suites-bad.tsv"
printf 'internal/idp/appdoor.go has spaces not a tab\n' > "$sbad"
CR_REQUIRED_SUITES_FILE="$sbad" refutes "malformed required-suites line" "malformed" "$(jq -n --arg c3 "$c3" '{
  issue:444, status:"success", commits:[$c3], changed_files:["impl.go"],
  tests:[{command:"go test ./...",exit_code:0}], summary:"s"
}')"

# T29 — gate 8 default-open: an area NOT in the registry (impl.go) is unchanged —
# a success with no matching area passes even with the registry present.
CR_REQUIRED_SUITES_FILE="$sreg" clean "no area match — unchanged (default-open)" "$(jq -n --arg c3 "$c3" '{
  issue:444, status:"success", commits:[$c3], changed_files:["impl.go"],
  tests:[{command:"go test ./...",exit_code:0}], summary:"s"
}')"

# --- gate 9: cross-repo mirrors (#1963) ------------------------------------
# A trigger whose mirror lives in ANOTHER repo cannot ship in this close, so the
# gate demands the close NAME an open foreign issue that owes the copy. The
# foreign tracker comes through the cr_foreign_issue_state seam, stubbed here.
xreg="$aux/cross-repo-mirrors.tsv"
printf 'internal/idp/testdata/app-door-golden.json\tMatou/matou-app\tfrontend/tests/fixtures/app-door-golden.json\n' > "$xreg"

xstate="$aux/foreign-state.sh"
cat > "$xstate" <<'STUB'
#!/usr/bin/env bash
# <owner/repo> <number>: 678 is open in matou-app, 664 is closed, anything else missing.
case "$1#$2" in
  "Matou/matou-app#678") echo open ;;
  "Matou/matou-app#664") echo closed ;;
  *) echo missing ;;
esac
STUB
chmod +x "$xstate"

# a commit that touches the golden, so changed_files can claim it honestly
# (exactly one file — gate 2 is bidirectional, #206).
mkdir -p "$repo/internal/idp/testdata"
printf '{"note":"golden"}\n' > "$repo/internal/idp/testdata/app-door-golden.json"
git -C "$repo" add -A; git -C "$repo" commit -qm c4-golden
c4="$(git -C "$repo" rev-parse HEAD)"

# a commit whose SUBJECT cites #444, for the gate-1 subject-citation tests (#206)
printf 'cite\n' > "$repo/cite.txt"
git -C "$repo" add -A; git -C "$repo" commit -qm "sandcastle: #444 do the thing"
c_cite="$(git -C "$repo" rev-parse HEAD)"

xenv() { # xenv <extra-json> — an envelope touching the golden, merged with extra
  jq -n --arg c4 "$c4" --argjson extra "$1" '{
    issue:444, status:"success", commits:[$c4],
    changed_files:["internal/idp/testdata/app-door-golden.json"],
    tests:[{command:"go test ./...",exit_code:0}], summary:"s"
  } + $extra'
}

# T30 — the #1959 envelope replayed: the golden moved, nobody was told to copy it.
CR_CROSS_REPO_MIRRORS_FILE="$xreg" CR_FOREIGN_ISSUE_STATE_CMD="$xstate" \
  refutes "cross-repo mirror unnamed (the #1959 regression)" "cannot change in this close" "$(xenv '{}')"

# T31 — naming an OPEN foreign issue that owes the copy passes.
CR_CROSS_REPO_MIRRORS_FILE="$xreg" CR_FOREIGN_ISSUE_STATE_CMD="$xstate" \
  clean "cross-repo mirror owed by an open foreign issue" \
  "$(xenv '{"cross_repo":[{"trigger":"internal/idp/testdata/app-door-golden.json","issue":"Matou/matou-app#678"}]}')"

# T32 — a CLOSED foreign issue owes nothing; refused (gate 6's discipline).
CR_CROSS_REPO_MIRRORS_FILE="$xreg" CR_FOREIGN_ISSUE_STATE_CMD="$xstate" \
  refutes "cross-repo mirror owed by a closed issue" "CLOSED" \
  "$(xenv '{"cross_repo":[{"trigger":"internal/idp/testdata/app-door-golden.json","issue":"Matou/matou-app#664"}]}')"

# T33 — an issue that cannot be verified open fails closed.
CR_CROSS_REPO_MIRRORS_FILE="$xreg" CR_FOREIGN_ISSUE_STATE_CMD="$xstate" \
  refutes "cross-repo mirror owed by an unverifiable issue" "cannot be verified open" \
  "$(xenv '{"cross_repo":[{"trigger":"internal/idp/testdata/app-door-golden.json","issue":"Matou/matou-app#99999"}]}')"

# T34 — an issue in the WRONG repo does not owe the copy of a file it does not hold.
CR_CROSS_REPO_MIRRORS_FILE="$xreg" CR_FOREIGN_ISSUE_STATE_CMD="$xstate" \
  refutes "cross-repo mirror named in the wrong repo" "must be in the repo that holds it" \
  "$(xenv '{"cross_repo":[{"trigger":"internal/idp/testdata/app-door-golden.json","issue":"Matou/idss#1959"}]}')"

# T35 — a malformed issue reference (a bare number) fails closed.
CR_CROSS_REPO_MIRRORS_FILE="$xreg" CR_FOREIGN_ISSUE_STATE_CMD="$xstate" \
  refutes "cross-repo mirror with a bare issue number" "owner/repo#N" \
  "$(xenv '{"cross_repo":[{"trigger":"internal/idp/testdata/app-door-golden.json","issue":"678"}]}')"

# T36 — an explicit waiver overrides it (surfaced in the posted comment).
CR_CROSS_REPO_MIRRORS_FILE="$xreg" CR_FOREIGN_ISSUE_STATE_CMD="$xstate" \
  clean "cross-repo mirror waived explicitly" \
  "$(xenv '{"cross_repo_waiver":"comment-only change; the wire is untouched"}')"

# T37 — a non-list cross_repo fails closed.
CR_CROSS_REPO_MIRRORS_FILE="$xreg" CR_FOREIGN_ISSUE_STATE_CMD="$xstate" \
  refutes "non-list cross_repo" "must be an array" "$(xenv '{"cross_repo":"Matou/matou-app#678"}')"

# T38 — a non-object cross_repo entry fails closed.
CR_CROSS_REPO_MIRRORS_FILE="$xreg" CR_FOREIGN_ISSUE_STATE_CMD="$xstate" \
  refutes "non-object cross_repo entry" "not an object" "$(xenv '{"cross_repo":["Matou/matou-app#678"]}')"

# T39 — a malformed registry line fails closed (every close, like gates 7/8).
xbad="$aux/cross-repo-mirrors-bad.tsv"
printf 'internal/idp/testdata/app-door-golden.json\tMatou/matou-app\n' > "$xbad"
CR_CROSS_REPO_MIRRORS_FILE="$xbad" CR_FOREIGN_ISSUE_STATE_CMD="$xstate" \
  refutes "malformed cross-repo-mirrors line" "malformed" "$(xenv '{}')"

# T40 — default-open: a close touching no trigger is unchanged by the registry.
CR_CROSS_REPO_MIRRORS_FILE="$xreg" CR_FOREIGN_ISSUE_STATE_CMD="$xstate" \
  clean "no cross-repo trigger match — unchanged (default-open)" "$(jq -n --arg c2 "$c2" '{
  issue:444, status:"success", commits:[$c2], changed_files:["src.go","new.ts"],
  tests:[{command:"go test ./...",exit_code:0}], summary:"s"
}')"

# T41 — the seam fails closed with NO stub and no tracker: `missing`, not a pass.
CR_CROSS_REPO_MIRRORS_FILE="$xreg" \
  refutes "no foreign tracker reachable — fails closed" "cannot be verified open" \
  "$(xenv '{"cross_repo":[{"trigger":"internal/idp/testdata/app-door-golden.json","issue":"Matou/matou-app#678"}]}')"

# ─── gate 1 tightening (#206): start-sha membership + #<issue> in the subject ──
# All of this half is gated on CR_START_SHA (run-swarm drops the run's start sha
# in the host-signals dir; close-report.sh exports it). With it UNSET gate 1 is
# byte-identical to before — reachability only, no subject demand.

# T42 — a pre-existing/foreign SHA (reachable from main but an ancestor of the
# run's start) is refused: it is not work this run authored.
CR_START_SHA="$c2" refutes "pre-existing SHA (predates the run start)" "predates the run start" "$(jq -n --arg c1 "$c1" '{
  issue:444, status:"success", commits:[$c1], changed_files:["src.go"], summary:"s"
}')"

# T43 — a commit new since start but whose subject does NOT cite #<issue> is refused.
CR_START_SHA="$c2" refutes "commit subject omits #issue" "does not cite #444" "$(jq -n --arg c3 "$c3" '{
  issue:444, status:"success", commits:[$c3], changed_files:["impl.go"], summary:"s"
}')"

# T44 — a commit new since start AND citing #<issue> in its subject passes.
CR_START_SHA="$c4" clean "new commit citing #issue passes gate-1 membership + subject" "$(jq -n --arg c "$c_cite" '{
  issue:444, status:"success", commits:[$c], changed_files:["cite.txt"], summary:"s"
}')"

# T45 — additive: with NO CR_START_SHA, a commit whose subject omits #<issue>
# still passes (today's reachability-only gate 1 — the half an old pin keeps).
clean "no CR_START_SHA — subject not demanded (additive)" "$(jq -n --arg c3 "$c3" '{
  issue:444, status:"success", commits:[$c3], changed_files:["impl.go"], summary:"s"
}')"

# ─── gate 4b (#206): a host re-run of the pinned test command ─────────────────
# close-report.sh re-runs TEST_CMD host-side and passes its exit code in
# CR_TEST_HOST_EC; a status:success the host could not reproduce is refused.

# T46 — a self-reported pass (tests[].exit_code 0) whose host re-run FAILED is refused.
CR_TEST_HOST_EC=1 refutes "self-reported pass, host re-run failed" "host re-run of the pinned test command exited 1" "$(jq -n --arg c3 "$c3" '{
  issue:444, status:"success", commits:[$c3], changed_files:["impl.go"],
  tests:[{command:"the offline loop",exit_code:0}], summary:"s"
}')"

# T47 — the same self-report whose host re-run PASSED (ec 0) is clean.
CR_TEST_HOST_EC=0 clean "self-reported pass, host re-run agreed" "$(jq -n --arg c3 "$c3" '{
  issue:444, status:"success", commits:[$c3], changed_files:["impl.go"],
  tests:[{command:"the offline loop",exit_code:0}], summary:"s"
}')"

# T48 — a non-integer host re-run result fails closed.
CR_TEST_HOST_EC=boom refutes "non-integer host re-run result" "is not an integer" "$(jq -n --arg c3 "$c3" '{
  issue:444, status:"success", commits:[$c3], changed_files:["impl.go"], summary:"s"
}')"

# T49 — additive: with no CR_TEST_HOST_EC the self-report is trusted as before.
clean "no CR_TEST_HOST_EC — self-report trusted (additive)" "$(jq -n --arg c3 "$c3" '{
  issue:444, status:"success", commits:[$c3], changed_files:["impl.go"],
  tests:[{command:"the offline loop",exit_code:0}], summary:"s"
}')"

# ─── gate 5b (#206): every acceptance clause has a criteria entry ─────────────
# close-report.sh exports the issue body as CR_ISSUE_BODY; the envelope's
# `criteria` must carry at least one entry per acceptance clause (presence).
acc_body="$(printf '%s\n' '## Summary' 'words' '' '## Acceptance' '- a foreign SHA is refused' '- an unlisted file is refused')"

# T50 — a success whose envelope carries NO criteria, over a body with two
# acceptance clauses, is refused.
CR_ISSUE_BODY="$acc_body" refutes "missing criteria over an acceptance body" "acceptance clause" "$(jq -n --arg c3 "$c3" '{
  issue:444, status:"success", commits:[$c3], changed_files:["impl.go"], summary:"s"
}')"

# T51 — FEWER criteria entries than acceptance clauses is refused.
CR_ISSUE_BODY="$acc_body" refutes "fewer criteria than clauses" "acceptance clause" "$(jq -n --arg c3 "$c3" '{
  issue:444, status:"success", commits:[$c3], changed_files:["impl.go"],
  criteria:{"a foreign SHA is refused":"T42"}, summary:"s"
}')"

# T52 — a criteria entry per clause passes (presence, not truth).
CR_ISSUE_BODY="$acc_body" clean "a criteria entry per clause passes" "$(jq -n --arg c3 "$c3" '{
  issue:444, status:"success", commits:[$c3], changed_files:["impl.go"],
  criteria:{"a foreign SHA is refused":"T42","an unlisted file is refused":"T4"}, summary:"s"
}')"

# T53 — a body with no acceptance section demands nothing (no-op).
CR_ISSUE_BODY="$(printf '%s\n' '## Summary' '- not an acceptance clause')" \
  clean "no acceptance section — criteria not demanded" "$(jq -n --arg c3 "$c3" '{
  issue:444, status:"success", commits:[$c3], changed_files:["impl.go"], summary:"s"
}')"

# T54 — additive: with no CR_ISSUE_BODY, criteria is not demanded at all.
clean "no CR_ISSUE_BODY — criteria not demanded (additive)" "$(jq -n --arg c3 "$c3" '{
  issue:444, status:"success", commits:[$c3], changed_files:["impl.go"], summary:"s"
}')"
# ==========================================================================
# The independent reviewer gate's PARSE + verdict normalisation (#197). The
# claude CALL lives in close-report.sh (tested end-to-end in close-report-test.sh
# over a shimmed `claude`); here we drive cr_review_parse over canned
# `claude --output-format json` result files, proving each verdict normalises and
# that anything unparseable fails CLOSED (`malformed`).
# ==========================================================================
rf="$repo/review-result.json"
verdict_of() { jq -r '.verdict' <<<"$(cr_review_parse "$rf")"; }

# RV1 — an `approve` result (the agent's verdict object sits in .result) normalises.
jq -n '{type:"result", result:"{\"verdict\":\"approve\",\"findings\":[]}", usage:{input_tokens:1}}' > "$rf"
[ "$(verdict_of)" = approve ] || fail "RV1: an approve result must normalise to verdict=approve"; ok

# RV2 — a `reject` result carries its findings through verbatim as finding lines.
jq -n '{type:"result", result:"{\"verdict\":\"reject\",\"findings\":[{\"file\":\"src.go\",\"line\":12,\"severity\":\"high\",\"why\":\"nil deref on empty input\"}]}"}' > "$rf"
rj="$(cr_review_parse "$rf")"
[ "$(jq -r '.verdict' <<<"$rj")" = reject ] || fail "RV2: reject must normalise to verdict=reject"; ok
lines="$(cr_review_finding_lines "$rj")"
grep -q "src.go:12" <<<"$lines"            || fail "RV2: finding lines must carry the file:line"; ok
grep -q "\[high\]" <<<"$lines"             || fail "RV2: finding lines must carry the severity"; ok
grep -q "nil deref on empty input" <<<"$lines" || fail "RV2: finding lines must carry the why verbatim"; ok

# RV3 — an `unsure` result normalises (close-report.sh parks it).
jq -n '{type:"result", result:"{\"verdict\":\"unsure\",\"findings\":[{\"file\":\"x\",\"line\":1,\"severity\":\"low\",\"why\":\"out of my depth\"}]}"}' > "$rf"
[ "$(verdict_of)" = unsure ] || fail "RV3: an unsure result must normalise to verdict=unsure"; ok

# RV4 — the verdict object may be wrapped in a ```json fence (common model output).
printf '%s' '{"type":"result","result":"```json\n{\"verdict\":\"approve\",\"findings\":[]}\n```"}' > "$rf"
[ "$(verdict_of)" = approve ] || fail "RV4: a fenced verdict object must still parse"; ok

# RV5 — prose with no JSON object fails CLOSED (malformed).
jq -n '{type:"result", result:"I think this looks fine to me, approve."}' > "$rf"
[ "$(verdict_of)" = malformed ] || fail "RV5: unparseable prose must fail closed (malformed)"; ok

# RV6 — an out-of-vocabulary verdict fails CLOSED.
jq -n '{type:"result", result:"{\"verdict\":\"lgtm\",\"findings\":[]}"}' > "$rf"
[ "$(verdict_of)" = malformed ] || fail "RV6: an unknown verdict must fail closed (malformed)"; ok

# RV7 — an empty result file fails CLOSED.
: > "$rf"
[ "$(verdict_of)" = malformed ] || fail "RV7: an empty result must fail closed (malformed)"; ok

# RV8 — a missing result file fails CLOSED.
[ "$(jq -r '.verdict' <<<"$(cr_review_parse "$repo/does-not-exist.json")")" = malformed ] \
  || fail "RV8: a missing result file must fail closed (malformed)"; ok

# RV9 — a bare verdict object (no .result wrapper, e.g. a stub) still parses.
jq -n '{verdict:"approve", findings:[]}' > "$rf"
[ "$(verdict_of)" = approve ] || fail "RV9: a bare verdict object (no .result) must parse"; ok

# RV10 — an AUTH error (a claude -p child that is not logged in) normalises to
# `unauthenticated`, NOT `malformed`: the gate SKIPS it like an absent reviewer
# rather than failing CLOSED (#228). terminal_reason=api_error + a /login result.
jq -n '{type:"result", terminal_reason:"api_error", result:"Not logged in · Please run /login"}' > "$rf"
[ "$(verdict_of)" = unauthenticated ] || fail "RV10: an api_error /login result must normalise to verdict=unauthenticated (skip, #228)"; ok

# RV10b — the is_error flag is accepted as the error signal too (claude's actual
# --output-format json error shape), paired with the /login result text.
jq -n '{type:"result", subtype:"error_during_execution", is_error:true, result:"Invalid API key · Please run /login"}' > "$rf"
[ "$(verdict_of)" = unauthenticated ] || fail "RV10b: an is_error /login result must normalise to verdict=unauthenticated (#228)"; ok

# RV11 — a genuine review that merely MENTIONS "/login" in its prose must NOT be
# mistaken for an auth error: with no error signal it still fails CLOSED
# (malformed), preserving the fail-closed posture for real garbage (#228).
jq -n '{type:"result", result:"The handler should reject requests before /login — looks risky."}' > "$rf"
[ "$(verdict_of)" = malformed ] || fail "RV11: prose mentioning /login with no error signal must stay malformed (fail closed)"; ok

# RV11b — an error result WITHOUT a /login prompt (a transient api error, not an
# auth failure) stays malformed too — only an authentication failure skips.
jq -n '{type:"result", terminal_reason:"api_error", result:"upstream timeout, try again"}' > "$rf"
[ "$(verdict_of)" = malformed ] || fail "RV11b: an api_error without a /login prompt must stay malformed (fail closed)"; ok

echo "close-report-lib: $pass checks passed"
