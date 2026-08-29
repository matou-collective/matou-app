#!/usr/bin/env bash
# Starvation signal for a triage YIELD (#110). A triage yield is `exit 0` — a
# green run — so N consecutive yields for a repo with untriaged issues look
# identical to N healthy no-op ticks: Matou/coa starved 12 tickets across 12
# green yields with no signal, and the only evidence was the ABSENCE of a log on
# the hosts. This makes that visible without a human reading host /tmp.
#
# Called at every triage yield site — triage.yml's inline slot/workdir/drive
# gates (which run before run-triage.sh is even reached) and run-triage.sh's own
# limit-park and drive gates — with the yield reason. If untriaged issues exist
# it bumps the per-repo consecutive-yield counter and, at the threshold, posts
# ONE comment on the oldest untriaged issue and a Mattermost notice, ONCE per
# starvation episode. If nothing is untriaged it resets the counter (a yield with
# an empty queue is not starvation). run-triage.sh resets the counter on any real
# triage pass (triage_yield_reset).
#
# Best-effort BY CONTRACT: every caller invokes it `|| true`, and it never
# changes the yield's own exit — the existing yield semantics (never camp,
# exit 0) are unchanged (#110 acceptance). A preflight failure (a Forgejo blip,
# a permission gap) leaves the counter untouched and exits 0: we neither invent a
# streak nor erase a real one on missing information.
#
# Usage: triage-yield-signal.sh <reason>
# Env: FORGEJO_TOKEN, FORGEJO_API, REPO_SLUG (optional); Mattermost optional
#      (unset → notify-mattermost.sh prints to stderr, as everywhere else);
#      TRIAGE_YIELD_COUNT / TRIAGE_YIELD_THRESHOLD test seams.
set -euo pipefail
reason="${1:-unknown}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Token from the environment (CI sets it), else the materialized .env (host
# runs), else the bind-mounted secret — the same ladder preflight-triage.sh uses.
if [ -z "${FORGEJO_TOKEN:-}" ] && [ -f "$here/.env" ]; then . "$here/.env"; fi
if [ -z "${FORGEJO_TOKEN:-}" ] && [ -f /run/secrets/forgejo_token ]; then
  FORGEJO_TOKEN="$(cat /run/secrets/forgejo_token)"
fi
: "${FORGEJO_TOKEN:?}"
# shellcheck source=swarm-identity.sh
. "$here/swarm-identity.sh"       # FORGEJO_API / REPO_SLUG defaults (ADR 0180)
# shellcheck source=triage-yield-lib.sh
. "$here/triage-yield-lib.sh"     # the counter path + threshold, shared with run-triage.sh

repo_slug="${REPO_SLUG:-${FORGEJO_API##*/repos/}}"
api() { curl -sf -H "Authorization: token $FORGEJO_TOKEN" "$@"; }

# The untriaged set — reuse preflight so "untriaged" means EXACTLY what the
# workflow triages on (the same label-exclusion predicate, #555). A preflight
# failure must not touch the counter: capture its exit and, on failure, leave the
# streak as-is and return clean.
if ! untriaged="$(bash "$here/preflight-triage.sh" 2>/dev/null)"; then
  echo "triage-yield-signal: preflight unavailable — yield '$reason' counter left untouched"
  exit 0
fi
n_untriaged="$(jq 'length' <<<"$untriaged" 2>/dev/null || echo 0)"
if [ "${n_untriaged:-0}" -eq 0 ]; then
  triage_yield_reset
  echo "triage-yield-signal: nothing untriaged — yield '$reason', counter reset"
  exit 0
fi

count="$(triage_yield_bump)"
echo "triage-yield-signal: yield '$reason' — $count consecutive with $n_untriaged untriaged issue(s)"
[ "$count" -ge "$TRIAGE_YIELD_THRESHOLD" ] || exit 0

# Threshold reached — signal ONCE per episode (the marker is cleared by
# triage_yield_reset on the next real triage pass).
sig="$(triage_yield_signalled_path)"
if [ -e "$sig" ]; then
  echo "triage-yield-signal: already signalled this episode ($count yields) — no repeat"
  exit 0
fi

# Oldest untriaged issue = lowest number (issue numbers are monotonic per repo).
oldest_obj="$(jq -c 'min_by(.number)' <<<"$untriaged")"
oldest="$(jq -r '.number' <<<"$oldest_obj")"
title="$(jq -r '.title // ""' <<<"$oldest_obj")"
url="$(jq -r '.url // ""' <<<"$oldest_obj")"

body="⚠️ **Triage is starving.** This repo's triage has yielded **$count consecutive ticks** (most recent reason: \`$reason\`) with **$n_untriaged** untriaged issue(s) still open — the host's shared heavy slots have been busy or a rehearsal drive has reserved host capacity, so no \`/triage\` pass has run for them. New tickets here are waiting behind other work; a human may want to check host capacity.

Ruled by agent under ADR 0174 — veto anytime. Automated starvation signal (Matou/dev-factory #110): posted once per episode, cleared on the next real triage pass."

# Both writes are best-effort — a failed comment or notice must never red the
# yield (its caller already `|| true`s us, but be explicit so a partial post
# still records the marker and stops the repeat).
api -X POST -H 'Content-Type: application/json' \
  -d "$(jq -n --arg b "$body" '{body: $b}')" \
  "$FORGEJO_API/issues/$oldest/comments" >/dev/null 2>&1 \
  && echo "triage-yield-signal: commented on the oldest untriaged issue #$oldest" \
  || echo "triage-yield-signal: could not comment on #$oldest (best-effort)" >&2

bash "$here/notify-mattermost.sh" \
  ":hourglass_flowing_sand: **Triage starved** in \`$repo_slug\` — $count consecutive yields (\`$reason\`), $n_untriaged untriaged. Oldest: [#$oldest $title]($url)" \
  >/dev/null 2>&1 || true

: >"$sig"
echo "triage-yield-signal: posted starvation signal on #$oldest ($count yields, $n_untriaged untriaged)"
