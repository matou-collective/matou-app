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

SECONDS=0   # wall-clock for the drive-blocker ordering budget below

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# #111: a rehearsal drive reserved host capacity AFTER this run began. The
# host gate (schedule_drive_yield) runs once, before the slot is taken; the
# sandcastle loop then drains up to maxIterations tasks with nothing
# re-checking the reservation — a queue-draining run held slot 2 for hours
# while a ready drive skipped 20+ ticks. main.mts mirrors the host's FRESH
# reservation into every sandbox as /run/host-signals/drive-wanted (a
# read-only mount, polled every 2 s); when it is there this lister answers
# [] BEFORE any API call — so claim-next-task.sh claims nothing more and the
# prompt's "Done" re-check sees an empty set and completes. The run finishes
# its CURRENT task, lands it, releases the slot, and exits
# reason=yielded-to-drive; the drive fires and the swarm resumes on its next
# trigger. Host-side callers never see the mount, so nothing changes there.
drive_signal="${SWARM_DRIVE_YIELD_SIGNAL:-/run/host-signals/drive-wanted}"
if [ -e "$drive_signal" ]; then
  echo "list-ready-tasks: a rehearsal drive has reserved host capacity mid-run (#111) — answering [] so this run claims nothing more and yields after its current task" >&2
  echo '[]'
  exit 0
fi
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
# THIRD means (#1468, body-marker, per-ticket-safe): a rehearsal-CONFIRM ticket
# on the executor rail (REHEARSAL_DRIVE_QUEUE) is a host-mode drive too but wears
# neither the standing-drive label nor this host's REHEARSAL_DRIVE_ISSUE number —
# it is excluded below by the `<!-- rehearsal-target: <value> -->` body marker it
# carries, a fact that travels WITH the ticket so ALL swarm hosts skip it
# regardless of their own drive-issue env (see the select on `unblocked`).
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

# #142: a bare `curl -sf` threw the HTTP status away and returned 22 for ANY
# failure, so schedule-lib's verdict guessed "transient Forgejo 5xx" for every
# rc — an expired token (401) or a lost repo (404) then read, forever, as a
# self-healing outage while the swarm was permanently stalled. Capture the
# status the failure is IN HAND at (`-o body -w %{http_code}`, dropping bare
# `-f`), and on exhaustion write ONE stderr line naming the endpoint and the
# last status. schedule_list_ready_or_verdict words the verdict from that line —
# a 4xx is a rejection the swarm cannot self-heal, a 5xx/000 is transient.
api() {
  local url="${*: -1}" attempt=1 delay="$LIST_READY_BACKOFF" http crc body ep
  body="$(mktemp)"
  while :; do
    http="$(curl -s -o "$body" -w '%{http_code}' --max-time "$LIST_READY_MAX_TIME" \
      -H "Authorization: token $FORGEJO_TOKEN" "$@")" && crc=0 || crc=$?
    if [ "$crc" -eq 0 ] && [ "${http:-0}" -ge 200 ] && [ "${http:-0}" -lt 300 ]; then
      cat "$body"; rm -f "$body"; return 0
    fi
    [ "$attempt" -ge "$LIST_READY_RETRIES" ] && break
    sleep "$delay"
    delay=$((delay * 2))
    attempt=$((attempt + 1))
  done
  # Exhausted: name WHAT failed and the last status, so the verdict is worded
  # from an observation and not a guess. `000` is curl's transport failure
  # (timeout/DNS/connection), not an HTTP reply.
  ep="${url#"$FORGEJO_API"}"; ep="${ep%%\?*}"
  echo "list-ready-tasks: GET $ep failed after $LIST_READY_RETRIES attempts (last http=${http:-000})" >&2
  rm -f "$body"
  return 22
}

# #128 (matou-app#286): the /pulls listing (LANDING=pr) and the standing-drive
# listing share no data with each other or with the issues-page + dependency
# fan-out below — yet ran SERIALLY after it, summing to 15-26s of the lister's
# runtime (the /pulls leg alone ~1.4s per open PR). Kick both independent
# listings off in the BACKGROUND here so they overlap the main loop, and reap
# them at their use sites; setup collapses to max(legs) (~13s with 7 open PRs,
# was 26s). Each fetch's rc is captured at the reap (off `wait`, never tripping
# set -e), so its prior ruling is preserved EXACTLY: /pulls fail-OPEN (a failed
# fetch drops nothing), the standing-drive listing fail-to-UNPROMOTED
# (blocker_nums stays []). Background jobs can't write a command substitution, so
# each streams to a temp file reaped by an EXIT trap.
bg_files=""
cleanup_bg() { [ -n "$bg_files" ] && rm -f $bg_files; return 0; }
trap cleanup_bg EXIT

