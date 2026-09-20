#!/usr/bin/env bash
# Clone-or-fetch the shared per-repo swarm workdir (#638: called from
# swarm.yml/triage.yml AFTER `cd "$workdir"`, with the per-repo workdir lock
# already held, so nothing else is mutating .git concurrently).
#
# On failure this drops the SAME stage/exit/error verdict format
# verdict-lib.sh's other callers use (#235's run-swarm.sh/run-triage.sh
# stages) — so a git-setup fault (dead auth, unreachable remote, missing
# branch, corrupt workdir — the class #638's race was one instance of) still
# keys the healer's incident signature on the real fault (heal-lib.sh's
# seam_verdict_signal), instead of collapsing onto the bare workflow-name
# signature the healer used before any verdict existed for this stage (#639).
# A clean run leaves no verdict (verdict_write's contract).
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=verdict-lib.sh
. "$here/verdict-lib.sh"
: "${REPO_SLUG:?}"
: "${FORGEJO_TOKEN:?}"

# Same repo-tagged verdict-path formula run-swarm.sh/run-triage.sh/heal.sh
# each compute independently (#574) — WORKFLOW picks which of the two.
repo_tag="${REPO_SLUG//\//-}"
default_verdict="/tmp/matou-$repo_tag-swarm-verdict.txt"
[ "${WORKFLOW:-swarm}" = triage ] && default_verdict="/tmp/matou-$repo_tag-triage-verdict.txt"
verdict_begin "${GIT_SETUP_VERDICT_PATH:-$default_verdict}"

git_log="$(mktemp)"
verdict_stage "git-setup (clone/fetch/checkout/reset)" "$git_log"

# Test seam: point at a local fixture repo offline instead of the real
# git.matou.nz remote (tests/git-setup-test.sh).
url="${GIT_SETUP_REMOTE_URL:-https://swarm:${FORGEJO_TOKEN}@git.matou.nz/${REPO_SLUG}.git}"

# Transport posture (#1411 — the git-transport THIRD surface of #1359/#1394's
# rule that "a probe that cannot reach the server has not obtained a verdict").
# The fetch-or-clone below is git-setup's ONE live network call. A transient
# Forgejo 5xx on it used to red the whole swarm/triage tick at stage one with a
# bare `exit 128` that read as a checkout/auth fault and burned a healer
# investigation on a fault that was never in this repo (swarm run 22229,
# 2026-09-12). Retry with exponential backoff (each attempt bounded by git's
# own transport), matching check-harness-drift.sh's #1394 fetch and
# forgejo-lib.sh's #52/#1359 probe: a momentary blip is ridden out. A SUSTAINED
# transport outage still reds (the workdir was never updated, so it must never
# pass for a clean checkout — GOTCHAS #30), but it exits DISTINCTLY (code 3)
# NAMING TRANSPORT, so the healer separates "Forgejo was unreachable" from the
# three OTHER faults this one stage would otherwise collapse together.
GIT_SETUP_RETRIES="${GIT_SETUP_RETRIES:-3}"
GIT_SETUP_BACKOFF="${GIT_SETUP_BACKOFF:-2}"
EX_TRANSPORT=3

# A failure whose git output carries a transport signature — a 5xx/429 from the
# Forgejo front, a DNS/TCP/TLS failure, or curl's "unable to access" — is
# transient and worth another attempt. Dead auth (401/403), repo-not-found, and
# branch-not-found ("couldn't find remote ref") are NOT: they fail identically
# on every attempt, so retrying only delays a verdict that will not change, and
# they must keep their own native error so the healer's per-fault signatures
# stay distinct (#639).
is_transport_error() { # <git-log>; rc 0 iff the failure looks like a transport fault
  grep -qiE "returned error: (5[0-9][0-9]|429)|RPC failed|(could not|couldn't|can't) resolve|connection (refused|timed out|reset)|failed to connect|unable to access|gnutls|SSL_|operation timed out|early EOF|the remote end hung up|network is unreachable|temporary failure in name resolution" "$1"
}

# A real subshell (not just a `{ }` group) with its OWN `set -e`, so the first
# failing git command aborts the sequence immediately — without it, `git
# fetch` failing left `git checkout -f`/`git reset --hard` to run anyway
# against the stale pre-fetch refs and exit 0, masking the fetch failure
# entirely (caught by tests/git-setup-test.sh's fixture 2). Deliberately NOT
# `(...) || ec=$?` on one line — bash disables errexit for any command whose
# own exit status is itself tested by a following `||`/`&&`, which would
# silently undo the `set -e` just given the subshell. Capturing $? as a
# separate statement right after keeps errexit live inside the subshell. The
# retry loop re-runs this whole subshell per attempt (each attempt a fresh,
# self-contained fetch-or-clone), so the masked-fetch pin still holds.
attempt=1; delay="$GIT_SETUP_BACKOFF"; ec=0
while :; do
  (
  set -e
  if [ -d .git ]; then
    # Defensive recovery (#129 / matou-app#232,#233): a pre-push drift gate run
    # under a leaked GIT_DIR could have re-initialised this shared repo as bare
    # (core.bare=true), after which every `git checkout` here fails with
    # `fatal: this operation must be run in a work tree` (exit 128). If the
    # workdir's own .git is flagged bare, clear it before proceeding — matou-app
    # carried this inline in swarm.yml/triage.yml since 6fd69e6; upstreamed here
    # so those YAML copies can go once consumers re-vendor.
    if [ "$(git rev-parse --is-bare-repository 2>/dev/null)" = true ]; then
      git config --bool core.bare false
    fi
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
  # Fail FAST on a non-transport fault — its verdict will not change on retry,
  # and it must keep its native git error (fixtures 2/3). Only a transport-class
  # failure is worth riding out.
  is_transport_error "$git_log" || break
  [ "$attempt" -ge "$GIT_SETUP_RETRIES" ] && break
  sleep "$delay"; delay=$((delay * 2)); attempt=$((attempt + 1))
done
cat "$git_log"

# Sustained transport outage: Forgejo was unreachable across every attempt. The
# workdir was never updated, so re-key the verdict off the errlog's generic
# `fatal: ... 503` onto an explicit TRANSPORT line and exit DISTINCTLY (code 3),
# so the healer's signature names the remote as the cause and separates it from
# dead-auth / missing-branch / corrupt-workdir — never a bare 128 that reads as
# a checkout fault (#1411).
if [ "$ec" -ne 0 ] && is_transport_error "$git_log"; then
  ec="$EX_TRANSPORT"
  verdict_stage "git-setup (clone/fetch/checkout/reset)"
  verdict_error "TRANSPORT: git.matou.nz was unreachable across $attempt attempt(s) (transient 5xx / connection failure) — the workdir was NOT updated. Not a checkout, auth, or missing-branch fault; the tick is lost and the cron/backstop re-fires."
fi
# Wire the factory pre-push drift gate into this real (non-sandbox) swarm/triage
# workdir so a push that edits a factory-vendored file (FACTORY_MANIFEST, ADR
# 0180) is blocked BEFORE it lands, not by a red seam on main (idss #932). Same
# knob the sandbox sets in main.mts. Guarded: hook wiring must never turn a
# clean checkout into a red git-setup verdict.
if [ "$ec" -eq 0 ]; then
  git config core.hooksPath .sandcastle/git-hooks 2>/dev/null || true
fi
verdict_write "$ec"
rm -f "$git_log"
exit "$ec"
