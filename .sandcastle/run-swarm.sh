#!/usr/bin/env bash
# Run Sandcastle over the ready tasks, push the results to main, and post a
# Mattermost summary. Run from the repo checkout root; assumes the origin
# remote is authenticated for push (the workflow checkout sets this up).
#
# Env: FORGEJO_TOKEN, FORGEJO_API, CLAUDE_CODE_OAUTH_TOKEN (+ optional
#      CLAUDE_CODE_OAUTH_TOKEN_B standby — #510 failover, host/org env ONLY,
#      never .sandcastle/.env and never forwarded to workers),
#      MATTERMOST_URL/MATTERMOST_BOT_TOKEN/MATTERMOST_CHANNEL_ID (optional),
#      REPO_SLUG (optional),
#      RUN_URL (optional Actions run link).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=limit-lib.sh
. "$here/limit-lib.sh"
# shellcheck source=fence-lib.sh
. "$here/fence-lib.sh"
# shellcheck source=sweep-lib.sh
. "$here/sweep-lib.sh"
# shellcheck source=verdict-lib.sh
. "$here/verdict-lib.sh"
# shellcheck source=runlog-lib.sh
. "$here/runlog-lib.sh"
# shellcheck source=model-lib.sh
# Shared model config (#448): swarm_resolve_model + the $SWARM_MODEL default.
. "$here/model-lib.sh"
# shellcheck source=swarm-db-lib.sh
# swarm.db trace MIRROR (#447): best-effort SQLite front-end. Every writer
# swallows its own failure — a mirror we cannot write must never red a run.
. "$here/swarm-db-lib.sh"
# shellcheck source=cancel-lib.sh
# The operator-cancel kill-path (#612, idss ADR 0186): marker-file
# protocol the TUI writes and main.mts polls, plus the log-side
# swarm_cancel_hit detector this script's retry loop uses below.
. "$here/cancel-lib.sh"
# shellcheck source=protected-paths-lib.sh
# The outcome boundary (#445): fingerprint `.sandcastle/`+`.forgejo/` before and
# after the sandcastle run, attribute every protected change to the workers, roll
# it back, and fail loud. Gated behind PP_ENFORCE (see the guard below).
. "$here/protected-paths-lib.sh"
# shellcheck source=env-allowlist-lib.sh
# The preflight allowlist guard (#593, part 1 of #592): refuses a host-mode
# .env carrying a stray secret-shaped key. See the guard below, by the .env
# materialize step.
. "$here/env-allowlist-lib.sh"
: "${FORGEJO_TOKEN:?}"
: "${FORGEJO_API:?}"
repo_slug="${REPO_SLUG:-${FORGEJO_API##*/repos/}}"
# One runner now serves TWO repos (Matou/idss + Matou/matou-app). Any /tmp
# state that is per-repo must carry the repo in its name, or the two repos
# clobber each other's stamps (#238). Slashes aren't valid in a path segment,
# so flatten the slug: "Matou/idss" -> "Matou-idss".
repo_tag="${repo_slug//\//-}"

# Factory git identity (#19): every headless commit path stamps GIT_AUTHOR_*/
# GIT_COMMITTER_* from ONE place (swarm-identity.sh) so commits record which
# machinery made them instead of inheriting the host user's ~/.gitconfig. Pin
# REPO_SLUG to THIS run's repo (the runner serves several) before sourcing, and
# source AFTER the FORGEJO_API guard above so swarm-identity's `:=` defaults can
# never mask a missing API. `worker` covers this host's reconcile/rescue commits
# AND the value main.mts forwards into each worker container.
export REPO_SLUG="$repo_slug"
# shellcheck source=swarm-identity.sh
. "$here/swarm-identity.sh"
swarm_git_identity worker

# sandcastle tags its per-repo image `sandcastle:<checkout-basename>`, lowercased
# with every character outside [a-z0-9_.-] replaced by '-' (empty -> "local");
# see @ai-hero/sandcastle's defaultImageName. Replicated here so the nix-store
# seed below targets the SAME image the workers run. SANDCASTLE_IMAGE overrides.
# Pinned against drift by tests/nix-store-test.sh.
sandcastle_image_name() { # sandcastle_image_name <checkout-dir>
  local base sanitized
  base="$(basename "${1:-.}")"
  sanitized="$(printf '%s' "$base" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_.-]/-/g')"
  printf 'sandcastle:%s' "${sanitized:-local}"
}

# Seed the persistent nix store only when it is empty (or absent): a cold host
# seeds once from the image's /nix, a warm host reuses what's there.
should_seed_nix() { # should_seed_nix <nix-store-dir> -> "seed" | "skip"
  if [ -z "$(ls -A "$1" 2>/dev/null)" ]; then echo seed; else echo skip; fi
}

