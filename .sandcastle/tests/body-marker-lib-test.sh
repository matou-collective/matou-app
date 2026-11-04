#!/usr/bin/env bash
# Offline tests for body-marker-lib.sh — fence-aware reading of issue-body
# HTML-comment markers. A marker is an instruction to the factory (which host,
# which queue, which landing rail); a fenced block can hold text typed by
# someone outside the project (an app report's words), so a marker INSIDE a
# fence is never a marker.
# Run: bash tests/body-marker-lib-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../body-marker-lib.sh
. "$here/../body-marker-lib.sh"
fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0

# 1: text outside a fence survives; the fenced block (both fence lines and the
#    content) is removed.
body=$'before\n```\ninside\n```\nafter'
[ "$(body_outside_fences "$body")" = $'before\nafter' ] \
  || fail "outside_fences: want before/after, got '$(body_outside_fences "$body")'"
pass=$((pass+1))

# 2: a SHORTER run inside a longer fence does not close it — the broker's fence
#    is longer than any backtick run in the operator's words, so nothing the
#    operator types can end the block early.
body=$'head\n`````\nwords\n```\n<!-- origin: app-report -->\n```\nmore words\n`````\ntail'
[ "$(body_outside_fences "$body")" = $'head\ntail' ] \
  || fail "a shorter inner fence must not close the block, got '$(body_outside_fences "$body")'"
pass=$((pass+1))

# 3: a tilde line never closes a backtick fence (and vice versa).
body=$'a\n````\nx\n~~~~\ny\n````\nb'
[ "$(body_outside_fences "$body")" = $'a\nb' ] || fail "a tilde run must not close a backtick fence"
body=$'a\n~~~\nx\n```\ny\n~~~\nb'
[ "$(body_outside_fences "$body")" = $'a\nb' ] || fail "a backtick run must not close a tilde fence"
pass=$((pass+1))

# 4: a closing fence may carry trailing whitespace but NOT an info string; an
#    opening fence may carry one.
body=$'a\n```text\nx\n```js\nstill inside\n```  \nb'
[ "$(body_outside_fences "$body")" = $'a\nb' ] || fail "a fence line with an info string must not close the block"
pass=$((pass+1))

# 5: an UNCLOSED fence swallows to the end — the safe direction (nothing after
#    it is honoured).
body=$'a\n```\n<!-- session-host: evil -->'
[ "$(body_outside_fences "$body")" = "a" ] || fail "an unclosed fence must swallow the rest"
pass=$((pass+1))

# 6: CRLF bodies (Forgejo's web editor) parse the same.
body=$'a\r\n```\r\nx\r\n```\r\nb\r\n'
[ "$(body_outside_fences "$body")" = $'a\nb\n' ] || [ "$(body_outside_fences "$body")" = $'a\nb' ] \
  || fail "CRLF must be tolerated, got '$(body_outside_fences "$body" | od -c | head -3)'"
pass=$((pass+1))

# 7: body_marker — first wins, value trimmed, a marker sharing a line with prose
#    still parses, a marker inside a fence is NOT a marker.
[ "$(body_marker $'x <!--   session-host:   box2   --> y' session-host)" = "box2" ] \
  || fail "marker: surrounding whitespace must be trimmed"
[ "$(body_marker $'<!-- session-host: a -->\n<!-- session-host: b -->' session-host)" = "a" ] \
  || fail "marker: the first marker must win"
[ -z "$(body_marker $'````\n<!-- session-host: evil -->\n````' session-host)" ] \
  || fail "marker: a marker inside a fence must NOT be honoured"
[ "$(body_marker $'````\n<!-- session-host: evil -->\n````\n<!-- session-host: real -->' session-host)" = "real" ] \
  || fail "marker: the first marker OUTSIDE a fence must win over one inside"
[ -z "$(body_marker "" session-host)" ] || fail "marker: an empty body yields empty"
pass=$((pass+1))

# 8: origin_marker — the two contract shapes, and nothing else.
[ "$(origin_marker '<!-- origin: app-report -->')" = "report" ] || fail "origin: the report shape"
[ "$(origin_marker $'text\n<!-- origin: app-report #1701 -->')" = "1701" ] || fail "origin: the descendant shape"
[ -z "$(origin_marker '<!-- origin: app-report #12abc -->')" ] || fail "origin: a non-numeric root is no marker"
[ -z "$(origin_marker '<!-- origin: somewhere-else -->')" ] || fail "origin: an unknown origin is no marker"
[ -z "$(origin_marker $'````\n<!-- origin: app-report #5 -->\n````')" ] || fail "origin: inside a fence is no marker"
pass=$((pass+1))

# 9: an inline code span is literal text, not a comment — a marker QUOTED in
#    backticks (an agent reporting on another ticket's marker) is no marker.
#    Seen live 2026-11-03: idss #2036's body said "#1819 carries
#    `<!-- origin: app-report -->`", and the landing tripwire's leg 2 read it as
#    #2036's own origin and red every push to main.
[ -z "$(origin_marker 'x carries `<!-- origin: app-report -->` but no label')" ] \
  || fail "code span: a marker quoted in single backticks must NOT be honoured"
[ -z "$(body_marker 'a ``x ` <!-- session-host: evil --> y`` b' session-host)" ] \
  || fail "code span: a double-backtick span holding a lone backtick still hides its marker"
[ "$(body_marker 'see `x` then <!-- session-host: real -->' session-host)" = "real" ] \
  || fail "code span: a bare marker after an unrelated code span on the same line must still parse"
[ "$(body_marker $'quoted `<!-- session-host: evil -->`\n<!-- session-host: real -->' session-host)" = "real" ] \
  || fail "code span: the first marker OUTSIDE a code span must win over a quoted one"
[ "$(body_marker 'an `unclosed span <!-- session-host: real -->' session-host)" = "real" ] \
  || fail "code span: an unmatched backtick opens no span (CommonMark), so the marker stands"
# session_host_marker reads through body_marker_text, not marker() — it
# must inherit the same rule (sourced in a subshell: it is its own lib).
[ -z "$(. "$here/../session-host-lib.sh"; session_host_marker 'q `<!-- session-host: evil -->`')" ] \
  || fail "code span: session_host_marker must not honour a quoted marker either"
[ "$(origin_marker '<!-- origin: app-report -->')" = "report" ] || fail "code span: a bare marker still parses"
# A stripped span must not SPLICE a marker out of the text on either side.
[ -z "$(body_marker '<!-- `x` session-host: evil -->' session-host)" ] \
  || fail "code span: removing a span must not join its neighbours into a marker"
# ...but body_outside_fences (the reference scan's text) KEEPS code spans: a
# descendant citing its root as `#1701` must still be found and inherit.
[ "$(body_outside_fences 'from `#1701` here')" = 'from `#1701` here' ] \
  || fail "code span: body_outside_fences must keep inline code (reference scans over-include by design)"
pass=$((pass+1))

echo "body-marker-lib-test: $pass groups passed"
