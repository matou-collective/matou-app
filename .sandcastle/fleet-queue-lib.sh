#!/usr/bin/env bash
# fleet-queue-lib.sh — the fleet-wide ticket order (#301).
#
# Before #301 every consumer repo's swarm leg read ONLY its own ready list, so
# there was no order across repos at all: the first legs to win a host's two
# slots kept them, and a ticket filed an hour earlier in a quiet repo waited
# behind a loud repo's backlog. Ben's ruling (2026-10-22, on #301): ONE ticket
# per run; when a ticket closes, its dependants are worked next; otherwise the
# next ticket in line across the whole fleet — `priority` first, then the
# filing date. This library is that order, pure and offline-testable:
#
#   collect   every registered repo's OWN vendored list-ready-tasks.sh, merged
#   order     rank (priority / drive-blocker) → created_at → number
#   promote   a closed ticket's dependants (Forgejo `blocks`) to the front
#   cache     the order, on the host, so a leg can see where it stands
#   stamp     the last dispatch, so the tick never piles on its own pick
#   dispatch  workflow_dispatch of ONE repo with inputs.ticket + inputs.host
#
# Each repo's own lister is the authority on what is ready THERE (its DAG,
# its open agent PRs, its standing drive, its landing parity): the fleet view
# is the union of those answers, never a second opinion over the raw tracker —
# an org-wide label search would keep "dispatching" a repo for tickets that
# repo's lister hides, forever. No repo name, host or product path lives here:
# the caller (the generated host tick, onboarding/host-state-lib.sh) passes
# `<checkout>:<slug>` pairs from the host registry, and the API root is read
# from a checkout's own swarm-identity.sh.
#
# Offline-tested by tests/fleet-queue-lib-test.sh (shimmed curl, fake listers).

if [ -z "${__SWARM_FLEET_QUEUE_LIB:-}" ]; then
__SWARM_FLEET_QUEUE_LIB=1

