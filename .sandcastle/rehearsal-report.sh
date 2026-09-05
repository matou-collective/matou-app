#!/usr/bin/env bash
# The rehearsal ratchet's reporter (spec 2026-08-09-183-vps-rehearsal-ratchet):
# on a red drive, diagnose the run dir headlessly, dedup by incident signature
# (heal-lib's normalization), and file/append a rehearsal-183 issue. Caps:
# max REHEARSAL_FILING_CAP NEW issues per drive (default 2), never re-file a
# signature. Always exits 0 —
# the DRIVE's exit code is the drive's; a reporter crash must not mask it.
#
# Arg 3, the IP of the box the drive stood up, is the live door (#540): the
# caller's own box-cleanup path calls this SCRIPT before teardown destroys the
# box, so an IP here means the diagnosis can ssh in and ask the box directly
# instead of guessing from the harvested logs alone. Omitted (a manual run, or
# a caller whose drive keeps no reachable box) keeps today's text-only
# diagnosis unchanged. "Box" is the shape-neutral role (CONTEXT.md): a
# consumer's drive may stand up a container, a VM, bare metal or a provider's
# instance, and this file is vendored byte-identical into all of them (#53).
#
# Signature keys on the failing LEG, not the raw error line: the leg is the
# stable dedup axis (one hole per red leg), while run-specific noise in the
# error — 6-hex worker suffixes below normalize_error_line's 7-char fold, ports,
# "run <id>" tails — must NOT mint a fresh signature (the 2026-08-01 storm
# lesson, re-taught by the offline test's noise case). The error still drives
# the diagnosis body.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REHEARSAL_HEAL_PROMPT_FILE="${REHEARSAL_HEAL_PROMPT_FILE:-$here/rehearsal-heal-prompt.md}"
REHEARSAL_REPORT_PROMPT_FILE="${REHEARSAL_REPORT_PROMPT_FILE:-$here/rehearsal-report-prompt.md}"
# shellcheck source=swarm-identity.sh
. "$here/swarm-identity.sh"   # FORGEJO_API / REPO_SLUG — this repo's identity (ADR 0180 / #571)
# shellcheck source=forgejo-lib.sh
. "$here/forgejo-lib.sh"   # forgejo_* — the tracker adapter (ADR 0180 / #571)
# shellcheck source=evidence-lib.sh
. "$here/evidence-lib.sh"   # pick_representative_screenshot (#596)
# shellcheck source=heal-lib.sh
. "$here/heal-lib.sh"    # normalize_error_line, display_error_line, compute_signature
# shellcheck source=limit-lib.sh
. "$here/limit-lib.sh"   # claude_limit_parked / _hit / _park
# shellcheck source=model-lib.sh
. "$here/model-lib.sh"   # SWARM_HEAL_MODEL / SWARM_REPORT_MODEL — swarm.config is the ONE model source (#448); before this both claude legs passed no --model and ran on the host user's CLI default
# shellcheck source=rehearsal-heal-lib.sh
. "$here/rehearsal-heal-lib.sh"   # heal_rails, scrub_commit_message, heal_fail_*
# The healer (spec 2026-08-10-rehearsal-healer-design): one tool-enabled
# session per red may fix a small certain defect and the SCRIPT pushes it.
# Its own DEDICATED clone (#576 — never the shared checkout peer sessions
# work in; session-runner.sh ruled the same way first). REHEARSAL_HEAL_REPO
# is the clone source; REHEARSAL_CHECKOUT is where it lives on disk, cloned
# on first use and hard-reset before every heal (see try_heal) — mirrors
# session-runner.sh's own-checkout pattern. Both derive from REPO_SLUG so a
# byte-identical vendored copy never hardcodes which repo it's healing.
: "${REHEARSAL_HEALER:=1}"
: "${REHEARSAL_HEAL_REPO:=https://git.matou.nz/${REPO_SLUG}.git}"
: "${REHEARSAL_CHECKOUT:=${HOME:-/tmp}/rehearsal-heal/${REPO_SLUG##*/}}"
# rail 6's failure counter needs a state dir; the executor env never exported
# one, and heal-lib's ${REHEARSAL_STATE:?} guard fires inside $(...)
# substitutions — under set -u that is a SILENT no-op that disabled the
# two-mechanical-failures backstop (drive 20260811T165115Z, two bare
# "REHEARSAL_STATE unset" lines in the executor log). Default + create it
# here; an explicit env var still wins.
: "${REHEARSAL_STATE:=${HOME:-/tmp}/.local/state/${REPO_SLUG##*/}-rehearsal}"
mkdir -p "$REHEARSAL_STATE" 2>/dev/null || true
export REHEARSAL_STATE
# Per-arc filing cap (#1138, the #854 phase-5 retrospective): how many NEW
# issues one drive may file before it stops — and, if nothing else matched,
# parks the drive on a human. Lifted out of the loop as an env default so the
# host's rehearsal-env.sh can raise it for an arc expected to run overnight
# (more distinct faults tolerated before a park) WITHOUT a code change; unset
# keeps the historical 2. The park itself pages now (page_silent_park below).
: "${REHEARSAL_FILING_CAP:=2}"
# Where the silent-park marker lives — the same test-results/flip-pages/<drive>
# dir the executor's rehearsal-flip-page-lib writes, so the reporter's IMMEDIATE
# park page and the executor's next-tick page share ONE marker and never double
# up (the "one page per flip, not per tick" contract). Defaults to the repo root
# ($here/..) exactly as the executor derives its own root; a test overrides it to
# stay hermetic.
REHEARSAL_FLIP_PAGE_ROOT="${REHEARSAL_FLIP_PAGE_ROOT:-$(cd "$here/.." && pwd)}"
healed_any=false
healer_attempted=false
HEAL_FILE_VERDICT=""
HEAL_RESIDUAL_VERDICT=""

run_dir="${1:?usage: rehearsal-report.sh <run-dir> [drive-rc] [box-ip]}"
box_ip="${3:-}"
if [ -z "${FORGEJO_TOKEN:-}" ] && [ -f "$here/secrets/forgejo_token" ]; then
  FORGEJO_TOKEN="$(cat "$here/secrets/forgejo_token")"
