#!/usr/bin/env bash
# The Sandcastle task source — injected into prompt.md via a shell expression,
# evaluated INSIDE the sandbox at the start of every iteration.
#
# Surfaces ONLY issues that are all of:
#   1. open and labelled `ready-for-agent`,
#   2. unblocked — every Forgejo issue-dependency ("blocked by") is closed —
#      so the swarm honours the slice-map DAG (docs/slices/*.yaml) across
#      features, and
#   3. NOT labelled `agent-working` — claimed by a live run on another host
#      under the multi-host pool (claim-next-task.sh, spec D4); a claimed
#      ticket must vanish from every other host's queue immediately, not
#      just get lost to the claim race once an agent sees it.
#
# depends_on lives as NATIVE Forgejo issue dependencies (the repo has
# enable_issue_dependencies on), not as body text — see the factory's
# docs/agents/issue-tracker.md for how to set them (a factory doc, not a path
# in a consumer's checkout; #47).
#
# Output: a JSON array of {number, title, body, url} — the shape Sandcastle's
# built-in trackers emit. An empty array means done.
#
# Auth: FORGEJO_TOKEN from the environment, from .sandcastle/.env (host runs),
# or from the read-only file .sandcastle/secrets/forgejo_token that Sandcastle
# bind-mounts at /run/secrets/forgejo_token inside the sandbox (see
# .sandcastle/secrets/README.md — the token isn't forwarded as an env var
# because that lands in `docker inspect .Config.Env`).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Source .env only when the environment doesn't already provide the token —
# in CI the workflow sets it, and the materialized .env holds empty values
# that would clobber it.
# shellcheck disable=SC1091
if [ -z "${FORGEJO_TOKEN:-}" ] && [ -f "$here/.env" ]; then . "$here/.env"; fi
if [ -z "${FORGEJO_TOKEN:-}" ] && [ -f /run/secrets/forgejo_token ]; then
  FORGEJO_TOKEN="$(cat /run/secrets/forgejo_token)"
fi

: "${FORGEJO_TOKEN:?set in .sandcastle/.env, the environment, or /run/secrets/forgejo_token}"
# shellcheck source=swarm-identity.sh
. "$here/swarm-identity.sh"   # FORGEJO_API default — this repo's identity (ADR 0180 / #571)
# A standing rehearsal DRIVE issue is executed HOST-MODE by the workstation
# cron (scripts/rehearsal-executor.sh), never by the swarm — Ben's ruling on
# Matou/idss#380 (DO/broker secrets stay off the swarm containers; #377 proved
# the substrate has no /dev/kvm and carries no drive credentials). It is open,
# ready-for-agent and — until a red blocks it — unblocked, so it would
# otherwise pass every filter below and a swarm iteration would hot-loop on a
# drive it structurally cannot run. Exclude it here. The executor reads the
# issue directly, so the ratchet's real trigger is untouched.
# PRIMARY exclusion = the `standing-drive` tracker label (Ben's ruling
# 2026-08-13 on Matou/idss#493): re-minting the drive issue is ONE tracker
# action — label the new issue (PUT/POST /labels, never issue-PATCH). This is
# the name-based, per-repo-safe half and needs no configuration.
# REHEARSAL_DRIVE_ISSUE is an OPTIONAL numeric BACKSTOP: a consumer that wants
# a forgotten label and a stale number to BOTH have to happen before the live
# drive leaks sets it from its identity layer (.env / swarm-identity.sh) to the
# drive's number. No product number is defaulted here — an empty/unset value
# excludes NOTHING by number (CLAUDE.md: never default a per-repo value to any
# product), leaving the label as the sole automatic exclusion.
: "${REHEARSAL_DRIVE_ISSUE:=}"
export FORGEJO_TOKEN FORGEJO_API

# A transient Forgejo 5xx/timeout while listing must not RED an otherwise-idle
# tick (#52, run 421): these reads had neither a `--max-time` nor a retry
# (unlike forgejo-lib.sh:_forgejo_get, heal.sh, session-runner.sh,
# schedule-backstop.sh — all `--max-time 30`), so a brief blip that one retry
# absorbs propagated `curl -sf`'s exit 22 up through `set -e` and reddened the
# run (run-swarm re-keys any death here to the "list ready tasks" stage —
# GOTCHAS #7). Retry with exponential backoff, each attempt bounded by
# `--max-time`, matching _forgejo_get's posture. A persistent outage still
# exhausts the attempts and returns 22, failing the caller under `set -e`.
# Exported so the 10-wide dependency subshells below inherit the same knobs.
LIST_READY_MAX_TIME="${LIST_READY_MAX_TIME:-30}"
LIST_READY_RETRIES="${LIST_READY_RETRIES:-3}"
LIST_READY_BACKOFF="${LIST_READY_BACKOFF:-2}"
export LIST_READY_MAX_TIME LIST_READY_RETRIES LIST_READY_BACKOFF

