#!/usr/bin/env bash
# The swarm healer — deterministic orchestrator around one headless
# investigation (design: docs/superpowers/specs/2026-07-27-self-healing-swarm-design.md).
#
# Modes (HEAL_MODE): hook (default; a workflow's failure step calls us with
# WORKFLOW + RUN_URL) | watchdog (hourly healer.yml sweep).
# HEAL_DRY_RUN=1 → diagnose-only: the agent is told to change nothing and
# every post is prefixed [dry-run].
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/heal-lib.sh"
# shellcheck source=limit-lib.sh
. "$here/limit-lib.sh"
# shellcheck source=model-lib.sh
# The shared model config (#448): $SWARM_MODEL is the ONE value both this healer
# and the swarm worker (main.mts, via swarm.config) run on — no hardcoded id can
# drift between them anymore.
. "$here/model-lib.sh"

# Secrets: env wins (the workflow provides the authoritative value);
# the bind-mounted secrets file is the fallback for host runs
# (same precedence as list-ready-tasks.sh).
[ -z "${FORGEJO_TOKEN:-}" ] && [ -f "$here/secrets/forgejo_token" ] && FORGEJO_TOKEN="$(cat "$here/secrets/forgejo_token")"
# shellcheck source=swarm-identity.sh
. "$here/swarm-identity.sh"
# One runner serves TWO repos now (#238). Per-repo healer state must carry the
# repo slug or one repo's healer makes the other's skip its incident (the
# healer lock) and stomps its evidence dir. "Matou/ourcloud" -> "Matou-ourcloud"
# (slashes aren't valid in a path segment).
REPO_TAG="${FORGEJO_API##*/repos/}"; REPO_TAG="${REPO_TAG//\//-}"
MODE="${HEAL_MODE:-hook}"
WORKFLOW="${WORKFLOW:-unknown}"
WORKDIR="$HEAL_WORKDIR"
HEALER_STATE="${HEALER_STATE:-$WORKDIR/.sandcastle/.state/healer}"
mkdir -p "$HEALER_STATE"
NOW="$(date +%s)"
# Where each failing workflow drops its on-failure verdict (failing stage + first
# error lines). The runner is host-mode on the workstation and ci has no readable
# log API, so a well-known host path is how a run's real fault reaches the healer:
# `ci` via scripts/seam-smoke.sh (#197), `swarm`/`triage` via verdict-lib.sh
# (#235). Same repo-tagged defaults those scripts write to (#574) — REPO_TAG is
# already computed above from FORGEJO_API, same formula seam-smoke.sh derives
# from `git remote get-url origin` and run-swarm.sh/run-triage.sh derive from
# REPO_SLUG, so reader and writers always agree on the path.
SEAM_VERDICT="${SEAM_VERDICT_PATH:-/tmp/matou-$REPO_TAG-seam-verdict.txt}"
SWARM_VERDICT="${SWARM_VERDICT_PATH:-/tmp/matou-$REPO_TAG-swarm-verdict.txt}"
TRIAGE_VERDICT="${TRIAGE_VERDICT_PATH:-/tmp/matou-$REPO_TAG-triage-verdict.txt}"

# How fresh a verdict or worker log must be to count as evidence for THIS
# incident's run. Older artifacts (the stale 03:38 worker log that minted phantom
# #235 signatures) are context only, never the signature. Used as the relative
# `find -newermt "-$RUN_WINDOW"` cutoff — same "-N hours" form as the watchdog.
RUN_WINDOW="${HEAL_RUN_WINDOW:-2 hours}"

# verdict_path <workflow> — the on-failure verdict artifact for a workflow, empty
# for workflows that don't write one (the caller then keeps the legacy prose grep).
verdict_path() {
  case "$1" in
    ci)     printf '%s' "$SEAM_VERDICT" ;;
    swarm)  printf '%s' "$SWARM_VERDICT" ;;
    triage) printf '%s' "$TRIAGE_VERDICT" ;;
  esac
}

