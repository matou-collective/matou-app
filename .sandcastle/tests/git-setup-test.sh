#!/usr/bin/env bash
# Offline test for git-setup.sh (#639): a git-setup failure — before
# run-swarm.sh/run-triage.sh ever start and can verdict_begin their own
# stages (#235) — must still drop a stage/exit/error verdict in the exact
# format verdict-lib.sh's other callers use, so the healer's existing
# seam_verdict_signal keys the incident signature on the real fault instead
# of collapsing onto the bare workflow-name signature. No network: every
# scenario points GIT_SETUP_REMOTE_URL at a local fixture repo.
# Run: bash .sandcastle/tests/git-setup-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail() { echo "FAIL: $1" >&2; exit 1; }
. "$here/../heal-lib.sh"   # compute_signature, seam_verdict_signal

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT

# A real origin with a "main" branch, and a checked-out workdir that already
# carries git-setup.sh + verdict-lib.sh — exactly what a previously-
# successful swarm/triage run leaves behind for the NEXT run to source.
origin="$work/origin.git"
git init -q --bare "$origin"
seed="$work/seed"
git init -q "$seed"
git -C "$seed" config user.email t@example.com
git -C "$seed" config user.name t
echo hi > "$seed/f"; git -C "$seed" add f; git -C "$seed" commit -qm seed
git -C "$seed" branch -M main
git -C "$seed" remote add origin "$origin"
git -C "$seed" push -q origin main
git -C "$origin" symbolic-ref HEAD refs/heads/main   # else HEAD stays "master" (nonexistent) and clone checks out nothing

workdir="$work/workdir"
git clone -q "$origin" "$workdir"
mkdir -p "$workdir/.sandcastle"
cp "$here/../git-setup.sh" "$workdir/.sandcastle/git-setup.sh"
cp "$here/../verdict-lib.sh" "$workdir/.sandcastle/verdict-lib.sh"

verdict="$work/verdict.txt"
run_git_setup() { # run_git_setup <remote-url> [workflow]
  ( cd "$workdir" && \
    REPO_SLUG="x/y" FORGEJO_TOKEN=dummy WORKFLOW="${2:-swarm}" \
    GIT_SETUP_VERDICT_PATH="$verdict" GIT_SETUP_REMOTE_URL="$1" \
    bash .sandcastle/git-setup.sh )
}

# --- 1) success leaves no verdict, and clears a stale one ---------------------
printf 'stage=stale from a previous incident\nexit=1\n--- error lines ---\nold\n' > "$verdict"
if ! run_git_setup "$origin" >/dev/null 2>&1; then fail "a healthy fetch must exit 0"; fi
[ -f "$verdict" ] && fail "a clean git-setup run must leave no verdict (verdict_write's contract)"

# --- 2) a nonexistent remote (repo-not-found class) ----------------------------
rm -f "$verdict"
nope="$work/nonexistent/origin.git"
if run_git_setup "$nope" >/dev/null 2>&1; then fail "a nonexistent remote must fail"; fi
[ -f "$verdict" ] || fail "a git-setup failure must write a verdict"
grep -q "^stage=git-setup" "$verdict" || fail "verdict must name the git-setup stage, got: $(cat "$verdict")"
grep -q "^exit=[1-9]" "$verdict" || fail "verdict must carry a non-zero exit code, got: $(cat "$verdict")"
sig_missing="$(compute_signature swarm "$(seam_verdict_signal "$verdict")")"

# --- 3) a different fault class (branch-not-found) yields DIFFERENT content ---
nobranch="$work/nobranch.git"
git init -q --bare "$nobranch"
git -C "$seed" push -q "$nobranch" HEAD:other   # push to a DIFFERENT branch name — no "main" on this remote
rm -f "$verdict"
if run_git_setup "$nobranch" >/dev/null 2>&1; then fail "a remote lacking 'main' must fail"; fi
[ -f "$verdict" ] || fail "a git-setup failure must write a verdict (branch-not-found case)"
grep -q "^stage=git-setup" "$verdict" || fail "verdict must name the git-setup stage (branch-not-found case)"
sig_nobranch="$(compute_signature swarm "$(seam_verdict_signal "$verdict")")"

[ "$sig_missing" != "$sig_nobranch" ] || fail "two distinct git-setup faults (repo-not-found vs branch-not-found) must yield DIFFERENT signatures — the whole point of #639"

# --- 4) triage picks the TRIAGE verdict path, not swarm's ---------------------
triage_verdict="$work/triage-verdict.txt"
rm -f "$verdict" "$triage_verdict"
( cd "$workdir" && REPO_SLUG="x/y" FORGEJO_TOKEN=dummy WORKFLOW=triage \
    GIT_SETUP_VERDICT_PATH="$triage_verdict" GIT_SETUP_REMOTE_URL="$nope" \
    bash .sandcastle/git-setup.sh ) >/dev/null 2>&1 && fail "expected the triage git-setup call to fail too"
[ -f "$triage_verdict" ] || fail "triage's own verdict path must be written"

