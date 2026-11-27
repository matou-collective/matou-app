#!/usr/bin/env bash
# fleet-landing-detect-lib.sh — the fleet dispatcher's LANDING DETECTION (ADR
# 0009, slice 5 / #358).
#
# ADR 0009 decision 5 (ruling D: all four cases in v1): after a run ends nothing
# reconciles, on a clock that does not depend on the run surviving, that the
# ticket landed and closed correctly. The existing checks all run INSIDE a run
# (close-report gates, host land-after-verify, the stranded-close reopen, the
# rescue ladder) or at the START of a LATER run of the same repo (the PR
# reconcile / idle landing sweep #114, the janitor). So a host that dies between
# its in-sandbox close and the host land leaves a closed ticket with no commits
# on `main` and no later pass looks; a rescue branch is alarmed once and
# forgotten; the later-run checks fire only when that repo next gets a run.
#
# This slice fills those gaps as DETECTION — "detect, do not repair" (decision
# 5). After a run ends (and on a periodic pass over recent closes), the
# dispatcher notices four end-state anomalies and files each as a ticket at the
# FRONT of the fleet queue, naming the evidence; it NEVER auto-repairs them. The
# repair is done by the machinery that already exists — the janitor, the idle
# landing sweep (#114), the stranded-close reopen (#283/#328), the rescue ladder,
# a worker. This slice only makes the anomaly a fact at the head of the line:
#
#   1. stranded-close   a ticket closed with its claimed commits absent from main
#   2. working-no-run   a ticket labelled agent-working that no live run holds
#   3. unrelanded-rescue a sandcastle/rescue-* branch nobody re-landed onto main
#   4. unmerged-pr      a green agent PR nobody merged
#
# ── the shape of the slice (pure core + thin, fail-safe edges) ───────────────
# fleet_landing_detect is PURE: it takes ONE facts bundle (what the tracker, the
# hosts' fresh slot reports, and `git` already answer) and returns the anomalies,
# so the four rules are exhaustively offline-testable with crafted facts. The
# gather helpers around it are the edges — one small `curl` per read (the forge's
# issues / comments / pulls / branches), `git merge-base` for reachability — each
# tested with a shimmed curl and a throwaway git repo, exactly as fleet-queue-lib
# and close-report-lib test their forge/git paths. Every gather FAILS SAFE: a read
# it cannot complete surfaces NOTHING for that case (one stderr line), so a
# tracker blip never manufactures a bogus front-of-queue ticket.
#
# ── filing is gated by the dispatcher's mode (two-way door) ──────────────────
# fleet_landing_file mirrors fleet_dispatch_start_run's shadow|live seam: in
# SHADOW it LOGS what it would file and files nothing (decision 6a — the shadow
# rollout surfaces anomalies in its log without touching any tracker); in LIVE it
# files (idempotently — never a second ticket for an anomaly already open) with
# the fleet's `priority` label so the ticket lands at the FRONT of the order
# (fleet_queue_order ranks priority first). So the whole slice is a two-way door:
# shadow (the default this ships) writes nothing a human must undo.
#
# No repo name, host or product path lives here (CLAUDE.md blast radius): every
# forge call takes an explicit <api-root> + <slug> (never a global FORGEJO_API a
# host env may carry for a different repo — the fleet-queue-lib rule), every
# checkout is passed in, and the labels / branch prefixes keyed on are fleet-wide
# harness concepts (`agent-working`, `priority`, `sandcastle/rescue-`,
# `agent/issue-`), not any product's strings.
#
# Offline-tested by tests/fleet-landing-detect-lib-test.sh. The dispatcher loop's
# per-pass wiring (fleet-dispatch.sh) that gathers the facts and calls this is
# runtime glue proven at the ends, like the slot-report producer's inline wiring
# (the main-mts-offline rule).

if [ -z "${__SWARM_FLEET_LANDING_DETECT_LIB:-}" ]; then
__SWARM_FLEET_LANDING_DETECT_LIB=1

