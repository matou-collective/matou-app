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

# Every claim call is BOUNDED (#28). The Actions listing this lib reads is the
# harness's hottest API read (limit=100, once per claim and once per janitor
# sweep) and Forgejo's sibling `/actions/runs` stopped answering inside 60 s on
# the big repos (2026-08-22, GOTCHAS 16) — an untimed curl on a degraded forge
# does not RED a tick, it stalls one: the claim never returns, the run keeps
# its host-capacity slot, and the ticket says nothing. 30 s is the timeout
# schedule-backstop.sh, heal.sh and forgejo-lib.sh already use.
CLAIM_API_MAX_TIME="${CLAIM_API_MAX_TIME:-30}"

# ── #1279: liveness ≠ tracker-slow ──────────────────────────────────────────
# On the #1235 archive drive (2026-09-05/06) the tracker cost more wall-clock
# than the model did — #1246 waited 80 min and #1247 nearly 3 h on claim churn
# alone — because a slow `actions/tasks` read was being read as "run dead". Two
# knobs make a slow tracker a RETRY, never a death sentence:
#   - CLAIM_ALIVE_RETRIES: a timed-out / 5xx alive poll BACKS OFF and re-reads
#     (bounded) before the caller may conclude anything. The library default is
#     2 for the HOST-mode janitor (no wall-clock ceiling); claim-next-task.sh
#     sets 0 for its in-sandbox prefetch, which is bound by the 30 s
#     prompt-expansion budget and fails closed fast by design (idss#1195).
#   - CLAIM_ALIVE_RETRY_SLEEP: backoff seconds between those re-reads. Tests set
#     0 so the suite does not actually sleep.
CLAIM_ALIVE_RETRIES="${CLAIM_ALIVE_RETRIES:-2}"
CLAIM_ALIVE_RETRY_SLEEP="${CLAIM_ALIVE_RETRY_SLEEP:-2}"
# The host-side completion log the stale-claim sweeper keys on (#1279 ask 1): a
# claim whose run has a recorded TERMINAL verdict here is swept without waiting
# on the tracker at all. Same default path run-swarm.sh / landing-lib.sh write.
CLAIM_VERDICT_LOG="${CLAIM_VERDICT_LOG:-${SWARM_RUNLOG:-$HOME/swarm/logs/run-swarm-verdicts.log}}"
# Absence-based sweeping (#1279 ask 1, second arm): a claim whose run is absent
# from a SUCCESSFUL alive poll is not swept on the strength of one poll — a
# slow/partial-but-200 tracker response would false-sweep a live run. A run must
# be absent across this many consecutive SUCCESSFUL polls (state kept per run id
# under CLAIM_ABSENCE_STATE_DIR) before an absence-only sweep. A failed poll
# never counts (fail-closed). The verdict-log signal above is exempt — a recorded
# terminal verdict is proof, not a guess, and sweeps on the first pass.
CLAIM_ABSENCE_THRESHOLD="${CLAIM_ABSENCE_THRESHOLD:-2}"
CLAIM_ABSENCE_STATE_DIR="${CLAIM_ABSENCE_STATE_DIR:-$HOME/swarm/state/claim-absence}"
# Optional per-read latency sink so the p95 the budgets are sized to (#1279 ask
# 3) can be MEASURED off disk rather than guessed. Default unset = no-op; when
# set, claim_alive_runs appends `<epoch> dur=<n>s rc=<n>` per read.
CLAIM_LATENCY_LOG="${CLAIM_LATENCY_LOG:-}"

_claim_api() { curl -sf --max-time "$CLAIM_API_MAX_TIME" -H "Authorization: token $FORGEJO_TOKEN" "$@"; }

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
  # Name match is `swarm` OR `swarm (<suffix>)` (#541): swarm.yml's matrix
  # makes Forgejo suffix each matrix job's name — the worker index under the
  # 2-wide pool matrix (44fe333, live-probed 2026-08-15: "swarm (1)"/"swarm
  # (2)"), the host label under the per-host matrix (GOTCHAS 62: "swarm
  # (<host>)") — never bare "swarm". An exact-match filter (the pre-matrix original)
  # silently always returned [], so claim_won's arbitration only ever saw a
  # caller's OWN claim as alive and every racing host "won" — two hosts fully
  # implemented #536 before either noticed the other.
  # #1279: a timed-out / 5xx read is the tracker being SLOW, not the run being
  # dead. Retry (bounded, with backoff) before surfacing the failure, so a
  # transient blip does not force the caller's fail-closed arm — the janitor
  # then drops a live claim, claim-next-task then churns a whole cron cycle. The
  # jq filter and the rc-nonzero-on-final-failure contract are unchanged; only
  # WHETHER we re-read on failure is new (retries default 0 in the sandbox).
  local raw rc attempt=0 t0 dur
  while :; do
    t0="$(date +%s)"
    # `|| rc=$?` (not a bare `raw=$(...)`) so a curl failure is CAPTURED, not an
    # exit under a sourcing caller's `set -e` (claim-next-task.sh) — the same
    # guard the original single-shot `... || return 1` relied on.
    rc=0; raw="$(_claim_api "$FORGEJO_API/actions/tasks?limit=100&page=1")" || rc=$?
    if [ -n "$CLAIM_LATENCY_LOG" ]; then
      dur=$(( $(date +%s) - t0 ))
      printf '%s dur=%ss rc=%s\n' "$t0" "$dur" "$rc" >>"$CLAIM_LATENCY_LOG" 2>/dev/null || true
    fi
    if [ "$rc" -eq 0 ]; then
      jq -c '[.workflow_runs[]? | select((.name == "swarm" or (.name | test("^swarm \\("))) and (.status == "running" or .status == "waiting")) | .run_number]' <<<"$raw"
      return 0
    fi
    [ "$attempt" -ge "$CLAIM_ALIVE_RETRIES" ] && return "$rc"
    attempt=$((attempt + 1))
    if [ "${CLAIM_ALIVE_RETRY_SLEEP:-0}" -gt 0 ] 2>/dev/null; then sleep "$CLAIM_ALIVE_RETRY_SLEEP"; fi
  done
}

