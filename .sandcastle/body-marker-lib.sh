#!/usr/bin/env bash
# body-marker-lib.sh — fence-aware reading of issue-body markers. Pure
# functions (no network, no state); the fence semantics live in body-marker.jq
# beside this file. Tested offline by tests/body-marker-lib-test.sh.
#
# Why: an issue body can carry text typed by someone OUTSIDE the project (an app
# report's words, idss ADR 0267), always inside a fenced block. A body marker is
# an instruction to the factory — which host may run the ticket, which queue
# skips it, which rail lands it — so a marker inside a fence must never be
# honoured. Every marker parser in the harness reads through here.
__body_marker_lib_here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

body_outside_fences() { # body_outside_fences <issue-body> -> the body minus every fenced block
  jq -Rrs -L "$__body_marker_lib_here" 'include "body-marker"; outside_fences' <<<"${1:-}"
}

body_marker() { # body_marker <issue-body> <key> -> the first `<!-- key: value -->` outside fences, trimmed; empty when absent
  jq -Rrs -L "$__body_marker_lib_here" --arg k "$2" 'include "body-marker"; marker($k)' <<<"${1:-}"
}

origin_marker() { # origin_marker <issue-body> -> "report" | "<root-number>" | "" (no origin marker)
  local v
  v="$(body_marker "${1:-}" origin)"
  case "$v" in
    "app-report") echo report ;;
    "app-report #"*)
      v="${v#app-report #}"
      case "$v" in ''|*[!0-9]*) echo "" ;; *) echo "$v" ;; esac ;;
    *) echo "" ;;
  esac
}
