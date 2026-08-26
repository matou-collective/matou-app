#!/usr/bin/env bash
# Claim primitives for the multi-host swarm (spec:
# docs/superpowers/specs/2026-08-11-multihost-swarm-design.md, D4).
# Sourced by claim-next-task.sh (in-sandbox) and run-swarm.sh (host).
# A claim is a comment whose first line is `swarm-claim host=<h> run=<n>`,
# arbitrated by Forgejo's strictly-increasing comment ids: the LOWEST claim
# whose run is still in progress wins. The agent-working label hides claimed
# tickets from every other host's queue.
#
# Needs: FORGEJO_TOKEN, FORGEJO_API in the environment; curl + jq.
#
# Failure shape: every function that lists/reads (claim_alive_runs, claim_post,
# _claim_comments) captures curl's raw response into a variable FIRST, then
# filters it — never `curl | jq` in one pipeline. Piping curl straight into a
# trailing jq/sort collapses curl's own failure into jq's exit status: jq sees
# empty stdin as zero input documents, which is a *successful* zero-length
# result, not an error. A poisoned empty result is indistinguishable from a
# legitimate "nothing here" — and callers that guard with `|| return 0/1` never
# fire (2026-08-11 review finding 1: an actions/tasks blip made claim_alive_runs
# return `[]` at rc 0, and janitor_sweep's `|| return 0` guard never saw it,
# mass-re-arming every live claim). claim_mark_working does not raw-capture: it
# posts the label with the `-o /dev/null -w '%{http_code}'` idiom and pages on
# any non-2xx (#20 — a silent 403 on the agent-working write let #19 be worked
# with no claim label). (This header used to also
# name claim_label_id an exception — false premise: its pipeline ended in
# `jq | head -1` and the real safety was the `[ -n "$id" ]` emptiness check.
# It raw-captures like the rest now, and pages — #470 M-1/M-2.)
#
# Two live-probed facts arbitration RESTS on (2026-08-12 review, #470):
# (a) this forge's issue-comments endpoint is UNPAGINATED — `?limit=1`
#     returns every comment (probed live 2026-08-12). _claim_comments and
#     claim_won depend on seeing ALL claim comments in one response; if a
#     Forgejo upgrade starts paginating it, arbitration breaks silently.
# (b) the timing invariant: a run is visible in /actions/tasks for MINUTES
#     before its first claim post, while an alive-runs snapshot is only
#     seconds stale — so "run not in snapshot" reliably means dead, never
#     too-new. Any D6 revisit (intra-host parallelism, fast-boot workers)
#     must re-verify this before relying on arbitration.

_claim_api() { curl -sf -H "Authorization: token $FORGEJO_TOKEN" "$@"; }

claim_label_id() { # claim_label_id <name> -> id | rc 1 (LOUD on miss)
  # Paged (#470 M-2): single-page fetch went silently blind past 50 labels —
  # janitor_sweep's `|| return 0` guard would turn the janitor off without a
  # word. A genuinely missing label is now loud, and an API failure keeps
  # curl's own rc (raw-capture, finding-1 style).
  local id page=1 raw
  while :; do
    raw="$(_claim_api "$FORGEJO_API/labels?limit=50&page=$page")" || return 1
    id="$(jq -r --arg n "$1" '.[] | select(.name == $n) | .id' <<<"$raw" | head -1)"
    [ -n "$id" ] && { printf '%s\n' "$id"; return 0; }
    [ "$(jq 'length' <<<"$raw")" -lt 50 ] && break
    page=$((page + 1))
  done
  echo "claim-lib: label '$1' not found on the tracker ($page page(s) searched) — the depending label op is being skipped" >&2
  return 1
}

claim_alive_runs() { # -> JSON array of in-progress swarm run numbers | rc 1 on API failure
  # &page=1 is mandatory: without it Forgejo ignores `limit` and dumps every
  # task ever (O(n), ~30s and growing — the 2026-07-30 healer blindness).
  # Name match is `swarm` OR `swarm (N)` (#541): swarm.yml's 2-wide worker
  # matrix (44fe333) makes Forgejo suffix each matrix job's name with its
  # index — live-probed 2026-08-15, every real task is "swarm (1)"/"swarm
  # (2)", never bare "swarm". An exact-match filter (the pre-matrix original)
  # silently always returned [], so claim_won's arbitration only ever saw a
  # caller's OWN claim as alive and every racing host "won" — two hosts fully
  # implemented #536 before either noticed the other.
  local raw
  raw="$(_claim_api "$FORGEJO_API/actions/tasks?limit=100&page=1")" || return 1
  jq -c '[.workflow_runs[]? | select((.name == "swarm" or (.name | test("^swarm \\("))) and (.status == "running" or .status == "waiting")) | .run_number]' <<<"$raw"
}

claim_post() { # claim_post <issue> <host> <run> -> comment id | rc 1 on API failure
  local raw
  raw="$(jq -n --arg h "$2" --arg r "$3" \
    '{body: ("swarm-claim host=" + $h + " run=" + $r + "\n(automated multi-host claim — lowest live claim id works this ticket)")}' |
    _claim_api -X POST -H 'Content-Type: application/json' -d @- \
      "$FORGEJO_API/issues/$1/comments")" || return 1
  jq -r .id <<<"$raw"
}

