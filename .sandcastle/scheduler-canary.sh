#!/usr/bin/env bash
# scheduler-canary.sh — the DETECTION half of the scheduler-silence failure
# mode (#105, ruled by Ben on idss #269). It shouts to Mattermost when a repo's
# Forgejo Actions scheduler has gone quiet; the RESPONSE half (how to recover)
# is idss GOTCHAS #95, whose cure this alert names inline.
#
# Why a SIBLING of the backstop, never folded into it: schedule-backstop.sh's
# dispatch guard reads a `waiting` run as "already covered" and SKIPS — the
# exact inverse of this alarm, which fires BECAUSE runs are piling up `waiting`.
# So this canary runs alongside the backstop from the host crontab's
# backstop-tick.sh, never inside its guard. It must live OUTSIDE Forgejo's own
# scheduler — a scheduled canary dies in the very outage it watches — which is
# why it rides the host crontab (backstop-tick.sh) and not a `.forgejo/workflow`.
#
# No heartbeat is emitted: THE QUEUE IS THE HEARTBEAT. Two orthogonal
# assertions, for the ONE repo named by this copy's swarm-identity.sh
# (FORGEJO_API) — the generated backstop-tick.sh calls this once per repo it
# serves, exactly as it calls the backstop per repo, so "every repo the host
# serves" is covered by the tick's loop, not by this script reaching across
# repos with a borrowed token:
#
#   1. OLDEST-`waiting`-AGE (saturation / claiming — the idss #878 / #103 mode:
#      ~2,700 no-op runs buried every other workflow for ~24 h). For each event
#      in `push, schedule, workflow_dispatch, issues`, read the WAITING runs
#      (`?event=<e>&status=waiting`). Alarm when the oldest is older than
#      CANARY_MAX_WAIT_MIN, or when the count exceeds CANARY_MAX_WAITING.
#   2. HEAD-SHA LIVENESS (creation-drop — the 2026-07-28 mode: schedule rows
#      dropped, runs never CREATED). If the default branch's head commit is
#      older than CANARY_MAX_UNGATED_MIN there must be a CLAIMED ci.yml run
#      for that sha — one whose status has left `waiting`. A merely-existing
#      `waiting` ci run is NOT claimed (idss #880 / GOTCHAS #95). Read via
#      `runs?head_sha=<sha>` (server-side filtered, #109): the tasks view
#      pages by recency, and a busy repo pushes ~10 tasks per 15 min on the
#      SAME head, so the ci task fell off page 1 within ~3 h and every aged
#      head read UNGATED. Skipped for a repo with no ci.yml.
#
# The two modes need two DIFFERENT filters of `actions/runs` (GOTCHAS 34, 37):
# saturation is only visible in `runs?status=waiting`; creation-drop needs the
# head's OWN runs (`runs?head_sha=`), where a claimed one is any whose status
# is not `waiting`. This is the ONE harness reader of `actions/runs` — each
# read server-side-filtered, paged and curl-timed, the read GOTCHAS 16 could
# not have (the unfiltered list is tens of MB and times out — NEVER call it).
# tests/actions-endpoint-test.sh carves exactly these two filters and still
# forbids any broader runs read.
#
# Alert: one Mattermost post via the same MATTERMOST_URL/_BOT_TOKEN/_CHANNEL_ID
# ask-human.sh uses (through notify-mattermost.sh, which degrades to stderr when
# chat is unwired), prefixed `scheduler-canary:`. De-bounced by a state file
# under CANARY_STATE_DIR: re-post at most every CANARY_REPOST_MIN while the
# condition holds, and one `recovered` line when it clears.
#
# Exit-code contract: EXIT 0 ALWAYS while the API answers — a canary that reds
# the crontab is noise, not signal. EXIT 2 only when the API is unreachable for
# THIS repo (its own alarm line) — the generated tick runs each repo
# independently, so a whole-host outage reds every repo's line.
#
# This file is CANONICAL in Matou/dev-factory (ADR 0180) and vendored
# byte-identical into product repos like schedule-backstop.sh — edit it there,
# bump FACTORY_REF, re-vendor; never in a vendored copy (check-harness-drift.sh
# reds a direct edit). It pins no repo slug of its own: FORGEJO_API comes from
# swarm-identity.sh, the one deliberately-not-vendored per-repo layer.
#
# Usage: scheduler-canary.sh          # probes the repo named by swarm-identity.sh
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=swarm-identity.sh
. "$here/swarm-identity.sh"
if [ -z "${FORGEJO_TOKEN:-}" ] && [ -f "$here/secrets/forgejo_token" ]; then
  FORGEJO_TOKEN="$(cat "$here/secrets/forgejo_token")"
