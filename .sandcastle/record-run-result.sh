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
  total_in=$(( in_tok + cache_c + cache_r )) 2>/dev/null || total_in=0

  line="$(sed -n "$((i + 1))p" "$markers" 2>/dev/null || true)"
  issue=""; outcome=""; commits=""
  [ -n "$line" ] && IFS=$'\t' read -r issue outcome commits <<<"$line"

  # events: sessionId + logFilePath — the rest of what RunResult carried.
  swarmdb_event "$run_id" "$issue" iteration "session=$session_id" "$log_path"

  # spend: every iteration's usage, whether or not it ever reached close-report.
  if [ -n "$issue" ]; then
    swarmdb spend --run "$run_id" --issue "$issue" --input "$total_in" --output "$out_tok" --requests 1
  else
    swarmdb spend --run "$run_id" --input "$total_in" --output "$out_tok" --requests 1
  fi

  # attempts: only when close-report actually ran for this iteration — the
  # close_outcome wire (#574 item 2). status is earned ('success') only on the
  # gate's own success; every other outcome is omitted so the DB DEFAULT
  # 'fail' applies (swarm-db.py's invariant 1 — a crash/refusal never reads
  # green).
  if [ -n "$issue" ]; then
    if [ "$outcome" = success ]; then
      swarmdb attempt --run "$run_id" --issue "$issue" --status success \
        --commits "$commits" --close-outcome "$outcome"
    else
      swarmdb attempt --run "$run_id" --issue "$issue" \
        --commits "$commits" --close-outcome "$outcome"
    fi
  fi

  i=$((i + 1))
done

exit 0
