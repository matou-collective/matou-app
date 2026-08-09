# Sandcastle Swarm for matou-app (Mattermost-verified) — Design

**Date:** 2026-07-31
**Status:** Approved pending user review
**Repos touched:** `matou-app` (this repo: `.sandcastle/`, `.forgejo/workflows/`, `.claude/skills/triage/`), plus one-time admin on git.matou.nz and Mattermost — nothing changes in the `ourcloud` repo or on the matou-workstation runner.
**Reference implementation:** `/home/benz/Documents/1.projects/ourcloud/.sandcastle/` and `ourcloud/.forgejo/` (design docs: `ourcloud/docs/superpowers/specs/2026-07-21-forgejo-actions-swarm-design.md`, `2026-07-27-self-healing-swarm-design.md`).

## Purpose

Issues filed from the in-app reporter (bugs/improvements from real users) get
picked up and fixed by sandboxed Claude agents — but with a human gate in
front: **no issue is actioned until a human verifies it with a reply in
Mattermost**, and agents ask humans questions through Mattermost mid-task.
Agent work lands as reviewable PRs, never direct pushes to main.

## The two deltas from ourcloud

Everything not listed here follows ourcloud's implementation as-is.

1. **Verification gate.** ourcloud's `/triage` may label an issue
   `ready-for-agent` autonomously. Here it never does: actionable issues get
   `awaiting-verification` + a Mattermost thread, and only a human
   `approve` reply promotes them to `ready-for-agent` (via a new poller).
2. **PR landing.** ourcloud's agent commits to main and closes the issue.
   Here the agent pushes `agent/issue-<n>` and opens a Forgejo PR with
   `closes #<n>`; a human reviews and merges. Merge closes the issue.

## Flow

```
app user files issue (bug/enhancement label, context table in body)
  → triage.yml (issue open + :05/:35 cron): headless /triage
      applies quality/category labels
      actionable → awaiting-verification + Mattermost thread "#<n> <assessment>"
      not actionable → needs-info / ready-for-human / wontfix (as in ourcloud)
  → verify.yml (~10 min cron + dispatch): check-verifications.sh
      reply "approve[ guidance…]" → ready-for-agent label (+ guidance → issue comment)
      reply "reject[ reason…]"   → wontfix + close (+ reason → issue comment)
      other replies              → copied to issue as comment once; stays awaiting
  → swarm.yml (ready-for-agent label event / :15/:45 cron / dispatch):
      run-swarm.sh → Sandcastle Docker sandbox on matou-workstation runner
      agent: read issue+comments → implement → unit tests + lint →
             push agent/issue-<n> → open PR (closes #<n>) → Mattermost notify
  → human reviews PR, merges → issue closes → push-mirror syncs GitLab
```

Mid-task: `ask-human.sh` (ported unchanged) — Mattermost thread Q&A keyed by
`#<issue>`, resumable, ~20 min wait, `ready-for-human` label fallback on
timeout. Failures: healer (full port, `HEAL_DRY_RUN=1`) + Mattermost alert.

## Components

### Ported with light adaptation (repo slug / API path edits only)

