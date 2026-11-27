#!/usr/bin/env bash
# Starvation signal for a SWARM yield (#213). A swarm yield is `exit 0` — a
# green run — so N consecutive both-slots-busy losses for a repo with ready
# tickets look identical to N healthy no-op ticks: a low-traffic repo whose legs
# always lose while two long drains hold both slots on every host starves with
# no signal, the only evidence the ABSENCE of a log on the hosts (GOTCHAS 35, 51
# family). Triage already has this (triage-yield-signal.sh, #110); this gives the
# swarm the same visibility AND lets a chronically-yielding repo free a held slot
# mid-run by declaring a want-file.
#
# Called at the swarm's both-slots-busy yield site (swarm.yml, the inline host-
# capacity gate that runs before run-swarm.sh is reached) with the yield reason.
# If ready-for-agent tickets exist it bumps the per-repo consecutive-yield
# counter and, at the threshold, (1) writes this repo's want-file so peers'
# drains yield the slot to it, and (2) ONCE per episode posts a comment on the
# oldest ready ticket plus a Mattermost notice. If nothing is ready it resets the
# counter (a yield with an empty queue is not starvation). run-swarm.sh resets
# the counter on any real claim (swarm_yield_reset).
#
# Best-effort BY CONTRACT: every caller invokes it `|| true`, and it never
# changes the yield's own exit — the existing yield semantics (never camp,
# exit 0) are unchanged. A read failure (a Forgejo blip, a permission gap) leaves
# the counter untouched and exits 0: we neither invent a streak nor erase a real
# one on missing information.
#
# Usage: swarm-yield-signal.sh <reason>
# Env: FORGEJO_TOKEN, FORGEJO_API, REPO_SLUG (optional); Mattermost optional
#      (unset -> notify-mattermost.sh prints to stderr, as everywhere else);
#      SWARM_YIELD_COUNT / SWARM_YIELD_THRESHOLD / SWARM_REPO_WANTED test seams.
set -euo pipefail
reason="${1:-unknown}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Token from the environment (CI sets it), else the materialized .env (host
# runs), else the bind-mounted secret — the same ladder list-ready-tasks.sh uses.
if [ -z "${FORGEJO_TOKEN:-}" ] && [ -f "$here/.env" ]; then . "$here/.env"; fi
if [ -z "${FORGEJO_TOKEN:-}" ] && [ -f /run/secrets/forgejo_token ]; then
  FORGEJO_TOKEN="$(cat /run/secrets/forgejo_token)"
fi
: "${FORGEJO_TOKEN:?}"
# shellcheck source=swarm-identity.sh
. "$here/swarm-identity.sh"       # FORGEJO_API / REPO_SLUG defaults (ADR 0180)
# shellcheck source=swarm-yield-lib.sh
. "$here/swarm-yield-lib.sh"      # the counter + want-file paths + threshold, shared with run-swarm.sh

repo_slug="${REPO_SLUG:-${FORGEJO_API##*/repos/}}"
api() { curl -sf --max-time "${SWARM_YIELD_MAX_TIME:-30}" -H "Authorization: token $FORGEJO_TOKEN" "$@"; }

# The ready set — open issues labelled ready-for-agent (the swarm's queue, the
# same label list-ready-tasks.sh filters on). A read failure must not touch the
# counter: capture its exit and, on failure, leave the streak as-is and return
# clean (never invent or erase a streak on missing information).
if ! ready="$(api "$FORGEJO_API/issues?state=open&type=issues&labels=ready-for-agent&limit=50" 2>/dev/null)"; then
  echo "swarm-yield-signal: ready-set read unavailable — yield '$reason' counter left untouched"
  exit 0
fi
n_ready="$(jq 'length' <<<"$ready" 2>/dev/null || echo 0)"
if [ "${n_ready:-0}" -eq 0 ]; then
  swarm_yield_reset
  echo "swarm-yield-signal: nothing ready — yield '$reason', counter reset"
  exit 0
fi

count="$(swarm_yield_bump)"
echo "swarm-yield-signal: yield '$reason' — $count consecutive with $n_ready ready ticket(s)"
[ "$count" -ge "$SWARM_YIELD_THRESHOLD" ] || exit 0

# Threshold reached. Write (or refresh) this repo's want-file EVERY tick past the
# threshold so its mtime stays live — main.mts mirrors only FRESH peer want-files
# into each sandbox, exactly as it does for the drive reservation (#111). The
# comment + Mattermost notice fire ONCE per episode (the marker below).
: >"$(swarm_repo_wanted_path)"

sig="$(swarm_yield_signalled_path)"
if [ -e "$sig" ]; then
  echo "swarm-yield-signal: already signalled this episode ($count yields) — want-file refreshed, no repeat comment"
  exit 0
fi

# Oldest ready issue = lowest number (issue numbers are monotonic per repo).
oldest_obj="$(jq -c 'min_by(.number)' <<<"$ready")"
oldest="$(jq -r '.number' <<<"$oldest_obj")"
title="$(jq -r '.title // ""' <<<"$oldest_obj")"
url="$(jq -r '.html_url // ""' <<<"$oldest_obj")"

body="⚠️ **Swarm is starving.** This repo's swarm has yielded **$count consecutive ticks** (most recent reason: \`$reason\`) with **$n_ready** ready-for-agent ticket(s) still open — the host's shared heavy slots have been busy (two long drains hold both slots on every host), so no worker has claimed for them. New tickets here are waiting behind other repos' work; this repo has now declared a want-file so a peer's queue-draining run frees its slot after the current ticket. A human may want to check host capacity.

Ruled by agent under ADR 0174 — veto anytime. Automated starvation signal (Matou/dev-factory #213): posted once per episode, cleared on the next real claim."

# Both writes are best-effort — a failed comment or notice must never red the
# yield (its caller already `|| true`s us, but be explicit so a partial post
# still records the marker and stops the repeat).
api -X POST -H 'Content-Type: application/json' \
  -d "$(jq -n --arg b "$body" '{body: $b}')" \
  "$FORGEJO_API/issues/$oldest/comments" >/dev/null 2>&1 \
  && echo "swarm-yield-signal: commented on the oldest ready issue #$oldest" \
  || echo "swarm-yield-signal: could not comment on #$oldest (best-effort)" >&2

bash "$here/notify-mattermost.sh" \
  ":hourglass_flowing_sand: **Swarm starved** in \`$repo_slug\` — $count consecutive yields (\`$reason\`), $n_ready ready. Oldest: [#$oldest $title]($url)" \
  >/dev/null 2>&1 || true

: >"$sig"
echo "swarm-yield-signal: posted starvation signal on #$oldest ($count yields, $n_ready ready) and wrote the want-file"
