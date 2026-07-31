# Sandcastle execution config

Sandcastle (**installed** — `@ai-hero/sandcastle`, dev-dependency in the
repo-root `package.json`) orchestrates sandboxed coding agents: `main.mts`
calls `run()`, which boots a Docker sandbox from `Dockerfile`, injects
`prompt.md` (with its shell expressions evaluated fresh each iteration), and
loops until the ready-task list is empty or `maxIterations` is hit. Design:
`../docs/superpowers/specs/2026-07-31-sandcastle-swarm-design.md`. One-time
admin setup (Forgejo primary, push-mirror, labels, secrets): `../docs/swarm-setup.md`.

Issues here are **not** slice-map tasks: they're bug reports and improvement
requests filed by real app users through the in-app reporter, each carrying a
context table (app version, platform, environment, reporter). Every issue
also passes a **human verification gate** in Mattermost before an agent ever
touches it — see below.

## Run it

```
npm run sandcastle         # = npx tsx .sandcastle/main.mts
```

Prerequisites: Docker running; the image built
(`npx sandcastle docker build-image`); `.sandcastle/.env` filled in
(`CLAUDE_CODE_OAUTH_TOKEN`) and, for a manual host run, the bearer tokens
written to `.sandcastle/secrets/` per `secrets/README.md` — see
`../docs/architecture/07-secrets-architecture.md` for why those ride as file
mounts instead of `.env` values.

## Files

- `main.mts` — the orchestration entry point (loop config: model, sandbox,
  branch strategy, iterations, mounts).
- `prompt.md` — the standing instruction given to the agent each iteration.
  Its `` !`…` `` shell expressions run **inside the sandbox** before each
  iteration; the ready-task list is injected this way.
- `list-ready-tasks.sh` — the task source (see below).
- `preflight-triage.sh` — the untriaged-issue source for `run-triage.sh`.
- `ask-human.sh` — mid-task human-in-the-loop: posts a `needs_human_decision`
  question to Mattermost and waits (default 20 min) for a **direct thread
  reply** — channel chatter never counts as an answer. Asks are resumable,
  keyed by the `#<issue>` in the question text: a re-ask scans the open
  (unconsumed) questions for the same issue newest-first — a human reply in
  ANY of them is returned immediately (so late answers in whichever
  duplicate thread survive), otherwise it resumes the newest thread with an
  :eyes: note instead of posting a duplicate. On timeout the agent falls
  back to the `ready-for-human` label swap (prompt.md rule 6). Requires the
  bot to be a member of the channel.
- `resume-parked-asks.sh` — the other half of ask-human's parking promise: a
  cron sweep (`.forgejo/workflows/resume-asks.yml`, twice an hour) that scans
  every `ready-for-human` issue's unconsumed ask threads for a late human
  reply, records the reply on the issue as the durable ruling, and re-arms
  `ready-for-agent` (the label event fires the swarm). Without it a late
  thread reply was never read — a parked issue is off the frontier, so no
  "next ask" could ever run (the 2026-07-31 #203 incident).
- `check-verifications.sh` — the verification-gate poller; see below.
- `notify-mattermost.sh` — posts a markdown message to Mattermost as the
  swarm bot; every workflow uses it for pickup/summary/failure notices.
- `limit-lib.sh` / `sweep-lib.sh` — shared helpers: Claude usage-limit
  detection (pauses the swarm quietly instead of alerting on every queued
  run) and post-run worktree/branch cleanup.
- `heal.sh` / `heal-lib.sh` / `heal-prompt.md` — the healer, see below.
- `schedule-backstop.sh` — dispatches a workflow via the Forgejo API when its
  own registered schedule hasn't fired it inside a given window. A backstop
  for Forgejo's per-repo schedule rows silently going dead (observed
  upstream, no config change, healthy runner) — it only ever fills a gap,
  never double-fires a healthy schedule. Install as a **system cron** on the
  runner (outside Forgejo Actions, since its whole point is to work when
  Forgejo's own scheduler doesn't):

  ```cron
  # matou-app schedule backstop — dispatches only if Forgejo's own
  # schedule missed its window; requires FORGEJO_TOKEN exported or
  # .sandcastle/secrets/forgejo_token populated (see secrets/README.md).
  */5 * * * * cd /path/to/matou-app && bash .sandcastle/schedule-backstop.sh triage.yml 40
  */5 * * * * cd /path/to/matou-app && bash .sandcastle/schedule-backstop.sh swarm.yml 40
  */5 * * * * cd /path/to/matou-app && bash .sandcastle/schedule-backstop.sh resume-asks.yml 40
  */5 * * * * cd /path/to/matou-app && bash .sandcastle/schedule-backstop.sh verify.yml 20
  */10 * * * * cd /path/to/matou-app && bash .sandcastle/schedule-backstop.sh healer.yml 90
  ```

  Windows are roughly 1.5–2× each workflow's own cron interval, giving
  Forgejo room to fire normally before the backstop dispatches on top of it.
- `Dockerfile` — the sandbox image: node 22, the Go toolchain matching
  `backend/go.mod`, git, curl, jq, make, Claude Code CLI. No doctl/openssh —
  this repo has no clan-lab spike tasks.
- `.env` (git-ignored, from `.env.example`) — Sandcastle forwards every key
  listed there into the sandbox as a `docker run -e` value: only
  `CLAUDE_CODE_OAUTH_TOKEN` and non-secret config (`FORGEJO_API`,
  `MATTERMOST_URL`/`MATTERMOST_CHANNEL_ID`, Bash tool timeouts) belong here.
  `FORGEJO_TOKEN` and `MATTERMOST_BOT_TOKEN` are **not** in `.env` — they
  ship as read-only files under `/run/secrets` instead (`secrets/README.md`,
  `../docs/architecture/07-secrets-architecture.md`).