# Drop a stage/exit verdict on failure so the healer keys the incident signature
# on the run's REAL failing stage, not on worker chain-of-thought prose (#235).
# Cleared here so a verdict on disk always belongs to this run. The EXIT trap is
# armed NOW — before `pnpm install` (the #142 lockfile break) and the image build —
# so those early failures leave a verdict too; the worktree sweep only runs once
# the run is far enough in to have created worktrees (SWEEP_ARMED, set below).
# #574: repo-tagged default — two repos share this host (#238's lesson,
# already applied to /tmp/matou-swarm-lastready-$repo_tag below) and would
# stomp each other's verdict file without it.
verdict_begin "${SWARM_VERDICT_PATH:-/tmp/matou-$repo_tag-swarm-verdict.txt}"
verdict_stage "startup (list ready tasks, debounce)"
SWEEP_ARMED=""
# Host-side exit-reason log (#435). Every exit path lands ONE line here so the
# next green-and-empty stall is readable off disk instead of an Actions job log
# the REST API hangs on. Initialised now — before the trap arms — so an early
# `set -e` death still logs (reason falls back to the current verdict stage).
run_started="$(date +%s)"
ready_nums=""            # set once the ready set is known
stamp=""                 # the per-repo debounce stamp path, set below
stamp_written=""         # this run WROTE a fresh debounce stamp (took the run path)
worker_ran=""            # a worker container was confirmed born this run
events_pid=""            # background `docker events` worker-birth watcher (#435)
worker_births=""         # its capture file (cleaned up on every exit)
fence_pid=""             # background D3 container-fence watcher (#568)
SWARM_EXIT_REASON=""     # set at each intentional exit; else derived from the stage
# The swarm.db run id (#447): unique per run, per repo, per host. SWARM_RUN_ID is
# the Actions run number when present; the pid keeps a cron/host run unique too.
run_db_id="${repo_tag}-${SWARM_RUN_ID:-$run_started}-$$"
swarm_trigger="${SWARM_TRIGGER:-${GITHUB_EVENT_NAME:-unknown}}"
# One row per run — written NOW so even a run that dies in early startup, or is
# killed before it lists tasks, leaves a started-but-open trace (finalised by the
# EXIT trap below). Best-effort; migrates the db idempotently on first touch.
swarmdb_run_start "$run_db_id" "$repo_slug" "$swarm_trigger" "$run_started"
on_exit() {
  local ec=$?
  [ -n "$events_pid" ] && kill "$events_pid" 2>/dev/null || true
  [ -n "$fence_pid" ] && kill "$fence_pid" 2>/dev/null || true
  [ -n "$worker_births" ] && rm -f "$worker_births" 2>/dev/null || true
  rm -rf "${pp_before:-}" "${pp_after:-}" 2>/dev/null || true   # protected-path snapshots (#445)
  verdict_write "$ec"
  local reason="${SWARM_EXIT_REASON:-}"
  [ -n "$reason" ] || reason="died-in:${VERDICT_STAGE:-unknown}"
  runlog_append "${SWARM_RUNLOG:-$HOME/swarm/logs/run-swarm-verdicts.log}" \
    "$(runlog_line "$run_started" "$(date +%s)" "$repo_slug" "$ready_nums" "$reason" "$ec")"
  # Mirror the finalised verdict into swarm.db, closing the run row and any open
  # attempt (kills-finalise invariant: nothing reads 'running' forever). Runs on
  # EVERY exit path including the SIGTERM/SIGINT route below.
  swarmdb_run_end "$run_db_id" "$reason" "$reason" "$ec" "$(date +%s)"
  # Invalidate the debounce stamp when this run wrote a fresh one but never
  # confirmed a worker (#435): a stamp left by a run that died quietly — or one
  # that concluded green-and-empty — would coalesce away the very next genuine
  # retry. A run that DID spawn a worker keeps its stamp so a burst of identical
  # triggers still coalesces. The coalesce path never sets stamp_written, so its
  # existing stamp is preserved and debouncing keeps working.
  if [ -n "$stamp_written" ] && [ -z "$worker_ran" ] && [ -n "$stamp" ]; then
    rm -f "$stamp"
  fi
  if [ -n "$SWEEP_ARMED" ]; then sweep_and_report; fi
}
trap on_exit EXIT
# Kills finalise the trace (#447, invariant 2). Actions cancellation and the
# 180-minute timeout send SIGTERM (then SIGKILL); by default bash would die
# WITHOUT running the EXIT trap, leaving the run's swarm.db + runlog rows reading
# 'running' forever. Route both signals through a clean exit so on_exit fires and
# finalises. 143 = 128+SIGTERM, 130 = 128+SIGINT (the conventional codes).
# `(exit "$2")` sets $? so on_exit's `local ec=$?` reads the signal code, not the
# last command's; `trap - EXIT` stops the final `exit` from re-running on_exit.
on_signal() { SWARM_EXIT_REASON="killed:$1"; trap - EXIT; (exit "$2"); on_exit; exit "$2"; }
trap 'on_signal SIGTERM 143' TERM
trap 'on_signal SIGINT 130' INT

api() { curl -sf -H "Authorization: token $FORGEJO_TOKEN" "$@"; }

# Preflight self-tests (#446, learning L5). BEFORE any real work — before the
# janitor mutates a label, before pnpm install, before a worker spawns — every
# silently-failing guard (limit grep, healer signature/rails, verdict parsing,
# secrets-as-content) is fired against a canned fixture it MUST match. A guard
# that has quietly broken (a mangled limit grep, a §17 `:?`-in-$() rail no-op)
# reds HERE in seconds, named, instead of during an incident. Zero token; the
# only network call is the #20 issue-write permission probe (one cheap GET).
# Fails closed: the run aborts and posts the failing guard, like every
# other run-fail path (runlog line comes from the EXIT trap via SWARM_EXIT_REASON).
verdict_stage "preflight self-tests (#446)"
if ! preflight_out="$(bash "$here/preflight-swarm.sh" 2>&1)"; then
  printf '%s\n' "$preflight_out"
  bash "$here/notify-mattermost.sh" ":rotating_light: **Swarm preflight RED** in \`$repo_slug\` — a silent-failure guard did not fire on its fixture; NO worker was spawned. Fix before the swarm can run:
