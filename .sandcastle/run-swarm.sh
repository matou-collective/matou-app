#!/usr/bin/env bash
# Run Sandcastle over the ready tasks and post a Mattermost summary of the
# PRs it opened. Run from the repo checkout root. Agents push their own
# agent/issue-<n> branches and open PRs from inside the sandbox — this host
# checkout's HEAD is never pushed to main.
#
# Env: FORGEJO_TOKEN, FORGEJO_API, CLAUDE_CODE_OAUTH_TOKEN,
#      MATTERMOST_URL/MATTERMOST_BOT_TOKEN/MATTERMOST_CHANNEL_ID (optional),
#      REPO_SLUG (optional),
#      RUN_URL (optional Actions run link).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=limit-lib.sh
. "$here/limit-lib.sh"
# shellcheck source=sweep-lib.sh
. "$here/sweep-lib.sh"
: "${FORGEJO_TOKEN:?}"
: "${FORGEJO_API:?}"
repo_slug="${REPO_SLUG:-${FORGEJO_API##*/repos/}}"
# One runner now serves TWO repos (Matou/ourcloud + Matou/matou-app). Any /tmp
# state that is per-repo must carry the repo in its name, or the two repos
# clobber each other's stamps (#238). Slashes aren't valid in a path segment,
# so flatten the slug: "Matou/matou-app" -> "Matou-matou-app".
repo_tag="${repo_slug//\//-}"

api() { curl -sf -H "Authorization: token $FORGEJO_TOKEN" "$@"; }

ready="$(bash "$here/list-ready-tasks.sh")"
n="$(jq 'length' <<<"$ready")"
if [ "$n" -eq 0 ]; then
  echo "run-swarm: no ready tasks"
  exit 0
fi
echo "run-swarm: $n ready task(s):"
jq -r '.[] | "  #\(.number) \(.title)"' <<<"$ready"

# Coalesce a burst of queued triggers. Every `issues` event queues its own run
# and they drain one-at-a-time behind the global lock, so a labelling pass over
# N tickets means N runs over the SAME ready set. (2026-07-29: filing 22 tickets
# in three label passes queued ~66 events; the backlog took 92 minutes to
# drain.) If the ready set is byte-identical to the one the previous run just
# attempted, this trigger is redundant — skip before posting anything.
#
# Keyed on the ready set itself, not on time alone: the moment real work lands,
# an issue closes, the set changes, and the next trigger runs immediately. Only
# genuinely repeated attempts at unchanged work are dropped. The 30-minute cron
# is the backstop either way.
SWARM_DEBOUNCE="${SWARM_DEBOUNCE:-600}"
ready_hash="$(printf '%s' "$ready" | sha1sum | cut -c1-16)"
# Per-repo (#238): a shared /tmp/matou-swarm-lastready let each repo overwrite
# the other's debounce stamp, defeating the coalescing entirely.
stamp="/tmp/matou-swarm-lastready-$repo_tag"
if [ -f "$stamp" ]; then
  read -r last_hash last_at < "$stamp" || true
  if [ "$last_hash" = "$ready_hash" ] &&
     [ $(( $(date +%s) - ${last_at:-0} )) -lt "$SWARM_DEBOUNCE" ]; then
    echo "run-swarm: same $n ready task(s) attempted $(( $(date +%s) - last_at ))s ago — coalescing this trigger"
    exit 0
  fi
fi
printf '%s %s\n' "$ready_hash" "$(date +%s)" > "$stamp"

pickup=":inbox_tray: **Swarm picking up $n task(s)** in \`$repo_slug\`:
$(jq -r '.[] | "- [#\(.number) \(.title)](\(.url))"' <<<"$ready")"
bash "$here/notify-mattermost.sh" "$pickup"

# Sandcastle's sandbox-forwarding manifest is .sandcastle/.env (git-ignored).
# In CI it doesn't exist — materialize it from the example so its empty
# values fall back to the env the workflow provides. Under Actions
# (GITHUB_ACTIONS set) refresh it every run so example changes propagate;
# never overwrite a developer's real .env on a host run.
if [ -n "${GITHUB_ACTIONS:-}" ] || [ ! -f "$here/.env" ]; then
  cp -f "$here/.env.example" "$here/.env"
fi

# FORGEJO_TOKEN/MATTERMOST_BOT_TOKEN are NOT in .env — Sandcastle forwards
# every key .env declares as a `docker run -e` value, which lands in
# `docker inspect .Config.Env` (the 2026-07-11 breach vector). They ship
# into the sandbox as read-only files instead (main.mts's
# `mounts`, consumed per .sandcastle/secrets/README.md). Materialize them
# here from this process's own env (CI: Actions secrets; host: whatever the
# operator exported) so every run picks up the current value, including
# rotations. Each is optional — a task that never needs one just won't find
# the file.
mkdir -p "$here/secrets" && chmod 700 "$here/secrets"
# Persistent sandbox caches (main.mts mounts them).
mkdir -p "$here/npm-cache" "$here/go-cache"
write_secret() { # write_secret <file> <value>
  if [ -n "$2" ]; then printf '%s' "$2" >"$here/secrets/$1" && chmod 600 "$here/secrets/$1"; fi
}
write_secret forgejo_token "$FORGEJO_TOKEN"
write_secret mattermost_bot_token "${MATTERMOST_BOT_TOKEN:-}"

