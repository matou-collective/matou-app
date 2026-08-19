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

if [ "$mode" = "--prepush" ]; then
  files="$(gate_files_from_prepush)"
else
  base="$(git merge-base HEAD origin/main 2>/dev/null || echo HEAD~1)"
  files="$(git diff --name-only "$base" HEAD)"
fi

printf '%s\n' "$files" | gate_run "$root"