fi
: "${REHEARSAL_LABEL:=rehearsal-183}"
# The incident-signature NAMESPACE (#51). It used to be the string
# "rehearsal-183" written into compute_signature at the call site — one drive's
# number hardcoded in a vendored harness file, so two repos running a drive
# would share one signature space and the same leg name in both would fold to
# the same signature. It follows the drive's LABEL, which is already the
# drive's per-repo name, so today's signatures are unchanged. Overridable on
# its own for the one case where following the label is wrong: a repo that
# RENAMES its label after filing pins the old value here, or every open issue's
# dedup marker orphans and re-files (capped at 2 per drive, but still noise).
: "${REHEARSAL_SIGNATURE_NS:=$REHEARSAL_LABEL}"
# Where the evidence bundle SITS, for the note a human reads on the issue
# (#51 — it used to name one product's workstation literally, #43's family).
# Order is declared-before-probed, the factory's rule everywhere else (ADR
# 0005: capacity is declared, never inferred): the claim identity first
# (SWARM_HOST is the only name that survives a container, where `hostname` is
# a random id), then the repo's own identity layer, and `hostname` only when a
# consumer's identity layer predates RUNNER_HOST. A drive whose evidence lands
# on neither box overrides this directly.
: "${REHEARSAL_EVIDENCE_HOST:=${SWARM_HOST:-${RUNNER_HOST:-$(hostname 2>/dev/null || echo "the drive host")}}}"
# The standing drive issue (spec "The cycle"): every red BLOCKS it so the
# swarm's ready list re-fires the drive only when the plugs land. A consumer
# that runs a drive declares its number in the identity/.env layer.
#
# Unlike its FILTER-side siblings (list-ready-tasks.sh, session-runner.sh) this
# script's every REHEARSAL_DRIVE_ISSUE use is a WRITE — a comment, a dependency
# wire, a ready-for-agent/-human label flip. So an empty value cannot default
# to any product's number: this is a byte-identical vendored harness file, and
# #43 already pulled one product's host fact out of it for exactly this reason.
# The filters default it EMPTY because an empty FILTER filters nothing; here
# "empty" instead means "wire NOTHING, and say so" — never write to issue ''
# (which in a consumer's tracker is a real, unrelated issue). drive_issue_set
# gates every write below (#54).
: "${REHEARSAL_DRIVE_ISSUE:=}"
drive_issue_set() { [ -n "$REHEARSAL_DRIVE_ISSUE" ]; }

# match_sig <issues-json> <sig> — the open issue number carrying this incident
# signature, or empty. One definition for both the pre-diagnosis check (skip an
# expensive diagnosis when the hole is already tracked) and the pre-file
# re-check (#403 defect 3) below.
match_sig() {
  jq -r --arg m "rehearsal-sig: $2" '.[]? | select(.body // "" | contains($m)) | .number' <<<"$1" 2>/dev/null | head -1
}

# append_evidence <issue-number> <note> — land one drive-evidence comment.
# #596: also attaches one representative screenshot (newest *.png under
# $run_dir) to the SAME comment via Forgejo's comment-asset API, best-effort
# — a missing screenshot or a failed attach never fails the comment itself,
# the host-path note in $2 still stands as the fallback. rc = the comment
# post's, unchanged from before this ticket.
append_evidence() {
  local id shot
  id="$(forgejo_comment_id "$1" "$2")" || return 1
  if [ -n "$id" ]; then
    shot="$(pick_representative_screenshot "$run_dir")"
    [ -n "$shot" ] && forgejo_attach_comment_asset "$id" "$shot" "$(basename "$shot")" >/dev/null
  fi
}

# parse_diagnosis <raw> — echo a clean JSON object carved from claude's stdout,
# rc 1 if none is recoverable. A manual run of the report prompt returns clean
# JSON, but the in-pipeline run intermittently wraps it in a markdown code fence
# or prefixes prose that jq can't parse (#403 defect 2 — a silent degrade to a
# generic ready-for-human filing on 3 of 5 drives). Strip lone fence lines, then
# fall back to the first-brace…last-brace span, before handing to jq.
parse_diagnosis() {
  local raw="$1" s ob='{' cb='}' span
  s="$(sed '/^[[:space:]]*```[[:alnum:]]*[[:space:]]*$/d' <<<"$raw")"
  if jq -e 'type=="object"' >/dev/null 2>&1 <<<"$s"; then printf '%s' "$s"; return 0; fi
  case "$s" in
    *"$ob"*"$cb"*)
      span="$ob${s#*"$ob"}"; span="${span%"$cb"*}$cb"
      if jq -e 'type=="object"' >/dev/null 2>&1 <<<"$span"; then printf '%s' "$span"; return 0; fi ;;
  esac
  return 1
}

# try_heal <leg> <err> <sig> <stamp> — one tool-enabled session may fix a
# small, certain defect and the SCRIPT pushes it through the gate (spec
# 2026-08-10-rehearsal-healer-design). rc 0 = healed, drive stays armed.
# rc 1 = not healed; HEAL_FILE_VERDICT may carry the session's file-verdict
# so the filing flow below reuses it (one claude call per red, ever).
#
# claude_auth_failed/CLAUDE_AUTH_RE now live in limit-lib.sh (#632 —
# run-swarm.sh needed the identical classifier for its own worker-log guard,
# so it moved to the shared lib both scripts already source rather than
# drifting a second copy, the same lesson CLAUDE_LIMIT_RE already teaches).
# Until 2026-08-21 an auth refusal here read as an "unparseable verdict": five
# consecutive red drives (003234Z..030832Z) went straight to a ticket with
# "(headless diagnosis unparseable)" while the real cause — "Failed to
# authenticate: OAuth session expired and could not be refreshed" — sat unread
# in healer-claude.out. Ben's rule: never silent. Detect it, fail over ONCE
# like a limit hit, and if both accounts refuse, say so on the drive ticket
# and stop pretending to diagnose.
claude_auth_announce() { # <who> <run_dir>
  local who="$1" run_dir="$2" acct tok
  acct="$(claude_active_account 2>/dev/null || echo A)"
  tok="${CLAUDE_CODE_OAUTH_TOKEN:-}"
  local msg="rehearsal $who: CLAUDE AUTH FAILED on account $acct (token ${tok:+${tok:0:14}…}${tok:-EMPTY}) — $(grep -ihoE "$CLAUDE_AUTH_RE[^\"]*" "$run_dir"/logs/$who-claude.out "$run_dir"/logs/$who-claude.err 2>/dev/null | head -1). Token source is ${HOST_ENV_FILE:-the host's env file (per the host registry's env directive)} (token-sync from the org secret CLAUDE_CODE_OAUTH_TOKEN[_B]); env seen by the call: logs/claude-env.txt in $run_dir"
  echo "$who: $msg" >&2
  drive_issue_set && forgejo_comment "$REHEARSAL_DRIVE_ISSUE" ":rotating_light: @ben $msg" >/dev/null 2>&1
  bash "$here/notify-mattermost.sh" "@ben $msg" >/dev/null 2>&1 || true
}

