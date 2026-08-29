#!/usr/bin/env bash
# record-run-result.sh — #574: the ONLY place `main.mts`'s RunResult (host-
# side, available only after the sandbox exits) becomes swarm.db rows.
# `main.mts` discarding RunResult entirely left `attempts`/`spend` with ZERO
# production writers (schema + tests exist, nothing wrote them outside the
# test suite) — this script is what main.mts now shells out to once per run.
#
# main.mts cannot itself tell which issue each iteration worked —
# IterationResult (sessionId/logFilePath/usage) carries no issue field, and
# claiming one from RunResult.commits would need a git-log round trip per SHA
# with no guaranteed 1:1 mapping to iterations. Instead close-report.sh (run
# INSIDE the sandbox, in every outcome — success or gate-refused) prints one
# structured stdout line:
#
#   SANDCASTLE_ATTEMPT issue=<N> outcome=<success|blocked|refused> commits=<csv>
#
# This is a deliberate protocol line this script parses out of
# RunResult.stdout (combined across every iteration) — NOT the worker
# chain-of-thought prose grep verdict-lib.sh's header warns against — and
# zips against RunResult.iterations[] IN ORDER (prompt.md rule 7: one issue
# per iteration). A retry within one iteration (close-report refused, the
# agent fixed the envelope and re-ran it — up to twice, prompt.md) emits TWO
# markers for the SAME issue; markers are deduped by issue (last occurrence —
# the iteration's final outcome wins), first-seen order preserved for the zip.
# An iteration with NO marker at all (the blocked path never calls
# close-report.sh) still gets its token spend recorded, with issue left NULL.
#
# Usage: record-run-result.sh <run-id>   (payload on stdin)
#   stdin: {"stdout": "<RunResult.stdout>", "logFilePath": "<RunResult.logFilePath>",
#           "iterations": [{"sessionId": "...", "sessionFilePath": "...",
#                            "usage": {"inputTokens": N, "cacheCreationInputTokens": N,
#                                      "cacheReadInputTokens": N, "outputTokens": N}}, ...]}
#
# Best-effort throughout, swarm-db-lib.sh's own posture: a mirror write we
# cannot make must never fail the caller. Always exits 0.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=swarm-db-lib.sh
. "$here/swarm-db-lib.sh"
# shellcheck source=limit-lib.sh
. "$here/limit-lib.sh"
# shellcheck source=forgejo-lib.sh
. "$here/forgejo-lib.sh"   # #99: the timeline read behind the queue-wait event

# The host-global active-account marker (limit-lib.sh) reflects the account
# the sandbox actually ran on — record-run-result.sh runs host-side once the
# sandbox has exited, so the marker still names that account. Read it ONCE and
# stamp every spend row so the fleet monitor can attribute token spend per
# account (#75). Best-effort like everything else here: if limit-lib is somehow
# absent the letter defaults to A (the primary) rather than blocking the write.
active_account="$(claude_active_account 2>/dev/null || echo A)"

# #95: per-iteration wall-clock bounds. Sandcastle's IterationResult carries no
# start/end of its own (main.mts forwards only sessionId/sessionFilePath/usage),
# so the real per-iteration duration is derived HERE from the session jsonl's
# first and last message `timestamp` (ISO8601, e.g. 2026-08-26T02:00:00.000Z).
# Echoes "<start_epoch> <end_epoch>" only when at least one timestamp parses,
# else nothing — best-effort, this script's posture: a missing/unreadable/
# timestamp-less session file yields no timing, so the attempt's started_at
# falls back to the record-time default and its ended_at stays NULL for the
# run-end mass finaliser to close (kills-finalise invariant 2, untouched).
iter_time_bounds() {
  local session="$1"
  [ -n "$session" ] && [ -f "$session" ] || return 0
  jq -srR '
    [ splits("\n")
      | select(length > 0)
      | (fromjson? | .timestamp?)
      | select(type == "string")
      | sub("\\.[0-9]+Z$"; "Z")          # drop fractional seconds jq cannot parse
      | fromdateiso8601? ]
    | select(length > 0)
    | "\(min) \(max)"
  ' "$session" 2>/dev/null || true
}

run_id="${1:-}"
if [ -z "$run_id" ]; then
  echo "record-run-result: usage: record-run-result.sh <run-id> (payload on stdin)" >&2
  exit 0
fi

payload="$(mktemp 2>/dev/null)" || exit 0
markers="$(mktemp 2>/dev/null)" || { rm -f "$payload"; exit 0; }
trap 'rm -f "$payload" "$markers"' EXIT

