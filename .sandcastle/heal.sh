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
HEAL_PROMPT_FILE="${HEAL_PROMPT_FILE:-$here/heal-prompt.md}"
. "$here/heal-lib.sh"
# shellcheck source=limit-lib.sh
. "$here/limit-lib.sh"
# shellcheck source=model-lib.sh
# The shared model config (#448): swarm.config is the ONE place naming what this
# healer runs on — no hardcoded id can drift from it. Since 2026-08-25 the healer
# rides its own SWARM_HEAL_MODEL (diagnosis quality beats cost), no longer the
# fleet's SWARM_MODEL the worker (main.mts) launches tickets on.
. "$here/model-lib.sh"
# shellcheck source=host-capacity-lib.sh
# The drive reservation predicate (#663/#664/#30): a waiting rehearsal drive
# declares it wants the host's heavy capacity; the healer's investigation is a
# heavy (claude-calling) consumer and stands down before taking a slot. Consumed
# by the drive-yield gate below.
. "$here/host-capacity-lib.sh"
# shellcheck source=swarm-db-lib.sh
# swarm.db trace mirror (#447/#92): the investigation is a claude call — a pooled
# heavy slot up to 15 min — that used to leave NO runs/processes/events rows, so
# heal time was invisible to the machine timeline and the util bar. run_agent
# opens a `heal`-trigger run + a claude process row and a `heal` event pointing
# at the evidence dir; the EXIT trap finalises them. Best-effort by construction
# (every writer swallows its exit), so a missing engine never reds a heal run.
. "$here/swarm-db-lib.sh"
# shellcheck source=rehearsal-heal-lib.sh
# The law-grade repair rails (#203): heal_rails (line/file caps, product-surface
# refusal, assertion-weakening + self-modification checks) and heal_push
# (rebase-onto-origin/main + re-validate + verified-landed push) already exist
# and are unit-proven for the rehearsal healer; the swarm healer reuses them so a
# claude-committed repair lands ONLY through the same mechanical gate, never an
# unbounded `git push` from the shared checkout. The credential-free git auth
# (#195) rides in the same way: git_cred_strip_url + git_cred_persist/export
# (re-exported from git-cred-lib.sh via rehearsal-heal-lib.sh) authenticate the
# repair clone's push with no token in the URL or on argv.
. "$here/rehearsal-heal-lib.sh"

# Secrets: env wins (the workflow provides the authoritative value);
# the bind-mounted secrets file is the fallback for host runs
# (same precedence as list-ready-tasks.sh).
[ -z "${FORGEJO_TOKEN:-}" ] && [ -f "$here/secrets/forgejo_token" ] && FORGEJO_TOKEN="$(cat "$here/secrets/forgejo_token")"
# shellcheck source=identity-lib.sh
. "$here/identity-lib.sh"     # identity_require — the contract seam (#31)
# shellcheck source=swarm-identity.sh
. "${SWARM_IDENTITY_FILE:-$here/swarm-identity.sh}"
# Identity contract seam (#31): the harness calls swarm_git_identity, defined in
# the consumer-owned (vendor-excluded) swarm-identity.sh. Fail LOUD with the
# regenerate command if a pin bump needs a newer identity layer than this
# consumer regenerated, instead of dying later on `command not found`.
identity_require || exit 2
# shellcheck source=policy-lib.sh
. "$here/policy-lib.sh"       # policy_load — the repo's LANDING knob (#13, ADR 0002); safe to source twice
# Landing-mode gate (#167, idss ADR 0267 — the healer half of #164's known gap).
# The healer is fault-driven and never claims a ticket, so no `landing-pr` TICKET
# reaches it (#165 is vacuous here); the DISTINCT residual is that its claude
# investigation can COMMIT a harness-infra repair and push it straight to `main`.
# In a pr-DEFAULT repo every landing on main is meant to be reviewed, so that
# push is an unattended agent bypassing the PR rail. heal.sh cannot mechanically
# intercept a `git push` inside the agent's OWN claude session without also
# killing the (read-only, valuable) diagnosis — so the gate is the strongest
# lever it does own: the incident prompt. In a pr-default repo the agent is told
# to diagnose + ESCALATE, never push a repair (a human opens the reviewed PR),
# and the ledger never marks the fault repaired (nothing landed). Byte-identical
# in a push repo (the default): no directive, the repair path unchanged.
# SWARM_POLICY_FILE is the same TEST-only seam session-runner/list-ready-tasks
# use; unset in production it reads the consumer's real swarm-policy.sh and
# defaults LANDING=push.
policy_load "${SWARM_POLICY_FILE:-}"
HEAL_NO_LAND=""; [ "${SWARM_POLICY_LANDING:-push}" = pr ] && HEAL_NO_LAND=1
# One runner serves TWO repos now (#238). Per-repo healer state must carry the
# repo slug or one repo's healer makes the other's skip its incident (the
# healer lock) and stomps its evidence dir. "Matou/idss" -> "Matou-idss"
# (slashes aren't valid in a path segment).
REPO_TAG="${FORGEJO_API##*/repos/}"; REPO_TAG="${REPO_TAG//\//-}"
MODE="${HEAL_MODE:-hook}"
WORKFLOW="${WORKFLOW:-unknown}"
# Which host the evidence dir SITS on, for the human reading the ping (#79 —
# it used to be one product's workstation, spelled out in this vendored file:
# every 2026-08-24 ping named that box while the healer was running on ANOTHER
# member of the pool, so every evidence path pointed at a directory that does
# not exist there). Unlike its rehearsal-report.sh sibling (#51) the probe
# comes BEFORE the identity layer's RUNNER_HOST here: heal.sh runs on the bare
# host, so `hostname` IS ground truth, while RUNNER_HOST declares the ONE host a
# repo nominates — exactly the value that misdirected those pings. SWARM_HOST
# (the pool-claim name) still wins when set, so the evidence line and the
# claim/commit identity agree.
HEAL_EVIDENCE_HOST="${HEAL_EVIDENCE_HOST:-${SWARM_HOST:-$(hostname 2>/dev/null || echo "the healer host")}}"
WORKDIR="$HEAL_WORKDIR"
HEALER_STATE="${HEALER_STATE:-$WORKDIR/.sandcastle/.state/healer}"
mkdir -p "$HEALER_STATE"
NOW="$(date +%s)"
# Where each failing workflow drops its on-failure verdict (failing stage + first
# error lines). The runner is host-mode on the workstation and ci has no readable
# log API, so a well-known host path is how a run's real fault reaches the healer:
# `ci` via scripts/seam-smoke.sh (#197), `swarm`/`triage` via verdict-lib.sh
# (#235), `smoke-drive` via the consumer's smoke driver (#10 — the reader half
# of matou-app#46; without it a red smoke lap degraded to stale worker prose),
# `pr-e2e` via the consumer's run-pr-e2e.sh (#127 — the reader half of
# matou-app#294; without it a red feature-e2e keyed on unrelated swarm prose).
# Same repo-tagged defaults those scripts write to (#574) — REPO_TAG is
# already computed above from FORGEJO_API, same formula seam-smoke.sh derives
# from `git remote get-url origin` and run-swarm.sh/run-triage.sh derive from
# REPO_SLUG, so reader and writers always agree on the path.
SEAM_VERDICT="${SEAM_VERDICT_PATH:-/tmp/matou-$REPO_TAG-seam-verdict.txt}"
SWARM_VERDICT="${SWARM_VERDICT_PATH:-/tmp/matou-$REPO_TAG-swarm-verdict.txt}"
TRIAGE_VERDICT="${TRIAGE_VERDICT_PATH:-/tmp/matou-$REPO_TAG-triage-verdict.txt}"
SMOKE_DRIVE_VERDICT="${SMOKE_DRIVE_VERDICT_PATH:-/tmp/matou-$REPO_TAG-smoke-drive-verdict.txt}"
PR_E2E_VERDICT="${PR_E2E_VERDICT_PATH:-/tmp/matou-$REPO_TAG-pr-e2e-verdict.txt}"
# `verify` via the consumer's run-verify.sh (#162 — the reader half of
# matou-app#380; without it a red verify fell through to stale worker prose and
# keyed run 12813's signature on an unrelated "Verified in sandbox" line).
VERIFY_VERDICT="${VERIFY_VERDICT_PATH:-/tmp/matou-$REPO_TAG-verify-verdict.txt}"

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
    smoke-drive) printf '%s' "$SMOKE_DRIVE_VERDICT" ;;
    pr-e2e) printf '%s' "$PR_E2E_VERDICT" ;;
    verify) printf '%s' "$VERIFY_VERDICT" ;;
  esac
}

