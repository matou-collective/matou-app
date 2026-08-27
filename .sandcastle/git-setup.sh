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
# A real subshell (not just a `{ }` group) with its OWN `set -e`, so the first
# failing git command aborts the sequence immediately — without it, `git
# fetch` failing left `git checkout -f`/`git reset --hard` to run anyway
# against the stale pre-fetch refs and exit 0, masking the fetch failure
# entirely (caught by tests/git-setup-test.sh's fixture 2). Deliberately NOT
# `(...) || ec=$?` on one line — bash disables errexit for any command whose
# own exit status is itself tested by a following `||`/`&&`, which would
# silently undo the `set -e` just given the subshell. Capturing $? as a
# separate statement right after keeps errexit live inside the subshell.
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
cat "$git_log"
verdict_write "$ec"
rm -f "$git_log"
exit "$ec"