fi
: "${FORGEJO_TOKEN:?no token: set FORGEJO_TOKEN or populate .sandcastle/secrets/forgejo_token}"

# Thresholds (env-overridable, all with the ticket's defaults).
MAX_WAIT_MIN="${CANARY_MAX_WAIT_MIN:-30}"        # oldest waiting run older than this → saturated
MAX_WAITING="${CANARY_MAX_WAITING:-40}"          # more waiting runs than this → saturated (count is the alarm)
MAX_UNGATED_MIN="${CANARY_MAX_UNGATED_MIN:-45}"  # head commit older than this with no claimed ci → ungated
REPOST_MIN="${CANARY_REPOST_MIN:-120}"           # while a condition holds, re-post at most this often
# De-bounce state lives OUTSIDE the checkout so it survives a re-vendor; the
# host tick points it at the backstop state dir. /tmp is a safe default: losing
# it across a reboot merely re-posts a still-live alarm once, never suppresses.
STATE_DIR="${CANARY_STATE_DIR:-${TMPDIR:-/tmp}/scheduler-canary}"
mkdir -p "$STATE_DIR" 2>/dev/null || true

# owner/repo (for the slug in alerts) — the last two path segments of FORGEJO_API.
slug="${FORGEJO_API%/}"; slug="${slug#*/repos/}"

api_ok=0   # set the moment ANY call answers; if it stays 0 the repo is unreachable (exit 2)
# get <url> -> body on stdout, rc 0 on a 2xx. curl -f fails on >=400 (a 404 is
# NOT reachability — has_ci handles that case explicitly).
get() {
  local body
  if body="$(curl -sf --max-time 30 -H "Authorization: token $FORGEJO_TOKEN" "$1")"; then
    api_ok=1; printf '%s' "$body"; return 0
  fi
  return 1
}

# stdout (a post id) is noise; stderr is NOT — when chat is unwired
# notify-mattermost.sh prints its "would have sent:" line to stderr, and the
# generated tick runs with a bare cron environment (no MATTERMOST_* until it
# sources the host env), so swallowing stderr drops the alarm without a trace
# (#107). Let stderr through: the tick's `[slug canary]` prefix carries it to
# backstop.log so a would-have-sent is at least visible.
notify() { bash "$here/notify-mattermost.sh" "$1" >/dev/null || true; }

now="$(date -u +%s)"
epoch() { # epoch <iso8601-or-empty> -> unix seconds, or empty
  [ -n "$1" ] && date -u -d "$1" +%s 2>/dev/null || true
}

# ── de-bounce ────────────────────────────────────────────────────────────────
# One state file per (repo, mode). Its presence means "alarm is live"; its
# contents is the epoch of the last post. debounce_fire prints `post` when the
# caller should post now (first sight, or REPOST_MIN elapsed) and stamps the
# file; debounce_clear prints `recovered` exactly once, when a live alarm ends.
state_file() { printf '%s/%s-%s' "$STATE_DIR" "${slug//\//-}" "$1"; }
debounce_fire() { # debounce_fire <mode> -> "post" if the caller should post
  local sf last
  sf="$(state_file "$1")"
  if [ -f "$sf" ]; then
    last="$(cat "$sf" 2>/dev/null || echo 0)"; case "$last" in ''|*[!0-9]*) last=0 ;; esac
    if [ "$((now - last))" -lt "$((REPOST_MIN * 60))" ]; then return 0; fi   # still de-bounced
  fi
  printf '%s' "$now" > "$sf" 2>/dev/null || true
  echo post
}
debounce_clear() { # debounce_clear <mode> -> "recovered" once, if an alarm was live
  local sf
  sf="$(state_file "$1")"
  if [ -f "$sf" ]; then rm -f "$sf" 2>/dev/null || true; echo recovered; fi
}