# verdict_is_fresh <file> — true iff it exists and was written within the run
# window. A verdict left by an earlier failed run (the workflow died before it
# could rewrite one) must NOT be trusted as this incident's fault (#235 AC2).
verdict_is_fresh() {
  [ -f "$1" ] && [ -n "$(find "$1" -newermt "-$RUN_WINDOW" 2>/dev/null)" ]
}

# Runtime kill switch (#203): HEAL=0 in env, or touch the off-file
# ($HOME/swarm/state/heal.off by default) — honoured WITHOUT a workflow
# re-render (the gap HEAL_DRY_RUN left: it needs the workflow re-rendered, so it
# could not stop a misfiring healer between renders). Checked before the healer
# lock, before any evidence gathering, any claude call, and any chat/tracker
# post — exactly the before-any-network posture session-runner.off takes.
HEAL_OFF_FILE="${HEAL_OFF_FILE:-$HOME/swarm/state/heal.off}"
if [ "${HEAL:-1}" = "0" ] || [ -f "$HEAL_OFF_FILE" ]; then
  echo "heal: kill switch is on (HEAL=0 or $HEAL_OFF_FILE present) — quiet tick"
  exit 0
fi

# One healer at a time PER REPO. Our OWN lock — never the swarm's — and
# per-repo (#238) so idss's healer never blocks matou-app's incident.
HEALER_LOCK="${HEALER_LOCK:-/tmp/matou-healer-$REPO_TAG.lock}"
exec 8>"$HEALER_LOCK"
flock -n 8 || { echo "heal: another healer holds the lock — exiting"; exit 0; }

# Yield to a ready rehearsal drive (#663 producer / #664 consumer / #30): a
# waiting drive needs EVERY host lock at once and loses to anything that takes a
# slot in the gap. The healer's investigation runs a claude call — a slot — so it
# stands down HERE, before gathering evidence or spending a ledger attempt, the
# same posture session-runner/swarm/triage take (yield, never camp). An abandoned
# reservation ages out (the TTL), and a genuine incident is re-detected by the
# next watchdog sweep once the drive clears — deferring costs nothing lasting. The
# healer's consecutive-defer count is its OWN (its own cadence, so a shared
# counter would conflate streaks — #664); the yield line carries the reservation's
# age so it and the executor's "skipped N ticks" line corroborate.
HEALER_DRIVE_DEFER_COUNT="${HEALER_DRIVE_DEFER_COUNT:-${HOST_CAPACITY_STATE_DIR:-$HOME/swarm/state}/matou-healer-drive-defer-count}"
if host_capacity_drive_wanted; then
  defer_n="$(host_capacity_consumer_defer_bump "$HEALER_DRIVE_DEFER_COUNT")"
  echo "heal: a rehearsal drive has reserved host capacity (#663) — yielding this run to a ready drive — reservation age $(host_capacity_drive_wanted_age)s — skipped $defer_n consecutive tick(s)"
  exit 0
fi
host_capacity_consumer_defer_reset "$HEALER_DRIVE_DEFER_COUNT"

# Per-repo evidence dir (#238): a repo-agnostic prefix left the two repos'
# incidents indistinguishable on disk.
EVIDENCE="$(mktemp -d "/tmp/matou-heal-$REPO_TAG.XXXXXX")"
echo "heal: evidence at $EVIDENCE (mode=$MODE workflow=$WORKFLOW)"