\`\`\`
$(printf '%s\n' "$preflight_out" | grep 'PREFLIGHT RED' | head -20)
\`\`\`" || true
  SWARM_EXIT_REASON="preflight-red"
  exit 1
fi
printf '%s\n' "$preflight_out"

# Per-repo POLICY (#12, ADR 0002): landing / merge-authority / loop-in-label
# knobs live in the consumer's swarm-policy.sh (beside swarm-identity.sh),
# defaulting to today's byte-identical behaviour when absent. Load + validate
# HERE, before a single worker spawns — an invalid policy fails LOUD like
# swarm_resolve_model, never a silent misconfiguration. NO knob is CONSUMED yet
# (the landing / merge / loop-in consumers are follow-up tickets); this only
# proves the file parses and every gate is well-formed.
# shellcheck source=policy-lib.sh
. "$here/policy-lib.sh"
# shellcheck source=landing-lib.sh
. "$here/landing-lib.sh"   # landing_reconcile (#13) — consumed by the reconcile stage in pr mode
policy_load
if ! policy_validate; then
  verdict_stage "policy validation (#12)"
  bash "$here/notify-mattermost.sh" ":no_entry: **Swarm aborted — invalid \`swarm-policy.sh\`** in \`$repo_slug\`. Fix the named policy key; no worker was spawned." || true
  SWARM_EXIT_REASON="invalid-policy"
  exit 1
fi
if [ "${SWARM_POLICY_FILE_PRESENT:-false}" = true ]; then
  echo "run-swarm: policy: LANDING=$SWARM_POLICY_LANDING MERGE_AUTHORITY=$SWARM_POLICY_MERGE_AUTHORITY"
else
  echo "run-swarm: policy: defaults (LANDING=$SWARM_POLICY_LANDING MERGE_AUTHORITY=$SWARM_POLICY_MERGE_AUTHORITY)"
fi

# Multi-host janitor (spec D4): re-arm tickets whose claiming run died — a
# crashed host must not strand agent-working tickets. Runs BEFORE listing so
# re-armed tickets rejoin this very run's queue.
# shellcheck source=claim-lib.sh
. "$here/claim-lib.sh"
rearmed="$(janitor_sweep || true)"
[ -n "$rearmed" ] && echo "run-swarm: janitor re-armed stale-claimed issue(s): $(printf '%s' "$rearmed" | tr '\n' ' ')"

ready="$(bash "$here/list-ready-tasks.sh")"
ready_nums="$(jq -r '[.[].number] | join(",")' <<<"$ready" 2>/dev/null || true)"
n="$(jq 'length' <<<"$ready")"
if [ "$n" -eq 0 ]; then
  echo "run-swarm: no ready tasks"
  SWARM_EXIT_REASON="no-ready-tasks"
  exit 0
fi
echo "run-swarm: $n ready task(s):"
jq -r '.[] | "  #\(.number) \(.title)"' <<<"$ready"
swarmdb_event "$run_db_id" "" ready-set "$n ready task(s)" "[$ready_nums]"

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
    SWARM_EXIT_REASON="coalesced"
    exit 0
  fi
fi
printf '%s %s\n' "$ready_hash" "$(date +%s)" > "$stamp"
stamp_written=1   # from here a quiet death without a worker must clear the stamp (#435)

# Per-ticket model (#448): the swarm picks the FIRST ready task, so THIS run's
# model follows that ticket's model-<name> label (list-ready-tasks.sh surfaces it
# as `.model`, null when unlabelled), defaulting to SWARM_MODEL. Resolve + validate
# HERE, before a single worker spawns — an unknown model fails LOUD now, never a
# silent fall back to the default. main.mts reads the exported SWARM_MODEL.
first_model="$(jq -r '.[0].model // empty' <<<"$ready" 2>/dev/null || true)"
if ! SWARM_MODEL="$(swarm_resolve_model "$first_model")"; then
  verdict_stage "swarm model resolution (#448 fail-fast)"
  bash "$here/notify-mattermost.sh" ":no_entry: **Swarm aborted — unknown model** \`${first_model:-?}\` on the first ready ticket in \`$repo_slug\`. Fix its \`model-*\` label; no worker was spawned." || true
  SWARM_EXIT_REASON="unknown-model"
  exit 1
fi
export SWARM_MODEL
echo "run-swarm: model for this run: $SWARM_MODEL${first_model:+ (from label model-$first_model on #$(jq -r '.[0].number' <<<"$ready"))}"

# Web URL of the repo (FORGEJO_API is <server>/api/v1/repos/<slug>).
repo_web="${FORGEJO_API%%/api/*}/$repo_slug"

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
else
  # Host-mode only (#593, part 1 of #592) — the CI branch above always
  # refreshes .env from .env.example, so it is structurally clean and this
  # guard never fires there. A host-mode .env is a developer's own file,
  # never regenerated, so it can drift a stray secret-shaped key into the
  # docker -e forward (docker inspect .Config.Env — the 2026-07-11 breach
  # vector, the #578 leak class) silently. Fail closed instead.
  env_violations="$(env_allowlist_violations "$here/.env")"
  if [ -n "$env_violations" ]; then
    # Same #9 treatment as the cold-store guard below: name the stage and capture
    # the FATAL, so the death is not mis-keyed to "preflight self-tests" with an
    # empty error block.
    verdict_stage "env allowlist check (#593)"
    env_fatal="run-swarm: FATAL — $here/.env carries key(s) beyond the allowlist: $(printf '%s' "$env_violations" | tr '\n' ' ')"
    echo "$env_fatal" >&2
    echo "run-swarm: sandcastle forwards every .env key as a docker run -e value (docker inspect .Config.Env — the 2026-07-11 breach vector, #578 leak class). Move secret-shaped keys to .sandcastle/secrets/ (see secrets/README.md) or add them to ENV_ALLOWLIST_KEYS in env-allowlist-lib.sh if they are genuinely non-secret." >&2
    verdict_error "$env_fatal"
    SWARM_EXIT_REASON="env-allowlist-violation"
    exit 1
  fi
fi

# FORGEJO_TOKEN/MATTERMOST_BOT_TOKEN/DIGITALOCEAN_ACCESS_TOKEN are NOT in
# .env — Sandcastle forwards every key .env declares as a `docker run -e`
# value, which lands in `docker inspect .Config.Env` (the 2026-07-11 breach
# vector). They ship into the sandbox as read-only files instead (main.mts's
# `mounts`, consumed per .sandcastle/secrets/README.md). Materialize them
# here from this process's own env (CI: Actions secrets; host: whatever the
# operator exported) so every run picks up the current value, including
# rotations. Each is optional — a task that never needs one just won't find
# the file.
mkdir -p "$here/secrets" && chmod 700 "$here/secrets"
# The sandbox's persistent pnpm store (main.mts mounts it at
# /home/agent/.pnpm-store) — survives across runs so workers install in
# seconds instead of re-downloading the registry every iteration.
mkdir -p "$here/pnpm-store"
# #489 / GOTCHAS #20: the mkdir guarantees the mount EXISTS, not that it is
# WARM. A fresh host's empty store makes every worker's frozen install fetch
# the whole tree inside the sandbox, which fails (exit 243) — zero workers
# born, anonymous ~29s reds every tick, visible only in the verdict file.
# Refuse loudly up front instead: seed the store from an established host
# (".forgejo/runner/README.md" → Fresh-host warm state; Ben's ruling
# 2026-08-13). SWARM_ALLOW_COLD_STORE=1 overrides for a deliberate cold start.
if [ "${SWARM_ALLOW_COLD_STORE:-0}" != "1" ] \
    && [ -z "$(find "$here/pnpm-store" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
  # Key the death on THIS guard's own stage + FATAL line (#9). Without the
  # verdict_stage the EXIT trap attributes the death to the last stage set (still
  # "preflight self-tests (#446)") — both in the verdict file's stage= and in the
  # runlog's died-in: reason, which derives from VERDICT_STAGE when
  # SWARM_EXIT_REASON is unset — and verdict_write leaves an EMPTY error block, so
  # the healer keys its signature on the wrong stage with no evidence and
  # escalates unknown. verdict_error captures the FATAL as the run's error line.
  # SWARM_EXIT_REASON is deliberately left UNSET so the runlog reason stays the
  # died-in:<stage> form the ticket's acceptance names (died-in:pnpm store warm
  # check) rather than a bare slug; the healer classifies off the verdict file.
  verdict_stage "pnpm store warm check (#489)"
  cold_fatal="run-swarm: FATAL — pnpm store $here/pnpm-store is EMPTY: workers cannot install (GOTCHAS #20, #489)."
  echo "$cold_fatal" >&2
  echo "run-swarm: seed it from an established host (.forgejo/runner/README.md → 'Fresh-host warm state'), or set SWARM_ALLOW_COLD_STORE=1 for a deliberate cold start." >&2
  verdict_error "$cold_fatal"
  exit 1
fi
# The sandbox's persistent nix store (main.mts mounts it at /nix) — survives
# across runs so the #198 Go pre-push gate enters `nix develop .#go-ci` from a
# warm store (seconds) instead of re-substituting the ADR-0040 pinned toolchain
# from the binary cache in every worker container (#249). Seeded from the image
# after build-image below (a bare mount would HIDE Nix itself — see there).
mkdir -p "$here/nix-store"
# main.mts mounts this at its own host path (#239) as a MANDATORY bind mount —
# Sandcastle throws "Mount hostPath does not exist" and the run never spawns a
# worker if it's missing. Gitignored (it holds live git worktrees), so a fresh
# clone never has it; the long-lived workstation checkout only got away with
# skipping this because a worktree had already been created there once before.
# A genuinely new host (elitebook-03, cutover 2026-08-12) hit this on every
# single dispatch — #464/#465 crash-looped there for ~7 min with no worker ever
# born, and never claimed since the crash happens before claim-next-task.sh runs.
mkdir -p "$here/worktrees"
write_secret() { # write_secret <file> <value>
  if [ -n "$2" ]; then printf '%s' "$2" >"$here/secrets/$1" && chmod 600 "$here/secrets/$1"; fi
}
write_secret forgejo_token "$FORGEJO_TOKEN"
write_secret mattermost_bot_token "${MATTERMOST_BOT_TOKEN:-}"
write_secret digitalocean_access_token "${DIGITALOCEAN_ACCESS_TOKEN:-}"