_FLEET_QUEUE_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The drive predicate + the pooled slot paths (host_capacity_drive_wanted,
# HOST_CAPACITY_SLOTS). host-capacity-lib.sh has no source guard and is
# idempotent, but a caller that already sourced it keeps its own state.
if ! command -v host_capacity_drive_wanted >/dev/null 2>&1; then
  # shellcheck source=host-capacity-lib.sh
  . "$_FLEET_QUEUE_HERE/host-capacity-lib.sh"
fi
HOST_CAPACITY_STATE_DIR="${HOST_CAPACITY_STATE_DIR:-$HOME/swarm/state}"

# Knobs (seconds). The cache TTL must outlive the tick cadence AND the
# redispatch window, since a tick that skips on a fresh stamp refreshes nothing.
FLEET_QUEUE_CACHE_TTL="${FLEET_QUEUE_CACHE_TTL:-600}"
FLEET_QUEUE_CLOSE_TTL="${FLEET_QUEUE_CLOSE_TTL:-900}"
FLEET_QUEUE_REDISPATCH="${FLEET_QUEUE_REDISPATCH:-300}"
FLEET_QUEUE_MAX_TIME="${FLEET_QUEUE_MAX_TIME:-30}"
# The lister / identity basenames looked up in each checkout (tests swap them).
FLEET_QUEUE_LISTER="${FLEET_QUEUE_LISTER:-list-ready-tasks.sh}"
FLEET_QUEUE_IDENTITY="${FLEET_QUEUE_IDENTITY:-swarm-identity.sh}"

# ── stand-down of a host whose dispatches never claim (#315) ─────────────────
# A dispatch that dies before it can claim (a sick host: no disk to mkdir the
# runner's act cache, a name it cannot resolve — #191) leaves the fleet head
# unchanged, so once the redispatch window lapses this host dispatches the SAME
# ticket to itself forever. The caller counts consecutive unclaimed dispatches
# (the fleet head is still the ticket we last stamped) and, past the threshold,
# stands this host down with a DECAYING backoff so a recovered host rejoins on
# its own the moment a probe dispatch claims.
FLEET_QUEUE_STRIKES_MAX="${FLEET_QUEUE_STRIKES_MAX:-3}"   # unclaimed dispatches before standing down
FLEET_QUEUE_BACKOFF_BASE="${FLEET_QUEUE_BACKOFF_BASE:-600}"  # first backoff, seconds
FLEET_QUEUE_BACKOFF_MAX="${FLEET_QUEUE_BACKOFF_MAX:-7200}"   # backoff cap, seconds (doubles each strike)

# ── disk-headroom floor for slot_free (#315) ─────────────────────────────────
# A host with no room to mkdir the runner's act cache reports a free slot today
# (slot_free gates only on a drive reservation and a pooled flock), wins the
# dispatch, and dies at `workflow prepared` before step one. A declared floor
# (the registry's `min-free-gb`, rendered into FLEET_QUEUE_MIN_FREE_GB) checked
# against the filesystem that holds the act cache closes that: 0 disables it, so
# a host that declares nothing behaves exactly as before. The cache path is
# $HOME/.cache/act by default (the act runner's own layout — not `/`, which can
# have room while the runner's $HOME does not); overridable for a test or an
# unusual host, never a product literal in the harness.
FLEET_QUEUE_MIN_FREE_GB="${FLEET_QUEUE_MIN_FREE_GB:-0}"
FLEET_QUEUE_ACT_CACHE="${FLEET_QUEUE_ACT_CACHE:-$HOME/.cache/act}"

# _fleet_queue_file <checkout> <basename> — the VENDORED copy (.sandcastle/)
# when the checkout is a consumer, else the root copy (the self-hosting
# factory checkout); rc 1 when neither exists (a pin that predates the file).
_fleet_queue_file() {
  if [ -f "$1/.sandcastle/$2" ]; then printf '%s' "$1/.sandcastle/$2"
  elif [ -f "$1/$2" ]; then printf '%s' "$1/$2"
  else return 1; fi
}

# fleet_queue_api_root <checkout> -> "<server>/api/v1", read from the
# checkout's own identity layer in a subshell (never this shell's FORGEJO_API,
# which a host env may carry for a DIFFERENT repo).
fleet_queue_api_root() {
  local f
  f="$(_fleet_queue_file "$1" "$FLEET_QUEUE_IDENTITY")" || return 1
  (
    unset FORGEJO_API REPO_SLUG
    # shellcheck disable=SC1090
    . "$f" >/dev/null 2>&1 || true
    [ -n "${FORGEJO_API:-}" ] || exit 1
    printf '%s' "${FORGEJO_API%%/repos/*}"
  )
}

# fleet_queue_collect <checkout:slug>... -> one merged JSON array on stdout.
# Every repo's lister runs in PARALLEL (host-side, that repo's own identity and
# policy, its cwd), each ticket gaining `repo` (the slug) and `rank` (0 for a
# `priority` or drive-blocker ticket, 1 otherwise — the lister surfaces both
# flags since #301). A repo whose lister fails, is missing, or answers
# non-JSON is OMITTED with one stderr line; the rest still merge (fail-open per
# repo: one repo's tracker blip must not blind the fleet).
fleet_queue_collect() {
  local pair checkout slug tag lister tmpd rc merged='[]' last
  tmpd="$(mktemp -d)"
  for pair in "$@"; do
    checkout="${pair%%:*}"; slug="${pair#*:}"; tag="${slug//\//-}"
    if ! lister="$(_fleet_queue_file "$checkout" "$FLEET_QUEUE_LISTER")"; then
      echo "fleet-queue: $slug carries no $FLEET_QUEUE_LISTER at $checkout — omitted this tick" >&2
      continue
    fi
    (
      cd "$checkout" || exit 1
      unset SWARM_POLICY_FILE SWARM_HOST_SIGNALS_DIR
      REPO_SLUG="$slug" FORGEJO_API='' bash "$lister" >"$tmpd/$tag.json" 2>"$tmpd/$tag.err"
      echo $? >"$tmpd/$tag.rc"
    ) &
  done
  wait
  for pair in "$@"; do
    slug="${pair#*:}"; tag="${slug//\//-}"
    [ -f "$tmpd/$tag.rc" ] || continue
    rc="$(cat "$tmpd/$tag.rc" 2>/dev/null || echo 1)"
    if [ "$rc" = 0 ] && jq -e 'type == "array"' "$tmpd/$tag.json" >/dev/null 2>&1; then
      merged="$(jq --arg slug "$slug" --slurpfile add "$tmpd/$tag.json" \
        '. + ($add[0] | map(. + {repo: $slug,
                                  rank: (if ((.priority // false) or (.blocker // false)) then 0 else 1 end)}))' \
        <<<"$merged")"
    else
      last="$(tail -n 1 "$tmpd/$tag.err" 2>/dev/null || true)"
      echo "fleet-queue: $slug lister failed (rc=$rc) — omitted this tick${last:+: $last}" >&2
    fi
  done
  rm -rf "$tmpd"
  printf '%s' "$merged"
}

# fleet_queue_order <merged-json> -> the fleet order: rank first (priority and
# drive blockers jump the line), then the filing date, oldest first; a ticket
# with no created_at (a lister from a pin before #301) sorts LAST within its
# rank rather than first; the number is the final tie-break.
fleet_queue_order() {
  jq 'sort_by(.rank, (.created_at // "~"), .number)' <<<"$1"
}

# fleet_queue_dependants <api-root> <slug> <n> -> JSON array of {repo, number}:
# the open issues ticket <slug>#<n> BLOCKS (Forgejo's native dependencies, the
# same DAG list-ready-tasks.sh filters on), in any repo. `[]` with a stderr
# line on a failed read — a blip must never promote the wrong ticket.
fleet_queue_dependants() {
  local root="$1" slug="$2" n="$3" raw
  if ! raw="$(curl -sf --max-time "$FLEET_QUEUE_MAX_TIME" -H "Authorization: token ${FORGEJO_TOKEN:-}" \
        "$root/repos/$slug/issues/$n/blocks?limit=50" 2>/dev/null)"; then
    echo "fleet-queue: could not read what $slug#$n blocks — no dependants promoted" >&2
    printf '[]'; return 0
  fi
  jq -c '[.[]? | select(.state == "open") | {repo: (.repository.full_name // ""), number}]' <<<"$raw" 2>/dev/null || printf '[]'
}

# fleet_queue_promote <ordered-json> <dependants-json> -> the order with every
# ticket named in <dependants> moved to the FRONT, their relative (fleet) order
# kept; everything else follows unchanged.
fleet_queue_promote() {
  jq --argjson d "$2" '
    def key: "\(.repo)#\(.number)";
    ($d | map("\(.repo)#\(.number)")) as $k
    | [.[] | select(key as $x | ($k | index($x)) != null)]
      + [.[] | select(key as $x | ($k | index($x)) == null)]' <<<"$1"
}

# ── recent closes: "each ticket, on close, asks for any dependant" ─────────
# A close is recorded on the HOST (by the finishing run's self-rearm and by the
# `closed`-event leg), so every tick on this host — not just the one run that
# knows — promotes that ticket's dependants until the record ages out.
fleet_queue_recent_closes_path() {
  printf '%s' "${FLEET_QUEUE_RECENT_CLOSES:-$HOST_CAPACITY_STATE_DIR/fleet-recent-closes}"
}
fleet_queue_recent_close_record() { # <slug> <n>
  mkdir -p "$(dirname "$(fleet_queue_recent_closes_path)")" 2>/dev/null || true
  printf '%s %s %s\n' "$(date +%s)" "$1" "$2" >>"$(fleet_queue_recent_closes_path)" 2>/dev/null || true
}
# fleet_queue_recent_closes [ttl] -> "slug n" lines younger than ttl, newest
# first, de-duplicated; the file is rewritten pruned.
fleet_queue_recent_closes() {
  local f ttl="${1:-$FLEET_QUEUE_CLOSE_TTL}" now kept
  f="$(fleet_queue_recent_closes_path)"
  [ -s "$f" ] || return 0
  now="$(date +%s)"
  kept="$(awk -v now="$now" -v ttl="$ttl" '$1 ~ /^[0-9]+$/ && now - $1 < ttl { print }' "$f")"
  printf '%s\n' "$kept" | grep . >"$f.tmp" 2>/dev/null; mv -f "$f.tmp" "$f" 2>/dev/null || true
  printf '%s\n' "$kept" | grep . | sort -rn -k1,1 | cut -d' ' -f2,3 | awk '!seen[$0]++'
}

# ── the host cache: where the fleet stands, for legs that cannot compute it ──
fleet_queue_cache_path() { printf '%s' "${FLEET_QUEUE_CACHE:-$HOST_CAPACITY_STATE_DIR/fleet-queue.json}"; }
fleet_queue_cache_write() { # <ordered-json>
  local f; f="$(fleet_queue_cache_path)"
  mkdir -p "$(dirname "$f")" 2>/dev/null || true
  printf '%s\n' "$1" >"$f.tmp" && mv -f "$f.tmp" "$f"
}
# fleet_queue_cache_head [ttl] -> "slug n" of the fleet head when the cache is
# fresher than ttl and non-empty; rc 1 otherwise (absent, stale, empty).
fleet_queue_cache_head() {
  local f ttl="${1:-$FLEET_QUEUE_CACHE_TTL}" age head
  f="$(fleet_queue_cache_path)"
  [ -s "$f" ] || return 1
  age=$(( $(date +%s) - $(stat -c %Y "$f" 2>/dev/null || echo 0) ))
  [ "$age" -lt "$ttl" ] || return 1
  head="$(jq -r '.[0] | select(. != null) | "\(.repo) \(.number)"' "$f" 2>/dev/null || true)"
  [ -n "$head" ] || return 1
  printf '%s' "$head"
}

# ── the dispatch stamp: never pile a second dispatch on an unclaimed pick ───
fleet_queue_stamp_path() { printf '%s' "${FLEET_QUEUE_STAMP:-$HOST_CAPACITY_STATE_DIR/fleet-queue-dispatched}"; }
fleet_queue_stamp_write() { # <slug> <n>
  mkdir -p "$(dirname "$(fleet_queue_stamp_path)")" 2>/dev/null || true
  printf '%s %s %s\n' "$(date +%s)" "$1" "$2" >"$(fleet_queue_stamp_path)"
}
# fleet_queue_stamp_fresh [window] -> rc 0 (and "slug n age" on stdout) when
# the last dispatch is younger than the window.
fleet_queue_stamp_fresh() {
  local f window="${1:-$FLEET_QUEUE_REDISPATCH}" at slug n age
  f="$(fleet_queue_stamp_path)"
  [ -s "$f" ] || return 1
  read -r at slug n <"$f" || return 1
  case "$at" in ''|*[!0-9]*) return 1 ;; esac
  age=$(( $(date +%s) - at ))
  [ "$age" -lt "$window" ] || return 1
  printf '%s %s %s' "$slug" "$n" "$age"
}
# fleet_queue_stamp_ticket -> "slug n" of the last dispatch regardless of its
# age (rc 1, no output, when no stamp exists). The strike accounting reads it to
# ask "is the ticket we last dispatched STILL the fleet head?" — a healthy claim
# relabels the ticket agent-working and it leaves every lister, so the head
# moves; only a dispatch that never claimed leaves it standing.
fleet_queue_stamp_ticket() {
  local f at slug n
  f="$(fleet_queue_stamp_path)"
  [ -s "$f" ] || return 1
  read -r at slug n <"$f" || return 1
  { [ -n "${slug:-}" ] && [ -n "${n:-}" ]; } || return 1
  printf '%s %s' "$slug" "$n"
}

# ── strikes: consecutive dispatches that never claimed (#315) ────────────────
# The strike file carries "<count> <last-strike-epoch>". A healthy progression
# (the head moved) resets it; each unclaimed-expiry bumps it. Past the threshold
# the host stands down with a backoff that doubles per strike (capped), so a
# sick host is probed ever less often yet rejoins the instant a probe claims.
fleet_queue_strikes_path() { printf '%s' "${FLEET_QUEUE_STRIKES:-$HOST_CAPACITY_STATE_DIR/fleet-queue-strikes}"; }
# fleet_queue_strikes -> the current strike count (0 when absent or malformed).
fleet_queue_strikes() {
  local f n rest
  f="$(fleet_queue_strikes_path)"
  [ -s "$f" ] || { echo 0; return 0; }
  read -r n rest <"$f" || { echo 0; return 0; }
  case "$n" in ''|*[!0-9]*) echo 0; return 0 ;; esac
  echo "$n"
}
# fleet_queue_strike_bump -> increment the counter, stamping NOW as the strike
# time, and echo the new count.
fleet_queue_strike_bump() {
  local f n
  f="$(fleet_queue_strikes_path)"
  mkdir -p "$(dirname "$f")" 2>/dev/null || true
  n="$(fleet_queue_strikes)"
  n=$(( n + 1 ))
  printf '%s %s\n' "$n" "$(date +%s)" >"$f"
  echo "$n"
}
# fleet_queue_strike_reset -> clear the counter (the host demonstrably claimed).
fleet_queue_strike_reset() { rm -f "$(fleet_queue_strikes_path)"; }

# fleet_queue_standdown -> rc 0 (and "<strikes> <remaining-seconds>" on stdout)
# when this host has >= FLEET_QUEUE_STRIKES_MAX consecutive unclaimed dispatches
# AND the decaying backoff since the last strike has not yet elapsed; rc 1
# otherwise (healthy, below the threshold, or the backoff lapsed so a probe
# dispatch is due now). The backoff doubles for each strike past the threshold,
# capped at FLEET_QUEUE_BACKOFF_MAX.
fleet_queue_standdown() {
  local f n last over backoff now elapsed remain
  f="$(fleet_queue_strikes_path)"
  [ -s "$f" ] || return 1
  read -r n last <"$f" || return 1
  case "$n" in ''|*[!0-9]*) return 1 ;; esac
  case "$last" in ''|*[!0-9]*) return 1 ;; esac
  [ "$n" -ge "$FLEET_QUEUE_STRIKES_MAX" ] || return 1
  over=$(( n - FLEET_QUEUE_STRIKES_MAX ))
  backoff="$FLEET_QUEUE_BACKOFF_BASE"
  while [ "$over" -gt 0 ] && [ "$backoff" -lt "$FLEET_QUEUE_BACKOFF_MAX" ]; do
    backoff=$(( backoff * 2 )); over=$(( over - 1 ))
  done
  [ "$backoff" -le "$FLEET_QUEUE_BACKOFF_MAX" ] || backoff="$FLEET_QUEUE_BACKOFF_MAX"
  now="$(date +%s)"
  elapsed=$(( now - last ))
  [ "$elapsed" -lt "$backoff" ] || return 1
  remain=$(( backoff - elapsed ))
  printf '%s %s' "$n" "$remain"
}