# verdict_is_fresh <file> — true iff it exists and was written within the run
# window. A verdict left by an earlier failed run (the workflow died before it
# could rewrite one) must NOT be trusted as this incident's fault (#235 AC2).
verdict_is_fresh() {
  [ -f "$1" ] && [ -n "$(find "$1" -newermt "-$RUN_WINDOW" 2>/dev/null)" ]
}

# One healer at a time PER REPO. Our OWN lock — never the swarm's — and
# per-repo (#238) so ourcloud's healer never blocks matou-app's incident.
exec 8>"/tmp/matou-healer-$REPO_TAG.lock"
flock -n 8 || { echo "heal: another healer holds the lock — exiting"; exit 0; }

# Per-repo evidence dir (#238): a repo-agnostic prefix left the two repos'
# incidents indistinguishable on disk.
EVIDENCE="$(mktemp -d "/tmp/matou-heal-$REPO_TAG.XXXXXX")"
echo "heal: evidence at $EVIDENCE (mode=$MODE workflow=$WORKFLOW)"

api() { curl -sf --max-time 30 -H "Authorization: token $FORGEJO_TOKEN" "$@"; }

gather_evidence() {
  local t0=$SECONDS
  # Probe the endpoint the automation actually depends on, paged: Forgejo
  # ignores limit without page and dumps the whole task table (~30s+ at
  # 1100 tasks; docs/research/2026-07-30-forgejo-actions-tasks-api.md).
  curl -sf --max-time 35 -o /dev/null \
    -H "Authorization: token $FORGEJO_TOKEN" \
    "$FORGEJO_API/actions/tasks?limit=1&page=1" \
    && echo "api_seconds=$((SECONDS - t0))" > "$EVIDENCE/api-timing.txt" \
    || echo "api_seconds=timeout" > "$EVIDENCE/api-timing.txt"
  api "$FORGEJO_API/actions/tasks?limit=50&page=1" > "$EVIDENCE/runs.json" 2>/dev/null \
    || echo '{"workflow_runs":[]}' > "$EVIDENCE/runs.json"
  # Scope worker logs to the triggering run (#235 AC2): only logs written within
  # the run window are evidence for THIS incident and feed the degrade-path grep.
  # Older worker chain-of-thought — the stale log that narrated an already-closed
  # ticket and minted phantom signatures — is kept only as a small, clearly
  # labelled tail of context, never mistaken for the current fault.
  : > "$EVIDENCE/worker-logs.txt"
  : > "$EVIDENCE/worker-logs-older.txt"
  local f nfresh=0 nolder=0
  for f in $(ls -t "$WORKDIR/.sandcastle/logs/"*.log 2>/dev/null); do
    if [ -n "$(find "$f" -newermt "-$RUN_WINDOW" 2>/dev/null)" ]; then
      [ "$nfresh" -lt 5 ] || continue
      { echo "===== ${f##*/} (tail, current run window)"; tail -c 20000 "$f"; echo; } >> "$EVIDENCE/worker-logs.txt"
      nfresh=$((nfresh + 1))
    else
      [ "$nolder" -lt 2 ] || continue
      { echo "===== ${f##*/} (tail, OLDER than the run window — context only, NOT the signature)"; tail -c 4000 "$f"; echo; } >> "$EVIDENCE/worker-logs-older.txt"
      nolder=$((nolder + 1))
    fi
  done
  journalctl -u forgejo-runner --since "-2 hours" --no-pager -q 2>/dev/null | tail -100 \
    > "$EVIDENCE/runner-journal.txt" || true
  {
    git -C "$WORKDIR" status --short 2>&1 | head -20
    git -C "$WORKDIR" log --oneline -5 2>&1
    ls "$WORKDIR/.git/rebase-merge" "$WORKDIR/.git/rebase-apply" 2>/dev/null || echo "no rebase in progress"
  } > "$EVIDENCE/workdir-git.txt" || true
  { df -h /; free -m; } > "$EVIDENCE/host.txt" 2>&1 || true
  # The triggering workflow's own verdict artifact (ci/swarm/triage), if the run
  # left a fresh one — so the diagnosis agent sees the same stage/fault the
  # signature keyed on. Copied only when fresh; a stale file is not this run's.
  local vf; vf="$(verdict_path "$WORKFLOW")"
  [ -n "$vf" ] && verdict_is_fresh "$vf" && cp "$vf" "$EVIDENCE/run-verdict.txt" 2>/dev/null || true
  # GLOBAL by design (#238): the swarm lock serializes one heavy worker per
  # host across both repos, so the healer probes the same shared lock.
  if flock -n /tmp/matou-swarm.lock -c true 2>/dev/null; then
    echo free > "$EVIDENCE/swarm-lock.txt"
  else
    echo held > "$EVIDENCE/swarm-lock.txt"
  fi
}

