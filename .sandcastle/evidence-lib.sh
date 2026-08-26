#!/usr/bin/env bash
# evidence-lib.sh — pick one representative screenshot out of a drive's run
# dir, for eyeball-rule attachment (#596: evidence was REFERENCED by a host
# path, never attached, so a tracker-only reader could never see it without
# SSH). Every driver conforming to the six-clause contract (docs/agents/
# e2e-driver-contract.md, clause 6) captures screenshot evidence somewhere
# under <run_dir>/artifacts — "newest *.png in the tree" is therefore a
# portable heuristic, not an idss-specific path: the last screenshot
# written is the journey's last leg on a green, or nearest the fault on a red
# (Playwright's own on-failure capture lands here too). Factory-shared
# (ADR 0183 §5, alongside forgejo-lib.sh): no per-repo hardcodes.
#
# Safe to source more than once (defines a function only, no top-level side
# effects).

pick_representative_screenshot() { # pick_representative_screenshot <run_dir> -> path on stdout | empty if none; rc always 0
  # `|| true`: a missing/empty $1 makes `find` itself exit non-zero (not just
  # "no matches") — under a caller's `set -euo pipefail` (rehearsal-cycle.sh),
  # pipefail would otherwise poison this whole function's return code and
  # kill the caller. This function's contract is "empty on nothing found,
  # never a failure" regardless of the caller's shell options.
  find "$1" -type f -name '*.png' -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn | head -1 | cut -d' ' -f2- || true
}