try_heal() {
  local leg="$1" err="$2" sig="$3" stamp="$4"
  HEAL_FILE_VERDICT=""
  HEAL_RESIDUAL_VERDICT=""
  local co="$REHEARSAL_CHECKOUT"
  # Dedicated checkout, no peers: clone once, then fetch + hard-reset + clean
  # before EVERY heal (session-runner.sh's own pattern). This self-heals any
  # leftover dirt from a session that was killed mid-run (the `timeout 1800`
  # below has no cleanup trap of its own) instead of refusing forever — the
  # old shared-checkout dirty-tree refusal was a TOCTOU with no lock; here
  # there is nothing else that can dirty it between the check and the use.
  if [ ! -d "$co/.git" ]; then
    mkdir -p "$(dirname "$co")"
    if ! git clone -q "$(rehearsal_heal_authed_url "$REHEARSAL_HEAL_REPO")" "$co" 2>/dev/null; then
      echo "healer: clone of $REHEARSAL_HEAL_REPO to $co failed — filing instead"
      return 1
    fi
  fi
  # #676: a checkout cloned before this fix (or one whose token rotated) is
  # still carrying a bare, credential-less git.matou.nz origin — refresh it
  # every heal so `heal_push`'s later `git push origin` never hits the
  # headless username prompt that stranded e920f9e7. A no-op for the test
  # fixtures' local bare origins (rehearsal_heal_authed_url passes them
  # through unchanged).
  git -C "$co" remote set-url origin "$(rehearsal_heal_authed_url "$(git -C "$co" remote get-url origin 2>/dev/null)")" 2>/dev/null || true
  if ! git -C "$co" fetch -q origin 2>/dev/null \
     || ! git -C "$co" reset -q --hard origin/main 2>/dev/null; then
    echo "healer: could not sync dedicated checkout at $co — filing instead"
    return 1
  fi
  git -C "$co" clean -qfd >/dev/null 2>&1 || true
  # Rail 6 counts per FAULT (leg + normalised error), not per leg-keyed
  # signature: the incident signature folds every fault on a leg together
  # (GOTCHAS #16 by design), so keying the backstop on it locked the `join`
  # leg out after two unrelated cap breaches (#936/#937 → #938/#939 never got
  # a heal attempt, 2026-08-28).
  local fault
  fault="$(compute_signature "$REHEARSAL_SIGNATURE_NS" "$leg :: $err")"
  # Loop-guard (#1144 rail-6): a fault HEALED on a prior drive that has redded
  # again is a failed heal — file, never a second heal (no heal loops). File it
  # ourselves with a loop-guard diagnosis so the drive BLOCKS instead of
  # re-firing into it; no claude call is spent on a fault we already know resists.
  if [ "$(heal_healed_count "$fault")" -ge 1 ]; then
    echo "healer: fault $fault (sig $sig) was healed on a prior drive and redded again — loop-guard: filing, no second heal (rail 6)"
    HEAL_FILE_VERDICT="$(jq -cn --arg leg "$leg" \
      '{action:"file",
        title:($leg + " — healer loop-guard: a prior heal did not hold"),
        body:("A prior drive healed this exact fault (`" + $leg + "` :: same normalised error) and it has redded again. Per rail 6 (no heal loops), the healer refused a second heal and filed this blocker so the drive stops re-firing into it.\n\n**Healer refused: loop-guard rule** — diagnose why the prior heal did not hold before re-arming.\n\n_ticket-on-refusal under the healer-first regime (#1144)_"),
        confident:false}')"
    return 1
  fi
  if [ "$(heal_fail_count "$fault")" -ge 2 ]; then
    echo "healer: fault $fault (sig $sig) failed mechanically twice — filing instead (backstop)"
    return 1
  fi
  local pre_head history out verdict action
  pre_head="$(git -C "$co" rev-parse HEAD)"
  # The healer's own recent trail on the drive issue: informed retry judgment
  # (Ben's ruling: the healer judges each time; history is its memory). With no
  # drive declared there is no trail to read — an empty history, never a
  # malformed /issues//comments read (#54).
  history=""
  if drive_issue_set; then
    history="$(forgejo_get "/issues/$REHEARSAL_DRIVE_ISSUE/comments?limit=50" \
      | jq -r '[.[]? | select(.body | startswith("rehearsal healer"))][-3:] | .[].body' 2>/dev/null || true)"
  fi
  # Flags BEFORE -p, prompt bound directly to it: --allowedTools is variadic
  # and eats following positionals — with flags between -p and the prompt it
  # consumed the PROMPT ITSELF as allow rules (runs 001112Z/071123Z, empty out).
  # Limit-hit checks BOTH streams: on 2026-08-14 the refusal line arrived on
  # STDOUT (the .out file) while .err stayed 0 bytes, so an err-only check
  # missed it and the generic fallback filed (#530's raw-fallback ticket).
  # Two-account failover (#510): a limit on the active account flips to the
  # standby and retries ONCE; both exhausted → park, file instead (as before).
  # Diagnostic (2026-08-21): every in-drive healer/reporter claude call since
  # 00:32Z died with "OAuth session expired and could not be refreshed" while the
  # identical call succeeds from every manual reproduction (interactive, both
  # devshells, cron-mimic env -i). Capture the env the call actually sees so the
  # next red explains itself. Token values are truncated to a 14-char prefix.
  { echo "cwd=$co"; echo "uid=$(id -u) user=$(id -un)"; env | LC_ALL=C sort \
      | grep -E '^(HOME|USER|LOGNAME|SHELL|PATH|TMPDIR|XDG_[A-Z_]+|CLAUDE[A-Z_]*|ANTHROPIC[A-Z_]*|NODE[A-Z_]*|SSL_[A-Z_]+|https?_proxy|HTTPS?_PROXY|NO_PROXY|no_proxy|NIX_[A-Z_]+|IN_NIX_SHELL|name)=' \
      | sed -E 's/^((CLAUDE|ANTHROPIC)[A-Z_]*(TOKEN|KEY)[A-Z_]*=.{14}).*/\1…/'; } \
    > "$run_dir/logs/claude-env.txt" 2>&1 || true
  claude_select_token
  local heal_attempt=1 heal_transient=0
  while :; do
    out="$(cd "$co" && timeout 1800 claude --model "$SWARM_HEAL_MODEL" \
        --permission-mode acceptEdits --allowedTools "Edit,Write,Bash" \
        -p "$(cat "$REHEARSAL_HEAL_PROMPT_FILE")