From `ourcloud/.sandcastle/`: `main.mts`, `run-swarm.sh`,
`list-ready-tasks.sh`, `run-triage.sh`, `preflight-triage.sh`,
`ask-human.sh`, `notify-mattermost.sh`, `limit-lib.sh`, `sweep-lib.sh`,
`heal.sh`, `heal-lib.sh`, `heal-prompt.md`, `schedule-backstop.sh`,
`.env.example`, `.gitignore`, `tests/` (fake-Mattermost harness + ask-human
scenario tests). From `ourcloud/.forgejo/workflows/`: `triage.yml`,
`swarm.yml`, `healer.yml` (self-configuring from repo context; copied
verbatim per the runner README's add-a-repo checklist). From
`ourcloud/.claude/skills/`: the `/triage` skill, with its ready-for-agent
outcome replaced by `awaiting-verification` (see below). matou-app has no
root `package.json`, so one is created (private, no workspaces) holding only
`@ai-hero/sandcastle` + `tsx` as devDependencies and the
`"sandcastle": "tsx .sandcastle/main.mts"` script, mirroring ourcloud's root.

### Rewritten: `prompt.md`

matou-app issues are user bug reports/improvements with the reporter context
table — not ourcloud's slice manifests. The standing instruction covers:

- Task source: `list-ready-tasks.sh` output is the sole source of truth.
- Read the issue body AND comments first (verification guidance and prior
  human rulings live there), plus `CLAUDE.md` for repo conventions.
- Reproduce bugs where feasible before fixing.
- Verification inside the sandbox: frontend `npm run test:script` +
  `npm run lint`; backend `go build ./...` + `make test` (unit). **Never**
  e2e/integration/Playwright — they need live KERI/any-sync infra the
  sandbox doesn't have; say so in the PR body instead.
- Landing: branch `agent/issue-<n>`, push, open PR via Forgejo API with
  `closes #<n>` in the body, summary of what was verified and what wasn't,
  then `notify-mattermost.sh` with the PR link. Do NOT close the issue, do
  NOT push to main.
- `ask-human.sh` rules identical to ourcloud (at most one ask per issue per
  iteration; check comments for prior rulings first; `ready-for-human`
  fallback on timeout).
- On unresolvable blockers: `agent-blocked` label + explanatory comment
  (human resolves, re-adds `ready-for-agent`).

### New: `check-verifications.sh` + `verify.yml`

`check-verifications.sh` (in `.sandcastle/`), runs on the runner (no
sandbox — it's API-only, like run-triage's Mattermost bits):

1. List open issues labeled `awaiting-verification`.
2. For each, locate its Mattermost verification thread: newest bot post in
   the channel containing `#<n>` and the verification marker (same
   thread-discovery approach as `ask-human.sh`; study its consumed-reply
   bookkeeping at planning time and reuse the mechanism).
3. No thread found (triage crashed mid-post, thread pruned) → post a fresh
   verification thread and move on.
4. Read non-bot thread replies, oldest first, skipping ones already
   consumed:
   - first word `approve` (case-insensitive) → remove
     `awaiting-verification`, add `ready-for-agent` (label event fires
     swarm.yml); remaining reply text (if any) posted as an issue comment
     prefixed `**Verification guidance:**`.
   - first word `reject` → remove `awaiting-verification`, add `wontfix`,
     close the issue; remaining text posted as comment prefixed
     `**Rejected:**`.
   - anything else → posted once as an issue comment prefixed
     `**From Mattermost:**`; issue stays awaiting.
5. Mark processed replies consumed (ask-human's mechanism) so reruns are
   idempotent — a reply must never act twice.

`verify.yml`: cron `*/10 * * * *` + `workflow_dispatch`, runs-on
matou-workstation, env from the same org secrets, healer failure step
(dry-run) like the other workflows.

### New: `Dockerfile`

Sandbox image for the matou-app stack: node 22 (Quasar/Vitest), the Go
toolchain matching `backend/go.mod`, git, curl, jq, make, Claude Code CLI.
No doctl/openssh (no clan-lab here). Modeled on ourcloud's Dockerfile.

### New: `ci.yml`

So agent PRs aren't reviewed blind: on pull_request →
frontend `npm ci && npm run test:script && npm run lint`; backend
`go build ./... && make test`. Runs on matou-workstation. No e2e.

### Labels

ourcloud's canonical set (`needs-triage`, `needs-info`, `ready-for-agent`,
`ready-for-human`, `wontfix`, `no-triage`, `agent-blocked`) **plus
`awaiting-verification`**. `needs-design` is not ported (no design-tier docs
system here). `bug`/`enhancement` already exist.

## One-time admin steps (user-owned, ordered)

1. **Make Forgejo primary:** add `forgejo` remote
   (`git@git.matou.nz:Matou/matou-app.git` or https), push `main` (and the
   open feature branch). Repo Settings → set up **push-mirror → GitLab**
   (needs a GitLab access token) so GitLab tracks Forgejo automatically.
2. Repo Settings → Units: enable **Actions**; enable **issue dependencies**.
3. Create the labels listed above.
4. Confirm org Actions secrets exist (they do — shared with ourcloud):
   `SWARM_FORGEJO_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `MATTERMOST_URL`,
   `MATTERMOST_BOT_TOKEN`, `MATTERMOST_CHANNEL_ID`. Same channel and bot as
   ourcloud. Confirm `SWARM_FORGEJO_TOKEN`'s PAT scopes cover PR creation
   (`write:repository` includes it).
5. Nothing changes on the workstation runner (org-level registration).

## Error handling

- Ambiguous Mattermost replies never change labels — only explicit
  `approve`/`reject` first words act; everything else becomes a comment.
- Poller is idempotent via consumed-reply bookkeeping, and `verify.yml`
  serializes under the same `flock` global-lock pattern the other workflows
  use, so overlapping cron runs cannot double-act.
- Missing verification thread → poller re-posts it rather than stalling.
- Swarm/triage/verify failure → healer investigates in dry-run + posts
  `[dry-run]` report; if the healer itself errors, the raw
  `:rotating_light:` Mattermost fallback fires (ourcloud pattern).
- Claude usage-limit handling (`limit-lib.sh`) ported unchanged — swarm
  pauses quietly instead of hammering.

## Testing

- **Offline scenario tests** (extend ourcloud's `tests/` harness with its
  fake `curl`): `check-verifications.sh` cases — approve promotes + copies
  guidance; reject closes; chatter comments once and stays awaiting; no
  thread → re-post; consumed replies never act twice. Ported ask-human
  tests keep passing.
- **Live smoke, in order:** file a test issue from the app → triage posts
  to Mattermost with `awaiting-verification` → reply `approve` → verify.yml
  promotes it → swarm opens a PR → merge it → confirm GitLab mirror
  updated. One `reject` case too.

## Out of scope (YAGNI)

- Mattermost buttons/slash-commands (reply keywords only)
- Auto-merge of agent PRs; multi-channel routing
- Arming the healer (stays `HEAL_DRY_RUN=1`)
- e2e/integration tests in sandbox or CI
- `needs-design`/wireframe machinery; issue dependency DAGs beyond what
  `list-ready-tasks.sh` already honours
- Backfilling/triaging pre-existing GitLab issues