claim_run_terminal() { # claim_run_terminal <run> [<logfile>] -> rc 0 if run N has a recorded TERMINAL verdict
  # #1279 ask 1: the host-side run-swarm-verdicts.log records one line per run
  # EXIT (reason=completed / died-in:* / no-worker-spawned / …), stamped with
  # `run=<id>` — the same Actions run number a swarm-claim carries. A claim whose
  # run appears there has demonstrably finished, so its lingering comment/label
  # can be swept without consulting the (possibly unreachable) tracker at all —
  # exactly the #1247 deadlock, where the janitor could not sweep because every
  # alive poll timed out. The pre-merge `pr-opened` breadcrumb is written while
  # the run is STILL alive (landing-lib.sh), so it is explicitly NOT terminal.
  local run="$1" log="${2:-$CLAIM_VERDICT_LOG}"
  [ -n "$run" ] && [ "$run" != 0 ] || return 1
  [ -f "$log" ] || return 1
  grep -E "(^|[[:space:]])run=${run}\$" "$log" 2>/dev/null | grep -qv 'reason=pr-opened'
}

_claim_absence_key() { printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_'; }

_claim_absence_bump() { # _claim_absence_bump <run> -> echoes the new consecutive-absence count (rc 1 if state unwritable)
  local run="$1" f n
  mkdir -p "$CLAIM_ABSENCE_STATE_DIR" 2>/dev/null || return 1
  f="$CLAIM_ABSENCE_STATE_DIR/$(_claim_absence_key "$run")"
  n="$(cat "$f" 2>/dev/null || echo 0)"; case "$n" in ''|*[!0-9]*) n=0 ;; esac
  n=$((n + 1))
  printf '%s' "$n" >"$f" 2>/dev/null || return 1
  printf '%s\n' "$n"
}

