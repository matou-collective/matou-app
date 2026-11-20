#!/usr/bin/env bash
# .forgejo/ci-superseded.sh (#370): a queued ci run that a newer push run has
# overtaken skips its work; the newest run, a non-push run, and any run whose
# check cannot tell all run their tests (fail open).
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/../.forgejo/ci-superseded.sh"
# `.forgejo/**` is vendor-excluded: a consumer's vendored copy of this test has
# no such script next to it, and that is not a failure.
[ -f "$script" ] || { echo "ci-superseded-test: no .forgejo/ci-superseded.sh here (a vendored copy) — skipped"; exit 0; }

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
cat >"$tmp/bin/curl" <<'SHIM'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE_DIR/argv.log"
[ -f "$FAKE_DIR/fail" ] && exit 22
cat "$FAKE_DIR/runs.json"
SHIM
chmod +x "$tmp/bin/curl"
export PATH="$tmp/bin:$PATH" FAKE_DIR="$tmp"
export CI_API="http://fj.test/api/v1/repos/O/R" CI_TOKEN=tok CI_REF_NAME=main CI_EVENT=push CI_RUN_NUMBER=100
unset GITHUB_OUTPUT CI_WORKFLOW

pass=0 fail=0
eq() { if [ "$1" = "$2" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: $3 (want '$1', got '$2')"; fi; }
runs() { jq -n --argjson r "$1" '{workflow_runs:$r}' >"$tmp/runs.json"; : >"$tmp/argv.log"; rm -f "$tmp/fail"; }
run() { bash "$script" 2>/dev/null; }

runs '[{"index_in_repo":100,"workflow_id":"ci.yml","event":"push","prettyref":"main","status":"running"},
       {"index_in_repo":99,"workflow_id":"ci.yml","event":"push","prettyref":"main","status":"success"}]'
eq false "$(run)" "the newest push run on the branch runs its tests"

runs '[{"index_in_repo":103,"workflow_id":"ci.yml","event":"push","prettyref":"main","status":"waiting"},
       {"index_in_repo":100,"workflow_id":"ci.yml","event":"push","prettyref":"main","status":"running"}]'
eq true "$(run)" "a newer queued push run on the same branch supersedes this one"
eq 1 "$(grep -c 'actions/runs?limit=30&page=1' "$tmp/argv.log")" "one bounded runs read"
eq 1 "$(grep -c -- '--max-time' "$tmp/argv.log")" "the runs read is curl-timed"

runs '[{"index_in_repo":104,"workflow_id":"swarm.yml","event":"push","prettyref":"main","status":"waiting"},
       {"index_in_repo":103,"workflow_id":"ci.yml","event":"push","prettyref":"feature","status":"waiting"},
       {"index_in_repo":102,"workflow_id":"ci.yml","event":"pull_request","prettyref":"main","status":"waiting"},
       {"index_in_repo":101,"workflow_id":"ci.yml","event":"workflow_dispatch","prettyref":"main","status":"waiting"}]'
eq false "$(run)" "another workflow, another branch, a PR run and a manual run do not supersede"

runs '[{"index_in_repo":103,"workflow_id":"ci.yml","event":"push","prettyref":"main","status":"waiting"}]'
eq false "$(CI_EVENT=pull_request run)" "a pull_request run is never superseded"
eq false "$(CI_EVENT=workflow_dispatch run)" "a manual run is never superseded"
eq 0 "$(wc -l <"$tmp/argv.log")" "a non-push run makes no tracker read"
eq false "$(CI_RUN_NUMBER='' run)" "no run number -> run the tests"

touch "$tmp/fail"
eq false "$(run)" "a failed runs read fails OPEN (run the tests)"
rm -f "$tmp/fail"; printf 'not json' >"$tmp/runs.json"
eq false "$(run)" "an unparseable answer fails OPEN"

runs '[{"index_in_repo":103,"workflow_id":"ci.yml","event":"push","prettyref":"main","status":"waiting"}]'
out="$tmp/gh-output"; : >"$out"
GITHUB_OUTPUT="$out" bash "$script" >/dev/null 2>&1
eq "superseded=true" "$(cat "$out")" "the verdict is written to GITHUB_OUTPUT for the job's later steps"

# The workflow wires the check into BOTH jobs and gates their work on it.
wf="$here/../.forgejo/workflows/ci.yml"
eq 2 "$(grep -c 'bash .forgejo/ci-superseded.sh' "$wf")" "both ci jobs ask whether they are superseded"
eq 0 "$(grep -c '^    runs-on: matou-workstation' "$wf")" "ci is not pinned to the small pool host (#370)"

echo "ci-superseded-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