# Per-repo LANDING policy (#13, ADR 0002). SWARM_POLICY_FILE is a TEST-only seam
# (points policy_load at a throwaway swarm-policy.sh); unset in production, so
# policy_load reads the consumer's real file and defaults LANDING=push — the
# queue is then byte-identical to before (idss/factory nil-diff).
# shellcheck source=policy-lib.sh
. "$here/policy-lib.sh"
policy_load "${SWARM_POLICY_FILE:-}"

api() {
  local attempt=1 delay="$LIST_READY_BACKOFF" out
  while :; do
    if out="$(curl -sf --max-time "$LIST_READY_MAX_TIME" -H "Authorization: token $FORGEJO_TOKEN" "$@")"; then
      printf '%s' "$out"
      return 0
    fi
    [ "$attempt" -ge "$LIST_READY_RETRIES" ] && return 22
    sleep "$delay"
    delay=$((delay * 2))
    attempt=$((attempt + 1))
  done
}

ready='[]'
page=1
while :; do
  batch="$(api "$FORGEJO_API/issues?state=open&type=issues&labels=ready-for-agent&limit=50&page=$page")"
  count="$(jq 'length' <<<"$batch")"
  [ "$count" -eq 0 ] && break

  # Dependency checks run 10-wide: with the whole DAG labelled ready-for-agent
  # (70+ issues), serial curls take ~90s — past Sandcastle's 30s shell-expression
  # timeout. A failed check aborts the whole script (xargs propagates the
  # subshell's failure), matching the old serial strictness: never emit an
  # issue whose blockers could not be verified closed.
  # -r (--no-run-if-empty): when the exclusion above empties the number
  # stream (e.g. the drive issue is the only ready one left), xargs must run
  # NOTHING — without it xargs fires the check once with an empty $0, curling
  # /issues//dependencies and aborting the whole script on the non-numeric
  # reply. An empty queue is a legitimate "nothing for the swarm" result.
  unblocked="$(jq -r --arg drive "$REHEARSAL_DRIVE_ISSUE" \
      '.[]
       | select((((.labels // []) | map(.name) | index("standing-drive")) == null)
                and ((.number | tostring) != $drive))
       | .number' <<<"$batch" | xargs -r -P 10 -n 1 bash -c '
    set -euo pipefail
    # Same transient-5xx posture as api() above (#52): the dependency GET is a
    # `curl -sf` too, so a blip here would abort the whole listing under the
    # xargs failure propagation. Retry with backoff, each attempt --max-time
    # bounded; raw-capture then jq (never curl|jq, which merges curl'"'"'s failure
    # into jq'"'"'s exit — claim-lib finding-1). A persistent failure still exits 1
    # so a blocker that could not be verified closed is never emitted.
    attempt=1; delay="${LIST_READY_BACKOFF:-2}"; raw=""
    while :; do
      if raw="$(curl -sf --max-time "${LIST_READY_MAX_TIME:-30}" -H "Authorization: token $FORGEJO_TOKEN" \
          "$FORGEJO_API/issues/$0/dependencies?limit=50")"; then
        break
      fi
      [ "$attempt" -ge "${LIST_READY_RETRIES:-3}" ] && exit 1
      sleep "$delay"; delay=$((delay * 2)); attempt=$((attempt + 1))
    done
    open="$(jq "[.[] | select(.state == \"open\")] | length" <<<"$raw")"
    case "$open" in
      0) echo "$0" ;;
      "" | *[!0-9]*) exit 1 ;;
    esac
  ')"

  # $batch goes in via --slurpfile, not --argjson: spec issues carry ~40KB
  # bodies, and a full 50-issue page blows past the 128KB argv-string limit.
  # Membership select keeps the batch's original order. The `priority` flag is
  # a sort key only — stripped before emit; `model` is the additive per-ticket
  # model-<name> override (#448) that run-swarm.sh resolves for the run's model,
  # surfaced here (null when the ticket carries no model-* label). The tracker
  # contract stays {number, title, body, url} plus the informational `model`.
  nums="$(printf '%s\n' "$unblocked" | jq -Rn '[inputs | select(length > 0) | tonumber]')"
  ready="$(jq --slurpfile batch <(printf '%s' "$batch") --argjson nums "$nums" \
    '. + [$batch[0][] | select(.number as $n | $nums | index($n) != null)
      | select(((.labels // []) | map(.name) | index("agent-working")) == null)
      | {number, title, body, url: .html_url,
         priority: ((.labels // []) | map(.name) | index("priority") != null),
         model: ((.labels // []) | map(.name) | map(select(startswith("model-")))
                 | if length == 0 then null else (.[0] | ltrimstr("model-")) end)}]' \
    <<<"$ready")"

  [ "$count" -lt 50 ] && break
  page=$((page + 1))
done

# LANDING=pr (#13): an issue with an OPEN agent PR (agent/issue-<N>) is already
# being landed and awaiting merge — drop it so the swarm neither re-claims nor
# re-works it while a human reviews (matou-app's filter, promoted into the core).
# In push mode (default) this whole block is skipped: no /pulls call is made and
# the queue is byte-identical.
if [ "${SWARM_POLICY_LANDING:-push}" = pr ]; then
  open_pr_nums="$(api "$FORGEJO_API/pulls?state=open&limit=50" |
    jq -r '.[]? | (.head.ref // "") | select(test("^agent/issue-[0-9]+$")) | sub("^agent/issue-";"")' 2>/dev/null || true)"
  if [ -n "$open_pr_nums" ]; then
    drop="$(printf '%s\n' $open_pr_nums | jq -Rn '[inputs | select(length > 0) | tonumber]')"
    ready="$(jq --argjson drop "$drop" \
      'map(select(.number as $n | ($drop | index($n)) == null))' <<<"$ready")"
  fi
fi

# Drive-blocker ordering (#24): a ready ticket that is a native Forgejo
# dependency ("blocked by") of an OPEN `standing-drive` issue is exactly what a
# standing drive is waiting on — surface it AHEAD of ordinary backlog so a
# reporter-filed blocker is claimed on the next tick instead of losing the
# "lowest live claim id" race to unrelated work (the swarm-gridlock shape:
# idss #668 sat 69 minutes blocking drive #652 while the host slot chewed
# backlog). Resolve via the dependencies API ONCE per standing drive (not per
# candidate): list the open standing drives, GET each one's blockers, keep the
# open ones. A failed fetch, no standing drive, or none with open blockers →
# blocker_nums stays [] and the emit order below is byte-identical to before.
blocker_nums='[]'
if drives="$(api "$FORGEJO_API/issues?state=open&type=issues&labels=standing-drive&limit=50")"; then
  for d in $(jq -r '.[]?.number' <<<"$drives" 2>/dev/null || true); do
    deps="$(api "$FORGEJO_API/issues/$d/dependencies?limit=50")" || continue
    blocker_nums="$(jq --argjson acc "$blocker_nums" \
      '($acc + [.[]? | select(.state == "open") | .number]) | unique' <<<"$deps" \
      2>/dev/null || printf '%s' "$blocker_nums")"
  done
fi

# Emit order: drive blockers FIRST, then everything else; WITHIN each partition
# keep today's ordering — `priority`-labelled first (the rehearsal reporter
# applies `priority` to every issue blocking the VPS-own drive, #378; a human
# may hand-apply it to anything else), tracker order preserved within a group.
# Concatenation, never sort_by, so within-group order is provably the tracker's.
# prompt.md's "pick the first task" makes this list order the scheduler. The
# `priority`/`blocker` helper flags are stripped before emit; the contract stays
# {number, title, body, url} plus the additive `.model` (#448) — which survives
# the del below, the per-ticket override run-swarm.sh reads from .[0].model.
jq --argjson blockers "$blocker_nums" '
  map(. + {blocker: ((.number) as $n | ($blockers | index($n)) != null)})
  | ( [.[] | select(.blocker and .priority)]
    + [.[] | select(.blocker and (.priority | not))]
    + [.[] | select((.blocker | not) and .priority)]
    + [.[] | select((.blocker | not) and (.priority | not))] )
  | map(del(.priority, .blocker))' <<<"$ready"
