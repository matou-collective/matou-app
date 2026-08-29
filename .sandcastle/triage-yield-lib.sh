#!/usr/bin/env bash
# Per-repo consecutive-YIELD counter for triage (#110). A triage yield is
# `exit 0` — a green run — so a repo whose triage yields tick after tick while
# untriaged issues pile up is invisible on the run list: Matou/coa filed 12
# phase-1 tickets and triage fired 12 times, every run green, 0 triaged, all 12
# still `needs-triage` an hour later, because every tick exited at a pre-work
# capacity gate. This is the counter behind the starvation signal; the network
# side (untriaged count, the issue comment, the Mattermost notice) is
# `triage-yield-signal.sh`. Pure w.r.t. paths — no network, no tracker calls —
# so both the signal script and `run-triage.sh` (which RESETS the counter on a
# real triage pass) share one definition of the counter path and the threshold.
#
# Distinct from the drive-defer counter (`/tmp/matou-triage-drive-defer-count`,
# #664): that counts ONLY the ticks a rehearsal drive reservation made triage
# stand down; THIS counts EVERY consecutive yield (both host slots busy, the
# workdir busy, a drive reserved, the Claude window parked) while untriaged
# issues exist, and resets on the next real triage pass. Two counters because
# they answer two different questions — "how long has the drive held the host"
# vs "how long has this repo's triage queue been starving".

# triage_yield_count_path — the per-repo counter file. REPO_SLUG (or, absent it,
# the FORGEJO_API tail) keys it so one runner's two repos never share a streak
# (#574's clobber lesson); TRIAGE_YIELD_COUNT overrides the whole path, the
# test seam every other host-global counter here carries (cf.
# TRIAGE_DRIVE_DEFER_COUNT, HOST_CAPACITY_DRIVE_SKIPS).
triage_yield_count_path() {
  local slug tag
  slug="${REPO_SLUG:-}"; [ -n "$slug" ] || slug="${FORGEJO_API:-}"; slug="${slug##*/repos/}"
  tag="${slug//\//-}"
  printf '%s' "${TRIAGE_YIELD_COUNT:-/tmp/matou-triage-yield-$tag}"
}

# triage_yield_signalled_path — the once-per-episode marker beside the counter.
# The threshold signal posts ONCE per starvation episode, not on every tick past
# the threshold (else a genuinely-starved repo would get a fresh comment every
# :05/:35 cron tick). Cleared with the counter by triage_yield_reset.
triage_yield_signalled_path() { printf '%s.signalled' "$(triage_yield_count_path)"; }

# TRIAGE_YIELD_THRESHOLD — consecutive yields (with untriaged issues present)
# before the signal fires. 3, matching the acceptance in #110 and the
# drive-defer signal cadence (#664): enough that a single unlucky tick behind
# established repos' periodic traffic never fires it, few enough that a genuinely
# starving new consumer surfaces within ~15 min of cron ticks.
TRIAGE_YIELD_THRESHOLD="${TRIAGE_YIELD_THRESHOLD:-3}"

# triage_yield_bump — increment the counter and echo the new value. Same
# clamp-non-numeric shape as host_capacity_consumer_defer_bump so a hand-mangled
# /tmp file can never wedge the arithmetic under `set -e`.
triage_yield_bump() {
  local f n
  f="$(triage_yield_count_path)"
  n="$(cat "$f" 2>/dev/null || echo 0)"; case "$n" in ''|*[!0-9]*) n=0 ;; esac
  n=$((n + 1)); echo "$n" >"$f"; echo "$n"
}

# triage_yield_reset — zero the counter and clear the episode marker. Called on
# any real triage pass (a `/triage` that actually ran) and whenever a yield finds
# NOTHING untriaged (an empty queue is not starvation). Idempotent.
triage_yield_reset() { rm -f "$(triage_yield_count_path)" "$(triage_yield_signalled_path)"; }