# The window a ticket may sit `agent-working` before a live run must be visible in
# a fresh slot report — covers claim → first report (a healthy claim relabels and
# reports within a tick). A ticket agent-working for longer with NO fresh report
# holding it is case 2. Measured against the label's most-recent ADD on the
# timeline, our own clock on read.
FLEET_LANDING_WORKING_GRACE="${FLEET_LANDING_WORKING_GRACE:-600}"
# The main ref reachability is measured against (per checkout). origin/main is
# what a dispatcher checkout tracks; never a product literal.
FLEET_LANDING_MAIN_REF="${FLEET_LANDING_MAIN_REF:-origin/main}"
# How many recently-updated closed issues a periodic pass scans per repo.
FLEET_LANDING_CLOSED_SCAN="${FLEET_LANDING_CLOSED_SCAN:-20}"
FLEET_LANDING_MAX_TIME="${FLEET_LANDING_MAX_TIME:-30}"
# The title prefix every filed anomaly ticket carries — the dedup key the live
# filer searches on, so an anomaly already surfaced is re-armed, never re-filed.
FLEET_LANDING_TITLE_PREFIX="${FLEET_LANDING_TITLE_PREFIX:-[fleet-landing]}"
# The window a close may sit before it is JUDGED for landing (#363). A push close
# lands only after the host verifies it (#193) and a PR close lands at merge; a
# close younger than this may just be mid-land (idss#2202 was flagged at ~14:54Z
# with its commit still on a sandcastle/worker/* branch). Measured against the
# issue's closed_at, our own clock on read — the same grace shape case 2 uses.
FLEET_LANDING_CLOSE_GRACE="${FLEET_LANDING_CLOSE_GRACE:-900}"
# How many commits deep on <main-ref> a patch-id / issue-ref landing witness scans
# (#363). The landing path rewrites SHAs (rebase, squash, merge), so a by-SHA
# ancestry miss is NOT proof the work is absent; these witnesses catch a landed-
# under-a-new-sha commit the way a human would read `main`.
FLEET_LANDING_PATCHID_SCAN="${FLEET_LANDING_PATCHID_SCAN:-200}"

# _fleet_landing_now -> epoch, overridable so the offline test can pin "now".
_fleet_landing_now() { echo "${FLEET_LANDING_NOW:-$(date +%s)}"; }

# _fleet_landing_api <curl-args...> — the fleet-queue-lib curl posture: an
# explicit URL + the host's FORGEJO_TOKEN. The token is fed on STDIN as a curl
# config directive (--config -), NEVER on argv, so it cannot be read from `ps` by
# another user on the host for the length of the call (#363 — fleet-dispatch.sh's
# "Never on argv or a URL"). No caller pipes stdin to a read, so the heredoc is
# free. rc = curl's.
_fleet_landing_api() {
  curl -sf --max-time "$FLEET_LANDING_MAX_TIME" --config - "$@" <<CFG
header = "Authorization: token ${FORGEJO_TOKEN:-}"
CFG
}

