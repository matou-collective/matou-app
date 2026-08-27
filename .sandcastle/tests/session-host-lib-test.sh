#!/usr/bin/env bash
# Offline tests for session-host-lib.sh — the pure core of session-runner's host
# affinity (#89). No network, no fixtures: marker extraction, matching, and the
# host-name resolution order. The WIRING (a wrong-host ticket is skipped without
# burning an attempt) is asserted in session-runner-test.sh group 18.
# Run: bash tests/session-host-lib-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../session-host-lib.sh
. "$here/../session-host-lib.sh"
fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0

# 1: the marker rides the body as an HTML comment, exactly like the drive
#    issues' <!-- rehearsal-target: … --> shape.
body=$'## Destination\n\n<!-- session-host: box1 -->\nsome text'
got="$(session_host_marker "$body")"
[ "$got" = "box1" ] || fail "marker: want 'box1', got '$got'"
pass=$((pass+1))

# 2: NO marker is the default and means "any host" — every pre-#89 ticket is
#    unaffected, which is the whole opt-in premise.
[ -z "$(session_host_marker $'plain body\nno markers here')" ] \
  || fail "marker: a body with no marker must yield empty"
[ -z "$(session_host_marker "")" ] || fail "marker: an empty body must yield empty"
session_host_match "" box1 || fail "match: no marker must match any host"
session_host_match "" "" || fail "match: no marker must match even an unknown host"
pass=$((pass+1))

# 3: whitespace around the value is trimmed; a marker sharing a line with prose
#    still parses; the FIRST marker wins if a body somehow carries two.
[ "$(session_host_marker "text <!--   session-host:   box2   --> more")" = "box2" ] \
  || fail "marker: surrounding whitespace must be trimmed"
[ "$(session_host_marker $'<!-- session-host: box1 -->\n<!-- session-host: box2 -->')" = "box1" ] \
  || fail "marker: the first marker must win"
pass=$((pass+1))

# 4: a marker may name SEVERAL hosts (comma- or space-separated) — "either of
#    these two boxes has the standing" is a real shape.
m="box1, box2"
[ "$(session_host_marker "<!-- session-host: $m -->")" = "$m" ] || fail "marker: a list must survive extraction"
session_host_match "$m" box2 || fail "match: a listed host must match"
session_host_match "$m" box1      || fail "match: the first listed host must match"
session_host_match "box1 box2" box2 \
  || fail "match: a space-separated list must match"
pass=$((pass+1))

# 5: the whole point — a host NOT named does not match, so it never picks.
session_host_match box1 box3 \
  && fail "match: an unnamed host must NOT match (this is the reported bug)"
session_host_match box1 "" \
  && fail "match: an unresolvable host name must not match a pinned ticket"
pass=$((pass+1))

# 6: matching is case-insensitive and tolerates an FQDN on our side — a host
#    whose `hostname` answers box1.local is still box1.
session_host_match BOX1 box1 || fail "match: must be case-insensitive"
session_host_match box1 box1.lan || fail "match: an FQDN self must match its short name"
session_host_match box1 box10 && fail "match: a prefix must not match a different host"
pass=$((pass+1))

# 7: host-name resolution order — an explicit SESSION_RUNNER_HOST is the
#    operator's escape hatch and outranks SWARM_HOST (which itself outranks
#    `hostname`, the only name that survives a container).
[ "$(SESSION_RUNNER_HOST=box9 SWARM_HOST=box1 session_host_self)" = "box9" ] \
  || fail "self: SESSION_RUNNER_HOST must win"
[ "$(env -u SESSION_RUNNER_HOST SWARM_HOST=box1 bash -c ". '$here/../session-host-lib.sh'; session_host_self")" = "box1" ] \
  || fail "self: SWARM_HOST must be used when SESSION_RUNNER_HOST is unset"
[ -n "$(env -u SESSION_RUNNER_HOST -u SWARM_HOST bash -c ". '$here/../session-host-lib.sh'; session_host_self")" ] \
  || fail "self: with neither var set, the hostname fallback must still name something"
pass=$((pass+1))

echo "OK: $pass checks passed (session host affinity, pure core)"