# The signature's raw material.
#
# For every workflow that drops a verdict artifact — `ci` (#197), now `swarm`
# and `triage` (#235) — key the signature on the run's OWN failing stage + first
# error line, so the incident signature tracks the ACTUAL fault. A moved fault →
# a new signature → a fresh investigation, instead of collapsing every failure
# within the cooldown onto one degraded workflow-name-only signature (a moved
# fault masked as "still failing"). Crucially, swarm/triage no longer grep the
# Sandcastle worker chain-of-thought (saturated with "error"/"failed" prose), so
# a stale worker log narrating an unrelated, already-closed ticket can no longer
# mint a phantom signature (the 2026-07-31 false positives this ticket fixes).
#
# With no fresh verdict, degrade to the workflow name alone (empty line) but
# leave a marker so every post says the "still failing" line is unverified (AC1).
#
# For any other workflow (e.g. a watchdog-detected name with no runner verdict):
# unchanged — the newest error-ish worker-log line, now already scoped to the
# run window by gather_evidence.
error_line() { # <workflow>
  local wf="${1:-$WORKFLOW}" vf sv
  vf="$(verdict_path "$wf")"
  if [ -n "$vf" ]; then
    if verdict_is_fresh "$vf"; then
      sv="$(seam_verdict_signal "$vf")"
      if [ -n "$sv" ]; then printf '%s' "$sv"; return; fi
    fi
    : > "$EVIDENCE/seam-degraded"   # marker read by handle_incident's posts
    return 0
  fi
  grep -hE "error|Error|ERR|failed|Failed|timed out|fatal" "$EVIDENCE/worker-logs.txt" 2>/dev/null | tail -1 || true
}

post() { # post <msg> [thread_root] → echoes post id (empty when chat unset)
  local msg="$1" root="${2:-}"
  [ -n "${HEAL_DRY_RUN:-}" ] && msg="[dry-run] $msg"
  bash "$here/notify-mattermost.sh" "$msg" "$root" || true
}

