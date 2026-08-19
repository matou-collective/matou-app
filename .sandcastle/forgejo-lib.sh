#!/usr/bin/env bash
# forgejo-lib.sh — the tracker adapter (ADR 0180 / #571: "the biggest missing
# seam in the subsystem" per the 2026-08-15 factory-reengineering survey).
# Before this, rehearsal-report.sh alone made ~15 Forgejo calls in three
# different styles (a silent -sf GET/POST, a status-code-capturing
# `-o /dev/null -w '%{http_code}'` POST for tolerant handling, and one-off
# inline jq). Every script that speaks to the tracker re-learned the same
# lessons the hard way (label-PATCH-ignored, IssueMeta dependency bodies
# needing owner+repo or a live 404 — #381, unpaginated comments — #470).
# This file is the one place those lessons live; also the layer a TUI or any
# future tracker sits on.
#
# Needs: FORGEJO_TOKEN, FORGEJO_API in the environment; curl + jq. Safe to
# source more than once (defines functions only, no top-level side effects).
#
# Two call shapes, matching the two things a caller ever needs from a write:
#   - "did it work, and what came back" (forgejo_get / forgejo_post) — dies
#     loud via curl -f semantics, body on stdout, for the caller that needs
#     the response (e.g. a freshly created issue's number).
#   - "what HTTP code did it get" (forgejo_post_code / forgejo_delete_code) —
#     never fails the pipeline itself; the CALLER decides which codes are
#     tolerable (a dependency POST treats 409 as success, a label POST any
#     2xx). Matches curl's own `-w '%{http_code}'` idiom so existing
#     fakebin/curl shims that pattern-match on `-w` keep working unchanged.

_forgejo_get() { curl -sf --max-time 30 -H "Authorization: token ${FORGEJO_TOKEN:-}" "$@"; }
_forgejo_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 30 -H "Authorization: token ${FORGEJO_TOKEN:-}" "$@"; }

forgejo_get() { # forgejo_get <path-suffix> -> body on stdout | rc = curl's
  _forgejo_get "$FORGEJO_API$1"
}

forgejo_post() { # forgejo_post <path-suffix> <json-body> -> body on stdout | rc = curl's
  _forgejo_get -X POST -H 'Content-Type: application/json' "$FORGEJO_API$1" -d "$2"
}

forgejo_post_code() { # forgejo_post_code <path-suffix> <json-body> -> HTTP code on stdout, rc 0 always
  _forgejo_code -X POST -H 'Content-Type: application/json' "$FORGEJO_API$1" -d "$2"
}

forgejo_delete_code() { # forgejo_delete_code <path-suffix> -> HTTP code on stdout, rc 0 always
  _forgejo_code -X DELETE "$FORGEJO_API$1"
}

forgejo_label_id() { # forgejo_label_id <labels-json> <name> -> id | empty on miss
  # Raw-capture-then-filter (claim-lib.sh finding-1 discipline): caller
  # fetches labels_json once via forgejo_get and passes it in — never
  # `curl | jq` in one pipeline here.
  jq -r --arg n "$2" '.[]? | select(.name==$n) | .id' <<<"$1" 2>/dev/null | head -1
}

forgejo_comment() { # forgejo_comment <issue-num> <body-text> -> rc = curl's
  forgejo_post "/issues/$1/comments" "$(jq -n --arg b "$2" '{body:$b}')" >/dev/null
}

forgejo_add_labels() { # forgejo_add_labels <issue-num> <label-ids-csv> -> HTTP code
  # POST /labels ADDS to the set (only PUT replaces) — the label-PATCH-ignored
  # lesson every caller used to re-learn: a `labels` field in a PATCH on the
  # issue itself is silently ignored (docs/agents/issue-tracker.md).
  forgejo_post_code "/issues/$1/labels" "{\"labels\":[$2]}"
}

forgejo_remove_label() { # forgejo_remove_label <issue-num> <label-id> -> HTTP code
  forgejo_delete_code "/issues/$1/labels/$2"
}

forgejo_add_dependency() { # forgejo_add_dependency <target-issue> <index> <owner> <repo> -> HTTP code
  # The IssueMeta body MUST name the target issue's repo — live Forgejo 404s
  # (IsErrRepoNotExist) a bare {"index": n} (#381).
  forgejo_post_code "/issues/$1/dependencies" \
    "$(jq -cn --argjson i "$2" --arg o "$3" --arg r "$4" '{index:$i, owner:$o, repo:$r}')"
}

forgejo_dispatch_workflow() { # forgejo_dispatch_workflow <workflow-file> <ref> -> HTTP code
  forgejo_post_code "/actions/workflows/$1/dispatches" "$(jq -cn --arg r "$2" '{ref:$r}')"
}

forgejo_create_issue() { # forgejo_create_issue <title> <body> [label-ids-json-array] -> response JSON on stdout | rc = curl's
  local payload
  if [ -n "${3:-}" ]; then
    payload="$(jq -n --arg t "$1" --arg b "$2" --argjson l "$3" '{title:$t, body:$b, labels:$l}')"
  else
    payload="$(jq -n --arg t "$1" --arg b "$2" '{title:$t, body:$b}')"
  fi
  forgejo_post "/issues" "$payload"
}

forgejo_repo_slug() { # forgejo_repo_slug -> "owner/repo", derived from FORGEJO_API's .../repos/<owner>/<repo> tail
  local api_base="${FORGEJO_API%/}" repo owner
  repo="${api_base##*/}"
  owner="${api_base%/*}"; owner="${owner##*/}"
  printf '%s/%s\n' "$owner" "$repo"
}