# swarm.db trace (#92): run_agent opens these when it actually invokes claude;
# the EXIT trap below finalises them on EVERY exit path (a clean return, a
# no-diagnosis, or the limit-park `exit 0` mid-diagnosis) with the
# investigation's real outcome as the run verdict — the SAME kills-finalise
# discipline session-runner/run-swarm use (swarm-db.py invariant 2). A heal that
# never reaches claude (drive-yield, limit gate, lock, a downgraded kill, or a
# dedup silence) opens NOTHING — heal_run_db_id stays empty and the trap is a
# no-op, so there is no per-non-investigation-tick noise. An untrappable
# SIGKILL/OOM cannot run the trap: its open process row is the wedge marker by
# design, exactly as everywhere else in the mirror.
heal_run_db_id=""
heal_run_verdict=""
# The throwaway repair clone (#203): the heal agent investigates and commits in
# an ISOLATED checkout, never the shared $WORKDIR, so a wedged/aborted repair
# can never corrupt a running worker's checkout. run_agent sets this; the EXIT
# trap removes it on every exit path. HEAL_PUSH_RESULT records how a committed
# repair fared at the rails: none (no commit / diagnosis-only) | pushed (landed
# through heal_rails+heal_push) | refused (committed but the rails or the push
# rejected it — a human lands a reviewed fix, ties #168).
HEAL_CLONE=""
HEAL_PUSH_RESULT="none"
heal_on_exit() {
  local ec=$?
  [ -n "$HEAL_CLONE" ] && rm -rf "$HEAL_CLONE" 2>/dev/null || true
  [ -n "$heal_run_db_id" ] || return 0
  local now; now="$(date +%s)"
  swarmdb proc-close --run "$heal_run_db_id" --ref "$$" --ended "$now"
  swarmdb_run_end "$heal_run_db_id" "${heal_run_verdict:-died-in:heal}" \
    "${heal_run_verdict:-died-in:heal}" "$ec" "$now"
}
trap heal_on_exit EXIT

api() { curl -sf --max-time 30 -H "Authorization: token $FORGEJO_TOKEN" "$@"; }

# How many matrix legs (job indices) to probe for logs before giving up (#188).
HEAL_JOB_LOG_MAX_LEGS="${HEAL_JOB_LOG_MAX_LEGS:-20}"

# collect_job_logs <run-url> — put the failing run's OWN job log(s) in the
# bundle as `job-log.txt` (#188). The one route this Forgejo serves is the run's
# WEB url + `/jobs/<leg>/attempt/1/logs` — the `/attempt/1/` segment is
# mandatory (omitting it 404s, which cost three 2026-10-09 passes a "mechanism
# not identified"), and the API url 404s entirely. Built from the passed run
# url, never a literal `actions/runs` string in this source, so the
# actions-endpoint ratchet stays green (AC1).
#
# On a cross-host failure (#135) this is the ONLY fault text the bundle can
# carry — every host-local artefact is empty by construction — so the decisive
# single line (`Could not resolve host: …`) reaches the diagnosis agent here.
#
# Every leg (job index 0..n-1) is fetched so a matrix fault is attributable to
# its leg and "sibling green, this leg red" is proven from the logs, not a
# duration argument (AC2). Best-effort and fail-soft (AC3): a non-2xx / timeout
# on the FIRST leg leaves a one-line note and NEVER reds the heal run; a run url
# we never had leaves an explicit "not fetched" note, never a silent empty file
# (AC4, GOTCHAS 30).
collect_job_logs() { # <run-url>
  local run_url="${1:-}" out="$EVIDENCE/job-log.txt"
  if [ -z "$run_url" ]; then
    printf 'job log not fetched: no run URL for this incident (mode=%s) — nothing was probed\n' "$MODE" > "$out"
    return 0
  fi
  run_url="${run_url%/}"
  # A per-job html_url carries a `/jobs/<n>…` suffix; strip back to the run base
  # so the leg index we append is authoritative.
  case "$run_url" in */jobs/*) run_url="${run_url%%/jobs/*}" ;; esac
  : > "$out"
  local leg=0 resp rc http body
  while [ "$leg" -lt "$HEAL_JOB_LOG_MAX_LEGS" ]; do
    rc=0
    resp="$(curl -s --max-time 30 -w $'\n%{http_code}' \
      -H "Authorization: token $FORGEJO_TOKEN" \
      "$run_url/jobs/$leg/attempt/1/logs")" || rc=$?
    http="${resp##*$'\n'}"; body="${resp%$'\n'*}"
    if [ "$rc" -ne 0 ]; then
      # Transport failure / timeout. On leg 0 the whole fetch is unavailable;
      # past it, treat it as the end of the matrix (we already have leg 0..n-1).
      [ "$leg" -eq 0 ] && printf 'job log unavailable (curl exit %s) — probed %s/jobs/0/attempt/1/logs\n' "$rc" "$run_url" > "$out"
      break
    fi
    if [ "${http:0:1}" = 2 ]; then
      { printf '===== job %s (attempt 1) — %s/jobs/%s/attempt/1/logs\n' "$leg" "$run_url" "$leg"
        printf '%s\n' "$body"; } >> "$out"
      leg=$((leg + 1))
      continue
    fi
    # A non-2xx: leg 0 means no readable log at all; past it, the end of the legs.
    [ "$leg" -eq 0 ] && printf 'job log unavailable (HTTP %s) — probed %s/jobs/0/attempt/1/logs\n' "${http:-000}" "$run_url" > "$out"
    break
  done
  return 0
}

gather_evidence() {
  # Probe the endpoint the automation actually depends on, paged: Forgejo
  # ignores limit without page and dumps the whole task table (~30s+ at
  # 1100 tasks). This is the endpoint on purpose — its sibling
  # `/actions/runs` scales with the repo's whole run history and stopped
  # answering inside 60 s on the big repos (GOTCHAS 16; the pointer this
  # comment used to carry named a research doc that did not come across in
  # the ADR 0180 extraction).
  # probe_api records curl's own outcome (http/elapsed/exit) so auth, a genuine
  # timeout, and remote degradation are distinguishable in the evidence, instead
  # of one ambiguous `api_seconds=timeout` on any curl failure (#1462).
  probe_api "$FORGEJO_API/actions/tasks?limit=1&page=1" "$FORGEJO_TOKEN" "$EVIDENCE/api-timing.txt"
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
  # shellcheck disable=SC2045 # -t orders by mtime (newest first, the cap below depends on it); log names never contain spaces/newlines.
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
  local vf have_local_verdict=""; vf="$(verdict_path "$WORKFLOW")"
  if [ -n "$vf" ] && verdict_is_fresh "$vf"; then
    cp "$vf" "$EVIDENCE/run-verdict.txt" 2>/dev/null && have_local_verdict=1 || true
  fi
  # Stamp the healer's OWN host into the bundle (#135), always — so the human (and
  # the diagnosis agent) reading a bundle knows which box gathered it. SWARM_HOST
  # else `hostname`, exactly like HEAL_EVIDENCE_HOST already resolved up top.
  echo "healer-host: $HEAL_EVIDENCE_HOST" > "$EVIDENCE/healer-host.txt"
  # Pool-locality honesty (#135): `swarm` is a multi-host runner pool, so a
  # failing leg often ran on the OTHER host, where NONE of the host-local
  # artefacts above exist — every evidence file comes back empty and the healer
  # files an undiagnosable ticket. When there is no fresh worker log AND no fresh
  # verdict for this run's window locally, say so explicitly IN the artefacts the
  # diagnosis agent reads, instead of handing it empty worker-logs.txt /
  # run-verdict.txt that read like a fault that vanished. A run that DID execute
  # on this host keeps its real artefacts untouched.
  if [ "$nfresh" -eq 0 ] && [ -z "$have_local_verdict" ]; then
    local runid="${RUN_URL:-}"; runid="${runid##*/}"
    { [ -n "$runid" ] && [ "$runid" != "${RUN_URL:-}" ]; } || runid="${SWARM_RUN_ID:-watchdog}"
    local msg="no local evidence for run ${runid} in the last ${RUN_WINDOW}: the failing leg ran on another swarm pool host (healer-host: ${HEAL_EVIDENCE_HOST})"
    printf '%s\n' "$msg" > "$EVIDENCE/worker-logs.txt"
    printf '%s\n' "$msg" > "$EVIDENCE/run-verdict.txt"
    printf '%s\n' "$msg" > "$EVIDENCE/no-local-evidence.txt"
    echo "heal: $msg"
  fi
  # GLOBAL by design (#238): the swarm lock serializes one heavy worker per
  # host across both repos, so the healer probes the same shared lock. Probe
  # EVERY pooled capacity slot, not just slot 1 (#203): the prompt gates a
  # `reset --hard origin/main` of the shared workdir on swarm-lock.txt=`free`,
  # but a worker holding SLOT 2 is just as much a live user of that checkout as
  # one holding slot 1 — probing only slot 1 let the healer reset the workdir
  # out from under a slot-2 worker. `held` iff ANY configured slot is held.
  local slot lock_state=free
  for slot in $HOST_CAPACITY_SLOTS; do
    if ! flock -n "$slot" -c true 2>/dev/null; then lock_state=held; break; fi
  done
  echo "$lock_state" > "$EVIDENCE/swarm-lock.txt"
}

