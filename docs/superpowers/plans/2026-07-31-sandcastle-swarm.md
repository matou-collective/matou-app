# Sandcastle Swarm for matou-app Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port ourcloud's Sandcastle swarm to matou-app with a Mattermost verification gate (approve/reject by thread reply), PR landing instead of push-to-main, and the full healer in dry-run.

**Architecture:** `.sandcastle/` scripts + `.forgejo/workflows/` running on the shared org-level matou-workstation runner. Triage labels issues `awaiting-verification` and opens a Mattermost thread per issue; a new poller (`check-verifications.sh`, cron) promotes `approve` replies to `ready-for-agent`; the swarm agent (Docker sandbox, `@ai-hero/sandcastle`) implements and opens a PR. Sources are copied from `/home/benz/Documents/1.projects/ourcloud/` and adapted.

**Tech Stack:** bash + curl + jq, `@ai-hero/sandcastle` ^0.12.0 (tsx/TypeScript entry), Docker (node 22 + Go 1.25.5 image), Forgejo Actions, Mattermost REST v4.

**Spec:** `docs/superpowers/specs/2026-07-31-sandcastle-swarm-design.md`
**Reference tree (read-only source of truth for ports):** `/home/benz/Documents/1.projects/ourcloud/` — abbreviated below as `$OC`.

## Global Constraints

- Branch: create `feat/sandcastle-swarm` off `feat/forgejo-issue-reporting` (the spec rides on that branch; it merges first). All commits on the new branch.
- The working tree carries unrelated user WIP — NEVER `git add -A`/`git add .`; stage only the files each task names.
- Repo slug everywhere: `Matou/matou-app` (default `FORGEJO_API=https://git.matou.nz/api/v1/repos/Matou/matou-app`).
- Labels (exact strings): `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`, `no-triage`, `agent-blocked`, `awaiting-verification`, plus existing `bug`/`enhancement`. NO `needs-design` in this repo.
- Verification reply grammar: first word `approve` / `reject`, case-insensitive; anything else is chatter (copied to issue once, never changes labels).
- Agent branch naming: `agent/issue-<n>`. Agent NEVER pushes to main, NEVER closes issues (PR `closes #<n>` does it on merge).
- Sandbox verification commands: frontend `npm run test:script` + `npm run lint` (in `frontend/`), backend `go build ./...` + `make test` (in `backend/`). Never e2e/Playwright/integration.
- Healer: `HEAL_DRY_RUN: "1"` in every workflow hook — never armed by this plan.
- Mattermost thread markers (load-bearing, poller greps them): verification root posts start with `:mag: **Verify #<n>**`; ask-human roots start with `:raising_hand:` (ported, unchanged); bot action confirmations in verification threads start with `:white_check_mark:` / `:speech_balloon:` and embed the processed reply's post id as `` `<post_id>` ``.
- Shell style: `set -euo pipefail`, `bash -n` clean, matching ourcloud's conventions. Workflow YAML must parse (`python3 -c "import yaml,sys; yaml.safe_load(open(...))"`).
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Branch, root package.json, sandcastle scaffolding

**Files:**
- Create: `package.json` (repo root), `.sandcastle/.gitignore`, `.sandcastle/.env.example`, `.sandcastle/main.mts`
- Modify: `.gitignore` (repo root — add `node_modules/` if not already ignored at root level)

**Interfaces:**
- Produces: `npm run sandcastle` (root) → `tsx .sandcastle/main.mts`; main.mts mounts `.sandcastle/secrets` → `/run/secrets`, `.sandcastle/npm-cache` → `/home/agent/.npm`, `.sandcastle/go-cache` → `/home/agent/go/pkg/mod`; agent model `claude-opus-4-8`; `maxIterations: 3`; branchStrategy `merge-to-head`. Tasks 2/6 depend on these mount paths and the script name.

- [ ] **Step 1: Create the branch**

```bash
cd /home/benz/Documents/1.projects/matou-app
git checkout -b feat/sandcastle-swarm feat/forgejo-issue-reporting
```

- [ ] **Step 2: Root package.json**

Create `package.json`:

```json
{
  "name": "matou-app-swarm",
  "private": true,
  "description": "Root harness for the Sandcastle swarm (.sandcastle/). App code lives in frontend/ and backend/.",
  "scripts": {
    "sandcastle": "tsx .sandcastle/main.mts"
  },
  "devDependencies": {
    "@ai-hero/sandcastle": "^0.12.0",
    "tsx": "^4.19.0"
  }
}
```

Check root `.gitignore`: if it doesn't already ignore `node_modules/` at the top level, add a line `node_modules/`.

- [ ] **Step 3: `.sandcastle/.gitignore` and `.env.example`**

`.sandcastle/.gitignore`:

```
.env
secrets/
npm-cache/
go-cache/
logs/
.state/
```

`.sandcastle/.env.example` — copy `$OC/.sandcastle/.env.example`, then:
- Delete the `FORGEJO_API=` default-comment's ourcloud mention (the file has none hardcoded — verify with grep; if the copy is clean, keep as-is).
- Keep `CLAUDE_CODE_OAUTH_TOKEN`, `FORGEJO_API`, `MATTERMOST_URL`, `MATTERMOST_CHANNEL_ID`, `BASH_DEFAULT_TIMEOUT_MS=1500000`, `BASH_MAX_TIMEOUT_MS=1800000` exactly.
- Remove the `DIGITALOCEAN_ACCESS_TOKEN` mention in the trailing comment (no clan-lab here); the comment should list only `FORGEJO_TOKEN, MATTERMOST_BOT_TOKEN` as secrets-file-delivered.

- [ ] **Step 4: `main.mts`**

