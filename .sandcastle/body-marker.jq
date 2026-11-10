# body-marker.jq — fence-aware reading of issue-body HTML-comment markers.
# The ONE place fence semantics live: body-marker-lib.sh wraps these for shell
# callers, and list-ready-tasks.sh includes them for its in-pipeline filter.
#
# A fence opens on a line of >=3 backticks or tildes (<=3 leading spaces, an
# info string allowed) and closes only on a line of the SAME character, at
# least as long, with nothing but whitespace after it (CommonMark). An unclosed
# fence runs to the end of the body.
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

# marker("session-host") -> the trimmed value of the FIRST
# `<!-- session-host: value -->` outside fences; "" when absent.
def marker($key):
  outside_fences
  | ([match("<!--[ \\t]*" + $key + ":[ \\t]*([^>]*?)[ \\t]*-->") | .captures[0].string] | first) // "";
