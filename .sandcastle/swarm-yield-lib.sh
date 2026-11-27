#!/usr/bin/env bash
# Per-repo consecutive-YIELD counter for the SWARM (#213). A swarm yield is
# `exit 0` — a green run — so a repo whose swarm legs lose both host-capacity
# slots tick after tick while ready-for-agent tickets pile up is invisible on
# the run list: triage already has the #110 yield signal (triage-yield-lib.sh),
# but the swarm had only the drive-defer counter (which counts ONLY the ticks a
# rehearsal drive reservation made the run stand down, not the both-slots-busy
# losses). A low-traffic repo whose legs always lose while two long drains hold
# both slots on every host can starve indefinitely with no counter, no comment,
# no notice (GOTCHAS 35, 51 family). This is the counter behind that starvation
# signal; the network side (ready count, the issue comment, the Mattermost
# notice, the want-file) is `swarm-yield-signal.sh`. Pure w.r.t. paths — no
# network, no tracker calls — so both the signal script and `run-swarm.sh`
# (which RESETS the counter on a real claim) share one definition of the
# counter path, the threshold, and the want-file path.
#
# Distinct from the drive-defer counter (`$HOME/swarm/state/matou-swarm-drive-defer-count`,
# #664): that counts ONLY the ticks a rehearsal drive reservation made the swarm
# stand down; THIS counts EVERY consecutive yield (both host slots busy, a peer
# repo past its own threshold, a drive reserved) while ready-for-agent tickets
# exist, and resets on the next real claim. Two counters because they answer two
# different questions — "how long has the drive held the host" vs "how long has
# THIS repo's swarm queue been starving behind other repos' drains".

# swarm_yield_count_path — the per-repo counter file. REPO_SLUG (or, absent it,
# the FORGEJO_API tail) keys it so one runner's two repos never share a streak
# (#574's clobber lesson); SWARM_YIELD_COUNT overrides the whole path, the test
# seam every other host-global counter here carries (cf. TRIAGE_YIELD_COUNT,
# TRIAGE_DRIVE_DEFER_COUNT, HOST_CAPACITY_DRIVE_SKIPS).
swarm_yield_count_path() {
  local slug tag
  slug="${REPO_SLUG:-}"; [ -n "$slug" ] || slug="${FORGEJO_API:-}"; slug="${slug##*/repos/}"
  tag="${slug//\//-}"
  printf '%s' "${SWARM_YIELD_COUNT:-/tmp/matou-swarm-yield-$tag}"
}

# swarm_yield_signalled_path — the once-per-episode marker beside the counter.
# The threshold signal posts ONCE per starvation episode, not on every tick past
# the threshold (else a genuinely-starved repo would get a fresh comment every
# :15/:45 cron tick). Cleared with the counter by swarm_yield_reset.
swarm_yield_signalled_path() { printf '%s.signalled' "$(swarm_yield_count_path)"; }

# swarm_repo_wanted_path — this repo's want-file, the generalisation of the
# rehearsal drive's `$HOME/swarm/state/matou-drive-wanted` (#663) into a per-repo signal
# (#213). A repo past the threshold writes it; main.mts mirrors every live peer
# want-file into each sandbox's host-signals dir, and list-ready-tasks.sh then
# answers [] for a PEER's drain so the held slot frees after the current ticket.
# Keyed on the slug exactly like the counter; SWARM_REPO_WANTED overrides the
# whole path (the test seam). The filename stem `matou-repo-wanted-<tag>` is the
# contract list-ready-tasks.sh and main.mts match on.
swarm_repo_wanted_path() {
  local slug tag
  slug="${REPO_SLUG:-}"; [ -n "$slug" ] || slug="${FORGEJO_API:-}"; slug="${slug##*/repos/}"
  tag="${slug//\//-}"
  printf '%s' "${SWARM_REPO_WANTED:-/tmp/matou-repo-wanted-$tag}"
}

# SWARM_YIELD_THRESHOLD — consecutive yields (with ready tickets present) before
# the signal fires and the want-file is written. 3, matching the triage yield
# signal (#110) and the drive-defer signal cadence (#664): enough that a single
# unlucky tick behind established repos' periodic traffic never fires it, few
# enough that a genuinely starving repo surfaces within ~90 min of :15/:45
# ticks.
SWARM_YIELD_THRESHOLD="${SWARM_YIELD_THRESHOLD:-3}"

# swarm_yield_bump — increment the counter and echo the new value. Same
# clamp-non-numeric shape as triage_yield_bump / host_capacity_consumer_defer_bump
# so a hand-mangled /tmp file can never wedge the arithmetic under `set -e`.
swarm_yield_bump() {
  local f n
  f="$(swarm_yield_count_path)"
  n="$(cat "$f" 2>/dev/null || echo 0)"; case "$n" in ''|*[!0-9]*) n=0 ;; esac
  n=$((n + 1)); echo "$n" >"$f"; echo "$n"
}

# swarm_yield_reset — zero the counter, clear the episode marker, AND drop this
# repo's want-file. Called on a real claim (a worker was confirmed born this
# run — run-swarm.sh) and whenever a yield finds NOTHING ready (an empty queue
# is not starvation). A real claim means this repo is no longer starving, so it
# must stop asking peers to yield to it — hence the want-file goes too.
# Idempotent.
swarm_yield_reset() {
  rm -f "$(swarm_yield_count_path)" "$(swarm_yield_signalled_path)" \
        "$(swarm_repo_wanted_path)"
}