_claim_comments() { # _claim_comments <issue> -> "id run" lines, ascending id | rc 1 on API failure
  local raw
  raw="$(_claim_api "$FORGEJO_API/issues/$1/comments")" || return 1
  # test() before capture() (#470 M-3): capture on a malformed hand-posted
  # claim body (e.g. `run=abc`) errors MID-STREAM, dropping every subsequent
  # line with the rc swallowed by the trailing sort — one bad comment could
  # blind arbitration on the whole issue. A body failing the strict shape is
  # not a claim; skip it.
  jq -r '.[] | select(.body | test("^swarm-claim host=\\S+ run=[0-9]+")) |
    "\(.id) \(.body | capture("run=(?<r>[0-9]+)").r)"' <<<"$raw" | sort -n
}

claim_won() { # claim_won <issue> <my_comment_id> <alive_runs_json> -> rc 0 if mine is lowest live claim
  local id run lowest="" comments
  # A comments-fetch failure can't be told apart from "no claims yet" once
  # filtered — but here we still have curl's own rc (finding 1's fix), so
  # bail out honestly instead of guessing: no evidence of winning is not a win.
  comments="$(_claim_comments "$1")" || return 1
  while read -r id run; do
    [ -n "$id" ] || continue
    # My own claim is alive by definition (my run is the one running this code)
    # even if a just-started run hasn't shown up in a stale alive_runs_json
    # snapshot yet — the id match short-circuits the runs-membership check.
    if [ "$id" = "$2" ] || jq -e --argjson r "$run" 'index($r) != null' <<<"$3" >/dev/null; then
      lowest="$id"; break   # first (lowest-id) claim that is live
    fi
  done <<<"$comments"
  [ "$lowest" = "$2" ]
}

claim_mark_working() { # claim_mark_working <issue> -> rc 0 on a 2xx label write; LOUD + rc 1 on refusal (#20)
  # A label write that returns non-2xx must fail LOUD, never silently continue:
  # #19's swarm-bot had repo.code write but not repo.issues write, so this POST
  # 403'd and the ticket was worked WITHOUT agent-working — invisible to the
  # janitor and to every other host's queue. Capture the HTTP code with the
  # -o/-w idiom (not curl -sf, which swallows a 403 into an rc the caller here
  # dropped) and page on anything but a 2xx.
  local lid code
  lid="$(claim_label_id agent-working)" || return 1
  code="$(jq -n --argjson l "$lid" '{labels: [$l]}' |
    curl -s -o /dev/null -w '%{http_code}' -H "Authorization: token $FORGEJO_TOKEN" \
      -X POST -H 'Content-Type: application/json' -d @- \
      "$FORGEJO_API/issues/$1/labels")"
  case "$code" in
    2*) return 0 ;;
    *) echo "claim: label write refused (HTTP $code) — check the bot's issues permission on this repo" >&2
       return 1 ;;
  esac
}

claim_release() { # claim_release <issue> <comment_id>
  _claim_api -X DELETE "$FORGEJO_API/issues/comments/$2" >/dev/null || true
  local lid; lid="$(claim_label_id agent-working)" || return 0
  _claim_api -X DELETE "$FORGEJO_API/issues/$1/labels/$lid" >/dev/null || true
}

janitor_sweep() { # re-arm agent-working tickets whose claiming run died
  local alive lid page batch count comments num cid run any_alive
  # Both guards now fire for real: claim_alive_runs and the per-page issues
  # fetch each surface curl's own rc (finding 1), so an API blip here means
  # "do nothing this sweep", never "assume nothing is alive".
  alive="$(claim_alive_runs)" || return 0
  lid="$(claim_label_id agent-working)" || return 0
  page=1
  while :; do
    batch="$(_claim_api "$FORGEJO_API/issues?state=open&type=issues&labels=agent-working&limit=50&page=$page")" || return 0
    count="$(jq 'length' <<<"$batch")"
    [ "$count" -eq 0 ] && break
    for num in $(jq -r '.[].number' <<<"$batch"); do
      # Fetch once per issue; a fetch failure here means "can't verify this
      # ticket's claims" — skip it rather than treat silence as "no live
      # claim" (the same finding-1 trap, scoped to a single issue).
      comments="$(_claim_comments "$num")" || continue
      any_alive=""
      while read -r cid run; do
        [ -n "$cid" ] || continue
        if jq -e --argjson r "$run" 'index($r) != null' <<<"$alive" >/dev/null; then
          any_alive=1
        fi
      done <<<"$comments"
      if [ -z "$any_alive" ]; then
        while read -r cid run; do
          [ -n "$cid" ] || continue
          _claim_api -X DELETE "$FORGEJO_API/issues/comments/$cid" >/dev/null || true
        done <<<"$comments"
        _claim_api -X DELETE "$FORGEJO_API/issues/$num/labels/$lid" >/dev/null || true
        printf '%s\n' "$num"
      fi
    done
    [ "$count" -lt 50 ] && break
    page=$((page + 1))
  done
}

rearm_dispatch() { # dispatch a fresh swarm run when claimable work remains
  jq -n '{ref: "main"}' |
    _claim_api -X POST -H 'Content-Type: application/json' -d @- \
      "$FORGEJO_API/actions/workflows/swarm.yml/dispatches"
}