# pnpm-only, matching the repo standard (flake.nix: "no npm/yarn") — the repo
# carries a single lockfile. The 2026-07-27 outage was `npm ci` here tripping
# over a package-lock.json that #142's package.json change never updated.
verdict_stage "pnpm install (frozen lockfile)"
pnpm install --frozen-lockfile
verdict_stage "sandcastle docker build-image"
pnpm exec sandcastle docker build-image   # fast no-op after first build (layer cache)

# Seed the persistent nix store (#249). Unlike the pnpm store — a plain cache dir
# that pnpm-the-binary lives OUTSIDE of — /nix holds Nix itself (the single-user
# install the Dockerfile bakes writes its closure to /nix/store, and
# ~/.nix-profile symlinks point into it). Bind-mounting an EMPTY host dir over
# /nix would therefore hide that install and break the `nix` command every
# worker's gate needs. So seed the host store from the freshly built image's /nix
# ONCE, before the first worker mounts it; from then on the mount persists and the
# Go gate's toolchain substitution accumulates there across containers. Runs as
# this host user's uid:gid — the same identity the worker mounts under — so the
# store stays agent-owned (AC #2). NON-FATAL, matching the nix-install posture:
# if the seed fails the gate simply fails closed (a blocked push, main stays
# green) until the next run retries.
verdict_stage "seed persistent nix store"
if [ "$(should_seed_nix "$here/nix-store")" = "seed" ]; then
  image="${SANDCASTLE_IMAGE:-$(sandcastle_image_name "$PWD")}"
  seed_id="$(id -u):$(id -g)"
  echo "run-swarm: seeding cold nix store from $image (first run on this host)"
  # --entrypoint overrides the image's `sleep infinity` ENTRYPOINT (else it would
  # prefix the command and hang). `cp -a /nix/.` copies the image's whole Nix
  # closure — binaries and store — into the empty host mount.
  if docker run --rm --user "$seed_id" --entrypoint cp \
       -v "$here/nix-store:/seed-nix" "$image" -a /nix/. /seed-nix/; then
    # Pre-warm .#go-ci so even the FIRST worker's gate finds the pinned toolchain
    # already substituted (AC #3's 'better' path), not a cold substitution on the
    # critical push path. Mount the repo + the seeded store so the closure lands
    # in the persistent dir. Best-effort under a timeout: if it can't warm (no
    # egress, flake hiccup), the first real gate populates the store instead —
    # still persistent thereafter, still AC-#3 'acceptable'.
    if timeout 900 docker run --rm --user "$seed_id" --entrypoint bash \
         -v "$here/nix-store:/nix" -v "$PWD:/home/agent/workspace" \
         -w /home/agent/workspace "$image" \
         -lc 'nix develop .#go-ci --command true'; then
      echo "run-swarm: nix store warmed with .#go-ci"
    else
      echo "run-swarm: .#go-ci pre-warm skipped — the first Go gate will populate the store"
    fi
  else
    echo "run-swarm: nix store seed failed — the first worker gate will populate a cold store"
  fi
