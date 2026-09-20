#!/usr/bin/env bash
# Pre-push language gate orchestrator (issue #198). Invoked by the
# .sandcastle/git-hooks/pre-push hook with `--prepush` (git's ref lines on
# stdin), or by hand for a quick check of the working range against origin/main.
# See .sandcastle/gate-lib.sh for the pure logic and the rationale.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=gate-lib.sh
. "$here/gate-lib.sh"

root="$(git rev-parse --show-toplevel)"
mode="${1:-manual}"

# --prepush     — git's ref lines on stdin; run every language gate (sandbox).
# --prepush-host — same stdin, HOST push profile: the TS lint gate (#1252)
#                  plus the cheap gofmt-only Go gate (Gate 3b, #1458); the heavy
#                  Go seam stays sandbox-only (#198). `--prepush-ts` is an alias.
# manual        — the working range against origin/main; run every language gate.
case "$mode" in
  --prepush|--prepush-host|--prepush-ts)
    files="$(gate_files_from_prepush)" ;;
  *)
    base="$(git merge-base HEAD origin/main 2>/dev/null || echo HEAD~1)"
    files="$(git diff --name-only "$base" HEAD)" ;;
esac

# On the host push path the Go gate runs the cheap gofmt-only tier; the sandbox
# and a manual run get the full Go seam.
go_tier=full
case "$mode" in
  --prepush-host|--prepush-ts) go_tier=gofmt ;;
esac

printf '%s\n' "$files" | gate_run "$root" "" "$go_tier"
