#!/usr/bin/env bash
# swarm-db.sh — reader surface over the swarm.db trace mirror (#447, L4).
#
# The forensic trail is scattered by design (the Actions REST API hangs): host
# runlog verdict lines, /tmp verdict artifacts, Mattermost threads, worker logs,
# healer evidence, journalctl. swarm.db is the queryable MIRROR that ties one
# ticket's history together. These are the canned reads:
#
#   swarm-db.sh issue <N>        history of issue N (attempts, events, spend)
#   swarm-db.sh open-processes   believed-alive rows — the #435 wedge/hang surface
#   swarm-db.sh spend-weekly     token/request spend bucketed by ISO week
#   swarm-db.sh red-by-stage     red runs grouped by the verdict/stage that killed them
#
# SWARM_DB overrides the db path (default ~/swarm/state/swarm.db).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${SWARM_DB:=$HOME/swarm/state/swarm.db}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "swarm-db.sh: python3 is required to read the trace mirror" >&2
  exit 1
fi

cmd="${1:-}"
case "$cmd" in
  issue)
    [ -n "${2:-}" ] || { echo "usage: swarm-db.sh issue <N>" >&2; exit 2; }
    exec python3 "$here/swarm-db.py" --db "$SWARM_DB" query issue "$2"
    ;;
  open-processes|spend-weekly|red-by-stage)
    exec python3 "$here/swarm-db.py" --db "$SWARM_DB" query "$cmd"
    ;;
  ""|-h|--help|help)
    sed -n '2,14p' "$here/swarm-db.sh"
    exit 0
    ;;
  *)
    echo "swarm-db.sh: unknown query '$cmd'" >&2
    echo "try: issue <N> | open-processes | spend-weekly | red-by-stage" >&2
    exit 2
    ;;
esac
