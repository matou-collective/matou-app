#!/usr/bin/env bash
# session-host-lib — host affinity for the ready-for-session queue (#89).
# Pure functions (no network, no state), tested offline by
# tests/session-host-lib-test.sh; the wiring lives in session-runner.sh's pick
# loop and is asserted by tests/session-runner-test.sh group 18.
#
# The gap this closes: `ready-for-session` exists precisely for work that needs
# a PARTICULAR session's standing — host credentials, live box doors, a
# host's own evidence directories. The label records *that* a host is needed; it
# cannot record *which*. So whichever host ticks first claims the ticket, and a
# ticket whose evidence lived on a host that runs no session-runner at all was
# unclaimable by the only host that could do it and claimable by every host that
# could not — two attempts burned, escalated to a human who was never the actual
# blocker (Matou/idss#743, reported as Matou/idss#746).
#
# The fix is an OPT-IN body marker, the same HTML-comment shape consumers'
# drive issues already use for `<!-- rehearsal-target: … -->`:
#
#   <!-- session-host: <host> -->              # one host
#   <!-- session-host: <host-a>, <host-b> -->  # either of two
#
# NO marker means "any host" — every pre-#89 ticket is untouched, which is what
# makes this safe to land on a live queue. A marked ticket is skipped by any
# host it does not name, at PICK time: before the claim, before the attempt
# marker, before the fail counter. That is deliberate — the runner's `fail-<n>`
# counter cannot tell "this host can't do it" from "this work is hard", so a
# wrong-host skip must never reach it (the ticket's second half).
#
# Cost of the mechanism: a marker naming a host that never ticks (a typo, a
# decommissioned box) leaves the ticket sitting in the queue forever, visible
# only as a per-tick skip line in every other host's log. The escape hatch is
# SESSION_RUNNER_HOST=<name> on the host that should take it.

# session_host_marker <issue-body> -> the declared host list, trimmed; empty
# when the body carries no marker (the default: any host may take it). The
# FIRST marker wins if a body somehow carries two.
session_host_marker() {
  local raw
  raw="$(sed -n -E 's/.*<!--[[:space:]]*session-host:[[:space:]]*([^>]*)-->.*/\1/p' <<<"${1:-}" | head -1)"
  raw="${raw#"${raw%%[![:space:]]*}"}"   # ltrim
  raw="${raw%"${raw##*[![:space:]]}"}"   # rtrim
  printf '%s\n' "$raw"
}

# session_host_match <declared-hosts> <this-host> -> 0 when this host may work
# the ticket. An empty declaration matches everything (the opt-in default);
# otherwise the declaration is a comma- or space-separated list matched
# case-insensitively against this host's name, tolerating an FQDN on our side
# (`box1` matches `box1.lan`, never `box10`).
session_host_match() {
  local want="${1:-}" self="${2:-}" h
  [ -n "$want" ] || return 0
  [ -n "$self" ] || return 1
  want="$(tr 'A-Z,' 'a-z ' <<<"$want")"
  self="$(tr 'A-Z' 'a-z' <<<"$self")"
  for h in $want; do
    case "$self" in "$h"|"$h".*) return 0 ;; esac
  done
  return 1
}

# session_host_self -> the name THIS host answers to, in the order the rest of
# the factory already resolves it (rehearsal-report.sh, claim-next-task.sh):
# an explicit override, then SWARM_HOST (the only name that survives a
# container, where `hostname` is a random id), then `hostname` itself.
session_host_self() {
  printf '%s\n' "${SESSION_RUNNER_HOST:-${SWARM_HOST:-$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo unknown)}}"
}