# ── assertion 1: oldest-waiting-age (saturation) ─────────────────────────────
# For each event, read that event's WAITING runs. total_count is authoritative:
# above MAX_WAITING the count itself is the alarm and we never need the oldest.
# Otherwise (count <= MAX_WAITING <= 50) a single limit=50 page holds them all,
# so we sort client-side for the oldest `created`. Fires per event, whichever
# threshold trips first, and de-bounces per event so two events can each speak.
sat_seen=0
for ev in push schedule workflow_dispatch issues; do
  waiting="$(get "$FORGEJO_API/actions/runs?event=$ev&status=waiting&limit=50&page=1")" || continue
  count="$(printf '%s' "$waiting" | jq -r '.total_count // (.workflow_runs | length) // 0' 2>/dev/null)"
  case "$count" in ''|*[!0-9]*) count=0 ;; esac

  # count 0 is NOT a `continue`: an event whose queue just drained must reach
  # the clear branch below, or a live alarm never gets its `recovered` line.
  mode="saturated-$ev"; reason=""; url=""
  if [ "$count" -eq 0 ]; then
    :
  elif [ "$count" -gt "$MAX_WAITING" ]; then
    reason="$count runs waiting (> $MAX_WAITING) for event=$ev"
    url="$(printf '%s' "$waiting" | jq -r 'first(.workflow_runs[]?.html_url // empty) // empty' 2>/dev/null)"
  else
    # oldest of this page: min `created` (created_at falls back for older forges)
    oldest="$(printf '%s' "$waiting" | jq -r \
      '[.workflow_runs[]? | {c: (.created // .created_at // .started // ""), u: (.html_url // "")}]
       | map(select(.c != "")) | sort_by(.c) | first // empty | @json' 2>/dev/null)"
    if [ -n "$oldest" ] && [ "$oldest" != "null" ]; then
      oc="$(printf '%s' "$oldest" | jq -r '.c')"; url="$(printf '%s' "$oldest" | jq -r '.u')"
      oe="$(epoch "$oc")"
      if [ -n "$oe" ] && [ "$((now - oe))" -ge "$((MAX_WAIT_MIN * 60))" ]; then
        reason="$count waiting for event=$ev, oldest $(( (now - oe) / 60 ))m old (> ${MAX_WAIT_MIN}m)"
      fi
    fi
  fi

  if [ -n "$reason" ]; then
    sat_seen=1
    if [ "$(debounce_fire "$mode")" = post ]; then
      notify "$(printf 'scheduler-canary: %s SATURATED — %s\n%s\nrecovery: cancel the queued no-op runs and stop what mints them; do NOT re-push the workflow files (that cures the UNGATED mode only).' \
        "$slug" "$reason" "${url:-(no run url)}")"
    fi
  else
    if [ "$(debounce_clear "$mode")" = recovered ]; then
      notify "scheduler-canary: $slug recovered — event=$ev waiting queue back within limits."
    fi
  fi
done

# ── assertion 2: head-sha liveness (creation-drop / ungated) ─────────────────
# Only for a repo that has a ci.yml. has_ci distinguishes 404 (no ci → skip,
# reachable) from a transport error (unreachable → leave api_ok alone).
has_ci() {
  local code
  code="$(curl -s --max-time 30 -o /dev/null -w '%{http_code}' \
    -H "Authorization: token $FORGEJO_TOKEN" \
    "$FORGEJO_API/contents/.forgejo/workflows/ci.yml" 2>/dev/null)" || return 2
  case "$code" in 200) api_ok=1; return 0 ;; 404) api_ok=1; return 1 ;; *) return 2 ;; esac
}