pulls_pid=""
if [ "${SWARM_POLICY_LANDING:-push}" = pr ]; then
  pulls_file="$(mktemp)"; bg_files="$bg_files $pulls_file"
  api "$FORGEJO_API/pulls?state=open&limit=50" >"$pulls_file" & pulls_pid=$!
fi

# The standing-drive listing is backgrounded only when the drive-blocker budget
# is not already spent at t=0 — i.e. always in production (default 8s), but a
# consumer that DISABLES drive-blocker ordering with LIST_READY_DRIVE_BUDGET=0
# pays zero listing cost (the #120 guarantee, now "don't even start the fetch"
# rather than "skip it after paying for it"). SECONDS is ~0 here, so this gate
# fires only for a <=0 budget.
drives_pid=""
if [ "$SECONDS" -lt "${LIST_READY_DRIVE_BUDGET:-8}" ]; then
  drives_file="$(mktemp)"; bg_files="$bg_files $drives_file"
  api "$FORGEJO_API/issues?state=open&type=issues&labels=standing-drive&limit=50" >"$drives_file" & drives_pid=$!
fi

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
  # #1468: a rehearsal-CONFIRM ticket on the executor rail (REHEARSAL_DRIVE_QUEUE)
  # is a host-mode live drive too, but carries NEITHER the standing-drive label
  # (it is a one-off confirm, not a re-mintable tracker) NOR this host's
  # REHEARSAL_DRIVE_ISSUE number (that points at the host's OWN rehearsal, 657,
  # not 1447) — so a generic swarm host passed it every filter above and
  # hot-loop mis-claimed it (bens-mac-04 run 23886), a claim it structurally
  # cannot honour (#377: no /dev/kvm, no drive creds) and cannot blocked-path
  # (removing ready-for-agent sabotages the executor's gate). Exclude it by the
  # `<!-- rehearsal-target: <value> -->` BODY MARKER that every queued drive
  # ticket carries (scripts/lib/rehearsal-queue-lib.sh:rehearsal_issue_marker) —
  # a per-ticket fact that travels WITH the ticket, so ALL swarm hosts skip it
  # regardless of their own drive-issue env. The regex mirrors the lib's parser,
  # requiring a real value after the key so a prose mention doesn't match.
  # The marker is read outside fenced blocks only — a fence can hold outside
  # input (body-marker.jq).
  unblocked="$(jq -r -L "$here" --arg drive "$REHEARSAL_DRIVE_ISSUE" \
      'include "body-marker";
       .[]
       | select((((.labels // []) | map(.name) | index("standing-drive")) == null)
                and ((.number | tostring) != $drive)
                and (((.body // "") | outside_fences | test("<!--[[:space:]]*rehearsal-target:[[:space:]]*[^[:space:]]+[[:space:]]*-->")) | not))
       | .number' <<<"$batch" | xargs -r -P 10 -n 1 bash -c '
    set -euo pipefail
    # Same transient-5xx posture as api() above (#52): the dependency GET is a
    # `curl -sf` too, so a blip here would abort the whole listing under the
    # xargs failure propagation. Retry with backoff, each attempt --max-time
    # bounded; raw-capture then jq (never curl|jq, which merges curl'"'"'s failure
    # into jq'"'"'s exit — claim-lib finding-1). A persistent failure still exits 1
    # (which xargs propagates as 123) so a blocker that could not be verified
    # closed is never emitted. #142: capture the status (-o body -w code, not
    # bare -f) and, on exhaustion, name the endpoint and last status on stderr —
    # otherwise the failure reaches the verdict as a bare 123 with no cause.
    attempt=1; delay="${LIST_READY_BACKOFF:-2}"; raw=""; http=""
    bodyf="$(mktemp)"
    while :; do
      http="$(curl -s -o "$bodyf" -w "%{http_code}" --max-time "${LIST_READY_MAX_TIME:-30}" \
          -H "Authorization: token $FORGEJO_TOKEN" \
          "$FORGEJO_API/issues/$0/dependencies?limit=50")" && crc=0 || crc=$?
      if [ "$crc" -eq 0 ] && [ "${http:-0}" -ge 200 ] && [ "${http:-0}" -lt 300 ]; then
        raw="$(cat "$bodyf")"; rm -f "$bodyf"; break
      fi
      if [ "$attempt" -ge "${LIST_READY_RETRIES:-3}" ]; then
        echo "list-ready-tasks: GET /issues/$0/dependencies failed after ${LIST_READY_RETRIES:-3} attempts (last http=${http:-000})" >&2
        rm -f "$bodyf"; exit 1
      fi
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
  # `landing_label` / `landing` (idss ADR 0267) are the additive per-ticket
  # LANDING override, surfaced the same way: the raw `landing-<suffix>` label (or
  # null) and the mode it resolves to (the repo default when unlabelled). An
  # unknown suffix is surfaced RAW so the host-side gate can name the ticket.
  nums="$(printf '%s\n' "$unblocked" | jq -Rn '[inputs | select(length > 0) | tonumber]')"
  ready="$(jq --slurpfile batch <(printf '%s' "$batch") --argjson nums "$nums" \
      --arg landing_default "${SWARM_POLICY_LANDING:-push}" \
    '. + [$batch[0][] | select(.number as $n | $nums | index($n) != null)
      | select(((.labels // []) | map(.name) | index("agent-working")) == null)
      | ((.labels // []) | map(.name) | map(select(startswith("landing-")))
         | if length == 0 then null else (.[0] | ltrimstr("landing-")) end) as $ll
      | {number, title, body, url: .html_url,
         priority: ((.labels // []) | map(.name) | index("priority") != null),
         model: ((.labels // []) | map(.name) | map(select(startswith("model-")))
                 | if length == 0 then null else (.[0] | ltrimstr("model-")) end),
         landing_label: $ll,
         landing: ($ll // $landing_default)}]' \
    <<<"$ready")"

  [ "$count" -lt 50 ] && break
  page=$((page + 1))
done

# An issue with an OPEN agent PR (agent/issue-<N>) is already being landed and
# awaiting a human's merge — drop it so the swarm neither re-claims nor re-works
# it (#13). Two ways a ticket lands by PR: the repo default is `pr`, or the
# ticket carries `landing-pr` in a push repo (idss ADR 0267). The second case
# pays for the /pulls read ONLY when such a ticket is actually ready, so a repo
# with no landing-* label is byte-identical to before (no /pulls call at all).
open_pr_nums=""
if [ "${SWARM_POLICY_LANDING:-push}" = pr ]; then
  # #128: reap the /pulls fetch kicked off at the top. fail-OPEN preserved — a
  # non-zero fetch (rc captured off `wait`, never tripping set -e) yields an
  # empty PR list that drops nothing, exactly as the old `|| true` did.
  pulls_rc=0; wait "$pulls_pid" || pulls_rc=$?
  if [ "$pulls_rc" -eq 0 ]; then
    open_pr_nums="$(jq -r '.[]? | (.head.ref // "") | select(test("^agent/issue-[0-9]+$")) | sub("^agent/issue-";"")' \
      <"$pulls_file" 2>/dev/null || true)"
  fi
elif jq -e 'any(.[]; .landing == "pr")' <<<"$ready" >/dev/null 2>&1; then
  # Raw-capture then filter (never curl|jq). fail-OPEN, like the pr-repo leg: a
  # failed read drops nothing, and the worst case is a re-claimed ticket whose
  # land-pr.sh finds its PR already open and refreshes it.
  pulls_json="$(api "$FORGEJO_API/pulls?state=open&limit=50" 2>/dev/null)" || pulls_json='[]'
  open_pr_nums="$(jq -r '.[]? | (.head.ref // "") | select(test("^agent/issue-[0-9]+$")) | sub("^agent/issue-";"")' \
    <<<"$pulls_json" 2>/dev/null || true)"
fi
if [ -n "$open_pr_nums" ]; then
  drop="$(printf '%s\n' $open_pr_nums | jq -Rn '[inputs | select(length > 0) | tonumber]')"
  if [ "${SWARM_POLICY_LANDING:-push}" = pr ]; then
    ready="$(jq --argjson drop "$drop" \
      'map(select(.number as $n | ($drop | index($n)) == null))' <<<"$ready")"
  else
    # push repo: only a ticket that itself lands by PR is "being landed" by an
    # open agent/issue-<N> branch.
    ready="$(jq --argjson drop "$drop" \
      'map(select((.landing != "pr") or (.number as $n | ($drop | index($n)) == null)))' <<<"$ready")"
  fi
fi

# Run parity (idss ADR 0267). One Sandcastle run shares ONE worktree across its
# iterations, so a push-ticket iteration that follows a PR-ticket iteration
# would carry the PR ticket's commit onto main underneath its own. The run's
# landing is therefore fixed HOST-side from the head ticket (preflight-lib.sh,
# the per-run-model precedent) and mirrored into every sandbox as a read-only
# file beside the drive-yield signal:
#   `pr <N>`  this run works ticket N and nothing else;
#   `push`    this run never sees a ticket that lands by PR.
# The signal DIRECTORY tells host from sandbox: absent = a host-side listing (or
# a manual run), which must see every ticket to choose the parity at all.
# Present with no/garbled file = a sandbox nobody gated — fail SAFE to `push`.
# Only a push-default repo needs any of this: in a LANDING=pr repo every ticket
# already lands on its own branch.
if [ "${SWARM_POLICY_LANDING:-push}" = push ]; then
  run_landing_signal="${SWARM_RUN_LANDING_SIGNAL:-/run/host-signals/run-landing}"
  if [ -d "$(dirname "$run_landing_signal")" ]; then
    run_landing="$(head -1 "$run_landing_signal" 2>/dev/null || true)"
    case "$run_landing" in
      "pr "[0-9]*)
        ready="$(jq --arg n "${run_landing#pr }" 'map(select((.number | tostring) == $n))' <<<"$ready")" ;;
      *)
        hidden="$(jq -r '[.[] | select(.landing != "push") | "#\(.number)"] | join(" ")' <<<"$ready")"
        [ -z "$hidden" ] || echo "list-ready-tasks: push-parity run — hiding ticket(s) that land by PR (or carry an unknown landing-* label): $hidden" >&2
        ready="$(jq 'map(select(.landing == "push"))' <<<"$ready")" ;;
    esac
  fi
fi

# Forgejo IGNORES an unknown `labels=` filter instead of matching nothing: in a
# repo with no `standing-drive` label the query above returns EVERY open issue
# (probed live 2026-08-27 on matou-app — 23 of 23, none carrying the label).
# That made this block one SERIAL dependencies call per OPEN ISSUE: 25.5s of the
# lister's 29.7s, which alone blew Sandcastle's 30s shell-expression budget and
# REDed the tick as `PromptExpansionTimeoutError` (run 7707) — before
# claim-next-task.sh's CLAIM_NEXT_BUDGET could even be consulted, since that
# guard lives inside the claim walk this lister runs BEFORE. It also poisoned
# the ordering it exists to fix, promoting any ready ticket that blocks ANY open
# issue as a "drive blocker". Re-filter the response CLIENT-side on the label we
# actually asked for, so a repo with no standing drive does zero extra calls and
# blocker_nums stays [] (the emit order below is then byte-identical to before —
# the same fallback this block already documents). A repo that DOES carry the
# label is unaffected: server filter and client filter agree.
#
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
# #120/#128: the budget must bound the WHOLE drive-blocker block. #120 measured
# the `labels=standing-drive` listing call at 5.5-12.7s on matou-app (Forgejo
# IGNORES an unknown labels= filter, dumping every open issue) and gated it
# BEFORE the fetch; #128 moves that fetch to the BACKGROUND at the top so its
# cost overlaps the main loop entirely. The gate now decides at t=0 whether to
# START the fetch (`drives_pid` set ⇔ budget > 0) — a spent/zero budget skips
# the listing exactly as before, leaving blocker_nums=[] and the emit order
# byte-identical to the documented no-standing-drive fallback. The per-drive
# dependency fan-out below is still bounded by the same wall clock.
if [ -z "$drives_pid" ]; then
  echo "list-ready-tasks: drive-blocker ordering skipped (budget ${LIST_READY_DRIVE_BUDGET:-8}s) — the standing-drive listing was not started; queue emitted unpromoted." >&2
elif drives_rc=0; wait "$drives_pid" || drives_rc=$?; [ "$drives_rc" -eq 0 ] && drives="$(cat "$drives_file")"; then
  for d in $(jq -r '.[]? | select((((.labels // []) | map(.name) | index("standing-drive"))) != null) | .number' <<<"$drives" 2>/dev/null || true); do
    # Wall-clock bound (belt and braces): even a repo with a genuinely deep
    # standing-drive list must not spend the whole 30s budget on ORDERING.
    # Stopping early keeps whatever blockers we resolved; the rest just lose
    # their front-of-queue promotion for this tick.
    if [ "$SECONDS" -ge "${LIST_READY_DRIVE_BUDGET:-8}" ]; then
      echo "list-ready-tasks: drive-blocker ordering stopped at ${SECONDS}s (budget ${LIST_READY_DRIVE_BUDGET:-8}s) — queue emitted unpromoted." >&2
      break
    fi
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
# {number, title, body, url} plus the additive `.model` (#448), `.landing_label`
# and `.landing` (idss ADR 0267) — which survive the del below; `.model` is the
# per-ticket override run-swarm.sh reads from .[0].model.
jq --argjson blockers "$blocker_nums" '
  map(. + {blocker: ((.number) as $n | ($blockers | index($n)) != null)})
  | ( [.[] | select(.blocker and .priority)]
    + [.[] | select(.blocker and (.priority | not))]
    + [.[] | select((.blocker | not) and .priority)]
    + [.[] | select((.blocker | not) and (.priority | not))] )
  | map(del(.priority, .blocker))' <<<"$ready"
