#!/usr/bin/env bash
# close-report.sh — the ONLY sanctioned path for a swarm worker to close a
# ticket (#444, learning L1). "Agent proposes, code disposes."
#
# The worker writes a close-report envelope (JSON) describing what it did; this
# script runs the deterministic claim gates (close-report-lib.sh) over it and
# closes the issue ONLY if every gate passes. The envelope — valid or not — is
# ALWAYS posted to the issue as a comment, so the thread carries the evidence in
# every outcome. On gate failure it prints the verbatim violation list (for the
# worker to fix and retry, prompt step 7) and exits non-zero WITHOUT closing.
#
# Usage:  close-report.sh <issue-number> <envelope.json>
#   env:  FORGEJO_API (required), FORGEJO_TOKEN or /run/secrets/forgejo_token,
#         CR_MAIN_HEAD (default origin/main).
# Exit:   0 = gates passed, comment posted, issue closed.
#         2 = usage / envelope-read error (nothing posted).
#         1 = gates refused the close; envelope+violations posted, NOT closed.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=close-report-lib.sh
. "$here/close-report-lib.sh"

issue="${1:-}"
envelope_file="${2:-}"
if [ -z "$issue" ] || [ -z "$envelope_file" ]; then
  echo "usage: close-report.sh <issue-number> <envelope.json>" >&2
  exit 2
fi
if [ ! -r "$envelope_file" ]; then
  echo "close-report: cannot read envelope file '$envelope_file'" >&2
  exit 2
fi

json="$(cat "$envelope_file")"
if ! jq -e . >/dev/null 2>&1 <<<"$json"; then
  echo "close-report: envelope '$envelope_file' is not valid JSON — refusing to touch the issue" >&2
  exit 2
fi

token="${FORGEJO_TOKEN:-$(cat /run/secrets/forgejo_token 2>/dev/null || true)}"
: "${FORGEJO_API:?close-report: FORGEJO_API is not set}"
root="$(git rev-parse --show-toplevel 2>/dev/null || echo .)"

# Deterministic verdict. cr_violations echoes one line per failed gate.
violations="$(cr_violations "$json" "$root" "${CR_MAIN_HEAD:-origin/main}")" && gate_rc=0 || gate_rc=$?

status="$(jq -r '.status // "?"' <<<"$json")"
pretty="$(jq . <<<"$json")"

# #574: close_outcome — the value swarm-db.py's attempts.close_outcome column
# exists for (success|blocked|refused|...) — is the GATE's verdict, not merely
# the envelope's self-declared status: an agent claiming "success" whose gates
# refuse the close must read "refused", never "success". Printed as a single
# structured stdout line (never worker chain-of-thought prose — the exact
# anti-pattern verdict-lib.sh's header warns about) in EVERY outcome, so
# main.mts (host-side, holding the full RunResult after the sandbox exits) can
# parse it out of the combined run stdout and wire attempts/spend into
# swarm.db — closing the "zero production writers" gap main.mts's own missing
# capture left (#574 item 1).
outcome="$status"
[ "$gate_rc" -ne 0 ] && outcome="refused"
commits_csv="$(jq -r '(.commits // []) | join(",")' <<<"$json")"
echo "SANDCASTLE_ATTEMPT issue=$issue outcome=$outcome commits=$commits_csv"

if [ "$gate_rc" -eq 0 ]; then
  verdict=":white_check_mark: **close-report gates passed** — every claim verified against main; closing."
else
  bullets="$(printf '%s\n' "$violations" | sed 's/^/- /')"
  verdict=":no_entry: **close-report gates REFUSED this close** — the following claims did not verify:

$bullets"
fi

comment="**close-report** for #$issue — status \`$status\`

$verdict

<details><summary>envelope</summary>

\`\`\`json
$pretty
\`\`\`
</details>"

# The envelope lands on the issue in EVERY outcome (evidence trail, #444 AC).
jq -n --arg b "$comment" '{body:$b}' |
  curl -sf -X POST -H "Authorization: token $token" -H "Content-Type: application/json" \
    -d @- "$FORGEJO_API/issues/$issue/comments" >/dev/null

if [ "$gate_rc" -ne 0 ]; then
  echo "close-report: REFUSED — issue #$issue NOT closed. Violations:" >&2
  printf '%s\n' "$violations" >&2
  exit 1
fi

# Gates green: close the issue.
curl -sf -X PATCH -H "Authorization: token $token" -H "Content-Type: application/json" \
  -d '{"state":"closed"}' "$FORGEJO_API/issues/$issue" >/dev/null
echo "close-report: issue #$issue closed (all claim gates passed)."