Run directory: $run_dir
Red leg: $leg
Error: $err
Signature: $sig
Recent healer history on #$REHEARSAL_DRIVE_ISSUE (empty = none):
${history:-none}" 2>"$run_dir/logs/healer-claude.err" || true)"
    printf '%s\n' "$out" > "$run_dir/logs/healer-claude.out"
    if claude_auth_failed "$run_dir/logs/healer-claude.err" "$run_dir/logs/healer-claude.out"; then
      if [ "$heal_attempt" = 1 ] && claude_failover; then
        heal_attempt=2
        echo "healer: Claude auth refused — failed over to account $(claude_active_account); retrying once"
        continue
      fi
      claude_auth_announce healer "$run_dir"
      git -C "$co" reset --hard "$pre_head" >/dev/null 2>&1 || true
      HEAL_AUTH_FAILED=1
      return 1
    fi
    if claude_limit_hit "$run_dir/logs/healer-claude.err" \
       || claude_limit_hit "$run_dir/logs/healer-claude.out"; then
      if [ "$heal_attempt" = 1 ] && claude_failover; then
        heal_attempt=2
        echo "healer: Claude account limited — failed over to account $(claude_active_account); retrying once"
        continue
      fi
      claude_limit_park
      echo "healer: claude limit hit — parking, filing instead"
      git -C "$co" reset --hard "$pre_head" >/dev/null 2>&1 || true
      return 1
    fi
    # Transient API fault (idss freshness-tax finding 5): NO verdict came back
    # AND the CLI reported a 5xx/overloaded error — wait once, retry once. Only
    # when nothing parsed: a healed verdict whose narrative quotes an API error
    # is still a verdict. A second transient in a row falls through to filing,
    # named as such (never "unparseable").
    if ! parse_diagnosis "$out" >/dev/null 2>&1 \
       && claude_transient_hit "$run_dir/logs/healer-claude.err" "$run_dir/logs/healer-claude.out"; then
      if [ "$heal_transient" = 0 ]; then
        heal_transient=1
        echo "healer: Claude API transient fault (5xx/overloaded) — retrying once in ${CLAUDE_TRANSIENT_RETRY_DELAY}s (a 529 is a minute of waiting, not a diagnosis)"
        git -C "$co" reset --hard "$pre_head" >/dev/null 2>&1 || true
        sleep "$CLAUDE_TRANSIENT_RETRY_DELAY"
        continue
      fi
      echo "healer: Claude API transient fault twice in a row — reverting and filing (raw in logs/healer-claude.out)"
      git -C "$co" reset --hard "$pre_head" >/dev/null 2>&1 || true
      HEAL_TRANSIENT=1
      return 1
    fi
    break
  done
  if ! verdict="$(parse_diagnosis "$out")"; then
    echo "healer: unparseable verdict — reverting and filing (raw in logs/healer-claude.out)"
    git -C "$co" reset --hard "$pre_head" >/dev/null 2>&1 || true
    return 1
  fi
  action="$(jq -r '.action // empty' <<<"$verdict" 2>/dev/null)"
  if [ "$action" != "healed" ]; then
    # A judgment decline (or a legacy no-action diagnosis): discard any stray
    # edits and hand the verdict to the filing flow. Declines never count
    # toward the mechanical backstop.
    git -C "$co" reset --hard "$pre_head" >/dev/null 2>&1 || true
    HEAL_FILE_VERDICT="$verdict"
    return 1
  fi
  if ! heal_rails "$co" "$pre_head"; then
    heal_fail_mark "$fault"
    # Ticket-on-refusal (#1144): the rails refused this fix — file the blocker
    # ourselves, naming the rule that fired, reusing the healer's single claude
    # call (no second diagnosis). SWARMABLE picks the label: a too-big-but-
    # mechanical fix is swarm-actionable; a would-weaken-a-check / product-
    # surface refusal needs a session or a design ruling.
    local hsummary confident_flag
    hsummary="$(jq -r '.summary // "the healer proposed a fix"' <<<"$verdict" 2>/dev/null)"
    confident_flag=false; [ "${HEAL_RAIL_SWARMABLE:-false}" = "true" ] && confident_flag=true
    HEAL_FILE_VERDICT="$(jq -cn --arg leg "$leg" --arg rule "${HEAL_RAIL_REASON:-a refusal rule}" \
      --arg sum "$hsummary" --argjson conf "$confident_flag" \
      '{action:"file",
        title:($leg + " — healer refused (" + $rule + ")"),
        body:("The healer diagnosed this red and proposed a fix, but a refusal rule fired so **no commit landed** — the rails reverted it.\n\n**Healer refused: " + $rule + "**\n\n**What the healer found:** " + $sum + "\n\nThe healer may never weaken what a check proves, exceed the line cap, or change a product-behaviour surface (#1144). Route this to a swarm worker or a design ruling as the label suggests.\n\n_ticket-on-refusal under the healer-first regime (#1144)_"),
        confident:$conf}')"
    return 1
  fi
  scrub_commit_message "$co"
  # Rebase onto origin/main before pushing so a concurrent advance of main (an
  # operator sitting on the harness, the swarm draining tickets) can't lose this
  # heal to a non-fast-forward. A conflict / persistent refusal / cap breach on
  # the replayed commit resets and files, preserving the blocked invariant (#460).
  if ! heal_push "$co" "$pre_head" "$run_dir"; then
    heal_fail_mark "$fault"
    return 1
  fi
  heal_fail_clear "$fault"
  # Loop-guard bookkeeping (#1144 rail-6): remember we healed this fault so a
  # re-red on a later drive routes straight to ticket-on-refusal above.
  heal_healed_mark "$fault"
  # A heal may fix only the red's PRESENTATION (a hidden bar, a swallowed
  # error) while a distinct substantive fault remains — drive 20260811T165115Z
  # healed the standup bar, NAMED the supply host-key fault in its summary, and
  # left the drive armed with nothing filed (one paid re-drive of the box per
  # occurrence). The session may hand that fault back as `residual` (same shape
  # as a file-verdict); the caller routes it through the filing flow.
  HEAL_RESIDUAL_VERDICT="$(jq -c '.residual // empty | select(type=="object")' <<<"$verdict" 2>/dev/null || true)"
  local head stat checks armed_note
  head="$(git -C "$co" rev-parse HEAD)"
  stat="$(git -C "$co" diff --stat "$pre_head..$head" | tail -1 | sed 's/^ *//')"
  checks="$(jq -r '.checks // "none reported"' <<<"$verdict" 2>/dev/null)"
  armed_note="The drive stays armed; the next tick re-drives."
  [ -n "$HEAL_RESIDUAL_VERDICT" ] && armed_note="The session also named a residual fault — it is being filed and will block the drive."
  if drive_issue_set; then
    forgejo_comment "$REHEARSAL_DRIVE_ISSUE" \
      "rehearsal healer: drive \`$stamp\` red at \`$leg\` (sig $sig) self-fixed — commit \`$head\` ($stat); checks: $checks. $armed_note" \
      2>/dev/null || true
  fi
  return 0
}