# The signature's raw material.
#
# For every workflow that drops a verdict artifact — `ci` (#197), `swarm` and
# `triage` (#235), `smoke-drive` (#10), `pr-e2e` (#127) — key the signature on the run's OWN
# failing stage + first error line, so the incident signature tracks the
# ACTUAL fault. A moved fault → a new signature → a fresh investigation,
# instead of collapsing every failure within the cooldown onto one degraded
# workflow-name-only signature (a moved fault masked as "still failing").
# Crucially, swarm/triage no longer grep the Sandcastle worker chain-of-thought
# (saturated with "error"/"failed" prose), so a stale worker log narrating an
# unrelated, already-closed ticket can no longer mint a phantom signature (the
# 2026-07-31 false positives this ticket fixes).
#
# With no fresh verdict, degrade to the workflow name alone (empty line) but
# leave a marker so every post says the "still failing" line is unverified (AC1).
#
# For any other workflow with no wired verdict artifact (e.g. a watchdog-detected
# name, or a runner whose verdict seam is not yet vendored): key on a STABLE
# `no verdict for workflow <w>` line, never the worker-prose grep. The Sandcastle
# worker tail is saturated with "error"/"failed" narration from unrelated runs, so
# grepping it minted a fresh phantom signature on every red — the #127 garbage this
# fixes (matou-app pr-e2e run 11299 keyed on a sentence from an unrelated success).
# A per-workflow constant instead makes the signature stable and unmistakably
# "unwired", so ledger recurrence tracking stays meaningful.
error_line() { # <workflow>
  local wf="${1:-$WORKFLOW}" vf sv bc bstage
  vf="$(verdict_path "$wf")"
  if [ -n "$vf" ]; then
    if verdict_is_fresh "$vf"; then
      sv="$(seam_verdict_signal "$vf")"
      if [ -n "$sv" ]; then printf '%s' "$sv"; return; fi
    fi
    # No fresh verdict, but a fresh breadcrumb (#34): the run reached a stage and
    # was then SIGKILL'd (probable OOM) BEFORE its EXIT trap could write a verdict
    # — a resource kill, not a code/harness fault. verdict_write erases the
    # breadcrumb on every trapped exit, so its survival next to an absent verdict
    # is unambiguous. Key the signature on the killed STAGE (never the bare
    # workflow name — that phantom `sha1("triage|")` incident is exactly what this
    # fixes) and flag it so handle_incident downgrades instead of investigating.
    bc="${vf}.breadcrumb"
    if verdict_is_fresh "$bc"; then
      bstage="$(sed -n 's/^stage=//p' "$bc" | head -1)"
      : > "$EVIDENCE/seam-killed"
      printf 'killed mid-stage :: %s' "${bstage:-unknown}"
      return 0
    fi
    : > "$EVIDENCE/seam-degraded"   # marker read by handle_incident's posts
    return 0
  fi
  printf 'no verdict for workflow %s' "$wf"
}

# The chat sender. Overridable for tests via HEAL_NOTIFY_CMD (mirrors
# HEAL_AGENT_CMD), so a scenario can drive a delivery FAILURE (a 5xx brownout,
# which makes notify-mattermost.sh exit non-zero) without a live channel.
HEAL_NOTIFY_CMD="${HEAL_NOTIFY_CMD:-}"
# POST_DELIVERED (#203): set by post() to 1 iff the send SUCCEEDED, else 0 — the
# escalation latch keys on it so a Mattermost brownout during the one @ben ping
# no longer silences the signature for the whole cooldown. A no-chat deployment
# (notify-mattermost.sh prints to stderr and exits 0 on purpose) counts as
# DELIVERED, so callers behave identically with or without chat wired up; only a
# configured send that ERRORS (curl -f on a 5xx → non-zero exit, swallowed here)
# reads as undelivered and makes the escalate branch retry next tick.
POST_DELIVERED=1
post() { # post <msg> [thread_root] → echoes post id (empty when chat unset)
  local msg="$1" root="${2:-}" rc=0
  [ -n "${HEAL_DRY_RUN:-}" ] && msg="[dry-run] $msg"
  if [ -n "$HEAL_NOTIFY_CMD" ]; then
    ${HEAL_NOTIFY_CMD} "$msg" "$root" || rc=$?
  else
    bash "$here/notify-mattermost.sh" "$msg" "$root" || rc=$?
  fi
  POST_DELIVERED=0; [ "$rc" -eq 0 ] && POST_DELIVERED=1
  return 0
}