_claim_absence_reset() { # _claim_absence_reset <run> — clears a run's absence streak (it was seen alive, or swept)
  rm -f "$CLAIM_ABSENCE_STATE_DIR/$(_claim_absence_key "$1")" 2>/dev/null || true
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

claim_fresh_runs() { # claim_fresh_runs <issue> <max_age_seconds> [<now_epoch>] -> JSON array of runs whose claim comment is YOUNGER than max_age | rc 1 on API failure
  # #1412: a claim comment is a leader-election marker, but nothing expires it.
  # A session/run that dies, is killed, times out, or loses its host between
  # claiming and finishing leaves its `swarm-claim` comment behind forever. On an
  # agent-working ticket the janitor (janitor_sweep) / the session-runner's
  # stale-claim sweep eventually reap it — but once the ticket returns to
  # ready-for-session those sweeps NEVER visit it again (both filter on
  # agent-working), so the comment becomes a TOMBSTONE. The session-runner's
  # arbitration treated every present claim as a live contender, so one tombstone
  # with a lower comment id outranked every future live claim and wedged the
  # ticket forever (#1373 sat ready-for-session for an hour).
  # This filters the alive-set by AGE, the way HOST_CAPACITY_DRIVE_WANTED_TTL
  # expires a stale drive reservation: a session-runner session is bounded by
  # SESSION_RUNNER_TIMEOUT and a swarm run by its own job timeout, so a claim that
  # has outlived max_age cannot be live — drop its run and claim_won skips it. now
  # is injectable for hermetic tests; production reads the wall clock. A comment
  # with a missing/unparseable created_at is kept (fail-closed: an un-ageable
  # claim is treated as live, never stolen). Same raw-capture-then-filter
  # discipline as the readers above (finding 1): a curl failure returns rc 1, not
  # a degraded '[]'.
  local raw now="${3:-}"
  [ -n "$now" ] || now="$(date -u +%s)"
  raw="$(_claim_api "$FORGEJO_API/issues/$1/comments")" || return 1
  jq -c --argjson max "$2" --argjson now "$now" '
    [ .[]
      | select(.body | test("^swarm-claim host=\\S+ run=[0-9]+"))
      | (.body | capture("run=(?<r>[0-9]+)").r | tonumber) as $run
      | (try (.created_at | fromdateiso8601) catch null) as $t
      | if ($t == null) or (($now - $t) <= $max) then $run else empty end ]' <<<"$raw"
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

claim_owned_by_run() { # claim_owned_by_run <issue> <run> -> 0 owned; 1 reachable but NO claim for this run; 3 tracker unreachable
  # The COMMIT-time counterpart to claim_won (git-hooks/commit-msg, #1717).
  # claim_won answers "did I win the race for a claim I posted?"; this answers
  # the blunter question a mechanical gate needs before any work lands: does a
  # `swarm-claim host=... run=<run>` for THIS run exist on the issue at all? Its
  # absence is exactly what let run 29782's elitebook worker implement #1713
  # with no claim of its own — duplicate work whose orphan commit poisoned the
  # shared workdir's local main and RED the merge-to-main sync, and which
  # NOTHING mechanical refused (close-report's gates only run at CLOSE, and a
  # lost push race never reaches them).
  #
  # The three return codes are the whole contract, so the caller picks its fail
  # posture: rc 0 owned (allow); rc 1 the tracker was READ and holds no such
  # claim (the real refusal — fail CLOSED); rc 3 the tracker could not be reached
  # (_claim_comments's own curl failure — the caller FAILS OPEN, because a forge
  # blip must never wedge an honestly-claimed worker mid-iteration, the same
  # fail-open the pre-push drift gate takes on an unreachable factory).
  local issue="$1" run="$2" comments cid r
  [ -n "$run" ] && [ "$run" != 0 ] || return 1
  comments="$(_claim_comments "$issue")" || return 3
  while read -r cid r; do
    [ -n "$cid" ] || continue
    [ "$r" = "$run" ] && return 0
  done <<<"$comments"
  return 1
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
  # Timed out like every other claim call (#28) — curl writes `000` for a
  # timeout, which lands on the same non-2xx page-loudly path as a real 403.
  code="$(jq -n --argjson l "$lid" '{labels: [$l]}' |
    curl -s -o /dev/null -w '%{http_code}' --max-time "$CLAIM_API_MAX_TIME" \
      -H "Authorization: token $FORGEJO_TOKEN" \
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
  local alive alive_rc lid page batch count comments num cid run any_live claim_count cnt
  # #1279: liveness ≠ tracker-slow. claim_alive_runs already RETRIES a timed-out
  # / 5xx poll before it fails (see above), so a mere blip no longer surfaces as
  # a failure here at all. When it STILL fails, the sweep does NOT abort — the
  # verdict-log signal (claim_run_terminal) is tracker-independent and can sweep
  # a demonstrably-finished run's stale claim even with the tracker unreachable
  # (the #1247 deadlock, where every alive poll timed out and the janitor could
  # therefore sweep nothing). What a failed poll forfeits is ABSENCE-based
  # sweeping, which needs the alive list: with no verdict and no alive data a
  # claim is treated as live (fail-closed, finding-1 preserved — T10).
  alive="$(claim_alive_runs)"; alive_rc=$?
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
      any_live=""       # a claim on this issue we could NOT prove dead
      claim_count=0
      while read -r cid run; do
        [ -n "$cid" ] || continue
        claim_count=$((claim_count + 1))
        # 1. A recorded terminal verdict is proof of death — no tracker needed.
        if claim_run_terminal "$run"; then
          continue
        fi
        # 2. No verdict AND no alive data (poll failed) → cannot prove dead.
        if [ "$alive_rc" -ne 0 ]; then
          any_live=1
          continue
        fi
        # 3. Present in a SUCCESSFUL alive snapshot → live; streak resets.
        if jq -e --argjson r "$run" 'index($r) != null' <<<"$alive" >/dev/null; then
          _claim_absence_reset "$run"; any_live=1
          continue
        fi
        # 4. Absent from a SUCCESSFUL poll — sweep only after the run has been
        #    absent across CLAIM_ABSENCE_THRESHOLD consecutive successful polls,
        #    so one slow/partial-but-200 response cannot false-sweep a live run.
        cnt="$(_claim_absence_bump "$run" || echo 0)"
        if [ "${cnt:-0}" -lt "$CLAIM_ABSENCE_THRESHOLD" ]; then
          any_live=1
        fi
      done <<<"$comments"
      # Sweep when every claim is provably dead. A label with NO claim comment is
      # an orphan — reclaim it only on a SUCCESSFUL poll (evidence the tracker is
      # reachable), never on a failed one (fail-closed).
      if { [ "$claim_count" -gt 0 ] && [ -z "$any_live" ]; } ||
         { [ "$claim_count" -eq 0 ] && [ "$alive_rc" -eq 0 ]; }; then
        while read -r cid run; do
          [ -n "$cid" ] || continue
          _claim_api -X DELETE "$FORGEJO_API/issues/comments/$cid" >/dev/null || true
          _claim_absence_reset "$run"
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