cat > "$payload" 2>/dev/null || exit 0
jq -e . "$payload" >/dev/null 2>&1 \
  || { echo "record-run-result: stdin is not valid JSON — nothing recorded" >&2; exit 0; }

# Dedup by issue (last occurrence wins), first-seen order preserved — see the
# retry note above.
jq -r '.stdout // ""' "$payload" 2>/dev/null \
  | grep -E '^SANDCASTLE_ATTEMPT issue=[0-9]+ outcome=\S+ commits=' \
  | awk '
      {
        issue = $0; sub(/.*issue=/, "", issue); sub(/ .*/, "", issue)
        outcome = $0; sub(/.*outcome=/, "", outcome); sub(/ .*/, "", outcome)
        commits = $0; sub(/.*commits=/, "", commits)
        if (!(issue in seen)) { order[n++] = issue; seen[issue] = 1 }
        out[issue] = outcome; com[issue] = commits
      }
      END { for (i = 0; i < n; i++) { iss = order[i]; print iss "\t" out[iss] "\t" com[iss] } }
    ' > "$markers" 2>/dev/null || true

# The whole run's log file (RunResult.logFilePath — run-scoped, not per
# iteration) as one run-scoped event, so it isn't dropped alongside the
# per-iteration sessionFilePaths below.
run_log_path="$(jq -r '.logFilePath // ""' "$payload" 2>/dev/null)"
[ -n "$run_log_path" ] && swarmdb_event "$run_id" "" run-log "sandcastle run log file" "$run_log_path"

n_iter="$(jq '(.iterations // []) | length' "$payload" 2>/dev/null)"
case "$n_iter" in ''|*[!0-9]*) n_iter=0 ;; esac