fi

# Post-run sweep: Sandcastle's merge-to-head worktrees and sandcastle/worker/*
# branches are never cleaned up, so the workdir leaked 18 worktrees (2.9 GB) and
# 198 orphaned branches by 2026-07-30 — and the stale checkouts poisoned
# `go test ./internal/wireconvention/...` with 1867 phantom findings (#187).
# Since #577 / ADR 0184 host capacity is a TWO-slot pool with no repo affinity,
# so a sibling swarm on this SAME repo+workdir can be live when this exit trap
# fires — sweep_worktrees/reap_containers therefore spare anything younger than a
# run-lifetime (that live sibling's checkout) and only remove provably-dead
# debris. Runs on EVERY exit (limit-pause, push-fail, normal). An unmerged worker
# branch is left intact and surfaced, never `-D`'d away.
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
# From here on the run can create worktrees, so arm the post-run sweep (the trap
# itself was installed up top so an early install/build failure still verdicts).
SWEEP_ARMED=1

start_sha="$(git rev-parse HEAD)"

# Protected-path boundary (#445): fingerprint the machinery NOW, before a single
# worker runs, so the post-run diff can attribute every change under
# `.sandcastle/`/`.forgejo/` to the workers and roll it back. Snapshotting here —
# after the pre-existing dirty state is whatever it is — means another session's
# uncommitted work is the baseline we compare against and is never rolled back as
# collateral. Best-effort: a snapshot we cannot take never reds the run (the
# enforce guard below simply finds nothing to compare and no-ops).
pp_before=""
if [ "${PP_ENFORCE:-0}" = 1 ]; then
  pp_before="$(mktemp -d)"
  pp_snapshot "$PWD" "$pp_before" 2>/dev/null || true
fi

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
# Watch worker-container births for the whole run (#435). Sandcastle starts each
# iteration's worker as `docker run -d --name sandcastle-<uuid>` (verified against
# @ai-hero/sandcastle's docker sandbox), so a `create` event whose name begins
# `sandcastle-` is proof a worker actually spawned. A LIVE stream survives a 3h
# run where a post-hoc `docker events --since` query could age out of the daemon's
# event buffer. We hold the global lock, so the only sandcastle-* births now are
# ours; the earlier nix-seed `docker run --rm` containers are unnamed and predate
# this watcher. If docker is somehow unavailable we simply skip the wedge check
# rather than false-fail (a build/run that needed docker already failed loud).
worker_births="$(mktemp)"
events_pid=""
if command -v docker >/dev/null 2>&1; then
  # --since replays events from the run's start too, so a worker born in the
  # millisecond before the stream attaches is still caught (no startup race);
  # the name filter keeps the earlier unnamed nix-seed containers out.
  docker events --since "$run_started" --filter 'type=container' --filter 'event=create' \
    --format '{{.Actor.Attributes.name}}' >"$worker_births" 2>/dev/null &
  events_pid=$!
  # D3 container fence (#568): bound each worker container the moment its
  # birth lands in $worker_births — `docker update`, so the in-flight worker
  # is never restarted. Polls the same capture file the wedge check reads
  # (no second events stream) and self-terminates when the file is cleaned.
  swarm_fence_watch "$worker_births" &
  fence_pid=$!
