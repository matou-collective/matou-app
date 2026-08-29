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

forgejo_label_applied_at() { # forgejo_label_applied_at <issue-num> <label-name> -> epoch of the label's most-recent ADD on stdout (empty on miss/parse-failure); rc = curl's on the GET
  # #99 (queue latency): when was a label last applied? The issue TIMELINE is the
  # only local source — the issue itself carries no label-applied timestamp. A
  # Forgejo TimelineComment for a label event has type "label", the Label object,
  # an ISO8601 `created_at`, and `body` "1" for an ADD ("" for a remove), so an
  # add is (type=="label" and body=="1" and label.name==name). A ticket can cycle
  # ready→working→ready (a re-arm), so take the LATEST add — that is the state the
  # caller is timing from. Raw-capture-then-filter (claim-lib.sh finding-1
  # discipline): never curl|jq in one pipeline. `fromdateiso8601?` drops any
  # created_at the parser can't read rather than erroring the whole read.
  local resp
  resp="$(forgejo_get "/issues/$1/timeline?limit=100")" || return 1
  jq -r --arg n "$2" '
    [ .[]? | select(.type=="label" and .body=="1" and (.label.name==$n))
           | .created_at | fromdateiso8601? ]
    | (max // empty)' <<<"$resp" 2>/dev/null
}

forgejo_comment() { # forgejo_comment <issue-num> <body-text> -> rc = curl's
  forgejo_post "/issues/$1/comments" "$(jq -n --arg b "$2" '{body:$b}')" >/dev/null
}

forgejo_comment_id() { # forgejo_comment_id <issue-num> <body-text> -> new comment's id on stdout (empty on parse failure); rc = curl's
  local resp
  resp="$(forgejo_post "/issues/$1/comments" "$(jq -n --arg b "$2" '{body:$b}')")" || return 1
  jq -r '.id // empty' <<<"$resp" 2>/dev/null
}

forgejo_attach_comment_asset() { # forgejo_attach_comment_asset <comment-id> <file-path> [display-name] -> HTTP code (000 if file missing)
  # #596: the eyeball rule needs an actual image a tracker-only reader can
  # open, not a host path — POST multipart/form-data to the comment's own
  # asset endpoint (Forgejo's issueCreateIssueCommentAttachment).
  local file="$2" name="${3:-$(basename "$2")}"
  [ -f "$file" ] || { echo 000; return 0; }
  _forgejo_code -X POST -F "attachment=@${file};filename=${name};type=image/png" \
    "$FORGEJO_API/issues/comments/$1/assets"
}

forgejo_attach_issue_asset() { # forgejo_attach_issue_asset <issue-num> <file-path> [display-name] -> HTTP code (000 if file missing)
  # Same shape as forgejo_attach_comment_asset, for evidence attached directly
  # to an issue's own body (a freshly filed issue — the initial body is not a
  # comment, so it takes the issue-level asset endpoint instead).
  local file="$2" name="${3:-$(basename "$2")}"
  [ -f "$file" ] || { echo 000; return 0; }
  _forgejo_code -X POST -F "attachment=@${file};filename=${name};type=image/png" \
    "$FORGEJO_API/issues/$1/assets"
}

forgejo_add_labels() { # forgejo_add_labels <issue-num> <label-ids-csv> -> HTTP code
  # POST /labels ADDS to the set (only PUT replaces) — the label-PATCH-ignored
  # lesson every caller used to re-learn: a `labels` field in a PATCH on the
  # issue itself is silently ignored (the factory's docs/agents/issue-tracker.md
  # — a factory doc, not a path in a consumer's checkout; #47).
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

# --- pull requests (the LANDING=pr flow — #13, ADR 0002) ------------------
# Forgejo exposes no reliable `head=` query filter on /pulls, so the open-PR
# lookup GETs the open set and filters client-side by .head.ref (matou-app's
# prompt learned this the hard way). Raw-capture-then-filter — never curl|jq in
# one pipeline (claim-lib.sh finding-1 discipline).

forgejo_open_pr_for() { # forgejo_open_pr_for <head-branch> -> open PR number on stdout (empty if none); rc = curl's on the GET
  local branch="$1" resp
  resp="$(forgejo_get "/pulls?state=open&limit=50")" || return 1
  jq -r --arg b "$branch" '.[]? | select(.head.ref==$b) | .number' <<<"$resp" 2>/dev/null | head -1
}

forgejo_merged_pr_for() { # forgejo_merged_pr_for <head-branch> -> newest MERGED PR number from that branch on stdout (empty if none); rc = curl's on the GET
  # #108: a PR can be merged by ANOTHER run's reconcile sweep (landing_merge_reconcile
  # lands every open agent PR, #15) between a worker's push and its close-report,
  # so "no OPEN PR" alone does not mean the work never landed. Closed-but-unmerged
  # PRs (the pre-reconcile sandcastle/worker/* one, an abandoned branch) don't count.
  local branch="$1" resp
  resp="$(forgejo_get "/pulls?state=closed&limit=50")" || return 1
  jq -r --arg b "$branch" '[.[]? | select(.head.ref==$b and .merged==true)] | sort_by(.number) | reverse | .[0].number // empty' <<<"$resp" 2>/dev/null
}

forgejo_create_pr() { # forgejo_create_pr <title> <head> <base> <body> -> response JSON on stdout | rc = curl's
  forgejo_post "/pulls" \
    "$(jq -n --arg t "$1" --arg h "$2" --arg base "$3" --arg b "$4" '{title:$t, head:$h, base:$base, body:$b}')"
}

forgejo_pr_head_sha() { # forgejo_pr_head_sha <pr-number> -> the PR head commit sha on stdout (empty on miss); rc = curl's
  local resp
  resp="$(forgejo_get "/pulls/$1")" || return 1
  jq -r '.head.sha // empty' <<<"$resp" 2>/dev/null
}

forgejo_merge_pr() { # forgejo_merge_pr <pr-number> [style] -> HTTP code on stdout, rc 0 always
  # style: Forgejo's merge `Do` (merge|rebase|squash…); default a plain merge.
  forgejo_post_code "/pulls/$1/merge" "$(jq -cn --arg s "${2:-merge}" '{Do:$s}')"
}

forgejo_pr_combined_status() { # forgejo_pr_combined_status <pr-number> -> CombinedStatus JSON on stdout; rc non-zero if the head sha is unknown or the GET fails
  # The merge-if-green gate (#15) reads whether every required check on the PR
  # head is `success`. Forgejo's combined-status endpoint keys off a commit, not
  # a PR, so resolve the head sha first, then GET .../commits/<sha>/status — its
  # `.state` is the overall verdict (success|pending|failure|error, "" for no
  # checks) and `.statuses[].context` names each check.
  local sha
  sha="$(forgejo_pr_head_sha "$1")" || return 1
  [ -n "$sha" ] || return 1
  forgejo_get "/commits/$sha/status"
}

forgejo_repo_default_merge_style() { # forgejo_repo_default_merge_style -> the repo's merge style (merge|rebase|rebase-merge); rc 0 always
  # #15: an agent-after-green merge follows the repo's own Forgejo setting, but
  # NEVER a squash — squashing rewrites the human/agent commit into a new one,
  # breaking the close-report gate's SHA-reachability check. squash/unknown/
  # unreachable all fall back to a plain merge commit.
  local resp style
  resp="$(forgejo_get "" 2>/dev/null)" || { printf 'merge\n'; return 0; }
  style="$(jq -r '.default_merge_style // "merge"' <<<"$resp" 2>/dev/null)"
  case "$style" in
    rebase|rebase-merge|merge) printf '%s\n' "$style" ;;
    *) printf 'merge\n' ;;
  esac
}