# ── the pure core ────────────────────────────────────────────────────────────
# fleet_landing_detect <facts-json> -> the anomalies, a JSON array of
# {kind, repo, number, ref, key, evidence}. PURE: no disk, no clock, no network —
# the caller gathers the facts and passes them in, so every rule is testable with
# crafted input. Facts shape (every field optional, defaulting empty):
#   { "closes":  [ {repo, number, commits:[sha...], unreached:[sha...]} ],
#     "working": [ {repo, number} ],                    # labelled agent-working
#     "live":    [ {repo, issue} ],                      # held by a fresh report
#     "reports_seen": bool,  # any fresh slot report at all this pass (cold-start gate)
#     "rescues": [ {repo, branch, head, merged:bool} ],
#     "prs":     [ {repo, number, head, state, status, merged:bool} ] }
# Rules:
#   1. a close with any unreached commit                 -> stranded-close
#   2. a working ticket no live entry names              -> working-no-run
#      (a busy slot whose repo is null OR matches, holding that issue, suppresses
#       it — err toward NOT filing when a report cannot name the repo). SUPPRESSED
#       WHOLESALE when reports_seen is false (#363): a cold-started dispatcher that
#       holds NO fresh report from any host cannot tell a dead run from a live one it
#       simply has not heard from yet, so it flags none. reports_seen defaults to
#       "live is non-empty" when the caller omits it.
#   3. a rescue branch not merged onto main              -> unrelanded-rescue
#   4. an OPEN agent PR, status success, not merged       -> unmerged-pr
# `key` is the stable dedup/title key ("<kind> <repo>#<number>", or for a rescue
# "<kind> <repo> <branch>"); the live filer searches on the title that carries it.
fleet_landing_detect() {
  jq -c '
    . as $f
    | (($f.live) // []) as $live
    | ( [ ($f.closes // [])[] | select(((.unreached) // []) | length > 0)
          | { kind:"stranded-close", repo, number, ref:(((.unreached) // []) | join(",")),
              key:("stranded-close \(.repo)#\(.number)"),
              evidence:("ticket closed but commit(s) " + (((.unreached) // []) | join(", "))
                        + " are absent from main (close-report claimed "
                        + ( ((.commits) // []) | if length == 0 then "no commits" else join(", ") end ) + ")") } ]
      + ( if ( ($f.reports_seen) // (($live | length) > 0) ) then
          [ ($f.working // [])[] as $w
            | select( ( $live | any(.issue == $w.number and (.repo == null or .repo == $w.repo)) ) | not )
            | { kind:"working-no-run", repo:$w.repo, number:$w.number, ref:null,
                key:("working-no-run \($w.repo)#\($w.number)"),
                evidence:"labelled agent-working but no fresh slot report holds it — the claiming run is gone" } ]
          else [] end )
      + [ ($f.rescues // [])[] | select(((.merged) // false) | not)
          | { kind:"unrelanded-rescue", repo:(.repo // null), number:null, ref:.branch,
              key:("unrelanded-rescue \((.repo) // "?") \(.branch)"),
              evidence:("rescue branch " + .branch + " is not on main — parked work never re-landed"
                        + (if .head then " (head " + .head + ")" else "" end)) } ]
      + [ ($f.prs // [])[] | select(((.state) // "open") == "open" and ((.status) // "") == "success" and (((.merged) // false) | not))
          | { kind:"unmerged-pr", repo, number, ref:(.head // null),
              key:("unmerged-pr \(.repo)#\(.number)"),
              evidence:("agent PR #" + (.number | tostring) + " (" + (.head // "?")
                        + ") is green but unmerged — no run reconciled it") } ]
      )' <<<"$1"
}

# fleet_landing_format <anomalies-json> -> one human log line per anomaly, the
# shadow surface the acceptance reads: the kind, the subject, and the evidence.
fleet_landing_format() {
  jq -r '.[] |
    "  LANDING \(.kind)  " + (.repo // "?")
    + (if .number then "#" + (.number | tostring)
       else (if .ref then " " + .ref else "" end) end)
    + "  [\(.evidence)]"' <<<"$1"
}

# ── gather: the forge / git reads that build the facts (fail-safe edges) ─────

# fleet_landing_issue_closed <root> <slug> <n> -> rc 0 iff the issue reads
# closed; rc 1 on open OR any read failure (never guess "closed" on a blip).
fleet_landing_issue_closed() {
  local raw state
  raw="$(_fleet_landing_api "$1/repos/$2/issues/$3" 2>/dev/null)" || return 1
  state="$(jq -r '.state // ""' <<<"$raw" 2>/dev/null)" || return 1
  [ "$state" = closed ]
}

# fleet_landing_close_commits <root> <slug> <n> -> the SHAs (space-separated) the
# NEWEST close-report envelope on the ticket claimed. close-report.sh posts the
# envelope inside a ```json fenced block in a "**close-report** for #N" comment;
# this reads .commits out of the latest such block. Empty (rc 0) when there is no
# close-report comment; rc 1 only on a failed comments read.
fleet_landing_close_commits() {
  local raw body
  raw="$(_fleet_landing_api "$1/repos/$2/issues/$3/comments?limit=50" 2>/dev/null)" || return 1
  body="$(jq -r '[.[]? | select((.body // "") | test("\\*\\*close-report\\*\\* for #"))]
                 | sort_by(.id) | last | .body // ""' <<<"$raw" 2>/dev/null)" || return 1
  [ -n "$body" ] || return 0
  # Pull the fenced envelope and read .commits; a body with no block / no commits
  # yields nothing. awk extracts the lines between ```json and the next fence.
  printf '%s\n' "$body" \
    | awk '/```json/{f=1;next} /```/{if(f){f=0}} f' \
    | jq -r '(.commits // [])[]? | tostring' 2>/dev/null | tr '\n' ' '
}

# fleet_landing_unreached <checkout> <main-ref> <commits> -> the subset of
# <commits> (space- or comma-separated) NOT reachable from <main-ref> in
# <checkout>, space-separated. A commit the checkout cannot even resolve (never
# fetched, because it never landed) is unreachable — exactly the stranded case.
fleet_landing_unreached() {
  local checkout="$1" main="${2:-$FLEET_LANDING_MAIN_REF}" shas="$3" c out=""
  shas="${shas//,/ }"
  for c in $shas; do
    [ -n "$c" ] || continue
    git -C "$checkout" merge-base --is-ancestor "$c" "$main" 2>/dev/null || out="$out$c "
  done
  printf '%s' "${out% }"
}

# _fleet_landing_main_patch_ids <checkout> <main-ref> -> the patch-id of each of the
# last FLEET_LANDING_PATCHID_SCAN commits on <main-ref>, one per line. Empty when the
# ref cannot be resolved. A patch-id is the stable hash of a commit's DIFF, so a
# commit rebased / cherry-picked / single-commit-squashed onto main keeps it under a
# new sha — this is how a rewritten-sha land is recognised (#363).
_fleet_landing_main_patch_ids() {
  git -C "$1" log -p --no-color -n "${3:-$FLEET_LANDING_PATCHID_SCAN}" "$2" 2>/dev/null \
    | git patch-id --stable 2>/dev/null | awk '{print $1}'
}

# _fleet_landing_commit_patch_id <checkout> <sha> -> the patch-id of <sha>'s diff,
# empty when the checkout cannot resolve it (never fetched) or it is a no-diff commit.
_fleet_landing_commit_patch_id() {
  git -C "$1" show --no-color "$2" 2>/dev/null | git patch-id --stable 2>/dev/null | awk '{print $1}'
}

# _fleet_landing_ref_on_main <checkout> <main-ref> <number> -> rc 0 iff a commit on
# <main-ref> (within the scan window) references #<number> in its message. The
# factory's commit discipline ties every landing commit to its ticket, so this is a
# sha-INDEPENDENT landing witness that survives a squash or merge that fuses several
# claimed commits into one (whose patch-id matches none of them). rc 1 when no such
# commit (or the ref cannot be resolved). Errs toward "landed" — detection prefers
# NOT filing a bogus front-of-queue ticket (the fail-safe posture of the whole slice).
_fleet_landing_ref_on_main() {
  local checkout="$1" main="$2" num="$3"
  case "$num" in ''|*[!0-9]*) return 1 ;; esac
  git -C "$checkout" log -E --grep="#$num([^0-9]|\$)" --format=%H \
    -n "$FLEET_LANDING_PATCHID_SCAN" "$main" 2>/dev/null | grep -q .
}

# fleet_landing_unlanded <checkout> <main-ref> <commits> [number] — the subset of
# <commits> (space/comma-separated) whose work is NOT on <main-ref>, space-separated.
# The by-SHA ancestry of fleet_landing_unreached is not evidence of a stranded close
# when the landing path rewrites commits (#363: a push rebase changes the sha; a PR
# merge or squash changes it too). A commit counts as LANDED when ANY witness holds:
#   1. its sha is an ancestor of main            (clean push / merge-commit PR)
#   2. its patch-id appears on main              (rebase / cherry-pick / 1-commit squash)
#   3. #<number> is referenced by a main commit  (multi-commit squash / merge — sha-free)
# so only a genuinely absent commit is returned. Witness 3 (when <number> is given)
# clears the WHOLE close at once; 1 and 2 are per-commit. main's patch-id set is read
# at most once. A commit the checkout cannot resolve AND whose ref is not on main is
# the stranded case — returned.
fleet_landing_unlanded() {
  local checkout="$1" main="${2:-$FLEET_LANDING_MAIN_REF}" shas="$3" number="${4:-}" c out="" mainids="" pid
  shas="${shas//,/ }"
  # Witness 3 first (cheap, one git log) — a referenced ticket is wholly landed.
  if [ -n "$number" ] && _fleet_landing_ref_on_main "$checkout" "$main" "$number"; then
    printf ''; return 0
  fi
  for c in $shas; do
    [ -n "$c" ] || continue
    git -C "$checkout" merge-base --is-ancestor "$c" "$main" 2>/dev/null && continue   # witness 1
    [ -n "$mainids" ] || mainids="$(_fleet_landing_main_patch_ids "$checkout" "$main")"
    pid="$(_fleet_landing_commit_patch_id "$checkout" "$c")"
    if [ -n "$pid" ] && printf '%s\n' "$mainids" | grep -qxF "$pid"; then continue; fi  # witness 2
    out="$out$c "
  done
  printf '%s' "${out% }"
}

# _fleet_landing_close_recent <closed_at_iso> -> rc 0 iff the close is YOUNGER than
# FLEET_LANDING_CLOSE_GRACE (so a run may still be landing it — do NOT judge it yet,
# #363/idss#2202). rc 1 when it is old enough to judge. FAILS SAFE: an absent or
# unparseable timestamp returns rc 0 (treat as too-recent — never call a close
# stranded on a timestamp we cannot read).
_fleet_landing_close_recent() {
  local closed="$1" now at
  [ -n "$closed" ] || return 0
  now="$(_fleet_landing_now)"
  at="$(jq -rn --arg c "$closed" '($c|fromdateiso8601?) // empty' 2>/dev/null)" || return 0
  case "$at" in ''|*[!0-9]*) return 0 ;; esac
  [ $(( now - at )) -lt "$FLEET_LANDING_CLOSE_GRACE" ]
}

# fleet_landing_working <root> <slug> -> JSON array of {repo, number} for the
# OPEN issues labelled agent-working whose label was applied longer ago than the
# grace window (so a just-claimed ticket whose first slot report has not arrived
# is never flagged). rc 1 (nothing) on a failed list read. The label-age filter
# needs one timeline read per candidate; agent-working tickets are bounded by the
# fleet's heavy-slot count, so this is a handful of reads per pass.
fleet_landing_working() {
  local root="$1" slug="$2" raw now out="[]" n at age
  raw="$(_fleet_landing_api "$root/repos/$slug/issues?state=open&type=issues&labels=agent-working&limit=50" 2>/dev/null)" || return 1
  now="$(_fleet_landing_now)"
  for n in $(jq -r '.[]?.number' <<<"$raw" 2>/dev/null); do
    case "$n" in ''|*[!0-9]*) continue ;; esac
    at="$(fleet_landing_label_applied_at "$root" "$slug" "$n" agent-working)" || continue
    case "$at" in ''|*[!0-9]*) continue ;; esac   # cannot time it -> do not flag
    age=$(( now - at ))
    [ "$age" -ge "$FLEET_LANDING_WORKING_GRACE" ] || continue
    # A live session / interactive claim takes agent-working but never occupies a
    # heavy slot, so no slot report will ever name it (#363) — judging it by slot
    # reports would file a bogus working-no-run. Drop it from the working set.
    _fleet_landing_session_held "$root" "$slug" "$n" && continue
    out="$(jq -c --arg r "$slug" --argjson n "$n" '. + [{repo:$r, number:$n}]' <<<"$out")"
  done
  printf '%s' "$out"
}

# fleet_landing_label_applied_at <root> <slug> <n> <label> -> epoch of the
# label's most-recent ADD on the issue timeline (empty on miss/parse-failure);
# the same shape forgejo_label_applied_at reads (type=="label", body=="1"), kept
# here on the explicit-root curl so the dispatcher needs no global FORGEJO_API.
fleet_landing_label_applied_at() {
  local raw
  raw="$(_fleet_landing_api "$1/repos/$2/issues/$3/timeline?limit=100" 2>/dev/null)" || return 1
  jq -r --arg L "$4" '
    [ .[]? | select(.type=="label" and .body=="1" and ((.label.name // "")==$L))
           | .created_at | fromdateiso8601? ] | (max // empty)' <<<"$raw" 2>/dev/null
}

# _fleet_landing_session_held <root> <slug> <n> -> rc 0 iff the issue carries a
# LIVE session claim: a `swarm-claim host=... run=... session-ttl=<N>` comment whose
# age is within its ttl (the session-runner / interactive claim shape, claim-lib.sh).
# Such a claim takes agent-working but occupies no heavy slot, so no slot report names
# it (#363) — the caller drops it from the working set rather than flag working-no-run.
# A null/unparseable created_at is treated as live (fail-closed, claim-lib's rule). rc
# 1 on no live session claim OR a failed comments read (the caller's other guards hold).
_fleet_landing_session_held() {
  local raw now held
  raw="$(_fleet_landing_api "$1/repos/$2/issues/$3/comments?limit=100" 2>/dev/null)" || return 1
  now="$(_fleet_landing_now)"
  held="$(jq -r --argjson now "$now" '
    [ .[]?
      | (.body // "") as $b
      | select($b | test("^swarm-claim host=\\S+ run=[0-9]+"))
      | ($b | split("\n")[0]) as $first
      | select($first | test(" session-ttl=[0-9]+( |$)"))
      | (($first | capture(" session-ttl=(?<t>[0-9]+)").t | tonumber)) as $ttl
      | (try (.created_at | fromdateiso8601) catch null) as $c
      | select(($c == null) or (($now - $c) <= $ttl)) ] | length' <<<"$raw" 2>/dev/null)" || return 1
  case "$held" in ''|0) return 1 ;; *) return 0 ;; esac
}

# fleet_landing_rescues <root> <slug> <checkout> [main-ref] -> JSON array of
# {repo, branch, head, merged} for every sandcastle/rescue-* branch on the forge,
# merged iff its head is reachable from <main-ref> in <checkout>. rc 1 (nothing)
# on a failed branch read. A head the checkout cannot resolve reads merged:false
# (surfaced) — a branch whose work never reached this checkout is exactly the
# un-relanded case. The forge is the branch authority (the checkout may not track
# rescue refs); reachability is the local main the checkout DOES track.
fleet_landing_rescues() {
  local root="$1" slug="$2" checkout="$3" main="${4:-$FLEET_LANDING_MAIN_REF}" raw out="[]" line branch head merged
  raw="$(_fleet_landing_api "$root/repos/$slug/branches?limit=100" 2>/dev/null)" || return 1
  while IFS=$'\t' read -r branch head; do
    [ -n "$branch" ] || continue
    if [ -n "$head" ] && git -C "$checkout" merge-base --is-ancestor "$head" "$main" 2>/dev/null; then
      merged=true
    else
      merged=false
    fi
    out="$(jq -c --arg r "$slug" --arg b "$branch" --arg h "$head" --argjson m "$merged" \
      '. + [{repo:$r, branch:$b, head:(if $h=="" then null else $h end), merged:$m}]' <<<"$out")"
  done <<<"$(jq -r '.[]? | select((.name // "") | startswith("sandcastle/rescue-"))
                    | "\(.name)\t\(.commit.id // "")"' <<<"$raw" 2>/dev/null)"
  printf '%s' "$out"
}

# fleet_landing_agent_prs <root> <slug> -> JSON array of {repo, number, head,
# state, status, merged} for every OPEN agent/issue-* PR, with its combined CI
# status (success|pending|failure|"") read from the PR head sha. rc 1 (nothing)
# on a failed pulls read. A PR whose status cannot be read reads status:"" and so
# is never flagged by rule 4 (only a proven-green unmerged PR is an anomaly).
fleet_landing_agent_prs() {
  local root="$1" slug="$2" raw out="[]" line num head sha status
  raw="$(_fleet_landing_api "$root/repos/$slug/pulls?state=open&limit=50" 2>/dev/null)" || return 1
  while IFS=$'\t' read -r num head sha; do
    case "$num" in ''|*[!0-9]*) continue ;; esac
    status=""
    if [ -n "$sha" ]; then
      status="$(_fleet_landing_api "$root/repos/$slug/commits/$sha/status" 2>/dev/null \
        | jq -r '.state // ""' 2>/dev/null || true)"
    fi
    out="$(jq -c --arg r "$slug" --argjson n "$num" --arg h "$head" --arg s "$status" \
      '. + [{repo:$r, number:$n, head:$h, state:"open", status:$s, merged:false}]' <<<"$out")"
  done <<<"$(jq -r '.[]? | select((.head.ref // "") | startswith("agent/issue-"))
                    | "\(.number)\t\(.head.ref)\t\(.head.sha // "")"' <<<"$raw" 2>/dev/null)"
  printf '%s' "$out"
}

# fleet_landing_merge_authority <checkout> -> agent-after-green | human. Case 4
# (a green unmerged agent PR) is an anomaly ONLY where the machinery was meant to
# merge it (MERGE_AUTHORITY=agent-after-green): under `human` a green agent PR
# awaiting a person is the normal state, and a push-mode repo has no agent PR at
# all, so flagging either would be noise. MERGE_AUTHORITY is a plain KEY=value in
# the repo's swarm-policy.sh (ADR 0002) — read it directly rather than sourcing
# the policy layer (no side effects); anything but an explicit `agent-after-green`
# (absent file, unreadable, human) answers `human`, so case 4 FAILS SAFE to off.
fleet_landing_merge_authority() {
  local checkout="$1" f v
  for f in "$checkout/.sandcastle/swarm-policy.sh" "$checkout/swarm-policy.sh"; do
    [ -f "$f" ] || continue
    v="$(sed -n 's/^[[:space:]]*MERGE_AUTHORITY=["'\'']*\([A-Za-z-]*\).*/\1/p' "$f" 2>/dev/null | tail -1)"
    [ "$v" = agent-after-green ] && { printf 'agent-after-green'; return 0; }
    break
  done
  printf 'human'
}

# ── file: surface each anomaly at the FRONT of the fleet queue ───────────────

# _fleet_landing_label_id <root> <slug> <name> -> the label id on <slug>, empty
# on miss/failure.
_fleet_landing_label_id() {
  local raw
  raw="$(_fleet_landing_api "$1/repos/$2/labels?limit=100" 2>/dev/null)" || return 0
  jq -r --arg n "$3" 'first(.[]? | select(.name==$n) | .id) // empty' <<<"$raw" 2>/dev/null
}

# _fleet_landing_existing <root> <slug> <title> -> rc 0 iff an OPEN issue whose
# title is exactly <title> already exists (the anomaly is already surfaced). rc 1
# when none exists. FAILS CLOSED: a read it cannot complete returns rc 0 (treat
# as "already exists", so the filer does NOT file) — a transient blip must never
# spawn a duplicate front-of-queue ticket; the next pass retries.
_fleet_landing_existing() {
  local root="$1" slug="$2" title="$3" raw hit
  raw="$(_fleet_landing_api --get --data-urlencode "q=$title" \
      "$root/repos/$slug/issues?state=open&type=issues&limit=50" 2>/dev/null)" || return 0
  hit="$(jq -r --arg t "$title" 'any(.[]?; (.title // "")==$t)' <<<"$raw" 2>/dev/null)" || return 0
  [ "$hit" = true ]
}

# fleet_landing_file <mode> <root> <slug> <anomaly-json> — surface ONE anomaly.
# shadow: LOG what it would file, file nothing (decision 6a). live: file a
# `priority` ticket (front of the fleet order) into the anomaly's own repo UNLESS
# one with that title is already open (idempotent — re-arm, never re-file). Always
# rc 0: a filing failure is one stderr line, never a dead dispatcher pass. The
# ticket is DETECT-ONLY — its body names the evidence and the repair machinery;
# the dispatcher never repairs (decision 5).
fleet_landing_file() {
  local mode="$1" root="$2" slug="$3" anom="$4" key title body kind repo number ref evidence lid code
  key="$(jq -r '.key' <<<"$anom" 2>/dev/null)" || return 0
  [ -n "$key" ] && [ "$key" != null ] || return 0
  title="$FLEET_LANDING_TITLE_PREFIX $key"
  kind="$(jq -r '.kind' <<<"$anom")"; repo="$(jq -r '.repo // "?"' <<<"$anom")"
  number="$(jq -r '.number // ""' <<<"$anom")"; ref="$(jq -r '.ref // ""' <<<"$anom")"
  evidence="$(jq -r '.evidence' <<<"$anom")"

  if [ "$mode" != live ]; then
    echo "fleet-landing: SHADOW — would file at the front of the fleet queue: \"$title\" — $evidence; filing nothing (ADR 0009 decision 6a)"
    return 0
  fi

  if _fleet_landing_existing "$root" "$slug" "$title"; then
    echo "fleet-landing: \"$title\" already open — re-armed, not re-filed"
    return 0
  fi

  body="**Landing anomaly detected by the fleet dispatcher** (ADR 0009 decision 5 / #358).

- **kind:** \`$kind\`
- **subject:** $repo${number:+#$number}${ref:+ \`$ref\`}
- **evidence:** $evidence

This ticket only makes the anomaly a fact at the head of the line (\`priority\`, so the fleet order works it next). The dispatcher **detects, it does not repair** — the repair is the machinery that already exists (the janitor, the idle landing sweep #114, the stranded-close reopen #283/#328, the rescue ladder, or a worker). Filed by the dispatcher's periodic landing pass; it will re-arm rather than re-file this title while the anomaly stands.

Ruled by agent under ADR 0174 — veto anytime."

  lid="$(_fleet_landing_label_id "$root" "$slug" priority)"
  # The create POST streams its JSON body on stdin (-d @-), so the auth header
  # cannot ride --config - (stdin is taken); write it to a mode-600 config file and
  # pass --config <file> — the token stays off argv (#363), out of `ps`. rm on exit.
  local authcfg; authcfg="$(mktemp 2>/dev/null)" || authcfg=""
  if [ -n "$authcfg" ]; then
    chmod 600 "$authcfg" 2>/dev/null || true
    printf 'header = "Authorization: token %s"\n' "${FORGEJO_TOKEN:-}" >"$authcfg"
  fi
  code="$(jq -n --arg t "$title" --arg b "$body" \
      "$( [ -n "$lid" ] && printf '{title:$t, body:$b, labels:[%s]}' "$lid" || printf '{title:$t, body:$b}' )" \
    | curl -s -o /dev/null -w '%{http_code}' --max-time "$FLEET_LANDING_MAX_TIME" \
        ${authcfg:+--config "$authcfg"} \
        -X POST -H 'Content-Type: application/json' -d @- \
        "$root/repos/$slug/issues" 2>/dev/null)" || true
  [ -n "$authcfg" ] && rm -f "$authcfg" 2>/dev/null || true
  case "${code:-000}" in
    2??) echo "fleet-landing: filed \"$title\" at the front of the fleet queue${lid:+ (priority)}" ;;
    *)   echo "fleet-landing: could NOT file \"$title\" (http=${code:-000}) — the next pass retries" >&2 ;;
  esac
  return 0
}

fi