fi
# The captured log feeds the verdict's error lines if this stage fails (#235).
verdict_stage "sandcastle run (workers)" "$sandcastle_log"
# #574: main.mts (the sandcastle orchestrator — runs on THIS host, so it needs
# no docker-forwarded env, just its own process env) records the RunResult it
# captures against this SAME run id, or its attempts/spend/events rows would
# land under a different run_id than the `runs` row swarmdb_run_start opened
# above and never join up with everything else this script writes.
export SWARM_DB_RUN_ID="$run_db_id"
# Two-account failover (#510): start on the host's active account (a fresh B
# marker means a prior caller already failed over — don't pay a failed attempt
# to rediscover it), and on a limit refusal flip to the standby and retry the
# run ONCE. A second refusal means BOTH windows are exhausted: exactly the old
# quiet park, with the notice naming both.
claude_select_token
swarm_attempt=1
while ! pnpm run sandcastle 2>&1 | tee "$sandcastle_log"; do
  # #612: a deliberate operator cancel (the TUI's Cancel action, via
  # main.mts's AbortController) reads as a distinct, unalarmed stop — never
  # the generic sandcastle-run-failed fallback below, and never paged to the
  # healer (verdict_write only fires on a non-zero exit). Checked FIRST,
  # exactly like the limit guard immediately below it.
  if swarm_cancel_hit "$sandcastle_log"; then
    cancel_reason="$(swarm_cancel_hit_reason "$sandcastle_log")"
    bash "$here/notify-mattermost.sh" ":stop_sign: **Swarm run cancelled** in \`$repo_slug\` — operator cancel via the factory TUI${cancel_reason:+ ($cancel_reason)}. In-flight work for this run's current iteration is NOT recorded in swarm.db (ADR 0186); its ticket will be picked back up by the next janitor sweep." || true
    swarmdb_event "$run_db_id" "" cancelled "operator cancel${cancel_reason:+: $cancel_reason}" "$repo_tag"
    rm -f "$sandcastle_log"
    echo "run-swarm: run cancelled by operator${cancel_reason:+ ($cancel_reason)}"
    SWARM_EXIT_REASON="cancelled:operator"
    exit 0
  fi
  # #632: a DEAD TOKEN ("Not logged in · Please run /login", "Failed to
  # authenticate: OAuth session expired…") is a distinct refusal shape from
  # the usage-limit hit below — it must never wait out a "reset" that will
  # never come, and it must never fall through to the generic
  # sandcastle-run-failed red either (that pages the healer on a signature
  # that degrades to the workflow name alone — the near-unparseable class
  # 2f0d3a6 already ruled out for the rehearsal path; this is its mirror for
  # the swarm executor). Checked BEFORE the limit guard, same order
  # rehearsal-report.sh's try_heal/reporter loops use. Mirrors the #510
  # limit failover exactly: one retry on the standby, then a clean, named
  # halt — never a red.
  if claude_auth_failed "$sandcastle_log"; then
    auth_line="$(grep -ihoE "$CLAUDE_AUTH_RE[^\"]*" "$sandcastle_log" | head -1)"
    if [ "$swarm_attempt" = 1 ]; then
      auth_account="$(claude_active_account)"
      if claude_failover; then
        swarm_attempt=2
        bash "$here/notify-mattermost.sh" ":arrows_counterclockwise: **Swarm failover — Claude account $auth_account auth-dead** in \`$repo_slug\` (${auth_line:-not logged in}) — retrying once on account $(claude_active_account)."
        swarmdb_event "$run_db_id" "" auth-failover "Claude account $auth_account auth-dead — failed over to $(claude_active_account)" "${auth_line:-not logged in}"
        : > "$sandcastle_log"
        continue
      fi
    fi
    if claude_standby_available; then
      auth_headline="**Swarm halted — BOTH Claude accounts auth-dead** in \`$repo_slug\` — re-login required"
    else
      auth_headline="**Swarm halted — Claude account $(claude_active_account) auth-dead** in \`$repo_slug\` — re-login required"
    fi
    # Hourly notice-dedupe, same shape as the limit-pause marker below — a
    # queued-trigger burst against a dead token must not become its own
    # storm. Repo-agnostic on purpose, matching the limit marker (#238):
    # the Claude auth session is one host-global thing.
    marker="/tmp/matou-swarm-claude-auth-dead"
    if [ ! -f "$marker" ] || [ $(( $(date +%s) - $(stat -c %Y "$marker") )) -gt 3600 ]; then
      touch "$marker"
      bash "$here/notify-mattermost.sh" ":rotating_light: $auth_headline (${auth_line:-not logged in}). No worker was lost; queued tickets stay ready and pick back up once the token is refreshed."
    fi
    swarmdb_event "$run_db_id" "" auth-dead "$auth_headline" "${auth_line:-not logged in}"
    rm -f "$sandcastle_log"
    echo "run-swarm: Claude auth refusal — $auth_headline"
    SWARM_EXIT_REASON="claude-auth-dead"
    exit 0
  fi
  if claude_limit_hit "$sandcastle_log"; then
    reset_hint="$(claude_limit_reset_hint "$sandcastle_log")"
    if [ "$swarm_attempt" = 1 ]; then
      limited_account="$(claude_active_account)"
      if claude_failover; then
        swarm_attempt=2
        bash "$here/notify-mattermost.sh" ":arrows_counterclockwise: **Swarm failover — Claude account $limited_account limited** in \`$repo_slug\` (${reset_hint:-reset time unknown}) — retrying once on account $(claude_active_account)."
        swarmdb_event "$run_db_id" "" limit-failover "Claude account $limited_account limited — failed over to $(claude_active_account)" "${reset_hint:-reset time unknown}"
        : > "$sandcastle_log"
        continue
      fi
    fi
    # GLOBAL by design (#238): the Claude subscription is one window shared
    # across every repo, so the hourly notice-dedupe marker stays repo-agnostic
    # — one repo hitting the limit correctly suppresses the other's redundant
    # first notice for the same outage.
    if claude_standby_available; then
      park_headline="**Swarm paused — BOTH Claude accounts limited** in \`$repo_slug\` (${reset_hint:-reset time unknown})"
    else
      park_headline="**Swarm paused — Claude usage limit** in \`$repo_slug\` (account $(claude_active_account); ${reset_hint:-reset time unknown})"
    fi
    marker="/tmp/matou-swarm-claude-limit"
    if [ ! -f "$marker" ] || [ $(( $(date +%s) - $(stat -c %Y "$marker") )) -gt 3600 ]; then
      touch "$marker"
      bash "$here/notify-mattermost.sh" ":hourglass_flowing_sand: $park_headline. Queued runs will drain quietly until it resets; no work was started or lost."
    fi
    swarmdb_event "$run_db_id" "" limit-pause "Claude usage limit — paused quietly" "${reset_hint:-reset time unknown}"
    rm -f "$sandcastle_log"
    echo "run-swarm: Claude usage limit — pausing quietly"
    SWARM_EXIT_REASON="claude-limit-parked"
    exit 0
  fi
  # Leave $sandcastle_log in place — the EXIT trap's verdict_write reads it.
  SWARM_EXIT_REASON="sandcastle-run-failed"
  exit 1
done
rm -f "$sandcastle_log"