if has_ci; then
  meta="$(get "$FORGEJO_API")" && default_branch="$(printf '%s' "$meta" | jq -r '.default_branch // "main"')"
  : "${default_branch:=main}"
  branch="$(get "$FORGEJO_API/branches/$default_branch")" || branch=""
  if [ -n "$branch" ]; then
    head_sha="$(printf '%s' "$branch" | jq -r '.commit.id // .commit.sha // ""')"
    head_ts="$(printf '%s' "$branch" | jq -r '.commit.timestamp // .commit.created // .commit.commit.committer.date // ""')"
    head_epoch="$(epoch "$head_ts")"
    # Only worth checking once the head has aged past the ungated window: a
    # freshly-pushed commit legitimately has no claimed ci yet.
    if [ -n "$head_sha" ] && [ -n "$head_epoch" ] && [ "$((now - head_epoch))" -ge "$((MAX_UNGATED_MIN * 60))" ]; then
      # The head's OWN runs (`?head_sha=`, server-side; #109), matched by
      # WORKFLOW (`.workflow_id == "ci.yml"` — the file has_ci probes; never
      # the job name, #107) and CLAIMED = status has left `waiting` (a waiting
      # run is the #880 trap). The ci run is the OLDEST run on a head (it
      # fires at the push; cron workflows pile on after), so it lives on the
      # LAST page: read page 1 for total_count, then the last page, then a
      # bounded walk of the pages between — never the whole listing.
      claimed=0
      count_claimed() { # count_claimed <runs-json> -> number of claimed ci.yml runs
        local n
        n="$(printf '%s' "$1" | jq -r '[.workflow_runs[]?
              | select((.workflow_id // "") == "ci.yml")
              | select((.status // "waiting") != "waiting")] | length' 2>/dev/null)"
        case "$n" in ''|*[!0-9]*) n=0 ;; esac
        printf '%s' "$n"
      }
      runs="$(get "$FORGEJO_API/actions/runs?head_sha=$head_sha&limit=50&page=1")" || runs=""
      claimed="$(count_claimed "$runs")"
      total="$(printf '%s' "$runs" | jq -r '.total_count // 0' 2>/dev/null)"
      case "$total" in ''|*[!0-9]*) total=0 ;; esac
      last=$(( (total + 49) / 50 ))
      if [ "$claimed" -eq 0 ] && [ "$last" -gt 1 ]; then
        runs="$(get "$FORGEJO_API/actions/runs?head_sha=$head_sha&limit=50&page=$last")" || runs=""
        claimed="$(count_claimed "$runs")"
        # middle pages (a re-run ci can sit anywhere): bounded at 10 pages.
        p=$((last - 1)); floor=$((last - 10)); [ "$floor" -lt 2 ] && floor=2
        while [ "$claimed" -eq 0 ] && [ "$p" -ge "$floor" ]; do
          runs="$(get "$FORGEJO_API/actions/runs?head_sha=$head_sha&limit=50&page=$p")" || runs=""
          claimed="$(count_claimed "$runs")"
          p=$((p - 1))
        done
      fi
      if [ "$claimed" -eq 0 ]; then
        if [ "$(debounce_fire ungated)" = post ]; then
          notify "$(printf 'scheduler-canary: %s UNGATED — head %s on %s is %dm old with NO claimed ci task (a waiting run is not a claimed one — the #880 trap).\nrecovery: re-push the workflow files to re-register the dropped schedule.' \
            "$slug" "${head_sha:0:12}" "$default_branch" "$(( (now - head_epoch) / 60 ))")"
        fi
      else
        if [ "$(debounce_clear ungated)" = recovered ]; then
          notify "scheduler-canary: $slug recovered — head $default_branch now has a claimed ci task."
        fi
      fi
    else
      # head is fresh (or unreadable) → not ungated; clear any stale alarm.
      if [ "$(debounce_clear ungated)" = recovered ]; then
        notify "scheduler-canary: $slug recovered — $default_branch head is fresh again."
      fi
    fi
  fi
fi

# ── exit contract ────────────────────────────────────────────────────────────
if [ "$api_ok" -eq 0 ]; then
  notify "scheduler-canary: $slug API UNREACHABLE — every probe failed; cannot tell if the scheduler is alive. This is the canary's own alarm, not a repo alarm."
  echo "scheduler-canary: $slug API unreachable — exiting 2" >&2
  exit 2
fi
[ "$sat_seen" -eq 1 ] && echo "scheduler-canary: $slug — saturation alarm live" >&2
exit 0