# fleet_queue_free_gb <path> -> whole GiB free on the filesystem holding <path>,
# on stdout; rc 1 with no output when df cannot answer. The act cache dir may
# not exist yet, so the probe walks up to the nearest existing ancestor (the
# filesystem is the same). This is the ONE place df is called, so the offline
# test shims df behind a full/empty-disk fixture.
fleet_queue_free_gb() {
  local p="$1" parent avail
  while [ -n "$p" ] && [ ! -e "$p" ]; do
    parent="${p%/*}"
    [ -n "$parent" ] && [ "$parent" != "$p" ] || parent=/
    p="$parent"
  done
  [ -n "$p" ] || p=/
  # -P: POSIX one-line-per-fs (never wrapped); -k: 1K blocks (portable — -BG is
  # GNU-only). Available is the 4th column of the data row.
  avail="$(df -Pk "$p" 2>/dev/null | awk 'NR==2 {print $4}')" || return 1
  case "$avail" in ''|*[!0-9]*) return 1 ;; esac
  echo $(( avail / 1024 / 1024 ))
}

# fleet_queue_slot_free -> rc 0 iff this host could start a run NOW: no fresh
# rehearsal-drive reservation, enough headroom on the runner's act-cache
# filesystem (FLEET_QUEUE_MIN_FREE_GB, 0 = unchecked), and at least one pooled
# slot flocks non-blocking (probed and released at once — never camp, never
# hold; the leg takes it for real). Sourced into the caller's shell so the
# probe fds close here. The disk gate FAILS OPEN (a df blip never blinds the
# host) but FAILS CLOSED on a concrete under-floor reading — a host that cannot
# mkdir the act cache must not report a free slot (#315).
fleet_queue_slot_free() {
  local slot fd free
  host_capacity_drive_wanted && return 1
  if [ "${FLEET_QUEUE_MIN_FREE_GB:-0}" -gt 0 ]; then
    free="$(fleet_queue_free_gb "$FLEET_QUEUE_ACT_CACHE")" || free=""
    if [ -n "$free" ] && [ "$free" -lt "$FLEET_QUEUE_MIN_FREE_GB" ]; then
      echo "fleet-queue: ${free}G free on the runner cache filesystem ($FLEET_QUEUE_ACT_CACHE, < ${FLEET_QUEUE_MIN_FREE_GB}G floor) — no free slot until the disk recovers" >&2
      return 1
    fi
  fi
  host_capacity_statedir_ensure
  for slot in $HOST_CAPACITY_SLOTS; do
    exec {fd}>"$slot" || continue
    if flock -n "$fd"; then exec {fd}>&-; return 0; fi
    exec {fd}>&-
  done
  return 1
}

# fleet_queue_dispatch <api-root> <slug> <n> <host> -> prints the HTTP code;
# rc 0 on a 2xx. ONE repo's swarm.yml, with inputs.ticket (the pick: the leg
# works it or nothing) and inputs.host (ONLY that host's leg runs — the others
# stand down before touching a slot, so one dispatch is one run, no claim race
# between an idle host's legs).
fleet_queue_dispatch() {
  local root="$1" slug="$2" n="$3" host="$4" code
  code="$(jq -cn --arg t "$n" --arg h "$host" '{ref: "main", inputs: {ticket: $t, host: $h}}' |
    curl -s -o /dev/null -w '%{http_code}' --max-time "$FLEET_QUEUE_MAX_TIME" \
      -X POST -H "Authorization: token ${FORGEJO_TOKEN:-}" -H 'Content-Type: application/json' -d @- \
      "$root/repos/$slug/actions/workflows/swarm.yml/dispatches" 2>/dev/null)" || true
  code="${code:-000}"
  printf '%s' "$code"
  case "$code" in 2??) return 0 ;; *) return 1 ;; esac
}

fi