# The run said "success" — but did a worker ever actually spawn? Stop the birth
# watcher and count sandcastle-* container creations. A non-empty ready set that
# concludes green with ZERO worker births is #435's wedge: fail LOUD (red job +
# verdict the healer keys a fresh signature on) instead of green-and-empty, and
# let the EXIT trap clear the debounce stamp so the next trigger retries at once.
workers=0
if [ -n "$events_pid" ]; then
  kill "$events_pid" 2>/dev/null || true
  wait "$events_pid" 2>/dev/null || true
  events_pid=""   # stopped — keep the trap from re-killing a dead pid
  # Stop the fence watcher too (#568) — removing $worker_births below would
  # end it anyway; the kill just makes it prompt.
  if [ -n "$fence_pid" ]; then
    kill "$fence_pid" 2>/dev/null || true
    wait "$fence_pid" 2>/dev/null || true
    fence_pid=""
  fi
  workers="$(grep -cE '^/?sandcastle-' "$worker_births" 2>/dev/null || true)"
  workers="${workers:-0}"
  # Capture the distinct born-worker names BEFORE removing the file (they become
  # finalised processes rows on the healthy path below).
  born_workers="$(grep -oE 'sandcastle-[a-zA-Z0-9_.-]+' "$worker_births" 2>/dev/null | sort -u || true)"
  rm -f "$worker_births"
  if [ "$(worker_wedge "$n" 0 "$workers")" = wedge ]; then
    SWARM_EXIT_REASON="no-worker-spawned"
    verdict_stage "sandcastle run concluded success but spawned NO worker (#435 green wedge)"
    # The #435 answer in swarm.db: the wedge is an UNFINALISED processes row (no
    # end, no events of its own) — a hung agent emits nothing, so the row IS the
    # evidence. `swarm-db.sh open-processes` surfaces it.
    swarmdb_wedge "$run_db_id" "$ready_nums"
    bash "$here/notify-mattermost.sh" ":rotating_light: **Swarm run concluded success but spawned no worker** in \`$repo_slug\` — $n ready task(s) went untouched (#435 green wedge). Failing loud; the debounce stamp is cleared so the next trigger retries."
    exit 1
  fi
  # Healthy run: mirror each born worker as a FINALISED processes row (it spawned
  # and the sandcastle run returned, so it is done) — the contrast that makes an
  # open wedge row legible.
  while read -r wname; do
    [ -n "$wname" ] || continue
    swarmdb proc-open --run "$run_db_id" --kind worker --ref "$wname" \
      --command "sandcastle worker container" --started "$run_started" --ended "$(date +%s)"
  done <<<"$born_workers"
else
  rm -f "$worker_births"
fi
worker_ran=1   # a worker was confirmed born (or docker was unavailable to verify)

# Protected-path boundary — enforce (#445). Fingerprint the machinery again and
# attribute every change under `.sandcastle/`/`.forgejo/` to the workers.
#
# STAGED behind PP_ENFORCE, default OFF: today the ORDINARY swarm still runs
# machinery tickets directly (this very commit is a worker editing `.sandcastle/`),
# so a live rollback would revert exactly that legitimate work. The target model
# routes machinery through the session-gated escape path (worker files a
# `ready-for-session` issue; an interactive session rules it, escalating to
# `ready-for-human` only on a one-way door — ADR 0174) — and
# `.sandcastle/prompt.md` rule 9 already tells workers to route, not edit. The
# flip to PP_ENFORCE=1 is a one-line cutover once ordinary tickets no longer carry
# machinery changes; the library + its tests are the boundary itself and land now.
if [ "${PP_ENFORCE:-0}" = 1 ] && command -v pp_enforce >/dev/null 2>&1; then
  pp_after="$(mktemp -d)"
  pp_snapshot "$PWD" "$pp_after" 2>/dev/null || true
  pp_banner="$(mktemp)"
  if pp_paths="$(pp_enforce "$PWD" "$pp_before" "$pp_after" 2>"$pp_banner")" && [ -z "$pp_paths" ]; then
    : # machinery untouched — the boundary is silent
  else
    # pp_enforce has already ROLLED BACK the worker's protected changes in the
    # working tree. We fail WITHOUT pushing so the breach never reaches main — a
    # human investigates the parked branch (the push ladder below is skipped).
    cat "$pp_banner" >&2   # the loud banner (paths + escape path) into the job log
    verdict_stage "protected-path violation — a worker edited machinery (#445)"
    swarmdb_event "$run_db_id" "" protected-path-violation \
      "worker changed protected machinery — rolled back, run failed" \
      "$(printf '%s' "$pp_paths" | tr '\n' ' ')" 2>/dev/null || true
    rescue="sandcastle/rescue-$(date -u +%Y%m%d-%H%M%S)"
    git push origin "HEAD:refs/heads/$rescue" 2>/dev/null || true
    bash "$here/notify-mattermost.sh" ":rotating_light: **Swarm run RED — protected-path violation** in \`$repo_slug\` (#445). A worker changed machinery that judges its work; it was rolled back and NOT pushed to main. Paths:
$(printf '%s' "$pp_paths" | sed 's/^/- `/; s/$/`/')
The worker must instead file a \`ready-for-session\` issue for any machinery change (escape path — ADR 0174). Commits parked on \`$rescue\` for a human to triage." || true
    rm -f "$pp_banner"
    SWARM_EXIT_REASON="protected-path-violation"
    exit 1
  fi
  rm -f "$pp_banner"
fi

# A human may have pushed to main during the (long) sandcastle run. The
# agent's commits are freshly authored, so rebase-and-retry is safe — and
# necessary: the issues are already closed, so abandoned commits would
# otherwise be silently discarded by the next run's reset --hard. (Agents
# also push per iteration now — prompt step 6 — so this final push is
# usually a no-op; the rebase deduplicates patch-identical commits.)
#
# If the rebase conflicts (STATUS.md's one-line header collides with any
# concurrent edit), hand the mid-rebase checkout to a headless claude —
# merging both sides of a STATUS entry is judgement work a text merge can't
# do. If even that can't land the push, NEVER die with the commits
# stranded: park HEAD on a rescue branch, alert, and fail — a human
# cherry-picks from there. (Run 330 lost three closed-issue commits before
# this ladder existed.)
resolve_rebase_with_claude() {
  command -v claude >/dev/null 2>&1 || return 1
  timeout 900 claude -p --dangerously-skip-permissions \
    "This git checkout is mid-rebase with conflicts. Finish the rebase: resolve every conflicted file preserving BOTH sides' intent — for STATUS.md keep both milestone-log entries (newest first) and merge the one-line header so it reflects the newest state plus any facts only one side carries. Then 'git add' the resolved files and 'GIT_EDITOR=true git rebase --continue'; repeat until the rebase completes. NEVER 'git rebase --abort', never force-push, never delete either side's content." \
    || return 1
  [ ! -e .git/rebase-merge ] && [ ! -e .git/rebase-apply ]
}

opened_prs="" merged_prs=""
if [ "${SWARM_POLICY_LANDING:-push}" = pr ]; then
  # LANDING=pr (#13): land each issue this run touched on its own agent/issue-<N>
  # branch and open/refresh its PR (closes #<N>); a human — or agent-after-green —
  # merges. No push to main here (that would bypass the PR); the rescue ladder
  # below is the push-mode path only. Touched = the pickup set + any #NN scraped
  # from this run's commit subjects (a mid-run close can unblock a child).
  verdict_stage "reconcile landing (pr — branch + PR per issue)"
  # `grep -oE` exits 1 when a commit range has no `#NN` (in pr mode the workers
  # push to their own branches, so this workdir's HEAD gets no new commits and
  # the range is empty). Under `set -euo pipefail` that 1 propagates out of the
  # command substitution and kills the whole reconcile stage with exit=1 before
  # a single PR is reconciled. Guard the scrape with `|| true`, exactly as the
  # sibling `commit_nums=` scrape below already does.
  reconcile_nums="$({ jq -r '.[].number' <<<"$ready";
      git log --format=%s "$start_sha"..HEAD | grep -oE '#[0-9]+' | tr -d '#' || true; } | sort -un)"
  opened_prs="$(landing_reconcile $reconcile_nums || true)"
  # agent-after-green (#15): merge EVERY open agent PR whose required checks are
  # green — including PRs from EARLIER runs that only went green after their own
  # run ended. A no-op under MERGE_AUTHORITY=human.
  merged_prs="$(landing_merge_reconcile || true)"