run_agent() { # <sig> <workflow> <errline> — 0 iff diagnosis.md was produced
  local sig="$1" wf="$2" errline="$3" ctx="$EVIDENCE/prompt.txt"
  {
    cat "$here/heal-prompt.md"
    echo; echo "## This incident"
    echo "- Mode: $MODE"
    echo "- Workflow: $wf"
    echo "- Run: ${RUN_URL:-n/a}"
    echo "- Signature: $sig"
    echo "- Trigger error line: ${errline:-unknown}"
    echo "- Swarm workdir: $WORKDIR"
    echo "- Evidence directory: $EVIDENCE (read every file)"
    echo "- Write your report to: $EVIDENCE/diagnosis.md"
    [ -n "${HEAL_DRY_RUN:-}" ] && echo "- DRY RUN: diagnose only. Make NO commits, NO pushes, file NO tickets."
  } > "$ctx"
  rm -f "$EVIDENCE/diagnosis.md"
  local status=0 heal_attempt=1
  claude_select_token
  while :; do
    status=0
    if [ -n "${HEAL_AGENT_CMD:-}" ]; then
      # Test seam: the stub receives the prompt as $1.
      timeout 900 ${HEAL_AGENT_CMD} "$(cat "$ctx")" > "$EVIDENCE/agent-out.log" 2>&1 || status=$?
    else
      ( cd "$WORKDIR" && timeout 900 claude -p --model "$SWARM_MODEL" \
          --dangerously-skip-permissions "$(cat "$ctx")" ) > "$EVIDENCE/agent-out.log" 2>&1 || status=$?
    fi
    # Shared detector (limit-lib.sh) — see the note in run-swarm.sh's guard. Mid-
    # diagnosis the claude call can itself hit the limit (the 0-byte agent-out.log
    # of the 2026-08-01 incident). First try the standby account (#510) — the
    # SAME limit-lib predicate decided both the hit and the flip, no second grep
    # anywhere. Only when both windows are exhausted (or no standby exists):
    # PARK the host so every other caller yields on the same window (#253),
    # record the deferral, and exit 0 BEFORE the ledger attempt below is
    # consumed — a limit refusal is not a spent diagnosis.
    if claude_limit_hit "$EVIDENCE/agent-out.log"; then
      if [ "$heal_attempt" = 1 ] && claude_failover; then
        heal_attempt=2
        echo "heal: Claude account limited — failed over to account $(claude_active_account); retrying the diagnosis once"
        continue
      fi
      claude_limit_park
      echo "deferred: limit window (claude refused mid-diagnosis)" > "$EVIDENCE/deferred-limit.txt"
      echo "heal: deferred — Claude usage limit mid-diagnosis; parked the host, no ledger attempt consumed"
      exit 0
    fi
    break
  done
  [ "$status" -eq 0 ] && [ -f "$EVIDENCE/diagnosis.md" ]
}

