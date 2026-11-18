# body-marker.jq — fence-aware reading of issue-body HTML-comment markers.
# The ONE place fence semantics live: body-marker-lib.sh wraps these for shell
# callers, and list-ready-tasks.sh includes them for its in-pipeline filter.
#
# A fence opens on a line of >=3 backticks or tildes (<=3 leading spaces, an
# info string allowed) and closes only on a line of the SAME character, at
# least as long, with nothing but whitespace after it (CommonMark). An unclosed
# fence runs to the end of the body.
#
# Inline code spans go too: a backtick run opens a span that closes only on a
# run of EXACTLY the same length (CommonMark), and what sits between renders
# as literal text — a `<!-- key: v -->` quoted in backticks is a mention, not a
# comment (idss #2036, 2026-11-03: an agent quoting another ticket's marker
# made the landing tripwire read it as the ticket's own). An unmatched run
# opens nothing. Spans are taken within a line — a marker never needs more.
# Each span becomes one inert U+001F, never "": deleting it outright could
# SPLICE a marker out of the text around it (`<!-- `x` key: v -->`).
def outside_code_spans:
  gsub("(?<!`)(?<t>`+)(?!`)(?:(?!\\k<t>).)*?(?<!`)\\k<t>(?!`)"; "\u001f");

def outside_fences:
  (. // "") | gsub("\r"; "") | split("\n")
  | reduce .[] as $l ({open: null, out: []};
      if .open == null then
        ([$l | match("^ {0,3}(`{3,}|~{3,})") | .captures[0].string] | first) as $f
        | if $f == null then .out += [$l] else .open = $f end
      else
        .open as $o
        | if ($l | test("^ {0,3}[" + $o[0:1] + "]{" + ($o | length | tostring) + ",}[ \\t]*$"))
          then .open = null else . end
      end)
  | .out | join("\n");

# outside_markup: the text a MARKER may be read from — outside fences AND
# outside code spans. Only marker reads use it: a `#N` reference scan (idss's
# app-report inheritance) keeps plain outside_fences, because there a ticket
# citing its root in backticks must still inherit — stripping spans would let
# a descendant slide off the PR rail (over-include by design).
def outside_markup: outside_fences | outside_code_spans;

# marker("session-host") -> the trimmed value of the FIRST
# `<!-- session-host: value -->` outside fences and code spans; "" when absent.
def marker($key):
  outside_markup
  | ([match("<!--[ \\t]*" + $key + ":[ \\t]*([^>]*?)[ \\t]*-->") | .captures[0].string] | first) // "";