Create `.sandcastle/main.mts` (adapted from `$OC/.sandcastle/main.mts` — same shape, npm/Go caches instead of pnpm store, no DO token):

```ts
import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

// Loop: pick ready tasks one by one, implement, open a PR per issue.
// Task source: .sandcastle/list-ready-tasks.sh via the shell expression in
// prompt.md. Run with: npm run sandcastle

await run({
  name: "worker",

  // Secrets ride in as read-only files under /run/secrets, not env vars —
  // env vars land in `docker inspect .Config.Env` (ourcloud's 2026-07-11
  // breach vector). run-swarm.sh materializes .sandcastle/secrets/* before
  // every run. CLAUDE_CODE_OAUTH_TOKEN stays an env var (the claude CLI has
  // no file-based option) — documented residual exposure, rotate it.
  sandbox: docker({
    mounts: [
      { hostPath: ".sandcastle/secrets", sandboxPath: "/run/secrets", readonly: true },
      // Persistent caches shared by every worker container.
      { hostPath: ".sandcastle/npm-cache", sandboxPath: "/home/agent/.npm", readonly: false },
      { hostPath: ".sandcastle/go-cache", sandboxPath: "/home/agent/go/pkg/mod", readonly: false },
    ],
  }),

  // opus balances capability against subscription quota for continuous use
  // (ourcloud: fable exhausted the window in ~14h; the limit guard handles
  // it, but opus stretches the window).
  agent: claudeCode("claude-opus-4-8"),

  promptFile: "./.sandcastle/prompt.md",
  maxIterations: 3,
  branchStrategy: { type: "merge-to-head" },

  hooks: {
    sandbox: {
      // Warm the frontend install before the agent starts; CI=true keeps npm
      // non-interactive; `npm ci` enforces the lockfile. Go modules download
      // lazily into the mounted cache during build/test.
      onSandboxReady: [
        { command: "CI=true npm ci --prefix frontend --cache /home/agent/.npm" },
      ],
    },
  },
});
```

- [ ] **Step 5: Verify install + typecheck**

```bash
cd /home/benz/Documents/1.projects/matou-app
npm install
npx tsx --version
node -e "const p=require('./package.json'); if(!p.devDependencies['@ai-hero/sandcastle']) process.exit(1)"
```

Expected: install succeeds, tsx prints a version. (Do not run `npm run sandcastle` — no Docker image yet.)

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .gitignore .sandcastle/.gitignore .sandcastle/.env.example .sandcastle/main.mts
git commit -m "feat(swarm): sandcastle scaffolding — root harness, env manifest, main.mts

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Sandbox Dockerfile

**Files:**
- Create: `.sandcastle/Dockerfile`

**Interfaces:**
- Produces: image with node 22, Go 1.25.5, git/curl/jq/make, Claude Code CLI, user `agent` (UID/GID build-args). Built by `npx sandcastle docker build-image` (Task 6's run-swarm.sh) and reused by Task 7's ci.yml.

- [ ] **Step 1: Write the Dockerfile**

Adapted from `$OC/.sandcastle/Dockerfile` — Go replaces doctl/openssh:

```dockerfile
FROM node:22-bookworm

# System deps. make for backend/Makefile targets.
RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  make \
  && rm -rf /var/lib/apt/lists/*

# Go toolchain matching backend/go.mod (go 1.25.5). bookworm's apt Go is far
# too old — install the official tarball.
RUN curl -sL https://go.dev/dl/go1.25.5.linux-amd64.tar.gz | tar -xz -C /usr/local
ENV PATH="/usr/local/go/bin:$PATH"

# Issue tracker: Forgejo (git.matou.nz/Matou/matou-app) — spoken to with
# plain curl + jq; no tracker CLI to install.

# Build-args for UID/GID alignment: sandcastle docker build-image defaults
# these to the host user's UID/GID so image-built files and bind-mounted
# files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER ${AGENT_UID}:${AGENT_GID}

# Install Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/home/agent/.local/bin:$PATH"

# Go env for the agent user: module cache on the mounted volume.
ENV GOMODCACHE=/home/agent/go/pkg/mod
ENV GOPATH=/home/agent/go

WORKDIR /home/agent

# Sandcastle bind-mounts the worktree at /home/agent/workspace and overrides
# the working directory at container start.
ENTRYPOINT ["sleep", "infinity"]
```

- [ ] **Step 2: Verify it builds**

```bash
cd /home/benz/Documents/1.projects/matou-app
docker build -t matou-sandcastle-smoke -f .sandcastle/Dockerfile .sandcastle
docker run --rm matou-sandcastle-smoke bash -lc 'node --version && go version && claude --version && jq --version && make --version | head -1'
docker rmi matou-sandcastle-smoke
```

Expected: node v22.x, go1.25.5, a claude version, jq + make versions.

- [ ] **Step 3: Commit**

```bash
git add .sandcastle/Dockerfile
git commit -m "feat(swarm): sandbox Dockerfile — node 22 + Go 1.25.5 + Claude CLI

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Port the shared scripts + test harness

**Files:**
- Create (copied from `$OC/.sandcastle/`, edits listed): `notify-mattermost.sh`, `ask-human.sh`, `limit-lib.sh`, `sweep-lib.sh`, `list-ready-tasks.sh`, `preflight-triage.sh`, `schedule-backstop.sh`, `secrets/README.md` (copy `$OC/.sandcastle/secrets/README.md`; if it references DigitalOcean, delete those lines), and the whole `tests/` directory (`fakebin/curl`, `fixtures/`, `test-ask-human.sh`, `resume-parked-asks-test.sh`, `notify-test.sh`, `limit-lib-test.sh`, `sweep-lib-test.sh`, `debounce-test.sh`, `heal-lib-test.sh`, `heal-test.sh`).

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `notify-mattermost.sh "<msg>" [root_id]` → prints created post id; `ask-human.sh "<question>" [timeout]` → exit 0 + reply on stdout / 2 unset / 3 timeout; `list-ready-tasks.sh` → JSON `[{number,title,body,url}]` of `ready-for-agent` issues with deps closed; `preflight-triage.sh` → JSON of untriaged issues. Tasks 4/5/6 call these by exact filename.

- [ ] **Step 1: Copy everything**

```bash
OC=/home/benz/Documents/1.projects/ourcloud
cd /home/benz/Documents/1.projects/matou-app
mkdir -p .sandcastle/tests
for f in notify-mattermost.sh ask-human.sh limit-lib.sh sweep-lib.sh list-ready-tasks.sh preflight-triage.sh schedule-backstop.sh; do
  cp "$OC/.sandcastle/$f" .sandcastle/
done
mkdir -p .sandcastle/secrets && cp "$OC/.sandcastle/secrets/README.md" .sandcastle/secrets/
cp -r "$OC/.sandcastle/tests/." .sandcastle/tests/
```

- [ ] **Step 2: Apply the slug edits (exact, verified by grep)**

The only ourcloud-specific lines in the copied set (confirmed by `grep -rn ourcloud`):

| File | Line content to change |
|---|---|
| `list-ready-tasks.sh` | `: "${FORGEJO_API:=https://git.matou.nz/api/v1/repos/Matou/ourcloud}"` → `.../Matou/matou-app}` |
| `preflight-triage.sh` | same default → `.../Matou/matou-app}` |
| `schedule-backstop.sh` | same default → `.../Matou/matou-app}` |
| `tests/resume-parked-asks-test.sh` | `export FORGEJO_API="http://fj.test/api/v1/repos/Matou/ourcloud"` → `.../Matou/matou-app"` |