run_agent() { # <sig> <workflow> <errline> — 0 iff diagnosis.md was produced
  local sig="$1" wf="$2" errline="$3" ctx="$EVIDENCE/prompt.txt"
  # The swarm.db run id (#92), computed BEFORE the prompt so the incident block
  # can hand it to the agent as the `matou.run` label for every docker run it
  # issues during a bisect (#123): that label + `matou.factory=heal` is what
  # lets the container sweep reap a container the agent leaks at
  # HEAL_REAP_CEILING (#122), instead of waiting out the multi-hour image belt.
  heal_run_db_id="heal-$REPO_TAG-$(date +%s)-$$"
  # Throwaway repair clone (#203): the agent investigates and COMMITS its code
  # repair in an isolated checkout, never the shared $WORKDIR — a wedged or
  # aborted repair can no longer corrupt a running worker's checkout, and the
  # agent's own `git push` cannot reach `main` (the clone's origin is the local
  # workdir, not the remote; it is re-pointed to the remote only AFTER the agent
  # returns, for the rails-gated heal_push below). A fresh/wedged workdir that
  # will not clone falls back to a bare throwaway dir so the agent STILL runs
  # outside $WORKDIR; it just has no push path (nothing to rebase onto).
  [ -n "$HEAL_CLONE" ] && rm -rf "$HEAL_CLONE" 2>/dev/null
  HEAL_CLONE="$(mktemp -d "/tmp/matou-heal-clone-$REPO_TAG.XXXXXX")"
  local clone_pre=""
  if git clone -q "$WORKDIR" "$HEAL_CLONE" >>"$EVIDENCE/clone.log" 2>&1; then
    clone_pre="$(git -C "$HEAL_CLONE" rev-parse HEAD 2>/dev/null || true)"
  else
    echo "heal: $WORKDIR not clonable — agent runs in a bare throwaway dir, no push path" >> "$EVIDENCE/clone.log"
  fi
  {
    cat "$HEAL_PROMPT_FILE"
    echo; echo "## This incident"
    echo "- Mode: $MODE"
    echo "- Workflow: $wf"
    echo "- Run: ${RUN_URL:-n/a}"
    echo "- Signature: $sig"
    echo "- Heal run id: $heal_run_db_id"
    echo "- Trigger error line: ${errline:-unknown}"
    echo "- Swarm workdir: $WORKDIR"
    echo "- Evidence directory: $EVIDENCE (read every file)"
    echo "- Write your report to: $EVIDENCE/diagnosis.md"
    # #203: a code repair is COMMITTED in the throwaway clone; the healer
    # validates it against the rails and lands it. Only in a push repo (not a
    # dry run, not a pr-default repo) — the #167 branch below already bars a
    # landing there, and a dry run changes nothing.
    { [ -z "${HEAL_DRY_RUN:-}" ] && [ -z "$HEAL_NO_LAND" ]; } && echo "- Repair checkout: $HEAL_CLONE — a THROWAWAY clone. Do your harness-infra code repair HERE and COMMIT it (one commit); the healer re-validates it against the diff rails and pushes it to \`main\` for you. Do NOT \`git push\` yourself. Host-level repairs that are not code (e.g. resetting the shared workdir when swarm-lock.txt says \`free\`) still act on \`$WORKDIR\` directly."
    [ -n "${HEAL_DRY_RUN:-}" ] && echo "- DRY RUN: diagnose only. Make NO commits, NO pushes, file NO tickets."
    # #167: a pr-default repo REVIEWS every landing on main — override the repairs
    # enrichment's "push to main" for a code fix. Diagnosis and ticket-filing are
    # unaffected (a ticket is not a push); only the direct-to-main repair is barred.
    [ -n "$HEAL_NO_LAND" ] && echo "- LANDING=pr: this repo REVIEWS every landing on main (idss ADR 0267). Do NOT push or commit a repair to \`main\`, and do NOT open the PR yourself. Diagnose the fault and set ESCALATE: yes so a human lands the reviewed PR; file a ticket for a product-class fault as usual. (This overrides any 'push to main' in the repairs section above.)"
  } > "$ctx"
  rm -f "$EVIDENCE/diagnosis.md"
  local status=0 heal_attempt=1
  # Stamp the factory git identity (#19) so the /tmp/heal-fix clone's commits
  # carry "…(healer@<host>)", never the host user's ~/.gitconfig. Belt to the
  # identity_require seam's braces (#31).
  command -v swarm_git_identity >/dev/null || {
    echo "identity: swarm_git_identity missing from swarm-identity.sh — re-run: onboard.sh identity ${REPO_SLUG:-<owner/repo>} .sandcastle/swarm-identity.sh" >&2
    exit 2
  }
  swarm_git_identity healer
  claude_select_token
  # swarm.db trace (#92): THIS is the choke point where the investigation
  # actually invokes claude. Open one run row (trigger `heal`, repo-scoped so the
  # fleet monitor's per-repo reads attribute it), one claude process row (ref the
  # pid — ended_at NULL = believed alive), and one `heal` event pointing at the
  # evidence dir. The verdict is EARNED below and finalised by the EXIT trap.
  local heal_started; heal_started="$(date +%s)"
  # #202: stamp the executing host on the run row (HEAL_EVIDENCE_HOST already
  # resolved it up top: SWARM_HOST else `hostname`) so spend groups per-device.
  swarmdb_run_start "$heal_run_db_id" "${REPO_SLUG:-$REPO_TAG}" heal "$heal_started" "$HEAL_EVIDENCE_HOST"
  swarmdb proc-open --run "$heal_run_db_id" --kind claude --ref "$$" \
    --command "heal $wf ($sig)" --started "$heal_started"
  swarmdb_event "$heal_run_db_id" "" heal "investigating $wf ($sig)" "$EVIDENCE"
  while :; do
    status=0
    # --kill-after (#123): the default SIGTERM at 900s lets the agent's own
    # cleanup trap run first (the cidfile+`docker rm -f` trap the heal-prompt
    # tells it to set on every bisect container), THEN a hard SIGKILL 30s later
    # backstops a wedged agent so it can never camp on the healer lock. A
    # container the agent still leaks past all of this is caught by the sweep's
    # `matou.factory=heal` label reap (#122) — belt, braces, and a floor.
    if [ -n "${HEAL_AGENT_CMD:-}" ]; then
      # Test seam: the stub receives the prompt as $1. Runs in the throwaway
      # clone, exactly like the real agent (#203).
      ( cd "$HEAL_CLONE" && timeout --kill-after=30 900 ${HEAL_AGENT_CMD} "$(cat "$ctx")" ) > "$EVIDENCE/agent-out.log" 2>&1 || status=$?
    else
      # #198: this claude runs UNSANDBOXED on the host with the full job env.
      # Strip the standby Claude token, the primary snapshot, and the chat bot
      # token from the child — the diagnosing agent needs none of them
      # (claude_select_token already put the ACTIVE account in
      # CLAUDE_CODE_OAUTH_TOKEN; FORGEJO_TOKEN stays for tracker reads).
      # #203: runs in the throwaway clone, never the shared $WORKDIR.
      # #202: `--output-format json` so the diagnosis call's `.usage` block is
      # captured for the spend row below. On a clean call stderr is empty, so
      # agent-out.log IS the single JSON object the helper parses; a call that
      # also wrote stderr prose folds in harmlessly (the helper reads NOTHING
      # from a non-JSON file — best-effort, never reds the run).
      ( cd "$HEAL_CLONE" && timeout --kill-after=30 900 \
          env -u CLAUDE_CODE_OAUTH_TOKEN_B -u CLAUDE_TOKEN_PRIMARY -u MATTERMOST_BOT_TOKEN \
          claude -p --model "$SWARM_HEAL_MODEL" --output-format json \
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
      heal_run_verdict="limit-parked"   # the EXIT trap finalises the run/process rows
      exit 0
    fi
    break
  done
  # ── spend: attribute the diagnosis call's token usage to the active account
  # (#202). Only a REACHED, non-limit claude call gets here (a limit refusal is
  # "not a spent diagnosis" and exited above). The `--output-format json` result
  # is agent-out.log; turn its usage block into ONE aggregate spend row via the
  # shared swarm-db-lib helper — run-scoped (the incident is not issue-scoped),
  # the same account-attributed shape the worker/session/triage calls record.
  # Best-effort: a usage-less / unparseable log writes nothing and never reds.
  local heal_account; heal_account="$(claude_active_account)"
  if [ "$(swarmdb_spend_from_result "$heal_run_db_id" "" "$heal_account" "$EVIDENCE/agent-out.log")" = 1 ]; then
    echo "heal: recorded the diagnosis call's token spend for account $heal_account (#202)"
  fi
  # Land a claude-committed repair ONLY through the mechanical rails (#203). The
  # agent committed in the throwaway clone; here the healer re-validates that
  # commit with heal_rails (one commit, ≤3 files, ≤cap non-test lines, no
  # product-surface change, no weakened check, no self-modification) and lands it
  # with heal_push (rebase onto origin/main, re-validate against the replayed
  # parent, verified-landed push). A refusal — over the cap, off the allowed
  # surface, a weakened check — or a failed push leaves NOTHING on main and sets
  # HEAL_PUSH_RESULT=refused, so the caller escalates for a human-landed reviewed
  # fix (ties #168). Attempted only when the agent cleanly committed in a real
  # clone, in a push repo, outside a dry run (the incident prompt barred a repair
  # landing in the other cases, so the clone HEAD cannot have moved for a landing).
  HEAL_PUSH_RESULT=none
  local clone_head=""
  [ -n "$clone_pre" ] && clone_head="$(git -C "$HEAL_CLONE" rev-parse HEAD 2>/dev/null || true)"
  if [ "$status" -eq 0 ] && [ -n "$clone_pre" ] && [ -n "$clone_head" ] \
     && [ "$clone_head" != "$clone_pre" ] \
     && [ -z "${HEAL_DRY_RUN:-}" ] && [ -z "$HEAL_NO_LAND" ]; then
    mkdir -p "$EVIDENCE/logs"
    if ! heal_rails "$HEAL_CLONE" "$clone_pre"; then
      HEAL_PUSH_RESULT=refused
      echo "heal: repair refused by the rails ($HEAL_RAIL_REASON) — not landing on main ($sig)"
    else
      # Re-point the repair clone's origin from the local $WORKDIR to the real
      # remote, CREDENTIAL-FREE (#195): strip any embedded credential from the URL
      # and persist git-cred-lib's token-free helper so heal_push's `git push
      # origin` authenticates with no token in the URL or on argv. git_cred_export
      # covers this process's git children too. A local-path origin (the test
      # fixtures' shape) passes through git_cred_strip_url unchanged.
      local rurl; rurl="$(git -C "$WORKDIR" remote get-url origin 2>/dev/null || true)"
      if [ -n "$rurl" ]; then
        git -C "$HEAL_CLONE" remote set-url origin "$(git_cred_strip_url "$rurl")" 2>/dev/null || true
        git_cred_persist -C "$HEAL_CLONE" 2>/dev/null || true
      fi
      git_cred_export
      if heal_push "$HEAL_CLONE" "$clone_pre" "$EVIDENCE"; then
        HEAL_PUSH_RESULT=pushed
        echo "heal: repair landed on main through the rails ($sig)"
      else
        HEAL_PUSH_RESULT=refused
        echo "heal: repair push refused ($sig) — nothing landed on main"
      fi
    fi
  fi
  # Earn the run verdict from the investigation's real outcome (#92): a produced
  # diagnosis is `diagnosed`, anything else `no-diagnosis`. The EXIT trap stamps
  # whichever we set here onto the run row and closes the process row.
  if [ "$status" -eq 0 ] && [ -f "$EVIDENCE/diagnosis.md" ]; then
    heal_run_verdict="diagnosed"
    return 0
  fi
  heal_run_verdict="no-diagnosis"
  return 1
}

handle_incident() { # <workflow> <errline> [<run-url>]
  local wf="$1" errline="$2" run_url="${3:-}" sig decision thread degraded=""
  # Put this incident's own job log in the bundle BEFORE any investigation reads
  # it (#188). Per incident (not once in gather_evidence) so a watchdog sweep's
  # distinct runs each get their own leg logs, and the file is fresh for the
  # run_agent call below.
  collect_job_logs "$run_url"
  sig="$(compute_signature "$wf" "$errline")"
  decision="$(ledger_decide "$sig" "$NOW")"
  thread="$(ledger_get "$sig" thread_id)"
  echo "heal: incident wf=$wf sig=$sig decision=$decision"
  # No readable seam evidence (error_line left the marker): the ci signature
  # degraded to the workflow name alone. Be honest about it on every post (AC3).
  [ -f "$EVIDENCE/seam-degraded" ] && degraded=$'\n:warning: signature degraded to workflow name (no fresh run verdict) — the recurrence status is unverified'

  case "$decision" in
    reply-recurring)
      # A fault whose diagnosis only FILED a ticket recurs until the fix lands,
      # so say so on the thread rather than repeating a bare "still failing"
      # that reads like new information (#79).
      local ticketed tnote=""
      ticketed="$(ledger_get "$sig" ticketed | grep -E '^[0-9]+$' || echo 0)"
      [ "${ticketed:-0}" -ge 1 ] && tnote=" · a ticket is already filed for this fault — recurrence expected until the fix lands"
      post ":arrows_counterclockwise: still failing (\`$sig\`, $wf) — ${RUN_URL:-watchdog}${tnote}${degraded}" "$thread" >/dev/null
      ledger_set "$sig" replies "$(( $(ledger_get "$sig" replies | grep -E '^[0-9]+$' || echo 0) + 1 ))"
      ;;
    escalate-noisy)
      # The reply cap is spent: say it once, with the operator action spelled
      # out, then go quiet for the rest of the cooldown. Silence here is the
      # point — the incident is already on the thread above.
      post "@ben :rotating_light: **$wf has failed ${HEAL_MAX_REPLIES}+ times with the same fault** (\`$sig\`) — the healer is going quiet on it until the cooldown expires or the fault changes. ${RUN_URL:-} · evidence: \`$EVIDENCE\` on $HEAL_EVIDENCE_HOST" "$thread" >/dev/null
      # Latch the silence ONLY when the ping was actually delivered (#203): a
      # swallowed 5xx must not silence the signature for the whole cooldown.
      if [ "${POST_DELIVERED:-1}" = 1 ]; then ledger_set "$sig" escalated 1
      else echo "heal: escalation ping not delivered ($sig) — not latching, will retry next tick"; fi
      ;;
    silent)
      echo "heal: $sig already escalated and silenced — posting nothing"
      ;;
    escalate-repaired)
      # Say it ONCE, then latch — exactly the brake escalate-noisy has always
      # had (#79). This branch used to set nothing, and `repaired=1` wins ahead
      # of the reply cap in ledger_decide, so every recurrence inside the
      # cooldown re-pinged @ben and refreshed last_seen: on 2026-08-24 that was
      # one ping per red run, a run every ~2 minutes, for a fault already
      # ticketed as a known product bug. The fault stays visible in the run
      # history and on the thread; only the PING is once per window.
      post "@ben :rotating_light: **$wf recurred after a repair attempt** (\`$sig\`) — the healer will not retry, and is going quiet on it until the cooldown expires or the fault changes. ${RUN_URL:-} · evidence: \`$EVIDENCE\` on $HEAL_EVIDENCE_HOST" "$thread" >/dev/null
      # Latch ONLY on a delivered ping (#203) — see escalate-noisy.
      if [ "${POST_DELIVERED:-1}" = 1 ]; then ledger_set "$sig" escalated 1
      else echo "heal: escalation ping not delivered ($sig) — not latching, will retry next tick"; fi
      ;;
    investigate|investigate-stale)
      local pid
      # A new cooldown window is a NEW incident: clear the previous window's
      # ladder state so both brakes start fresh (#79). Without this the latch
      # the escalate branches set would outlive its window — a signature that
      # escalated once would re-investigate on staleness and then go straight
      # to `silent` for every recurrence after it, i.e. once ever, not once
      # per window.
      if [ "$decision" = "investigate-stale" ]; then
        ledger_set "$sig" replies 0
        ledger_set "$sig" escalated 0
      fi
      if [ -f "$EVIDENCE/seam-killed" ]; then
        # Downgrade (#34): the run was SIGKILL'd mid-stage (probable OOM) and left
        # a breadcrumb but no verdict — its heavy work had typically already
        # succeeded (the triage claude call in the ticket completed, then the
        # wrapper was killed ~4 s later). This is a host-capacity event, not a
        # fault: do NOT spend an (expensive) investigation. Post a low-severity,
        # un-pinged note; the dedup ladder still owns recurrence, so a host that
        # keeps OOM-killing jobs escalates to @ben on its own via the reply cap.
        pid="$(post ":zzz: **$wf was killed mid-stage — probable resource kill / OOM, not a fault** (\`$sig\`) — no run verdict was written (a SIGKILL cannot run the EXIT trap; the last running stage was recovered from the breadcrumb). Not investigating. ${RUN_URL:-watchdog} · evidence: \`$EVIDENCE\` on $HEAL_EVIDENCE_HOST" "$thread")"
        [ -z "$thread" ] && [ -n "$pid" ] && ledger_set "$sig" thread_id "$pid"
        [ -z "$(ledger_get "$sig" repaired)" ] && ledger_set "$sig" repaired 0
      elif run_agent "$sig" "$wf" "$errline"; then
        local head_lines act
        head_lines="$(head -c 3500 "$EVIDENCE/diagnosis.md")"
        act="$(sed -n 's/^ACTION-TAKEN: *//p' "$EVIDENCE/diagnosis.md" | head -1)"
        local esc; esc="$(sed -n 's/^ESCALATE: *//p' "$EVIDENCE/diagnosis.md" | head -1)"
        local ping=""; [ "$esc" = "yes" ] && ping="@ben "
        pid="$(post "${ping}:stethoscope: **Healer — $wf** (\`$sig\`) ${RUN_URL:-}${degraded}
$head_lines" "$thread")"
        [ -z "$thread" ] && [ -n "$pid" ] && ledger_set "$sig" thread_id "$pid"
        if [ "${HEAL_PUSH_RESULT:-none}" = pushed ]; then
          # The agent's code repair LANDED on main through the rails (#203) — a
          # bounded, verified repair whatever the prose says. Mark it repaired so
          # a recurrence takes the loop-breaker (the healer never repairs twice).
          ledger_set "$sig" repaired 1
        elif [ "${HEAL_PUSH_RESULT:-none}" = refused ]; then
          # The agent committed a repair but it breached the diff rails (over the
          # file/line cap, off the allowed surface, a weakened check) or could not
          # land — NOTHING reached main. Do NOT mark it repaired; escalate for a
          # human-landed reviewed fix (ties #168), and keep it on the reply ladder.
          post "@ben :construction: **$wf — healer repair exceeded the diff rails** (\`$sig\`, ${HEAL_RAIL_REASON:-over rails}) — the fix was NOT landed on main; a human should land a reviewed PR. ${RUN_URL:-} · evidence: \`$EVIDENCE\` on $HEAL_EVIDENCE_HOST" "$thread" >/dev/null
          [ -z "$(ledger_get "$sig" repaired)" ] && ledger_set "$sig" repaired 0
        elif [ -n "$act" ] && [ "$act" != "none" ] && [ -z "${HEAL_DRY_RUN:-}" ]; then
          if action_is_ticket_only "$act"; then
            # Filing a ticket is the right action for a product-class fault —
            # and it is NOT a repair (#79): nothing on the host or in the repo
            # changed, so the fault recurs until the fix lands and each
            # recurrence carries no new information. Record it as `ticketed`
            # and leave the signature on the reply-cap ladder (three replies,
            # ONE escalation, then quiet). Marking it `repaired` instead is
            # what routed the 2026-08-24 recurrences onto the repair
            # loop-breaker, whose latch this ticket also fixes.
            ledger_set "$sig" ticketed "$(( $(ledger_get "$sig" ticketed | grep -E '^[0-9]+$' || echo 0) + 1 ))"
            [ -z "$(ledger_get "$sig" repaired)" ] && ledger_set "$sig" repaired 0
          elif [ -n "$HEAL_NO_LAND" ]; then
            # pr-default repo (#167): a non-ticket "repair" cannot have LANDED on
            # main here — the agent was told to escalate, not push — so this is
            # never a completed repair. Keep it on the reply-cap ladder (repaired=0)
            # so the still-unlanded fault stays visible, exactly like a dry run.
            [ -z "$(ledger_get "$sig" repaired)" ] && ledger_set "$sig" repaired 0
          else
            ledger_set "$sig" repaired 1
          fi
        else
          ledger_set "$sig" repaired "$(ledger_get "$sig" repaired)"
          [ -z "$(ledger_get "$sig" repaired)" ] && ledger_set "$sig" repaired 0
        fi
      else
        pid="$(post "@ben :rotating_light: **$wf failed and the healer could not produce a diagnosis** — ${RUN_URL:-watchdog} · agent log + evidence: \`$EVIDENCE\` on $HEAL_EVIDENCE_HOST" "$thread")"
        [ -z "$thread" ] && [ -n "$pid" ] && ledger_set "$sig" thread_id "$pid"
        [ -z "$(ledger_get "$sig" repaired)" ] && ledger_set "$sig" repaired 0
      fi
      ledger_set "$sig" workflow "$wf"
      [ -z "$(ledger_get "$sig" first_seen)" ] && ledger_set "$sig" first_seen "$NOW"
      ledger_set "$sig" attempts "$(( $(ledger_get "$sig" attempts | grep -E '^[0-9]+$' || echo 0) + 1 ))"
      ;;
  esac
  ledger_set "$sig" last_seen "$NOW"
  # Cross-host dedup observability (#203): the per-host file ledger decides this
  # host's dedup, but a sibling host working the same pool cannot SEE it. Mirror
  # every incident decision into swarm.db `events` as a `heal-dedup` row carrying
  # the signature, workflow, decision, and the healer's host — so the fleet
  # monitor (which reads every host's events) can observe that signature X was
  # deduped on host H at time T across the whole pool, not just in one host's
  # /tmp. Best-effort (swarmdb swallows every failure); the run never depends on
  # it, and the kind is distinct from run_agent's `heal` event so trace counts
  # stay unambiguous.
  swarmdb_event "heal-dedup-$REPO_TAG" "" heal-dedup \
    "sig=$sig wf=$wf decision=$decision host=$HEAL_EVIDENCE_HOST" "$EVIDENCE"
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
  handle_incident "$WORKFLOW" "$(error_line "$WORKFLOW")" "${RUN_URL:-}"
else
  found=0
  # (c) API reachability / latency incident (#1462). The probe now records
  # curl's own outcome, so read all three facts and trip on any UNHEALTHY probe
  # — a transport failure (curl exit != 0, incl. a genuine timeout=28), a
  # non-2xx status (a fast 401/403 auth fault or a 5xx remote degradation), or a
  # slow-but-successful call >=30s. This is the SAME trip-set the old blanket
  # `timeout` fired on (curl -sf failed on all of them), but the errline and the
  # api-timing.txt evidence now say WHICH, so the diagnosis no longer has to
  # re-probe live to tell auth from a real stall.
  api_s="$(sed -n 's/^api_seconds=//p' "$EVIDENCE/api-timing.txt")"
  api_http="$(sed -n 's/^api_http=//p' "$EVIDENCE/api-timing.txt")"
  api_rc="$(sed -n 's/^api_curl_exit=//p' "$EVIDENCE/api-timing.txt")"
  api_slow=""; { [ "${api_s%%.*}" -ge 30 ] 2>/dev/null; } && api_slow=1
  if [ "$api_rc" = 0 ] && [ "${api_http:0:1}" = 2 ] && [ -z "$api_slow" ]; then
    : # a fast 2xx — the API is healthy
  else
    handle_incident "forgejo-api" "API probe: http=${api_http:-?} elapsed=${api_s}s curl_exit=${api_rc:-?} (unhealthy; threshold 30s)" ""
    found=1
  fi
  # (a)+(b) failure streaks / always-red — skip workflows whose ledger was
  # touched within the cooldown (a hook already owns the incident)
  while IFS=$'\t' read -r wf kind; do
    [ -z "$wf" ] && continue
    recent="$(find "$HEALER_STATE" -maxdepth 1 -type f -newermt "-6 hours" \
      -exec grep -l "^workflow=$wf$" {} + 2>/dev/null | head -1 || true)"
    [ -n "$recent" ] && { echo "heal: $wf already ledgered recently — skipping"; continue; }
    handle_incident "$wf" "watchdog: $kind ($(error_line "$wf"))" "$(watchdog_run_url "$EVIDENCE/runs.json" "$wf")"
    found=1
  done < <(watchdog_detect "$EVIDENCE/runs.json")
  if [ "$found" -eq 0 ]; then echo "heal: watchdog — all healthy"; fi
fi