# --- 5) a workdir left bare recovers instead of exiting 128 (#129) -------------
# A pre-push drift gate run under a leaked GIT_DIR (matou-app#232,#233) can
# re-init this shared repo as bare — after which `git checkout` fails with exit
# 128 ("must be run in a work tree"). git-setup.sh must clear core.bare and
# recover, not wedge the workdir forever.
rm -f "$verdict"
git -C "$workdir" config --bool core.bare true
if ! run_git_setup "$origin" >/dev/null 2>&1; then
  fail "a workdir with .git/ + core.bare=true must recover, not exit 128: $(git -C "$workdir" config --get core.bare)"
fi
[ "$(git -C "$workdir" config --get core.bare)" = false ] || fail "git-setup must clear the stray core.bare flag"
[ -f "$verdict" ] && fail "a recovered git-setup run must leave no verdict"

# --- transport posture (#1411): a fake flaky git 5xxes the fetch/clone --------
# Real git handles everything EXCEPT the network op (fetch/clone), which 503s
# while $FLAKY > 0 then defers to real git — so the retry/TRANSPORT paths run
# for real against the same local fixture (no network). GIT_SETUP_BACKOFF=0
# keeps the tests instant. $workdir already carries a healthy .git (fixture 5
# recovered it), so this exercises the fetch path — exactly run 22229's path.
fakebin="$work/fakebin"; mkdir -p "$fakebin"
real_git="$(command -v git)"
cat >"$fakebin/git" <<EOF
#!/usr/bin/env bash
for a in "\$@"; do
  case "\$a" in
    fetch|clone)
      n=0; [ -f "\$FLAKY" ] && n="\$(cat "\$FLAKY")"
      if [ "\$n" -gt 0 ]; then
        echo "\$((n-1))" >"\$FLAKY"
        echo "fatal: unable to access '$origin/': The requested URL returned error: 503" >&2
        exit 128
      fi
      break ;;
  esac
done
exec "$real_git" "\$@"
EOF
chmod +x "$fakebin/git"
run_flaky() { # run_flaky <retries> — $FLAKY/$work/flaky drives the 503 count
  ( cd "$workdir" && REPO_SLUG="x/y" FORGEJO_TOKEN=dummy WORKFLOW=swarm \
      GIT_SETUP_VERDICT_PATH="$verdict" GIT_SETUP_REMOTE_URL="$origin" \
      GIT_SETUP_RETRIES="$1" GIT_SETUP_BACKOFF=0 FLAKY="$work/flaky" \
      PATH="$fakebin:$PATH" bash .sandcastle/git-setup.sh )
}

# --- 6) a TRANSIENT 5xx is ridden out — one blip never reds the tick ----------
rm -f "$verdict"
printf '1\n' >"$work/flaky"   # 503 the first fetch, then succeed
if ! run_flaky 3 >/dev/null 2>&1; then fail "a transient 5xx must be ridden out (exit 0)"; fi
[ -f "$verdict" ] && fail "a run that recovered after a transient 5xx must leave no verdict"
[ "$(cat "$work/flaky")" = 0 ] || fail "the transient 5xx should have been consumed by the retry: $(cat "$work/flaky")"

# --- 7) a SUSTAINED outage is NAMED TRANSPORT, distinct from other faults -----
# Every attempt 503s: the workdir was never updated, so it must NOT green, must
# exit DISTINCTLY (3) naming TRANSPORT, and must NOT be reported as a checkout /
# auth / missing-branch fault — the four faults this one stage used to collapse.
rm -f "$verdict"
printf '999\n' >"$work/flaky"
rc=0
run_flaky 2 >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 3 ] || fail "a sustained transport outage must exit 3 (TRANSPORT), got rc=$rc"
[ -f "$verdict" ] || fail "a sustained transport outage must write a verdict"
grep -q "^stage=git-setup" "$verdict" || fail "the TRANSPORT verdict must still name the git-setup stage"
grep -q "^exit=3" "$verdict" || fail "the TRANSPORT verdict must carry exit=3, got: $(cat "$verdict")"
grep -q "TRANSPORT" "$verdict" || fail "a sustained outage must be NAMED TRANSPORT, got: $(cat "$verdict")"
# The healer keys on seam_verdict_signal = "stage :: first-error-line": that
# line must be the TRANSPORT one, re-keyed OFF the raw git errlog — not the
# generic `returned error: 503` (nor a work-tree/auth string), which would
# collapse a transport outage onto whatever git happened to print.
first_err="$(seam_verdict_signal "$verdict")"
case "$first_err" in *TRANSPORT*) : ;; *) fail "the healer's signal line must name TRANSPORT, got: $first_err" ;; esac
grep -qiE "returned error: 5[0-9][0-9]|must be run in a work tree|authentication failed" "$verdict" \
  && fail "a transport outage must be re-keyed off the raw git error, not carry it: $(cat "$verdict")"
sig_transport="$(compute_signature swarm "$(seam_verdict_signal "$verdict")")"
[ "$sig_transport" != "$sig_missing" ] || fail "a transport outage must not share the repo-not-found signature (#1411)"
[ "$sig_transport" != "$sig_nobranch" ] || fail "a transport outage must not share the branch-not-found signature (#1411)"

echo "git-setup: 7 scenarios passed"