handle_incident() { # <workflow> <errline>
  local wf="$1" errline="$2" sig decision thread degraded=""
  sig="$(compute_signature "$wf" "$errline")"
  decision="$(ledger_decide "$sig" "$NOW")"
  thread="$(ledger_get "$sig" thread_id)"
  echo "heal: incident wf=$wf sig=$sig decision=$decision"
  # No readable seam evidence (error_line left the marker): the ci signature
  # degraded to the workflow name alone. Be honest about it on every post (AC3).
  [ -f "$EVIDENCE/seam-degraded" ] && degraded=$'\n:warning: signature degraded to workflow name (no fresh run verdict) — the recurrence status is unverified'

  case "$decision" in
    reply-recurring)
      post ":arrows_counterclockwise: still failing (\`$sig\`, $wf) — ${RUN_URL:-watchdog}${degraded}" "$thread" >/dev/null
      ledger_set "$sig" replies "$(( $(ledger_get "$sig" replies | grep -E '^[0-9]+$' || echo 0) + 1 ))"
      ;;
    escalate-noisy)
      # The reply cap is spent: say it once, with the operator action spelled
      # out, then go quiet for the rest of the cooldown. Silence here is the
      # point — the incident is already on the thread above.
      post "@ben :rotating_light: **$wf has failed ${HEAL_MAX_REPLIES}+ times with the same fault** (\`$sig\`) — the healer is going quiet on it until the cooldown expires or the fault changes. ${RUN_URL:-} · evidence: \`$EVIDENCE\` on matou-workstation" "$thread" >/dev/null
      ledger_set "$sig" escalated 1
      ;;
    silent)
      echo "heal: $sig already escalated and silenced — posting nothing"
      ;;
    escalate-repaired)
      post "@ben :rotating_light: **$wf recurred after a repair attempt** (\`$sig\`) — the healer will not retry. ${RUN_URL:-} · evidence: \`$EVIDENCE\` on matou-workstation" "$thread" >/dev/null
      ;;
    investigate|investigate-stale)
      local pid
      if run_agent "$sig" "$wf" "$errline"; then
        local head_lines act
        head_lines="$(head -c 3500 "$EVIDENCE/diagnosis.md")"
        act="$(sed -n 's/^ACTION-TAKEN: *//p' "$EVIDENCE/diagnosis.md" | head -1)"
        local esc; esc="$(sed -n 's/^ESCALATE: *//p' "$EVIDENCE/diagnosis.md" | head -1)"
        local ping=""; [ "$esc" = "yes" ] && ping="@ben "
        pid="$(post "${ping}:stethoscope: **Healer — $wf** (\`$sig\`) ${RUN_URL:-}${degraded}
$head_lines" "$thread")"
        [ -z "$thread" ] && [ -n "$pid" ] && ledger_set "$sig" thread_id "$pid"
        if [ -n "$act" ] && [ "$act" != "none" ] && [ -z "${HEAL_DRY_RUN:-}" ]; then
          ledger_set "$sig" repaired 1
        else
          ledger_set "$sig" repaired "$(ledger_get "$sig" repaired)"
          [ -z "$(ledger_get "$sig" repaired)" ] && ledger_set "$sig" repaired 0
        fi
      else
        pid="$(post "@ben :rotating_light: **$wf failed and the healer could not produce a diagnosis** — ${RUN_URL:-watchdog} · agent log + evidence: \`$EVIDENCE\` on matou-workstation" "$thread")"
        [ -z "$thread" ] && [ -n "$pid" ] && ledger_set "$sig" thread_id "$pid"
        [ -z "$(ledger_get "$sig" repaired)" ] && ledger_set "$sig" repaired 0
      fi
      ledger_set "$sig" workflow "$wf"
      [ -z "$(ledger_get "$sig" first_seen)" ] && ledger_set "$sig" first_seen "$NOW"
      ledger_set "$sig" attempts "$(( $(ledger_get "$sig" attempts | grep -E '^[0-9]+$' || echo 0) + 1 ))"
      ;;
  esac
  ledger_set "$sig" last_seen "$NOW"
}

gather_evidence

# Limit gate, BEFORE any claude call (#253): if the host-global marker says the
# Claude subscription window is exhausted, the healer's own claude call would
# just refuse — it goes BLIND exactly when it can't help, and a limit-caused red
# is almost never a real incident. Defer the whole incident: record it in the
# evidence dir and exit 0 WITHOUT consuming a ledger attempt (the ledger is only
# touched further down, past this gate).
if claude_limit_parked; then
  echo "deferred: limit window ($(date -u '+%Y-%m-%dT%H:%M:%SZ') — global marker fresh)" > "$EVIDENCE/deferred-limit.txt"
  echo "heal: deferred — Claude usage limit window (marker fresh); no ledger attempt consumed"
  exit 0
fi

if [ "$MODE" = "hook" ]; then
  handle_incident "$WORKFLOW" "$(error_line "$WORKFLOW")"
else
  found=0
  # (c) API latency incident
  api_s="$(sed -n 's/^api_seconds=//p' "$EVIDENCE/api-timing.txt")"
  if [ "$api_s" = "timeout" ] || { [ "$api_s" -ge 30 ] 2>/dev/null; }; then
    handle_incident "forgejo-api" "API version probe ${api_s}s (threshold 30s)"
    found=1
  fi
  # (a)+(b) failure streaks / always-red — skip workflows whose ledger was
  # touched within the cooldown (a hook already owns the incident)
  while IFS=$'\t' read -r wf kind; do
    [ -z "$wf" ] && continue
    recent="$(find "$HEALER_STATE" -maxdepth 1 -type f -newermt "-6 hours" \
      -exec grep -l "^workflow=$wf$" {} + 2>/dev/null | head -1 || true)"
    [ -n "$recent" ] && { echo "heal: $wf already ledgered recently — skipping"; continue; }
    handle_incident "$wf" "watchdog: $kind ($(error_line "$wf"))"
    found=1
  done < <(watchdog_detect "$EVIDENCE/runs.json")
  if [ "$found" -eq 0 ]; then echo "heal: watchdog — all healthy"; fi
fi