- `tests/` — offline scenario tests for these scripts (fake Mattermost/Forgejo
  via `tests/fakebin/curl`; no network): `test-ask-human.sh`,
  `resume-parked-asks-test.sh`, `check-verifications-test.sh`,
  `notify-test.sh`, `limit-lib-test.sh`, `sweep-lib-test.sh`,
  `debounce-test.sh`, `heal-lib-test.sh`, `heal-test.sh`. Run the relevant one
  directly after touching its script.

## The task-list filter (the load-bearing bit)

The prompt must surface **only** issues that are both `ready-for-agent` **and**
have every `depends_on` closed, so the swarm can't grab an issue whose
dependencies are unfinished. `list-ready-tasks.sh` implements this:
`depends_on` links live as **native Forgejo issue dependencies**
(`enable_issue_dependencies` is on for `Matou/matou-app`), and the script
drops any `ready-for-agent` issue with an open "blocked by" link. Output is a
JSON array of `{number, title, body, url}`; an empty array = done. Runs
identically on the host (sourcing `.env` itself) and in the sandbox (env
forwarded by Sandcastle, or read from `/run/secrets/forgejo_token`).

## Verification gate

No issue reaches the swarm without a human saying so first:

```
issue opened → triage.yml: headless /triage
    actionable → awaiting-verification + Mattermost thread ":mag: **Verify #<n>**"
    not actionable → needs-info / ready-for-human / wontfix
  → verify.yml (~10 min cron): check-verifications.sh reads the thread
      "approve[ guidance…]" → ready-for-agent (guidance → issue comment)
      "reject[ reason…]"    → wontfix + closed (reason → issue comment)
      anything else          → copied to the issue as a comment once, stays awaiting
  → swarm.yml (ready-for-agent label event / cron): agent picks it up
```

`check-verifications.sh` scans the Mattermost channel once per run for the
newest bot post matching `#<n>`, reads non-bot replies oldest-first, and
marks each processed reply consumed (its post id embedded in a bot
confirmation) so a rerun never acts on the same reply twice. A missing
thread is re-posted rather than stalling the issue. `/triage` never applies
`ready-for-agent` itself in this repo — that label is verify.yml's alone to
grant.

## PR landing

Agents never push to `main` or close the issue they're fixing. Per
`prompt.md` rule 5: branch `agent/issue-<n>`, push it, open a Forgejo PR with
`closes #<n>` in the body plus a summary of what was verified in-sandbox
(unit tests + lint only — never e2e/integration, which need live
KERI/any-sync infra) and what still needs live testing. A human reviews and
merges; the merge closes the issue and the push-mirror carries it to GitLab.

## The healer

`heal.sh` is a deterministic orchestrator around one headless Claude
investigation, wired as a `failure()` step on `triage.yml`/`swarm.yml`/
`verify.yml`/`ci.yml` and as an hourly sweep in
`.forgejo/workflows/healer.yml`. `heal-prompt.md` is the standing
instruction handed to that investigation. Incidents are deduped and
rate-limited through a small ledger under `.sandcastle/.state/healer/`,
keyed by a signature of the workflow + error line, so a recurring failure
gets one thread reply instead of a fresh page each time. Every hook and the
watchdog currently carry `HEAL_DRY_RUN: "1"` (five workflow files) — the
healer only diagnoses and posts `[dry-run]`-prefixed reports, it makes no
commits, pushes, or tickets; arming it means deleting those five
`HEAL_DRY_RUN` lines. Never edit `heal.sh` (or `heal-prompt.md`/
`heal-lib.sh`) via the healer itself — a self-modifying healer is exactly
the recursion the design forbids, which is also why `healer.yml` carries no
failure hook of its own.

## Automated runs (Forgejo Actions)

Five workflows on the `matou-workstation` runner run the swarm loop
end-to-end — no laptop required:

- `triage.yml` — issue open + `:05/:35` cron: headless `/triage`, routes to
  `awaiting-verification` (or a human gate) — never straight to
  `ready-for-agent`.
- `verify.yml` — `:10` cron: `check-verifications.sh`, the gate above.
- `swarm.yml` — `ready-for-agent` label event + `:15/:45` cron: `run-swarm.sh`
  runs Sandcastle in Docker, opens PRs.
- `resume-asks.yml` — `:10/:40` cron: `resume-parked-asks.sh`, re-arms issues
  with a late Mattermost reply.
- `healer.yml` — hourly cron: the watchdog sweep above.

A sixth workflow, `ci.yml`, runs on every PR and push to `main` (frontend
`npm ci && npm run test:script && npm run lint`; backend
`go build ./... && make test`, both inside the sandbox image) so agent PRs
aren't reviewed blind — it's part of code review, not the swarm loop.

Secrets arrive as org-level Actions secrets (no `.env` on the runner;
`run-swarm.sh`/`verify.yml` materialize `.sandcastle/secrets/*` from process
env at the start of every run). The Mattermost bot posts on every pickup,
verification thread, and swarm summary. `triage.yml`/`swarm.yml`/`verify.yml`
serialize under a shared `flock` (`/tmp/matou-swarm.lock`) so overlapping
runs can't race the same checkout; `resume-asks.yml` uses its own workdir to
avoid contending for that lock.