forgejo_issue_write_probe() { # forgejo_issue_write_probe -> rc 0 if the bot has repo write; LOUD + rc 1 otherwise (#20)
  # Zero-token preflight probe: GET the repo root with the bot token and assert
  # the caller's `permissions` block grants write. #19 looked like four
  # successful closes because swarm-bot had repo.code write but not repo.issues
  # write — it could COMMENT on a public repo yet every label/state write 403'd
  # silently. The repo-level permissions block (admin/push/pull) is the coarsest
  # signal the API exposes without a write; it reds a bot with no write at all
  # HERE, before a worker spawns. The code-write-but-not-issues case is caught
  # deeper — close-report.sh closes-then-verifies and claim_mark_working pages
  # on a 403 label write — so the three layers together never again read a
  # permission gap as a clean close.
  local resp push
  resp="$(forgejo_get "")" || {
    echo "forgejo: repo probe GET failed — cannot confirm the bot can write issues on $(forgejo_repo_slug)"
    return 1; }
  push="$(jq -r '.permissions.push // false' <<<"$resp" 2>/dev/null)"
  [ "$push" = "true" ] && return 0
  echo "forgejo: the bot has no write access (permissions.push=$push) on $(forgejo_repo_slug) — issue label/state writes will 403 (the machines team needs repo.issues + repo.pulls write, not just repo.code)"
  return 1
}

forgejo_repo_slug() { # forgejo_repo_slug -> "owner/repo", derived from FORGEJO_API's .../repos/<owner>/<repo> tail
  local api_base="${FORGEJO_API%/}" repo owner
  repo="${api_base##*/}"
  owner="${api_base%/*}"; owner="${owner##*/}"
  printf '%s/%s\n' "$owner" "$repo"
}
