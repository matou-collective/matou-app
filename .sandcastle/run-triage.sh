#!/usr/bin/env bash
# Headless triage: when untriaged issues exist, run the /triage skill via
# claude -p (labels get applied exactly as in an interactive session), then
# post to Mattermost every issue newly routed to a human gate.
# Run from the repo checkout root.
#
# Env: FORGEJO_TOKEN, FORGEJO_API, CLAUDE_CODE_OAUTH_TOKEN,
#      MATTERMOST_URL/MATTERMOST_BOT_TOKEN/MATTERMOST_CHANNEL_ID (optional),
#      REPO_SLUG (optional).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=verdict-lib.sh
. "$here/verdict-lib.sh"
# shellcheck source=limit-lib.sh
. "$here/limit-lib.sh"
: "${FORGEJO_TOKEN:?}"
: "${FORGEJO_API:?}"
repo_slug="${REPO_SLUG:-${FORGEJO_API##*/repos/}}"
# One runner serves TWO repos (#238) — a /tmp verdict path must carry the repo
# or the two clobber each other's (#574). Same formula as run-swarm.sh/heal.sh.
repo_tag="${repo_slug//\//-}"

api() { curl -sf -H "Authorization: token $FORGEJO_TOKEN" "$@"; }

# Drop a stage/exit verdict on failure so the healer keys the incident signature
# on the run's REAL failing stage, not on worker chain-of-thought prose (#235).
verdict_begin "${TRIAGE_VERDICT_PATH:-/tmp/matou-$repo_tag-triage-verdict.txt}"
# Clean up the captured claude log AFTER the verdict is written, never before —
# an `rm` on the failure path ahead of `exit 1` used to delete the log the EXIT
# trap's verdict_write then tried to read, leaving an empty `--- error lines ---`
# block and defeating the whole stage/exit/error verdict (#18).
trap 'verdict_write $?; [ -n "${triage_log:-}" ] && rm -f "$triage_log"' EXIT

# Limit gate, BEFORE claude (#253): if the host-global marker says the Claude
# subscription window is already exhausted (a worker or the healer parked it),
# yield cleanly — a blind claude call would only refuse, and one refusal within
# the watchdog window mints an always-red incident. Exit 0 with an honest
# "limit-parked" note so the run list never reads a parked window as green health.
if claude_limit_parked; then
  echo "run-triage: limit-parked — Claude usage limit window (marker fresh), yielding without calling claude"
  exit 0
fi

verdict_stage "preflight (list untriaged issues)"
untriaged="$(bash "$here/preflight-triage.sh")"
n="$(jq 'length' <<<"$untriaged")"
if [ "$n" -eq 0 ]; then
  echo "run-triage: nothing to triage"
  exit 0
fi
echo "run-triage: $n untriaged issue(s):"
jq -r '.[] | "  #\(.number) \(.title)"' <<<"$untriaged"

# Open issues currently sitting at a human gate, as "number<TAB>label" lines.
human_gated() {
  for label in ready-for-human needs-design; do
    page=1
    while :; do
      batch="$(api "$FORGEJO_API/issues?state=open&type=issues&labels=$label&limit=50&page=$page")"
      count="$(jq 'length' <<<"$batch")"
      [ "$count" -eq 0 ] && break
      jq -r --arg l "$label" '.[] | "\(.number)\t\($l)"' <<<"$batch"
      [ "$count" -lt 50 ] && break
      page=$((page + 1))
    done
  done | sort -u
}

before="$(human_gated)"
# Capture the claude output so a limit refusal can be classified after a failed
# call (#253): the log feeds both the limit detector and the verdict's error
# lines if this stage fails for a REAL fault.
triage_log="$(mktemp)"
verdict_stage "triage skill (claude -p /triage)" "$triage_log"
if ! timeout 2700 claude -p "/triage You are running headless in CI: no human can answer questions, so never ask any. Every untriaged issue must leave this run carrying a triage label. When you hit ambiguity or a judgement call you would normally ask a human about, first try to RULE it yourself under ADR 0174 (docs/adr/0174-*.md): if the call is revertible by a later commit or label change and provable by an existing test/drive/probe, and it is not on the one-way-door list (personal credentials, a security-posture widening, a member-facing trust accept, data destruction, non-routine spend), post the ruling to the issue — 'Ruled by agent under ADR 0174 — veto anytime', the ruling, why it is a two-way door, and what proves it — and apply the label your ruling calls for. Only label ready-for-human when the call is a genuine one-way door (state which in a '## Why human' line, per docs/agents/triage-labels.md), or needs-info if the reporter must supply missing information." --dangerously-skip-permissions 2>&1 | tee "$triage_log"; then
  # A limit refusal parks the host for every caller and exits CLEAN (never red);
  # any other failure still reddens honestly (the EXIT trap's verdict reads the log).
  if claude_limit_hit "$triage_log"; then
    claude_limit_park
    echo "run-triage: limit-parked — Claude refused with a usage-limit signature; marked the host parked, exiting clean"
    exit 0
  fi
  exit 1
fi
after="$(human_gated)"

new="$(comm -13 <(printf '%s\n' "$before") <(printf '%s\n' "$after"))"
if [ -n "$new" ]; then
  digest=""
  while IFS=$'\t' read -r num label; do
    [ -z "$num" ] && continue
    if [ "$label" = ready-for-human ]; then
      # The answerable ask thread, straight after triage — quotes the triage
      # comment; the resume sweep records the reply and re-arms the issue.
      bash "$here/post-issue-ask.sh" "$num" || true
      continue
    fi
    issue="$(api "$FORGEJO_API/issues/$num")"
    title="$(jq -r .title <<<"$issue")"
    url="$(jq -r .html_url <<<"$issue")"
    digest="$digest
- [#$num $title]($url) → \`$label\`"
  done <<<"$new"
  if [ -n "$digest" ]; then
    bash "$here/notify-mattermost.sh" ":wave: **Triage needs you** in \`$repo_slug\`:$digest"
  fi
fi

still="$(bash "$here/preflight-triage.sh" | jq 'length')"
if [ "$still" -gt 0 ]; then
  echo "run-triage: $still issue(s) still untriaged (next tick retries)" >&2
fi
exit 0