# Root harness only (sandcastle + tsx) — app deps install inside the sandbox.
npm ci
npx sandcastle docker build-image   # fast no-op after first build (layer cache)

# Post-run sweep: Sandcastle's merge-to-head worktrees and sandcastle/worker/*
# branches are never cleaned up, so the workdir leaked 18 worktrees (2.9 GB) and
# 198 orphaned branches by 2026-07-30 — and the stale checkouts poisoned
# `go test ./internal/wireconvention/...` with 1867 phantom findings (#187). We
# hold /tmp/matou-swarm.lock for the whole run (the workflow's flock), so no
# other swarm is live when this exit trap fires — every leftover worktree is dead
# and safe to remove. Runs on EVERY exit (limit-pause, push-fail, normal). An
# unmerged worker branch is left intact and surfaced, never `-D`'d away.
sweep_and_report() {
  # Reap leaked worker containers older than a run-lifetime (#238) — quiet
  # housekeeping, no alert. We hold the global lock, so anything this old is dead.
  local reaped; reaped="$(reap_containers)" || true
  [ -n "$reaped" ] && echo "run-swarm: reaped stale sandcastle-* container(s): $(printf '%s' "$reaped" | tr '\n' ' ')"
  local unmerged; unmerged="$(sweep_worktrees "$PWD")" || true
  [ -n "$unmerged" ] || return 0
  local count; count="$(printf '%s' "$unmerged" | grep -c .)"
  bash "$here/notify-mattermost.sh" ":warning: **Swarm sweep left $count unmerged \`sandcastle/worker/*\` branch(es)** in \`$repo_slug\` — possible lost work, NOT deleted:
$(printf '%s' "$unmerged" | sed 's/^/- `/; s/$/`/')" || true
}
trap sweep_and_report EXIT

run_start_epoch="$(date +%s)"

# Limit-aware guard: when the Claude subscription window is exhausted, every
# agent invocation fails instantly ("You've hit your limit · resets …") and a
# queued trigger backlog would drain as one red alert per minute (the
# 2026-07-25 18:41–20:00 storm). Detect it, post ONE hourly-deduped notice,
# and exit green — nothing was started, nothing is lost, the limit self-heals.
#
# Detection lives in limit-lib.sh so this guard and the healer's cannot drift:
# on 2026-07-29 this line grepped the literal "hit your limit" while the agent
# printed "hit your WEEKLY limit", the guard missed, and 70 queued runs went
# red in 92 minutes.
sandcastle_log="$(mktemp)"
if ! npm run sandcastle 2>&1 | tee "$sandcastle_log"; then
  if claude_limit_hit "$sandcastle_log"; then
    reset_hint="$(claude_limit_reset_hint "$sandcastle_log")"
    # GLOBAL by design (#238): the Claude subscription is one window shared
    # across every repo, so the hourly notice-dedupe marker stays repo-agnostic
    # — one repo hitting the limit correctly suppresses the other's redundant
    # first notice for the same outage.
    marker="/tmp/matou-swarm-claude-limit"
    if [ ! -f "$marker" ] || [ $(( $(date +%s) - $(stat -c %Y "$marker") )) -gt 3600 ]; then
      touch "$marker"
      bash "$here/notify-mattermost.sh" ":hourglass_flowing_sand: **Swarm paused — Claude usage limit** in \`$repo_slug\` (${reset_hint:-reset time unknown}). Queued runs will drain quietly until it resets; no work was started or lost."
    fi
    rm -f "$sandcastle_log"
    echo "run-swarm: Claude usage limit — pausing quietly"
    exit 0
  fi
  rm -f "$sandcastle_log"
  exit 1
fi
rm -f "$sandcastle_log"

# Report PRs the agents opened this run: open PRs on agent/issue-* branches
# updated since the run started.
prs="$(api "$FORGEJO_API/pulls?state=open&limit=50" |
  jq -r --argjson since "$(( run_start_epoch * 1000 ))" \
    '.[] | select((.head.ref | startswith("agent/issue-")) and ((.updated_at | fromdateiso8601 * 1000) >= $since))
     | "- [#\(.number) \(.title)](\(.html_url)) ← `\(.head.ref)`"')"
summary=":hammer_and_wrench: **Swarm run** in \`$repo_slug\` — $n task(s) picked up."
if [ -n "$prs" ]; then
  summary="$summary
**PRs opened/updated (review + merge to land):**
$prs"
else
  summary="$summary
No PRs produced (agent blocked or task left open — see issue comments)."
fi
if [ -n "${RUN_URL:-}" ]; then
  summary="$summary
[Actions run]($RUN_URL)"
fi
bash "$here/notify-mattermost.sh" "$summary"