legs="$run_dir/artifacts/legs.json"
if [ ! -f "$legs" ]; then
  # A red before the leg registry ran (wizard/broker/install). Synthesize one
  # record from the log tail so the signature machinery still has a leg to key.
  err="$(tail -40 "$run_dir"/logs/*.txt 2>/dev/null | grep -m1 -E 'Error|error|FAIL|timed out' || echo 'red before legs.json was written')"
  if ! printf '[{"leg":"pre-legs","status":"red","ms":0,"error":%s}]' \
        "$(jq -Rn --arg e "$err" '$e')" > "$legs" 2>/dev/null; then
    echo "reporter: no legs.json and cannot synthesize — nothing to report"
    exit 0
  fi
fi

# Green drive posts nothing (spec): collect the red legs first. A red drive
# with zero red legs is NOT green — the wizard died before driveLegs ran, so
# legs.json is empty / all-non-red (S1–S5 precede every leg). The caller passes
# the DRIVE's exit code as arg 2; the invariant (#392) is that any red drive
# ends with the drive issue blocked, so a red drive with no red legs synthesizes
# a "wizard" red — same shape as the pre-legs synthesis above — and files it.
#
# #574: artifacts/verdict.json (ADR 0183 clause 5), when present, is
# AUTHORITATIVE over the arg-2 rc — it is written unconditionally by the same
# process that writes legs.json, so the run dir says green-or-red on its own
# instead of trusting a caller to pass the right exit code out of band (the
# exact hazard this ticket closes). Its absence (older run dirs, a driver that
# predates the clause) falls back to arg 2 unchanged — byte-identical to before.
drive_rc="${2:-0}"
verdict_file="$run_dir/artifacts/verdict.json"
if [ -f "$verdict_file" ]; then
  file_verdict="$(jq -r '.verdict // empty' "$verdict_file" 2>/dev/null)"
  case "$file_verdict" in
    red)   drive_rc=1 ;;
    green) drive_rc=0 ;;
  esac
fi
mapfile -t reds < <(jq -c '.[] | select(.status=="red")' "$legs" 2>/dev/null)
if [ "${#reds[@]}" -eq 0 ]; then
  if [ "$drive_rc" = "0" ]; then
    echo "reporter: no red legs and drive rc=0 — green drive, nothing to file"
    exit 0
  fi
  err="$(tail -40 "$run_dir"/logs/*.txt 2>/dev/null | grep -m1 -E 'Error|error|FAIL|timed out' || echo 'drive red at wizard — the wizard died before any leg ran')"
  echo "reporter: red drive (rc=$drive_rc) with zero red legs — filing drive-red-at-wizard"
  reds=("$(jq -cn --arg e "$err" '{leg:"wizard", status:"red", ms:0, error:$e}')")
fi

# Consumer report-guard hook (#931): an OPTIONAL, consumer-OWNED extension
# point, run once the red set is finalized but BEFORE the per-leg file/heal
# loop below. A product repo may drop a `report-guard.sh` beside this file — it
# is NOT vendored (absent by default), so a factory-default consumer sources
# nothing and behaves byte-for-byte as before. When present it is SOURCED (not
# exec'd) so it sees the reporter's context in scope ($run_dir, $here, $reds,
# forgejo_*, the identity layer) and may `exit 0` to short-circuit filing —
# e.g. re-check a repo-specific staleness gate and route a probable-ghost drive
# to a park instead of a blocking leg-red. The factory owns the seam; the guard
# body is the consumer's product knowledge and stays in the consumer's repo.
if [ -f "$here/report-guard.sh" ]; then
  # shellcheck source=/dev/null
  . "$here/report-guard.sh"
fi

open_issues="$(forgejo_get "/issues?labels=$REHEARSAL_LABEL&state=open&type=issues&limit=50")" || open_issues='[]'
# #495: this ONE fetch feeds every label op for the run — filing labels, the
# priority float, the ready-for-agent/-human flip ids. It used to degrade
# silently (`|| labels_json='[]'`) on a single transient failure, leaving only
# a misleading "priority label missing" WARN downstream (drive
# 20260812T214238Z). Fail LOUD, retry once paced; fail-open stays — blockers
# still file, unlabelled, when the tracker is truly unreachable.
: "${REPORTER_LABELS_RETRY_DELAY:=5}"
labels_rc=0
labels_json="$(forgejo_get "/labels?limit=100")" || labels_rc=$?
if [ "$labels_rc" -ne 0 ]; then
  echo "reporter: WARN labels fetch failed (curl rc=$labels_rc) — retrying once in ${REPORTER_LABELS_RETRY_DELAY}s"
  sleep "$REPORTER_LABELS_RETRY_DELAY"
  labels_rc=0
  labels_json="$(forgejo_get "/labels?limit=100")" || labels_rc=$?
  if [ "$labels_rc" -ne 0 ]; then
    echo "reporter: WARN labels re-fetch failed (curl rc=$labels_rc) — label ops DEGRADED for this run: blockers file unlabelled, priority float and ready-for-agent/-human flips skip"
    labels_json='[]'
  else
    echo "reporter: labels re-fetch succeeded — label ops intact"
  fi
fi
label_id() { forgejo_label_id "$labels_json" "$1"; }

new_filed=0
touched=()   # issue numbers filed or matched this drive — they block the drive issue
# ONE fault, ONE ticket (idss #1184): the fault → issue map for THIS run, keyed
# on the normalised error text, not the leg. A single fault can surface under
# two leg names (idss drive 20260903T042240Z: `standing` and its nested
# `wizard-rent` both carried the identical broker refusal), and the leg-keyed
# signature above is by design blind to that — so the healer's ticket-on-
# refusal for leg 1 and the reporter's own filing for leg 2 produced two
# blockers for one fault (#1178 + #1179). The second leg now appends its
# evidence to the first leg's issue instead of filing.
declare -A filed_by_fault=()
# Plain for over the mapfile'd array — a `jq | while` subshell would lose
# new_filed and the 2-issue cap would never bite (plan Task 7 note).
for red in "${reds[@]}"; do
  leg="$(jq -r '.leg' <<<"$red" 2>/dev/null)"
  err="$(jq -r '.error // ""' <<<"$red" 2>/dev/null)"
  # Leg-keyed signature: noise in the error never moves it.
  sig="$(compute_signature "$REHEARSAL_SIGNATURE_NS" "$leg")"
  fault_key="$(normalize_error_line "$err")"
  stamp="$(basename "$run_dir")"
  evidence_note="drive \`$stamp\` red at \`$leg\`: \`$(display_error_line "$err")\`