i=0
while [ "$i" -lt "$n_iter" ]; do
  session_id="$(jq -r ".iterations[$i].sessionId // \"\"" "$payload" 2>/dev/null)"
  log_path="$(jq -r ".iterations[$i].sessionFilePath // \"\"" "$payload" 2>/dev/null)"
  in_tok="$(jq -r ".iterations[$i].usage.inputTokens // 0" "$payload" 2>/dev/null)"
  cache_c="$(jq -r ".iterations[$i].usage.cacheCreationInputTokens // 0" "$payload" 2>/dev/null)"
  cache_r="$(jq -r ".iterations[$i].usage.cacheReadInputTokens // 0" "$payload" 2>/dev/null)"
  out_tok="$(jq -r ".iterations[$i].usage.outputTokens // 0" "$payload" 2>/dev/null)"
  # #96: the three token classes price ~10x apart — keep them SEPARATE so a
  # dollar figure can be derived downstream. `input_tokens` is now FRESH input
  # only; cache-creation and cache-read go to their own columns. The real API
  # request count and the billing model are recorded when the usage block
  # exposes them (#98 populates them from the session jsonl); until then
  # `requests` falls back to 1 and `model` is left NULL rather than guessed.
  req="$(jq -r ".iterations[$i].usage.requests // empty" "$payload" 2>/dev/null)"
  case "$req" in ''|*[!0-9]*) req=1 ;; esac
  model="$(jq -r ".iterations[$i].usage.model // empty" "$payload" 2>/dev/null)"

  line="$(sed -n "$((i + 1))p" "$markers" 2>/dev/null || true)"
  issue=""; outcome=""; commits=""
  [ -n "$line" ] && IFS=$'\t' read -r issue outcome commits <<<"$line"

  # #95: real per-iteration start/end epochs from the session file, threaded into
  # the attempt row below. Both must be purely numeric before use; anything else
  # (no file, unparseable timestamps) leaves them empty and the attempt writer
  # omits the flag — started_at defaults to record-time, ended_at to the run-end
  # mass finaliser.
  iter_started=""; iter_ended=""
  read -r iter_started iter_ended <<<"$(iter_time_bounds "$log_path")" || true
  case "$iter_started" in ''|*[!0-9]*) iter_started="" ;; esac
  case "$iter_ended" in ''|*[!0-9]*) iter_ended="" ;; esac

  # events: sessionId + logFilePath — the rest of what RunResult carried.
  swarmdb_event "$run_id" "$issue" iteration "session=$session_id" "$log_path"

  # #99 (queue latency): how long the ticket sat claimable before a machine took
  # it — the backlog's core health number, recorded nowhere local. The claim
  # itself runs in the prompt-expansion sandbox (claim-next-task.sh), which has
  # NO swarm.db mount (main.mts mounts only secrets/worktrees/nix), so the write
  # lands HERE, host-side, where the issue is already known and both the tracker
  # AND swarm.db are reachable — ruled a two-way door on #99 (ADR 0174). ready→
  # claimed = agent-working-applied − ready-for-agent-applied, both read from the
  # tracker timeline (label ADD events, permanent history a later removal never
  # erases). Best-effort throughout, this script's posture: no tracker configured,
  # a missing/unreadable timeline entry, or a nonsensical (negative) delta writes
  # NO event and never fails the run.
  if [ -n "$issue" ] && [ -n "${FORGEJO_API:-}" ]; then
    ready_at="$(forgejo_label_applied_at "$issue" ready-for-agent 2>/dev/null || true)"
    claimed_at="$(forgejo_label_applied_at "$issue" agent-working 2>/dev/null || true)"
    # Both must be present AND purely numeric before any arithmetic; a claim that
    # never marked agent-working (a 403'd label write) or a timeline the parser
    # couldn't read leaves one empty, and we skip rather than error.
    case "$ready_at" in ''|*[!0-9]*) ready_at="" ;; esac
    case "$claimed_at" in ''|*[!0-9]*) claimed_at="" ;; esac
    if [ -n "$ready_at" ] && [ -n "$claimed_at" ] && [ "$claimed_at" -ge "$ready_at" ]; then
      swarmdb_event "$run_id" "$issue" queue-wait "$((claimed_at - ready_at))" \
        "ready-for-agent@$ready_at → agent-working@$claimed_at"
    fi
  fi

  # #98: the session jsonl carries the TRUE per-action record — every API request
  # with its own usage, every tool call. Ingest it into per-request `spend` rows
  # (cache classes split) and per-tool-call `events` (tool name + duration). This
  # runs host-side, best-effort: a missing/unparseable file just yields `0 0`.
  # When it lands ≥1 per-request row those REPLACE the single aggregate row below
  # (they sum to the same tokens — no double count); otherwise we fall back to
  # the RunResult usage aggregate, so an unreadable session is never dropped.
  ingested=0
  if [ -n "$log_path" ] && [ -f "$log_path" ]; then
    n_spend=0
    read -r n_spend _ <<<"$(swarmdb_ingest "$run_id" "$issue" "$log_path" "$active_account")" || n_spend=0
    case "$n_spend" in ''|*[!0-9]*) n_spend=0 ;; esac
    [ "$n_spend" -gt 0 ] && ingested=1
  fi

  # spend: every iteration's usage, whether or not it ever reached close-report.
  # --model is passed only when the block exposed one (empty => omitted => NULL).
  # Skipped entirely when the per-request ingest above already recorded the spend.
  if [ "$ingested" -eq 0 ]; then
    model_args=()
    [ -n "$model" ] && model_args=(--model "$model")
    if [ -n "$issue" ]; then
      swarmdb spend --run "$run_id" --issue "$issue" --input "$in_tok" --output "$out_tok" \
        --cache-creation "$cache_c" --cache-read "$cache_r" --requests "$req" \
        --account "$active_account" ${model_args[@]+"${model_args[@]}"}
    else
      swarmdb spend --run "$run_id" --input "$in_tok" --output "$out_tok" \
        --cache-creation "$cache_c" --cache-read "$cache_r" --requests "$req" \
        --account "$active_account" ${model_args[@]+"${model_args[@]}"}
    fi
  fi

  # attempts: only when close-report actually ran for this iteration — the
  # close_outcome wire (#574 item 2). status is earned ('success') only on the
  # gate's own success; every other outcome is omitted so the DB DEFAULT
  # 'fail' applies (swarm-db.py's invariant 1 — a crash/refusal never reads
  # green).
  if [ -n "$issue" ]; then
    # #95: pass the real iteration bounds when known. --ended set here means the
    # run-end mass finaliser (ended_at IS NULL) never touches this row; --ended
    # omitted leaves it NULL for that finaliser to close (invariant 2 intact).
    time_args=()
    [ -n "$iter_started" ] && time_args+=(--started "$iter_started")
    [ -n "$iter_ended" ] && time_args+=(--ended "$iter_ended")
    if [ "$outcome" = success ]; then
      swarmdb attempt --run "$run_id" --issue "$issue" --status success \
        --commits "$commits" --close-outcome "$outcome" ${time_args[@]+"${time_args[@]}"}
    else
      swarmdb attempt --run "$run_id" --issue "$issue" \
        --commits "$commits" --close-outcome "$outcome" ${time_args[@]+"${time_args[@]}"}
    fi
  fi

  i=$((i + 1))
done

exit 0
