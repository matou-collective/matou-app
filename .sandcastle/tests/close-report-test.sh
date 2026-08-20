#!/usr/bin/env bash
# Scenario test for ../close-report.sh against the fake Forgejo (fakebin/curl).
# No network. Proves the wrapper's disposition:
#   - the envelope lands on the issue as a comment in EVERY outcome (#444 AC), and
#   - the issue is PATCHed closed ONLY when the claim gates pass.
# The claim gates themselves are exercised offline in close-report-lib-test.sh;
# here we assert the network-facing behaviour ("code disposes").
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$here/fakebin:$PATH"
export FORGEJO_TOKEN="ftok"
export FORGEJO_API="http://fj.test/api/v1/repos/Matou/ourcloud"

pass=0
fail() { echo "FAIL: $1" >&2; exit 1; }
ok()   { pass=$((pass + 1)); }

# --- a throwaway repo with one real commit on main -------------------------
repo="$(mktemp -d)"; trap 'rm -rf "$repo" "$FAKE_DIR"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
git -C "$repo" init -q -b main
printf 'a\n' > "$repo/src.go"; git -C "$repo" add -A; git -C "$repo" commit -qm c1
c1="$(git -C "$repo" rev-parse HEAD)"
export CR_MAIN_HEAD=main

run_close() { # run_close <issue> <envelope-json>; sets rc + fresh FAKE_DIR
  FAKE_DIR="$(mktemp -d)"; export FAKE_DIR
  local ef="$FAKE_DIR/envelope.json"; printf '%s' "$2" > "$ef"
  ( cd "$repo" && bash "$here/../close-report.sh" "$1" "$ef" ) >"$FAKE_DIR/stdout.log" 2>&1
}

posted_comment() { grep -q '"body"' "$FAKE_DIR/forgejo.log" 2>/dev/null; }
closed_issue()   { grep -q '"state":"closed"' "$FAKE_DIR/forgejo.log" 2>/dev/null; }

# T1 — an honest envelope: gates pass → comment posted AND issue closed, rc 0.
run_close 444 "$(jq -n --arg c1 "$c1" '{
  issue:444, status:"success", commits:[$c1], changed_files:["src.go"],
  tests:[{command:"t",exit_code:0}], summary:"did it", blockers:[]
}')"; rc=$?
[ "$rc" -eq 0 ] || fail "honest close should exit 0, got $rc"; ok
posted_comment || fail "honest close must post the envelope comment"; ok
closed_issue   || fail "honest close must PATCH the issue closed"; ok
grep -q 'close-report' "$FAKE_DIR/forgejo.log" || fail "comment should carry the close-report header"; ok
# #574: the SANDCASTLE_ATTEMPT marker — main.mts's only way to learn the
# close_outcome + issue + commits out of the combined run stdout.
grep -qE '^SANDCASTLE_ATTEMPT issue=444 outcome=success commits='"$c1"'$' "$FAKE_DIR/stdout.log" \
  || fail "honest close must emit the SANDCASTLE_ATTEMPT marker with outcome=success"; ok

# T2 — a fabricated SHA: gates refuse → comment posted, issue NOT closed, rc 1.
run_close 444 "$(jq -n '{
  issue:444, status:"success", commits:["deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"],
  changed_files:["src.go"], summary:"lie"
}')"; rc=$?
[ "$rc" -eq 1 ] || fail "a refuted close should exit 1, got $rc"; ok
posted_comment || fail "a refuted close must STILL post the envelope comment (evidence trail)"; ok
! closed_issue || fail "a refuted close must NOT close the issue"; ok
grep -q 'REFUSED' "$FAKE_DIR/forgejo.log" || fail "the refusal comment must say REFUSED"; ok
# #574: close_outcome is the GATE's verdict, not the envelope's self-declared
# status — the envelope claimed "success" but the gates refused, so the
# marker must say outcome=refused, never outcome=success.
grep -qE '^SANDCASTLE_ATTEMPT issue=444 outcome=refused ' "$FAKE_DIR/stdout.log" \
  || fail "a refuted close must emit outcome=refused (never the envelope's claimed status)"; ok

# T3 — a reasonless refusal: gates refuse → posted, NOT closed, rc 1.
run_close 444 "$(jq -n '{issue:444, status:"refused", summary:"nope"}')"; rc=$?
[ "$rc" -eq 1 ] || fail "reasonless refusal should exit 1, got $rc"; ok
posted_comment || fail "reasonless refusal must post the envelope comment"; ok
! closed_issue || fail "reasonless refusal must NOT close the issue"; ok

# T4 — a malformed envelope file: nothing is posted, nothing closed, rc 2.
run_close 444 'not json {'; rc=$?
[ "$rc" -eq 2 ] || fail "malformed envelope should exit 2, got $rc"; ok
! posted_comment || fail "malformed envelope must touch NOTHING on the issue"; ok
! closed_issue   || fail "malformed envelope must not close the issue"; ok

echo "close-report: $pass checks passed"