evidence: \`$run_dir\` on $REHEARSAL_EVIDENCE_HOST (legs.json and whatever else the drive harvested there) — a representative screenshot is attached here if one was captured"

  if [ -n "$fault_key" ] && [ -n "${filed_by_fault[$fault_key]:-}" ]; then
    prior="${filed_by_fault[$fault_key]}"
    echo "reporter: same fault as #$prior under leg '$leg' — appending evidence, not re-filing (one red, one ticket; idss #1184)"
    append_evidence "$prior" "$evidence_note" >/dev/null 2>&1 \
      || echo "reporter: WARN evidence append for leg '$leg' on #$prior did not fully land — the run dir still carries it"
    continue   # #$prior is already in touched
  fi
  match="$(match_sig "$open_issues" "$sig")"
  if [ -n "$match" ]; then
    append_evidence "$match" "$evidence_note" \
      && echo "reporter: appended drive evidence to #$match ($sig)"
    touched+=("$match")
    [ -n "$fault_key" ] && filed_by_fault[$fault_key]="$match"
    continue
  fi
  if [ "$new_filed" -ge "$REHEARSAL_FILING_CAP" ]; then
    echo "reporter: cap reached ($new_filed/$REHEARSAL_FILING_CAP) — NOT filing '$leg' ($sig); it files on a future drive if it persists"
    continue
  fi
  if claude_limit_parked; then
    echo "reporter: claude limit window — deferring diagnosis of '$leg' to the next drive"
    continue
  fi

  # The healer gets first claim on the FIRST red leg (spec: one session per
  # red, ever). A heal leaves the drive armed; a decline hands its verdict to
  # the filing flow below via HEAL_FILE_VERDICT.
  if [ "$REHEARSAL_HEALER" = "1" ] && [ "$healer_attempted" = false ]; then
    healer_attempted=true
    if try_heal "$leg" "$err" "$sig" "$stamp"; then
      healed_any=true
      if [ -n "$HEAL_RESIDUAL_VERDICT" ]; then
        # The heal fixed the presentation; the session's residual verdict is
        # the substantive fault — hand it to the filing flow below exactly like
        # a decline's file-verdict (one claude call per red, ever). The filed
        # issue blocks the drive, so no blind re-drive into the same fault.
        echo "reporter: healed '$leg' ($sig) — residual fault handed to the filing flow"
        HEAL_FILE_VERDICT="$HEAL_RESIDUAL_VERDICT"; HEAL_RESIDUAL_VERDICT=""
      else
        echo "reporter: healed '$leg' ($sig) — drive stays armed, next tick re-drives"
        continue
      fi
    fi
  fi

  if [ -n "$HEAL_FILE_VERDICT" ]; then
    # The healer session already diagnosed this red — reuse its file-verdict,
    # never a second claude call. Persist it in the run dir too (idss #1184):
    # the healer's diagnosis is the drive's best artefact and must survive a
    # refused/failed filing, a cap skip, or a later human reading the run dir.
    diagnosis="$HEAL_FILE_VERDICT"; HEAL_FILE_VERDICT=""
    if mkdir -p "$run_dir/artifacts" 2>/dev/null \
       && jq -c --arg leg "$leg" --arg sig "$sig" '. + {leg:$leg, sig:$sig}' <<<"$diagnosis" > "$run_dir/artifacts/healer-refusal.json" 2>/dev/null; then
      echo "reporter: healer diagnosis for '$leg' saved to artifacts/healer-refusal.json"
    fi
  else
    # Limit-hit checks BOTH streams: on 2026-08-14 the refusal ("You've hit
    # your weekly limit · resets 8am (UTC)") was claude's STDOUT — .err stayed
    # 0 bytes — so the err-only check missed, the parse failed, and the
    # generic fallback filed #530 instead of parking. Two-account failover
    # (#510): flip to the standby and retry ONCE before deferring.
    claude_select_token
    reporter_attempt=1
    reporter_transient=0
    # The live door (#540): a box IP means the box is STILL UP (the caller
    # runs this before teardown) — grant Bash and hand the diagnosis an ssh
    # line + a read-only command palette so it can ask the box directly
    # instead of guessing from the harvested logs alone. No IP (a caller with
    # no reachable box, or a manual run) keeps this text-only, exactly as
    # before #540 — no Bash grant, no ssh line. The section's NAME is contract:
    # the reporter prompt's live-box paragraph promises a section by it (#53).
    live_prompt=""; live_tools=()
    if [ -n "$box_ip" ]; then
      live_prompt="

Live box at $box_ip — it dies to teardown minutes after you return; READ-ONLY commands only, nothing that mutates state (no restart/stop/reboot/writes):
  ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=8 root@$box_ip '<command>'
Useful: journalctl -u <unit> --no-pager -n 200, systemctl --failed --no-legend, systemctl status <unit> --no-pager -l, ss -tlnp, curl -sS --max-time 5 http://127.0.0.1:<port><path>.
If ssh is refused (connection refused, timeout, no route), say so plainly in the body and fall back to the harvested logs below — do not retry indefinitely."
      live_tools=(--allowedTools "Bash")
    fi
    while :; do
      diagnosis="$(cd "$run_dir" && timeout 900 claude --model "$SWARM_REPORT_MODEL" "${live_tools[@]}" -p \
        "$(cat "$REHEARSAL_REPORT_PROMPT_FILE")

Run directory: $run_dir$live_prompt" 2>"$run_dir/logs/reporter-claude.err" || true)"
      # Save the raw stdout unconditionally (#403 defect 1): on every silent flake
      # today reporter-claude.err was 0 bytes and jq's stderr went to /dev/null, so
      # nothing recorded what claude actually emitted. This file makes a parse flake
      # diagnosable after the fact.
      printf '%s\n' "$diagnosis" > "$run_dir/logs/reporter-claude.out"
      if claude_auth_failed "$run_dir/logs/reporter-claude.err" "$run_dir/logs/reporter-claude.out"; then
        if [ "$reporter_attempt" = 1 ] && claude_failover; then
          reporter_attempt=2
          echo "reporter: Claude auth refused — failed over to account $(claude_active_account); retrying once"
          continue
        fi
        claude_auth_announce reporter "$run_dir"
        REPORTER_AUTH_FAILED=1
        diagnosis=""
        break
      fi
      if claude_limit_hit "$run_dir/logs/reporter-claude.err" \
         || claude_limit_hit "$run_dir/logs/reporter-claude.out"; then
        if [ "$reporter_attempt" = 1 ] && claude_failover; then
          reporter_attempt=2
          echo "reporter: Claude account limited — failed over to account $(claude_active_account); retrying once"
          continue
        fi
        claude_limit_park
        echo "reporter: claude refused with a limit hit — parking, deferring '$leg'"
        # continue 2: the retry loop added one nesting level — this targets the
        # enclosing per-leg loop, exactly where the old `continue` went.
        continue 2
      fi
      # Transient API fault (idss freshness-tax finding 5): no diagnosis AND the
      # CLI reported a 5xx/overloaded error — wait once, retry once; a second
      # in a row falls through to the generic filing, named as such.
      if ! parse_diagnosis "$diagnosis" >/dev/null 2>&1 \
         && claude_transient_hit "$run_dir/logs/reporter-claude.err" "$run_dir/logs/reporter-claude.out"; then
        if [ "$reporter_transient" = 0 ]; then
          reporter_transient=1
          echo "reporter: Claude API transient fault (5xx/overloaded) — retrying once in ${CLAUDE_TRANSIENT_RETRY_DELAY}s"
          sleep "$CLAUDE_TRANSIENT_RETRY_DELAY"
          continue
        fi
        echo "reporter: Claude API transient fault twice in a row — filing the generic fallback (raw in logs/reporter-claude.out)"
      fi
      break
    done
  fi
  title=""
  if parsed="$(parse_diagnosis "$diagnosis")"; then
    title="$(jq -r '.title // empty' <<<"$parsed" 2>/dev/null)"
    body="$(jq -r '.body // empty' <<<"$parsed" 2>/dev/null)"
    confident="$(jq -r '.confident // false' <<<"$parsed" 2>/dev/null)"
  fi
  if [ -z "$title" ]; then
    # Unparseable even after fence-strip + brace-carve: file it, but unconfident
    # (a human ruling) and pointing at the saved raw stdout, never dropped.
    title="rehearsal drive red at $leg"
    if [ -n "${REPORTER_AUTH_FAILED:-}" ]; then
      body="(:rotating_light: NO DIAGNOSIS — the reporter's claude call could not authenticate on either account; see the auth comment on #$REHEARSAL_DRIVE_ISSUE and logs/claude-env.txt + logs/reporter-claude.out in the run dir. Fix the token source, then re-drive.)"
    else
      body="(headless diagnosis unparseable — raw stdout saved to logs/reporter-claude.out)"
    fi
    confident=false
  fi

  # Re-check the signature immediately before filing (#403 defect 3): the
  # open-issues snapshot was taken at script start, but the diagnosis above can
  # take up to 15 minutes — a concurrent drive that filed this same sig in that
  # window is invisible to the start-of-run match, and we'd file a duplicate
  # (#402 dup'd #400, blocking the drive with a ready-for-human dup that needed
  # hand cleanup). Re-fetch fresh and, if the hole is now tracked, append.
  fresh_issues="$(forgejo_get "/issues?labels=$REHEARSAL_LABEL&state=open&type=issues&limit=50")" || fresh_issues="$open_issues"
  match="$(match_sig "$fresh_issues" "$sig")"
  if [ -n "$match" ]; then
    append_evidence "$match" "$evidence_note" \
      && echo "reporter: sig appeared during diagnosis — appended to #$match ($sig), not re-filed"
    touched+=("$match")
    [ -n "$fault_key" ] && filed_by_fault[$fault_key]="$match"
    continue
  fi

  full_body="$body

$evidence_note

<!-- rehearsal-sig: $sig -->"

  # Labels: rehearsal-183 always; a confident diagnosis is swarm-actionable
  # (bug + ready-for-agent), otherwise it needs an interactive session to
  # diagnose from the workstation evidence bundle (ADR 0174: the reporter runs
  # headless with no human standing by, so an unconfident/unparseable
  # diagnosis is session-work, not automatically Ben's — #531). A session
  # working the ticket escalates to ready-for-human itself, on the ticket,
  # only if it finds a genuine one-way door. Forgejo's create-issue label
  # field wants ids, so resolve names → ids and send inline.
  names=("$REHEARSAL_LABEL")
  if [ "$confident" = true ]; then names+=("bug" "ready-for-agent"); else names+=("ready-for-session"); fi
  ids=()
  for n in "${names[@]}"; do id="$(label_id "$n")"; [ -n "$id" ] && ids+=("$id"); done
  larr=""
  [ "${#ids[@]}" -gt 0 ] && larr="[$(IFS=,; echo "${ids[*]}")]"
  if resp="$(forgejo_create_issue "$title" "$full_body" "$larr")"; then
    echo "reporter: filed '$title' ($sig)"
    new_filed=$((new_filed+1))
    num="$(jq -r '.number // empty' <<<"$resp" 2>/dev/null)"
    if [ -n "$num" ]; then
      touched+=("$num")
      [ -n "$fault_key" ] && filed_by_fault[$fault_key]="$num"
      # #596: the body above only NAMES the run dir — attach one
      # representative screenshot directly to the new issue (no prior
      # comment to key off, so this is the issue-asset endpoint, not the
      # comment one) so a tracker-only reader can eyeball it.
      shot="$(pick_representative_screenshot "$run_dir")"
      if [ -n "$shot" ]; then
        code="$(forgejo_attach_issue_asset "$num" "$shot" "$(basename "$shot")")"
        case "$code" in
          2??) echo "reporter: attached $(basename "$shot") to #$num" ;;
          *) echo "reporter: WARN screenshot attach for #$num → HTTP ${code:-000}" ;;
        esac
      fi
    fi
  else
    echo "reporter: WARN could not file '$title' ($sig) — API refused"
  fi
done

# The drive-issue loop (Ben's ruling, spec "The cycle"): wire every touched
# issue as a native dependency of the standing drive issue — that alone drops
# it off the ready list — and land ONE evidence comment there. The BLOCKED
# INVARIANT: a red must never leave the drive issue ready and undepended (the
# hot-loop state); if this drive filed and matched nothing, flip its
# ready-for-agent to ready-for-human instead.
stamp="$(basename "$run_dir")"

# The blocked invariant's escape hatch: flip the drive off the ready list and
# onto a human. Reached two ways — nothing could be filed/matched, OR a
# dependency failed to wire (#381) — both risk leaving the drive
# ready-and-undepended, the hot-loop state.
# The silent-park page (#1138, item 3): the reporter flipping the drive to
# ready-for-human IS the moment a human is needed — page NOW, don't wait for the
# next executor tick to notice the quiet lane. Shares the executor's
# one-page-per-flip marker (test-results/flip-pages/<drive>.paged): whichever
# fires first writes it, the other skips; the executor CLEARS it when the drive
# is re-armed, so a later re-park pages afresh. A FAILED post writes no marker,
# so a chat blip retries on the executor's next tick. Best-effort, never blocks
# the flip. Mirrors the reporter's existing notify-mattermost.sh idiom (the
# healer-refusal page) rather than sourcing the idss-side lib — this file is
# vendored byte-identical into every consumer (#53) and must stay layout-agnostic.
page_silent_park() { # $1 = the flip reason (the drive comment body)
  drive_issue_set || return 0
  local reason="$1"
  local mdir="$REHEARSAL_FLIP_PAGE_ROOT/test-results/flip-pages"
  local marker="$mdir/$REHEARSAL_DRIVE_ISSUE.paged"
  [ -f "$marker" ] && return 0
  mkdir -p "$mdir" 2>/dev/null || true
  # The issue's browser URL from the API base we already carry — never a second
  # hardcoded forge; absent FORGEJO_API, no link.
  local html="" link=""
  [ -n "${FORGEJO_API:-}" ] && html="${FORGEJO_API/\/api\/v1\/repos\///}"
  [ -n "$html" ] && link=" $html/issues/$REHEARSAL_DRIVE_ISSUE"
  if bash "$here/notify-mattermost.sh" ":vertical_traffic_light: drive #$REHEARSAL_DRIVE_ISSUE PARKED on a human (ready-for-human) by the reporter — the lane now reads \"blockers: none\" while NOTHING drives (the silent park that parked #854 three times). Reason: $reason$link" >/dev/null 2>&1; then
    date -u +%Y%m%dT%H%M%SZ > "$marker" 2>/dev/null || true
    echo "reporter: silent-park page posted for parked drive #$REHEARSAL_DRIVE_ISSUE"
  else
    echo "reporter: WARN silent-park page for #$REHEARSAL_DRIVE_ISSUE failed to post — the executor retries next tick"
  fi
}

flip_drive_to_human() { # $1 = comment body
  local rfa_id rfh_id
  rfa_id="$(label_id ready-for-agent)"
  rfh_id="$(label_id ready-for-human)"
  [ -n "$rfa_id" ] && forgejo_remove_label "$REHEARSAL_DRIVE_ISSUE" "$rfa_id" >/dev/null 2>&1
  [ -n "$rfh_id" ] && forgejo_add_labels "$REHEARSAL_DRIVE_ISSUE" "$rfh_id" >/dev/null 2>&1
  forgejo_comment "$REHEARSAL_DRIVE_ISSUE" "$1" 2>/dev/null || true
  page_silent_park "$1"
}

if [ "${#touched[@]}" -gt 0 ]; then
  # Priority-first queue: every drive blocker — newly filed OR re-matched —
  # carries the `priority` label, which list-ready-tasks.sh floats to the head
  # of the swarm queue. POST /labels ADDS to the set (only PUT replaces).
  # Best-effort but LOUD: a refused POST never reds the reporter, but it must
  # say so — #438 arrived unlabelled with zero forensic trail.
  pri_id="$(label_id priority)"
  if [ -z "$pri_id" ]; then
    echo "reporter: WARN priority label missing from the tracker — blockers filed unlabelled"
  else
    for num in "${touched[@]}"; do
      code="$(forgejo_add_labels "$num" "$pri_id" 2>/dev/null)"
      case "$code" in
        2??) ;;
        *) echo "reporter: WARN priority label POST for #$num → HTTP ${code:-000}" ;;
      esac
    done
  fi

  # No drive declared: the blockers are filed and priority-floated (above), but
  # there is no drive issue to wire them onto — writing to issue '' would hit a
  # real, unrelated issue in the consumer's tracker. Wire nothing, and say so
  # (#54); a consumer that runs a drive sets REHEARSAL_DRIVE_ISSUE.
  if ! drive_issue_set; then
    echo "reporter: no REHEARSAL_DRIVE_ISSUE declared — filed/matched ${touched[*]} but wiring NOTHING onto a drive (empty is not issue ''; #54)"
  else
    # The IssueMeta dependency body MUST name the target issue's repo — live
    # Forgejo 404s (IsErrRepoNotExist) a bare {"index": n}.
    dep_slug="$(forgejo_repo_slug)"
    dep_owner="${dep_slug%%/*}"; dep_repo="${dep_slug#*/}"
    wired_all=true
    for num in "${touched[@]}"; do
      # Capture the HTTP code (forgejo_post's -f would swallow it): 2xx =
      # created, 409 = already a blocker (tolerated, not an error). Any other
      # code means the blocker did NOT land — break the invariant and fall to
      # the ready-for-human swap below, never swallow it blind (the hot loop).
      code="$(forgejo_add_dependency "$REHEARSAL_DRIVE_ISSUE" "$num" "$dep_owner" "$dep_repo" 2>/dev/null)"
      case "$code" in
        2??|409) ;;
        *) wired_all=false
           echo "reporter: WARN dependency POST for #$num → HTTP ${code:-000} — blocker did not land"
           break;;
      esac
    done
    if [ "$wired_all" = true ]; then
      blockers="$(printf '#%s ' "${touched[@]}")"
      forgejo_comment "$REHEARSAL_DRIVE_ISSUE" \
        "drive \`$stamp\` RED — now blocked by: ${blockers}(evidence on each). The drive re-fires when the last blocker closes." \
        && echo "reporter: drive issue #$REHEARSAL_DRIVE_ISSUE blocked by ${touched[*]}"
      # Kick the swarm NOW: swarm.yml listens for issue label/close events, but
      # an issue CREATED with labels inline fires neither, so a fresh blocker
      # otherwise sits until the :15/:45 cron (which Forgejo's scheduler has
      # silently dropped before) — up to 30 idle minutes per red. Best-effort
      # and loud like the label POSTs above: a refused dispatch falls back to
      # exactly the old cron cadence, never reds the reporter.
      code="$(forgejo_dispatch_workflow "swarm.yml" "main" 2>/dev/null)"
      case "$code" in
        2??) echo "reporter: swarm dispatched for the new blocker(s)" ;;
        *) echo "reporter: WARN swarm dispatch → HTTP ${code:-000} — blockers wait for the swarm cron" ;;
      esac
    else
      flip_drive_to_human "drive \`$stamp\` RED — issues were filed but a dependency failed to wire onto the drive (see run log); flipped ready-for-human so the drive never sits ready-and-undepended (the hot-loop state). A human wires the blocker(s) and re-arms."
      echo "reporter: dependency wiring failed — drive issue #$REHEARSAL_DRIVE_ISSUE flipped ready-for-human (blocked invariant)"
    fi
  fi
elif [ "$healed_any" = true ]; then
  echo "reporter: red healed in-place — drive stays armed, next tick re-drives"
elif ! drive_issue_set; then
  echo "reporter: red with nothing filed/matched and no REHEARSAL_DRIVE_ISSUE declared — no drive to flip (#54)"
else
  flip_drive_to_human "drive \`$stamp\` RED but nothing could be filed or matched (cap/limit) — flipped ready-for-human so the drive never hot-loops. A human decides the next drive."
  echo "reporter: red with nothing filed/matched — drive issue #$REHEARSAL_DRIVE_ISSUE flipped ready-for-human (blocked invariant)"
fi
exit 0
