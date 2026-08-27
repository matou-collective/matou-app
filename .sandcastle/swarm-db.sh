#!/usr/bin/env bash
# swarm-db.sh — reader surface over the swarm.db trace mirror (#447, L4).
#
# The forensic trail is scattered by design (the Actions REST API hangs): host
# runlog verdict lines, /tmp verdict artifacts, Mattermost threads, worker logs,
# healer evidence, journalctl. swarm.db is the queryable MIRROR that ties one
# ticket's history together. These are the canned reads:
#
#   swarm-db.sh issue <N> [--repo <slug>|all]   history of issue N (attempts, events, spend)
#   swarm-db.sh open-processes [--repo <slug>]   believed-alive rows — the #435 wedge/hang surface
#   swarm-db.sh spend-weekly   [--repo <slug>]   token/request spend bucketed by ISO week
#   swarm-db.sh red-by-stage   [--repo <slug>]   red runs grouped by the verdict/stage that killed them
#   swarm-db.sh queue-wait     [--repo <slug>]   ready→claimed queue-wait percentiles bucketed by day (#99)
#   swarm-db.sh limit-lost                       lost capacity to Claude limits, per account, by ISO week
#
# Issue numbers are PER-REPO but swarm.db is ONE shared db per host (ADR 0004
# point 5), so `issue` defaults to the caller's own repo — sourced from the
# sibling swarm-identity.sh (REPO_SLUG) — and conflates nothing; `--repo <slug>`
# reads another repo's issue N, `--repo all` drops the scope. The host-scoped
# reads (open-processes / spend-weekly / red-by-stage) answer HOST questions by
# default and take `--repo <slug>` only to narrow to one consumer.
#
# SWARM_DB overrides the db path (default ~/swarm/state/swarm.db).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${SWARM_DB:=$HOME/swarm/state/swarm.db}"

usage() { sed -n '2,20p' "$here/swarm-db.sh"; }

if ! command -v python3 >/dev/null 2>&1; then
  echo "swarm-db.sh: python3 is required to read the trace mirror" >&2
  exit 1
fi

cmd="${1:-}"
shift || true

# Optional repo filter shared by every read. Sets $repo ('' => none passed).
repo=""
parse_repo() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --repo) repo="${2:-}"; shift 2 || { echo "swarm-db.sh: --repo needs a value" >&2; exit 2; } ;;
      *) echo "swarm-db.sh: unexpected argument '$1'" >&2; exit 2 ;;
    esac
  done
}

case "$cmd" in
  issue)
    n="${1:-}"
    [ -n "$n" ] || { echo "usage: swarm-db.sh issue <N> [--repo <slug>|all]" >&2; exit 2; }
    shift
    parse_repo "$@"
    if [ -z "$repo" ]; then
      # Default to the caller's own repo: env REPO_SLUG, else the sibling
      # identity layer. Refuse rather than conflate if neither is available.
      [ -n "${REPO_SLUG:-}" ] || { [ -f "$here/swarm-identity.sh" ] && . "$here/swarm-identity.sh"; }
      repo="${REPO_SLUG:-}"
      [ -n "$repo" ] || {
        echo "swarm-db.sh: cannot determine the repo for 'issue $n' — no REPO_SLUG and no swarm-identity.sh alongside." >&2
        echo "pass --repo <owner/name> for one repo, or --repo all to read every repo's issue $n." >&2
        exit 2
      }
    fi
    exec python3 "$here/swarm-db.py" --db "$SWARM_DB" query issue "$n" --repo "$repo"
    ;;
  open-processes|spend-weekly|red-by-stage|queue-wait)
    parse_repo "$@"
    if [ -n "$repo" ]; then
      exec python3 "$here/swarm-db.py" --db "$SWARM_DB" query "$cmd" --repo "$repo"
    fi
    exec python3 "$here/swarm-db.py" --db "$SWARM_DB" query "$cmd"
    ;;
  limit-lost)
    # Host-global by nature: a subscription window is one host-wide thing, so
    # this read takes no repo filter (it aggregates every account's park events).
    exec python3 "$here/swarm-db.py" --db "$SWARM_DB" query limit-lost
    ;;
  ""|-h|--help|help)
    usage
    exit 0
    ;;
  *)
    echo "swarm-db.sh: unknown query '$cmd'" >&2
    echo "try: issue <N> [--repo <slug>|all] | open-processes | spend-weekly | red-by-stage | queue-wait | limit-lost" >&2
    exit 2
    ;;
esac