else
verdict_stage "reconcile push to main"
git push origin HEAD:main || {
  git fetch origin main
  pushed=""
  if git rebase origin/main; then
    git push origin HEAD:main && pushed=1
  elif resolve_rebase_with_claude; then
    git push origin HEAD:main && pushed=1
  fi
  if [ -z "$pushed" ]; then
    git rebase --abort 2>/dev/null || true
    rescue="sandcastle/rescue-$(date -u +%Y%m%d-%H%M%S)"
    git push origin "HEAD:refs/heads/$rescue"
    bash "$here/notify-mattermost.sh" ":rotating_light: **Swarm push failed after issues were closed** in \`$repo_slug\` — commits parked on \`$rescue\`. Cherry-pick them onto main or the work is lost (the issues will NOT retry)."
    SWARM_EXIT_REASON="push-parked-on-rescue"
    exit 1
  fi
}
fi

commits="$(git log --format="- [\`%h\`]($repo_web/commit/%H) %s" "$start_sha"..HEAD)"
summary=":hammer_and_wrench: **Swarm run** in \`$repo_slug\` — $n task(s) picked up."
if [ -n "$commits" ]; then
  summary="$summary
**Commits pushed:**
$commits"
else
  summary="$summary
No commits produced (agent blocked or task left open — see issue comments)."
fi
# LANDING=pr (#13): the PRs opened/refreshed this run, one line each (closes #N).
# In push mode $opened_prs is empty and this section is omitted.
if [ -n "$opened_prs" ]; then
  pr_lines="$(while read -r pnum pr; do
      [ -n "$pr" ] || continue
      printf -- '- [PR #%s](%s/pulls/%s) (closes #%s)\n' "$pr" "$repo_web" "$pr" "$pnum"
    done <<<"$opened_prs")"
  summary="$summary
**PRs opened this run:**
$pr_lines"
fi
# agent-after-green (#15): the open agent PRs this reconcile pass merged / parked,
# one line each. Empty (section omitted) under MERGE_AUTHORITY=human or push mode.
if [ -n "$merged_prs" ]; then
  merge_lines="$(while read -r mnum mres; do
      [ -n "$mnum" ] || continue
      printf -- '- #%s → %s\n' "$mnum" "$mres"
    done <<<"$merged_prs")"
  summary="$summary
**Agent PRs reconciled (merge-if-green):**
$merge_lines"
fi
# Report every issue the run touched: the pickup snapshot PLUS issues shipped
# mid-run (a closed ticket can unblock children the agent picks up in a later
# iteration — they appear in commit subjects as #NN but not in $ready).
commit_nums="$(git log --format=%s "$start_sha"..HEAD | grep -oE '#[0-9]+' | tr -d '#' || true)"
while read -r num; do
  [ -n "$num" ] || continue
  # A commit subject can cite a FOREIGN #NN — a matou-app PR (#54) or an idss
  # issue (#664) referenced in a STATUS line — that does not resolve in THIS
  # repo. `api` is `curl -sf`, so its 404 exits 22 and, under `set -e`, kills
  # the whole reconcile stage AFTER the work is pushed and issues closed (run
  # 70: `#54` 404'd, verdict `reconcile push to main` exit=22). Skip a number
  # this repo cannot resolve rather than red an already-successful run.
  issue="$(api "$FORGEJO_API/issues/$num")" || continue
  state="$(jq -r .state <<<"$issue")"
  title="$(jq -r .title <<<"$issue")"
  labels="$(jq -r '[.labels[].name] | join(", ")' <<<"$issue")"
  issue_url="$(jq -r .html_url <<<"$issue")"
  summary="$summary
- [#$num $title]($issue_url) → **$state**${labels:+ [$labels]}"
done < <({ jq -r '.[].number' <<<"$ready"; printf '%s\n' $commit_nums; } | sort -un)
if [ -n "${RUN_URL:-}" ]; then
  summary="$summary
[Actions run]($RUN_URL)"
fi
bash "$here/notify-mattermost.sh" "$summary"

# Self-rearm (spec D5): a run that did real work and left ready tickets
# behind dispatches its successor instead of waiting for the :15/:45 cron.
# Gated on worker_ran so an empty/coalesced run can never dispatch-loop.
if [ -n "$worker_ran" ] && [ "$(bash "$here/list-ready-tasks.sh" | jq length)" -gt 0 ]; then
  rearm_dispatch && echo "run-swarm: ready tickets remain — dispatched a follow-up run" || true
fi

SWARM_EXIT_REASON="completed"
