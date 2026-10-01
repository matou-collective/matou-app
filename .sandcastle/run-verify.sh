#!/usr/bin/env bash
# Headless verify poller: sync the shared swarm workdir to origin/main, then run
# check-verifications.sh (promote awaiting-verification issues per Mattermost
# thread replies). Run from the repo checkout root, AFTER the workflow has taken
# a host-capacity slot and cd'd into the workdir.
#
# On failure this drops the SAME stage/exit/error verdict format verdict-lib.sh's
# other callers use (#235's run-swarm.sh/run-triage.sh stages, #639's
# git-setup.sh). Before this the verify workflow ran entirely inline in the YAML
# and wrote NO verdict, so the healer's error_line() fell through to grepping
# worker-logs.txt — always empty for a poller — and EVERY red verify degraded to
# the bare `verify|` signature: a moved fault masked as still-failing (#228,
# same failure mode #46 fixed for smoke-drive). A clean run leaves no verdict
# (verdict_write's contract).
#
# Env: FORGEJO_TOKEN, FORGEJO_API, REPO_SLUG (optional), SERVER_URL (optional —
#      the remote host; defaults to git.matou.nz), plus the Mattermost trio
#      check-verifications.sh needs. VERIFY_VERDICT_PATH / GIT_VERIFY_REMOTE_URL
#      are test seams.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=verdict-lib.sh
. "$here/verdict-lib.sh"
: "${FORGEJO_TOKEN:?}"
: "${FORGEJO_API:?}"
repo_slug="${REPO_SLUG:-${FORGEJO_API##*/repos/}}"
# One runner serves TWO repos (#238) — a /tmp verdict path must carry the repo
# or the two clobber each other's (#574). Same formula as run-triage.sh/heal.sh.
repo_tag="${repo_slug//\//-}"

# Drop a stage/exit verdict on failure so the healer keys the incident signature
# on the run's REAL failing stage, not on the bare workflow name (#228).
verdict_begin "${VERIFY_VERDICT_PATH:-/tmp/matou-$repo_tag-verify-verdict.txt}"
trap 'verdict_write $?' EXIT

# --- git sync -----------------------------------------------------------------
git_log="$(mktemp)"
verdict_stage "git sync (fetch/checkout/reset)" "$git_log"
# Derive the remote host from SERVER_URL (onboarding/README.md's
# no-hardcoded-remote fix, as in triage.yml's fallback) rather than baking in
# git.matou.nz; the test seam points at a local fixture repo offline.
host="${SERVER_URL#https://}"; host="${host:-git.matou.nz}"
url="${GIT_VERIFY_REMOTE_URL:-https://swarm:${FORGEJO_TOKEN}@${host}/${repo_slug}.git}"
# Bounded transient-transport retry around this ONE live git call, mirroring
# git-setup.sh's #511/#1411 loop (#714): the verify path never inherited #511's
# fix (git-setup.sh got it, this local sync copy did not), so a momentary Forgejo
# 5xx / connection blip on fetch-or-clone used to red the whole verify tick with
# a bare git exit. A transport-class failure (5xx/429, DNS/TCP/TLS, "unable to
# access") is ridden out; a NON-transport fault — dead auth, repo-not-found, a
# missing branch — fails FAST (it would fail identically on every attempt and
# must keep its native git error so the verdict names the real fault). A
# SUSTAINED outage still reds after the budget: the workdir was never updated, so
# it must never pass for a clean checkout.
VERIFY_SYNC_RETRIES="${VERIFY_SYNC_RETRIES:-3}"
VERIFY_SYNC_BACKOFF="${VERIFY_SYNC_BACKOFF:-2}"
is_transport_error() { # <git-log>; rc 0 iff the failure looks like a transport fault
  grep -qiE "returned error: (5[0-9][0-9]|429)|RPC failed|(could not|couldn't|can't) resolve|connection (refused|timed out|reset)|failed to connect|unable to access|gnutls|SSL_|operation timed out|early EOF|the remote end hung up|network is unreachable|temporary failure in name resolution" "$1"
}

# A real subshell with its OWN `set -e`, so the first failing git command aborts
# the sequence immediately — mirrors git-setup.sh: without it, a failed `git
# fetch` would leave `git checkout -f`/`git reset --hard` to run against stale
# refs and exit 0, masking the fetch failure entirely. Capturing $? as a separate
# statement right after keeps errexit live inside the subshell (a one-line
# `(...) || ec=$?` would disable it); the retry loop re-runs this whole
# self-contained fetch-or-clone per attempt, so that pin still holds.
attempt=1; delay="$VERIFY_SYNC_BACKOFF"; ec=0
while :; do
  (
    set -e
    if [ -d .git ]; then
      git remote set-url origin "$url"
      git fetch origin main
      git checkout -f main
      git reset --hard origin/main
    else
      git clone "$url" .
    fi
  ) > "$git_log" 2>&1
  ec=$?
  [ "$ec" -eq 0 ] && break
  is_transport_error "$git_log" || break
  [ "$attempt" -ge "$VERIFY_SYNC_RETRIES" ] && break
  sleep "$delay"; delay=$((delay * 2)); attempt=$((attempt + 1))
done
cat "$git_log"
# On failure LEAVE $git_log on disk: the EXIT trap's verdict_write greps it for
# the error lines. Removing it here would recreate the #18 bug — an `rm` ahead
# of the failing `exit` deletes the log the trap then tries to read, leaving an
# empty `--- error lines ---` block. Only the success path prunes it.
[ "$ec" -eq 0 ] || exit "$ec"
rm -f "$git_log"

# --- check verifications ------------------------------------------------------
# Capture combined output so a check-verifications failure feeds real error
# lines into the verdict (verdict_write greps this errlog), not just the bare
# stage. pipefail (set above) makes the pipeline exit non-zero when the script
# does; it is the LAST command, so its code becomes the script's exit and the
# EXIT trap's verdict_write keys the verdict on it.
cv_log="$(mktemp)"
verdict_stage "check-verifications" "$cv_log"
bash "$here/check-verifications.sh" 2>&1 | tee "$cv_log"