Then one behavioral edit in `preflight-triage.sh`: the jq filter that excludes issues already carrying a triage outcome label (`ready-for-agent`, `ready-for-human`, `needs-info`, `wontfix`, `no-triage`, `agent-blocked`, `needs-design`…) must ALSO exclude `awaiting-verification` — a triaged-but-unverified issue must not be re-triaged. Add `or . == "awaiting-verification"` to that `any(...)` chain (read the file; the chain is in the `untriaged=` jq program). `needs-design` may remain in the exclusion list (harmless — the label simply never exists here).

After edits: `grep -rn ourcloud .sandcastle/` → only hits allowed are none (empty).

- [ ] **Step 3: Run the ported test suite**

```bash
cd /home/benz/Documents/1.projects/matou-app/.sandcastle/tests
for t in test-ask-human.sh resume-parked-asks-test.sh notify-test.sh limit-lib-test.sh sweep-lib-test.sh debounce-test.sh; do
  echo "== $t"; bash "$t" || exit 1
done
```

Expected: all pass. (`heal-lib-test.sh`/`heal-test.sh` need Task 6's heal files — do NOT run them yet; note this in the report.) `debounce-test.sh` exercises run-swarm's debounce block — if it sources `run-swarm.sh` (read it to check), defer it to Task 6 alongside the heal tests and say so in the report.

- [ ] **Step 4: Commit**

```bash
git add .sandcastle/notify-mattermost.sh .sandcastle/ask-human.sh .sandcastle/limit-lib.sh .sandcastle/sweep-lib.sh .sandcastle/list-ready-tasks.sh .sandcastle/preflight-triage.sh .sandcastle/schedule-backstop.sh .sandcastle/secrets/README.md .sandcastle/tests
git commit -m "feat(swarm): port shared sandcastle scripts and offline test harness

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: run-triage.sh with the verification gate

**Files:**
- Create: `.sandcastle/run-triage.sh` (copy of `$OC/.sandcastle/run-triage.sh` + edits below)

**Interfaces:**
- Consumes: `preflight-triage.sh`, `notify-mattermost.sh` (Task 3).
- Produces: after `/triage`, every issue newly labeled `awaiting-verification` gets its own Mattermost ROOT post beginning exactly `:mag: **Verify #<n>**` (Task 5's poller greps this marker). Grouped "triage needs you" post retained for `ready-for-human` only.

- [ ] **Step 1: Copy and edit the headless instruction**

`cp $OC/.sandcastle/run-triage.sh .sandcastle/run-triage.sh`, then replace the `timeout 2700 claude -p "/triage ..."` instruction string with:

```bash
timeout 2700 claude -p "/triage You are running headless in CI: no human can answer questions, so never ask any. Every untriaged issue must leave this run carrying a triage label. This repo has a HUMAN VERIFICATION GATE: never apply the ready-for-agent label — where the ourcloud-style flow would mark an issue ready-for-agent, apply awaiting-verification instead and post a comment summarizing your assessment (what the issue asks, whether it is reproducible/actionable, suggested approach). A human promotes it to ready-for-agent via Mattermost. When you hit ambiguity or a judgement call, label the issue ready-for-human (or needs-info if the reporter must supply missing information) and post a comment explaining what needs deciding." --dangerously-skip-permissions
```

- [ ] **Step 2: Edit the gate-tracking block**

In the copied file, `human_gated()` loops `for label in ready-for-human needs-design` — change to `for label in ready-for-human` (no needs-design here).

After the existing "new human-gated" Mattermost block, add verification-thread posting. Insert a before/after snapshot around the claude call (the file already snapshots `before="$(human_gated)"` / `after=...` — mirror that pattern):

```bash
# Snapshot awaiting-verification BEFORE the claude call (add next to before=):
await_before="$(api "$FORGEJO_API/issues?state=open&type=issues&labels=awaiting-verification&limit=50" | jq -r '.[].number' | sort -u)"
```

```bash
# After the claude call (add next to after=):
await_after="$(api "$FORGEJO_API/issues?state=open&type=issues&labels=awaiting-verification&limit=50" | jq -r '.[].number' | sort -u)"

# One verification thread per newly-gated issue — the poller
# (check-verifications.sh) keys on the ':mag: **Verify #N**' marker.
new_await="$(comm -13 <(printf '%s\n' "$await_before") <(printf '%s\n' "$await_after"))"
for num in $new_await; do
  [ -n "$num" ] || continue
  issue="$(api "$FORGEJO_API/issues/$num")"
  title="$(jq -r .title <<<"$issue")"
  url="$(jq -r .html_url <<<"$issue")"
  body_excerpt="$(jq -r '.body // ""' <<<"$issue" | head -c 500)"
  bash "$here/notify-mattermost.sh" ":mag: **Verify #$num** — $title
$url

$body_excerpt

Reply **approve** (optionally followed by guidance for the agent) or **reject** (optionally a reason) in this thread. Anything else is copied to the issue as a comment." || true
done
```

(Keep pagination simple — 50 open awaiting-verification issues per snapshot is far beyond realistic volume; note the cap in a comment.)

- [ ] **Step 3: Verify**

```bash
bash -n .sandcastle/run-triage.sh
grep -c "awaiting-verification" .sandcastle/run-triage.sh   # expect >= 3
grep -n "ready-for-agent" .sandcastle/run-triage.sh          # only inside the instruction string ("never apply")
```

- [ ] **Step 4: Commit**

```bash
git add .sandcastle/run-triage.sh
git commit -m "feat(swarm): triage with awaiting-verification gate + per-issue verify threads

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: check-verifications.sh (the poller) — TDD

**Files:**
- Create: `.sandcastle/check-verifications.sh`
- Test: `.sandcastle/tests/check-verifications-test.sh`

**Interfaces:**
- Consumes: Mattermost REST v4 (same endpoints ask-human.sh uses: `/users/me`, `/channels/<id>/posts?per_page=200`, `/posts/<id>/thread`, `POST /posts`), Forgejo API (`/issues?...labels=awaiting-verification`, `PUT/DELETE .../labels`, `POST .../comments`, `PATCH /issues/<n>`), `notify-mattermost.sh`.
- Produces: idempotent poller run by Task 7's `verify.yml`. Exit 0 always unless config/API hard-fails.

**Behavior contract (drives the tests):**

For each open issue labeled `awaiting-verification`:
1. Find its verification thread: newest bot ROOT post (root_id == "", not deleted) whose message starts with `:mag:` and contains `#<n>` followed by a non-digit/end (same `test($key + "([^0-9]|$)")` guard ask-human.sh uses).
2. No thread → post a fresh `:mag: **Verify #<n>**` root (same format as Task 4) and continue to the next issue.
3. Fetch the thread. For each NON-BOT reply, oldest first, whose post id is NOT embedded in any bot post in the thread (consumption check: bot posts containing `` `<post_id>` ``):
   - First word `approve` (case-insensitive): remove `awaiting-verification`, add `ready-for-agent`; if the reply has text beyond the keyword, POST it as an issue comment prefixed `**Verification guidance:**`; reply in-thread `:white_check_mark: Approved — #<n> is now ready-for-agent. (`<post_id>`)`; stop processing this thread (the issue left the awaiting set).
   - First word `reject`: remove `awaiting-verification`, add `wontfix`, `PATCH` state closed; remainder → comment prefixed `**Rejected:**`; reply `:white_check_mark: Rejected — #<n> closed as wontfix. (`<post_id>`)`; stop.
   - Otherwise: POST reply text as issue comment prefixed `**From Mattermost:**`; reply `:speech_balloon: Copied to the issue. (`<post_id>`)`; continue with further replies.
4. Label ops use the Forgejo label API by NAME→id: fetch `/labels` once per run, map `awaiting-verification`/`ready-for-agent`/`wontfix` names to ids (`DELETE /issues/<n>/labels/<id>`, `POST /issues/<n>/labels {"labels":[<id>]}`).
5. Missing Mattermost env → print to stderr, exit 0 (same convention as notify-mattermost.sh). Missing FORGEJO_TOKEN → `: "${FORGEJO_TOKEN:?}"` hard fail.

- [ ] **Step 1: Write the failing test**

Create `.sandcastle/tests/check-verifications-test.sh` following the ported harness conventions — read `.sandcastle/tests/test-ask-human.sh` and `.sandcastle/tests/fakebin/curl` FIRST and reuse their fake-endpoint mechanism (PATH-prepended fake `curl` serving canned JSON per URL, with a request log the assertions grep). Scenarios (each an isolated case with its own canned responses; assert via the fake's request log):

```
S1 approve-promotes: one awaiting issue #7; thread has human reply "approve".
   Assert: DELETE label awaiting-verification id, POST label ready-for-agent id,
   NO comment POST, thread reply contains ':white_check_mark:' and '`<reply_id>`'.
S2 approve-with-guidance: reply "approve check the dark theme too".
   Assert: label swap AND issue comment POST whose body contains
   '**Verification guidance:** check the dark theme too'.
S3 reject-closes: reply "reject duplicate of #3".
   Assert: DELETE awaiting label, POST wontfix label, PATCH state=closed,
   comment contains '**Rejected:** duplicate of #3'.
S4 chatter-copied-once: reply "hmm can you add a screenshot?" and a bot
   ':speech_balloon: … `<that_id>`' already in thread.
   Assert: NO label ops, NO comment POST (already consumed).
S5 chatter-fresh: same reply, no bot confirmation.
   Assert: comment POST contains '**From Mattermost:**', thread reply posted,
   NO label ops.
S6 no-thread-reposts: awaiting issue #9, channel has no ':mag:' post matching #9.
   Assert: a POST /posts whose message starts ':mag: **Verify #9**'; no label ops.
S7 idempotent-rerun: run twice over S1's state where the fake reflects the
   first run's confirmations. Assert: second run performs zero label ops.
```

- [ ] **Step 2: Run to verify failure**

`bash .sandcastle/tests/check-verifications-test.sh` — expected: FAIL (script missing).

- [ ] **Step 3: Implement**

Write `.sandcastle/check-verifications.sh` per the behavior contract. Skeleton (flesh out following ask-human.sh's exact `api()`, `post()`, bot-id, and jq idioms — copy those helper patterns verbatim rather than inventing new ones):

```bash
#!/usr/bin/env bash
# Promote awaiting-verification issues per Mattermost thread replies.
# approve → ready-for-agent; reject → wontfix+closed; chatter → issue comment.
# Idempotent: every processed reply id is embedded in a bot thread post.
# Env: FORGEJO_TOKEN, FORGEJO_API, MATTERMOST_URL/MATTERMOST_BOT_TOKEN/
#      MATTERMOST_CHANNEL_ID (unset → log and exit 0).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${FORGEJO_TOKEN:?}"
: "${FORGEJO_API:=https://git.matou.nz/api/v1/repos/Matou/matou-app}"
# … Mattermost env check (exit 0 path), fapi()/mapi() helpers, bot_id,
# label name→id map, channel scan, per-issue thread discovery, per-reply
# consumption loop per the contract above …
```

Requirements the tests pin: first-word parsing is `word="$(awk '{print tolower($1)}' <<<"$reply")"`; remainder is the reply with the first word stripped and whitespace-trimmed; consumption grep is `` fixed-string `<post_id>` `` over bot posts of the thread.

- [ ] **Step 4: Run tests to green**

`bash .sandcastle/tests/check-verifications-test.sh` — all scenarios pass. Also `bash -n .sandcastle/check-verifications.sh`.

- [ ] **Step 5: Commit**

```bash
git add .sandcastle/check-verifications.sh .sandcastle/tests/check-verifications-test.sh
git commit -m "feat(swarm): Mattermost verification poller — approve/reject/chatter, idempotent

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: run-swarm.sh (PR mode), prompt.md, healer files

**Files:**
- Create: `.sandcastle/run-swarm.sh` (copy `$OC/.sandcastle/run-swarm.sh` + edits), `.sandcastle/prompt.md` (full rewrite below), `.sandcastle/heal.sh` + `.sandcastle/heal-lib.sh` + `.sandcastle/heal-prompt.md` (copies + slug edits)

**Interfaces:**
- Consumes: Tasks 1-5 artifacts by filename.
- Produces: `run-swarm.sh` posts pickup + summary (PRs opened) to Mattermost, never pushes main; `prompt.md` is the sandbox agent's standing instruction; heal trio used by every workflow's failure hook.

- [ ] **Step 1: run-swarm.sh — copy then apply five edits**

`cp $OC/.sandcastle/run-swarm.sh .sandcastle/run-swarm.sh`, then:

1. **pnpm store → npm/go caches.** Replace the `mkdir -p "$here/pnpm-store"` line (and its comment) with:
```bash
# Persistent sandbox caches (main.mts mounts them).
mkdir -p "$here/npm-cache" "$here/go-cache"
```
2. **Secrets set.** Delete the `write_secret digitalocean_access_token …` line (no DO here). Keep forgejo_token + mattermost_bot_token.
3. **Harness install.** Replace the `pnpm install --frozen-lockfile` + `pnpm exec sandcastle docker build-image` pair (and the pnpm-only comment above them) with:
```bash
# Root harness only (sandcastle + tsx) — app deps install inside the sandbox.
npm ci
npx sandcastle docker build-image   # fast no-op after first build (layer cache)
```
   and change `pnpm run sandcastle` in the limit-guard block to `npm run sandcastle`.
4. **Delete the push-to-main ladder.** Remove everything from the comment block beginning `# A human may have pushed to main during the (long) sandcastle run.` through the end of the `git push origin HEAD:main || { … }` compound (including `resolve_rebase_with_claude()`). Agents push their own `agent/issue-<n>` branches and open PRs from inside the sandbox; the host repo's merged HEAD is deliberately NOT pushed. Keep `start_sha` (delete it only if nothing else references it after edit 5 — check).
5. **Summary reports PRs, not commits.** Replace the summary construction between the deleted ladder and the final `notify-mattermost.sh "$summary"` call (the `commits=`/`commit_nums` section) with:
```bash
# Report PRs the agents opened this run: open PRs on agent/issue-* branches
# updated since the run started.
prs="$(api "$FORGEJO_API/pulls?state=open&limit=50" |
  jq -r --argjson since "$(( run_start_epoch * 1000 ))" \
    '.[] | select((.head.ref | startswith("agent/issue-")) and ((.updated_at | fromdateiso8601 * 1000) >= $since))
     | "- [#\(.number) \(.title)](\(.html_url)) ← `\(.head.ref)`"')"
summary=":hammer_and_wrench: **Swarm run** in \`$repo_slug\` — $n task(s) picked up."
if [ -n "$prs" ]; then
  summary="$summary
**PRs opened/updated (review + merge to land):**
$prs"
else
  summary="$summary
No PRs produced (agent blocked or task left open — see issue comments)."
fi
if [ -n "${RUN_URL:-}" ]; then
  summary="$summary
[Actions run]($RUN_URL)"
fi
```
   and add `run_start_epoch="$(date +%s)"` next to the (kept or removed) `start_sha` line before the sandcastle invocation. Delete `start_sha` if now unreferenced.

Then run the deferred harness tests from Task 3: `bash .sandcastle/tests/debounce-test.sh` (if deferred) — expected pass; if it asserts on pnpm/push-ladder text that no longer exists, update the test's expectations to the npm/PR-mode equivalents and say so in the report.

- [ ] **Step 2: prompt.md — full rewrite**

Create `.sandcastle/prompt.md` with exactly this content:

````markdown
# Context

## Ready tasks

!`bash .sandcastle/list-ready-tasks.sh`

The list above holds only issues that are `ready-for-agent` (human-verified
via Mattermost) with every Forgejo dependency closed. It is the sole source
of truth for what work exists. Do not run your own unfiltered query — if the
list is empty, there is nothing to do.

## Recent agent PRs (last 10)

!`git log --oneline --grep="agent:" -10`

# Task

You are a Sandcastle agent fixing **one issue** of the Matou app per
iteration. Issues are bug reports and improvement requests filed by real
app users from an in-app reporter; each carries a context table (app
version, platform, environment, reporter). Pick the first task in the list
above.

To see a task in full:

    curl -sf -H "Authorization: token $(cat /run/secrets/forgejo_token)" "$FORGEJO_API/issues/<NUMBER>"

## Read first

- The issue body **and its comments**
  (`$FORGEJO_API/issues/<NUMBER>/comments`) — verification guidance from the
  human gate and prior blocked-run rulings live there. A human may already
  have answered the question you're about to hit.
- `CLAUDE.md` at the repo root — project structure, commands, conventions.
- The relevant app code: `frontend/` (Quasar/Vue + Electron) and `backend/`
  (Go). Follow existing patterns; match surrounding style.

## Rules

1. **One issue per iteration.** Do not touch other issues' territory.
2. **Reproduce before fixing** where feasible: for frontend logic bugs write
   a failing Vitest test first; for backend bugs a failing Go test. If the
   bug can't be reproduced without live infrastructure, say so in the PR
   body and reason from the code.
3. **Verification inside this sandbox** — run what you changed:
   - frontend: `cd frontend && npm run test:script && npm run lint`
   - backend: `cd backend && go build ./... && make test`
   **Never** run e2e/Playwright/integration suites — they need live
   KERI/any-sync infrastructure this sandbox does not have. State in the PR
   body what you verified and what needs live testing.
4. **Ask a human when the issue's `needs_human_decision` moment arrives** —
   ambiguity about intent, UX judgement, scope. First check the issue
   comments for a prior ruling; otherwise run
   `bash .sandcastle/ask-human.sh "Question about #<NUMBER>: <question>"`
   (at most once per issue per iteration; give the Bash tool a 25-minute
   timeout). If it times out (exit 3): swap the issue's label
   `ready-for-agent` → `ready-for-human`, comment what you need, and stop
   working this issue.
5. **Land as a PR — never push main, never close the issue.**
   - branch: `git checkout -b agent/issue-<NUMBER>`
   - commit(s): conventional style, subject prefixed `agent:`, referencing
     `#<NUMBER>`
   - push: `git push "https://swarm:$(cat /run/secrets/forgejo_token)@git.matou.nz/Matou/matou-app.git" HEAD:refs/heads/agent/issue-<NUMBER>`
   - open the PR:

         curl -sf -X POST -H "Authorization: token $(cat /run/secrets/forgejo_token)" \
           -H 'Content-Type: application/json' \
           -d '{"title":"<concise title> (#<NUMBER>)","head":"agent/issue-<NUMBER>","base":"main","body":"closes #<NUMBER>\n\n<what changed>\n\n**Verified in sandbox:** <commands run>\n**Needs live verification:** <or None>"}' \
           "$FORGEJO_API/pulls"

   - notify: `bash .sandcastle/notify-mattermost.sh ":package: PR ready for review: <PR html_url> (fixes #<NUMBER>)"`
6. **Blocked with no human answer?** Label the issue `agent-blocked`, comment
   exactly what's blocking, and move on. A human resolves it and re-adds
   `ready-for-agent`.
7. **Stay in scope.** Fix what the issue reports. No drive-by refactors, no
   dependency changes unless the fix requires one — and a dependency change
   ships its lockfile update (`package-lock.json` / `go.sum`) in the same
   commit.
````

- [ ] **Step 3: Healer trio**

```bash
cp $OC/.sandcastle/heal.sh $OC/.sandcastle/heal-lib.sh $OC/.sandcastle/heal-prompt.md .sandcastle/
```

Edits (the only ourcloud references, verified by grep):
- `heal.sh`: `: "${FORGEJO_API:=https://git.matou.nz/api/v1/repos/Matou/ourcloud}"` → `.../Matou/matou-app}`; `WORKDIR="${HEAL_WORKDIR:-$HOME/swarm/Matou/ourcloud}"` → `.../Matou/matou-app}`.
- `heal-prompt.md`: three `Matou/ourcloud` / `~/swarm/Matou/ourcloud` mentions → `Matou/matou-app` equivalents.

Run the deferred heal tests: `bash .sandcastle/tests/heal-lib-test.sh && bash .sandcastle/tests/heal-test.sh` — expected pass (they use the fake harness; if a fixture hardcodes the ourcloud slug, update the fixture and note it).

- [ ] **Step 4: Verify**

```bash
bash -n .sandcastle/run-swarm.sh .sandcastle/heal.sh .sandcastle/heal-lib.sh .sandcastle/check-verifications.sh
grep -rn "ourcloud\|pnpm" .sandcastle/*.sh .sandcastle/*.md .sandcastle/*.mts | grep -v tests/   # expect: no hits
grep -n "push origin HEAD:main" .sandcastle/run-swarm.sh   # expect: no hits
```

- [ ] **Step 5: Commit**

```bash
git add .sandcastle/run-swarm.sh .sandcastle/prompt.md .sandcastle/heal.sh .sandcastle/heal-lib.sh .sandcastle/heal-prompt.md .sandcastle/tests
git commit -m "feat(swarm): PR-mode run-swarm, matou-app agent prompt, healer port

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Workflows — triage, swarm, verify, healer, ci

**Files:**
- Create: `.forgejo/workflows/triage.yml`, `.forgejo/workflows/swarm.yml`, `.forgejo/workflows/healer.yml` (copies of `$OC/.forgejo/workflows/*` — they self-configure from `${{ github.repository }}`; copy verbatim, then strip the ourcloud-history comment blocks at the top of each `on:` section if they reference specific ourcloud dates/incidents — keep the "pushing this file re-registers the schedule" warning, it's operationally load-bearing), `.forgejo/workflows/verify.yml`, `.forgejo/workflows/ci.yml` (new, below)

**Interfaces:**
- Consumes: `.sandcastle/run-triage.sh`, `run-swarm.sh`, `check-verifications.sh`, `heal.sh`, `Dockerfile` by path.
- Produces: the complete automation surface. All use `runs-on: matou-workstation`, org secrets, the `/tmp/matou-swarm.lock` flock, and the dry-run healer failure hook.

- [ ] **Step 1: Copy the four ported workflows**

```bash
mkdir -p .forgejo/workflows
cp $OC/.forgejo/workflows/triage.yml $OC/.forgejo/workflows/swarm.yml $OC/.forgejo/workflows/healer.yml $OC/.forgejo/workflows/resume-asks.yml .forgejo/workflows/
```

`resume-asks.yml` runs `.sandcastle/resume-parked-asks.sh` (ported in Task 3) on its own cron — it is the "resume sweep" that ask-human.sh's timeout message promises (records late Mattermost replies on the issue and re-adds `ready-for-agent`). Check it for `ourcloud` literals like the others; it should be self-configuring.

They contain no `ourcloud` literals (verified) — `${{ github.repository }}` self-configures. Trim ourcloud-incident comment paragraphs as noted above. Do not change crons (`5,35`/`15,45`/`0 * * * *`), the flock, the debounce-relevant `if:` guard on swarm's label events, or `HEAL_DRY_RUN: "1"`.

- [ ] **Step 2: verify.yml**

Create `.forgejo/workflows/verify.yml`:

```yaml
name: verify
on:
  schedule:
    - cron: "*/10 * * * *"
  workflow_dispatch: {}

jobs:
  verify:
    runs-on: matou-workstation
    timeout-minutes: 20
    steps:
      - name: Check Mattermost verifications under global lock
        env:
          FORGEJO_TOKEN: ${{ secrets.SWARM_FORGEJO_TOKEN }}
          FORGEJO_API: ${{ github.server_url }}/api/v1/repos/${{ github.repository }}
          REPO_SLUG: ${{ github.repository }}
          MATTERMOST_URL: ${{ secrets.MATTERMOST_URL }}
          MATTERMOST_BOT_TOKEN: ${{ secrets.MATTERMOST_BOT_TOKEN }}
          MATTERMOST_CHANNEL_ID: ${{ secrets.MATTERMOST_CHANNEL_ID }}
        run: |
          set -euo pipefail
          exec 9>/tmp/matou-swarm.lock
          # Non-blocking: a long swarm run can hold the lock for hours — a
          # poller should skip quietly and let the next cron tick retry, not
          # go red every 10 minutes.
          flock -n 9 || { echo "verify: swarm lock busy — skipping this tick"; exit 0; }
          workdir="$HOME/swarm/$REPO_SLUG"
          mkdir -p "$workdir"
          cd "$workdir"
          url="https://swarm:${FORGEJO_TOKEN}@git.matou.nz/${REPO_SLUG}.git"
          if [ -d .git ]; then
            git remote set-url origin "$url"
            git fetch origin main
            git checkout -f main
            git reset --hard origin/main
          else
            git clone "$url" .
          fi
          bash .sandcastle/check-verifications.sh
      - name: Investigate failure (healer)
        if: failure()
        env:
          FORGEJO_TOKEN: ${{ secrets.SWARM_FORGEJO_TOKEN }}
          FORGEJO_API: ${{ github.server_url }}/api/v1/repos/${{ github.repository }}
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          MATTERMOST_URL: ${{ secrets.MATTERMOST_URL }}
          MATTERMOST_BOT_TOKEN: ${{ secrets.MATTERMOST_BOT_TOKEN }}
          MATTERMOST_CHANNEL_ID: ${{ secrets.MATTERMOST_CHANNEL_ID }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_number }}
          WORKFLOW: verify
          HEAL_DRY_RUN: "1"
        run: |
          bash "$HOME/swarm/${{ github.repository }}/.sandcastle/heal.sh" || {
            [ -z "$MATTERMOST_BOT_TOKEN" ] && exit 0
            jq -n --arg channel_id "$MATTERMOST_CHANNEL_ID" --arg message ":rotating_light: verify failed AND the healer errored in \`${{ github.repository }}\` — $RUN_URL" '{channel_id: $channel_id, message: $message}' |
              curl -sf -X POST -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" -H 'Content-Type: application/json' -d @- "$MATTERMOST_URL/api/v4/posts" || true
          }
```

- [ ] **Step 3: ci.yml**

The runner is host-mode with no node/Go guaranteed on PATH (ourcloud uses nix; matou-app has no flake) — run the checks inside the sandbox image instead, reusing `.sandcastle/Dockerfile`:

```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request: {}
  workflow_dispatch: {}

jobs:
  checks:
    runs-on: matou-workstation
    timeout-minutes: 45
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Frontend + backend checks in the sandbox image
        run: |
          set -euo pipefail
          docker build -t matou-app-ci -f .sandcastle/Dockerfile .sandcastle
          # --entrypoint bash is required: the image's ENTRYPOINT is
          # ["sleep","infinity"], and args to `docker run` APPEND to an
          # entrypoint rather than replace it — without the override the
          # checks never execute.
          docker run --rm --entrypoint bash -v "$PWD":/work -w /work matou-app-ci -lc '
            set -euo pipefail
            cd frontend && CI=true npm ci && npm run test:script && npm run lint && cd ..
            cd backend && go build ./... && make test
          '
      - name: Investigate failure (healer)
        if: failure()
        env:
          FORGEJO_TOKEN: ${{ secrets.SWARM_FORGEJO_TOKEN }}
          FORGEJO_API: ${{ github.server_url }}/api/v1/repos/${{ github.repository }}
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          MATTERMOST_URL: ${{ secrets.MATTERMOST_URL }}
          MATTERMOST_BOT_TOKEN: ${{ secrets.MATTERMOST_BOT_TOKEN }}
          MATTERMOST_CHANNEL_ID: ${{ secrets.MATTERMOST_CHANNEL_ID }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_number }}
          WORKFLOW: ci
          HEAL_DRY_RUN: "1"
        run: |
          bash .sandcastle/heal.sh || {
            [ -z "$MATTERMOST_BOT_TOKEN" ] && exit 0
            jq -n --arg channel_id "$MATTERMOST_CHANNEL_ID" --arg message ":rotating_light: ci failed AND the healer errored in \`${{ github.repository }}\` — $RUN_URL" '{channel_id: $channel_id, message: $message}' |
              curl -sf -X POST -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" -H 'Content-Type: application/json' -d @- "$MATTERMOST_URL/api/v4/posts" || true
          }
```

- [ ] **Step 4: Verify all five parse**

```bash
for f in .forgejo/workflows/*.yml; do python3 -c "import yaml,sys; yaml.safe_load(open('$f')); print('OK $f')"; done
grep -rn "ourcloud" .forgejo/   # expect: no hits
grep -c 'HEAL_DRY_RUN: "1"' .forgejo/workflows/*.yml   # every workflow with a heal hook
```

- [ ] **Step 5: Commit**

```bash
git add .forgejo/workflows
git commit -m "feat(swarm): forgejo workflows — triage, swarm, verify poller, healer watchdog, ci

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: README + admin runbook

**Files:**
- Create: `.sandcastle/README.md` (adapted from `$OC/.sandcastle/README.md`), `docs/swarm-setup.md`

**Interfaces:** documentation only.

- [ ] **Step 1: `.sandcastle/README.md`**

Copy ourcloud's and rewrite the deltas: repo slug `Matou/matou-app`; the task-list filter section keeps its dependency-DAG explanation but drops the slice-map mention; add a **Verification gate** section (triage → `awaiting-verification` → `:mag:` thread → `approve`/`reject` → poller → `ready-for-agent`; `check-verifications.sh` + `verify.yml`); PR-landing section (agent/issue-N branches, `closes #N`, human merges); remove clan-lab/doctl sections; healer section stays with `HEAL_DRY_RUN` note; automated-runs section lists all five workflows.

- [ ] **Step 2: `docs/swarm-setup.md`** — the one-time admin checklist, verbatim from the spec's "One-time admin steps" section (Forgejo primary + push-mirror→GitLab with a GitLab token, enable Actions unit + issue dependencies, create the label set incl. `awaiting-verification`, confirm the five org secrets, runner untouched), plus the live-smoke script from the spec's Testing section and the standing note that labels created after config-server start need a config-server restart is NOT relevant here (that's the issue-reporter's proxy — don't copy it in).

- [ ] **Step 3: Commit**

```bash
git add .sandcastle/README.md docs/swarm-setup.md
git commit -m "docs(swarm): sandcastle README + one-time setup runbook

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Live verification (blocked on admin steps + merged branch)

**Files:** none — verification only. **BLOCKED-ON-USER** until: the issue-reporter branch and this branch are merged to main, main is pushed to Forgejo (primary), push-mirror + Actions + labels + issue-dependencies are set up per `docs/swarm-setup.md`.

- [ ] **Step 1:** Confirm workflows registered: repo → Actions tab lists triage/swarm/verify/healer/ci after the push to main.
- [ ] **Step 2:** File a small real test issue from the app (e.g. "[TEST] swarm e2e — cosmetic typo fix request"). Watch triage run (issue-open trigger): issue gains `awaiting-verification` + assessment comment; `:mag: **Verify #N**` thread appears in Mattermost.
- [ ] **Step 3:** Reply `approve keep the diff minimal` in the thread. Within ~10 min verify.yml promotes: label flips to `ready-for-agent`, guidance lands as an issue comment, `:white_check_mark:` confirmation in thread.
- [ ] **Step 4:** Swarm fires on the label event: pickup post in Mattermost → agent works → PR appears on `agent/issue-<n>` with `closes #<n>` + sandbox-verification notes → `:package:` PR notify. ci.yml runs green on the PR.
- [ ] **Step 5:** Review + merge the PR. Issue closes; GitLab mirror shows the merge commit.
- [ ] **Step 6:** File a second test issue; reply `reject just testing` — verify wontfix + closed + `**Rejected:**` comment.
- [ ] **Step 7:** Record outcomes (including any flakes) in the SDD ledger; clean up test issues/PR branches.
