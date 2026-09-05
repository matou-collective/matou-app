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
cat "$git_log"
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
