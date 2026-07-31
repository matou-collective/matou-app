# 07 — Sandcastle secrets: files, not env vars

**What it answers:** why the sandcastle swarm's bearer tokens (`FORGEJO_TOKEN`,
`MATTERMOST_BOT_TOKEN`) ship into the sandbox as read-only file mounts under
`/run/secrets` instead of `docker run -e` environment variables, why
`CLAUDE_CODE_OAUTH_TOKEN` is the one exception, and how to rotate.

## The breach vector

Sandcastle forwards every key declared in `.sandcastle/.env` into the sandbox
container as a `docker run -e KEY=value` argument. Docker records the full
process environment of every container in `docker inspect .Config.Env` —
readable by anyone with access to the Docker API (or `docker inspect` on the
host), not just the process itself. On 2026-07-11 this was the actual vector
a token leaked through. An env var is effectively as exposed as a
world-readable file the moment it lands in a container's launch args.

## The fix: bind-mounted files

`main.mts` bind-mounts `.sandcastle/secrets/` (host) to `/run/secrets/`
(sandbox, read-only) instead of forwarding those tokens as `-e` values. Each
consumer script (`list-ready-tasks.sh`, `preflight-triage.sh`, `ask-human.sh`,
`notify-mattermost.sh`, `check-verifications.sh`, `schedule-backstop.sh`)
reads its token from the environment first and falls back to the matching
`/run/secrets/<name>` file — so the same script works identically on the host
(env var or `.env`) and in CI (Actions secrets materialized to files by
`run-swarm.sh`/`verify.yml` at the start of every run).

| File | Consumed by |
| --- | --- |
| `.sandcastle/secrets/forgejo_token` | `list-ready-tasks.sh`, `preflight-triage.sh`, `check-verifications.sh`, `schedule-backstop.sh`, `prompt.md`'s example curl commands |
| `.sandcastle/secrets/mattermost_bot_token` | `ask-human.sh`, `notify-mattermost.sh`, `check-verifications.sh` |

Every file under `.sandcastle/secrets/` except its `README.md` is
git-ignored — the secret values themselves are never committed. In CI,
`run-swarm.sh` and `verify.yml` materialize both files from that process's
own environment (Forgejo org Actions secrets) at the start of every run, so
a rotated org secret takes effect on the very next run with nothing to do.
For a manual host run, an operator writes the files directly rather than
putting values in `.sandcastle/.env` (`.sandcastle/secrets/README.md` has
the exact `install` commands).

## The residual exception: `CLAUDE_CODE_OAUTH_TOKEN`

`CLAUDE_CODE_OAUTH_TOKEN` stays in `.sandcastle/.env` (and thus as a
`docker run -e` value) because the `claude` CLI has no file-based flag for
supplying it — there is no `/run/secrets`-compatible option to move it to.
This is a documented, accepted residual exposure, not an oversight.

## Rotation guidance

- **`FORGEJO_TOKEN` / `MATTERMOST_BOT_TOKEN`:** rotate the org Actions secret
  (`SWARM_FORGEJO_TOKEN`, `MATTERMOST_BOT_TOKEN`) — the next scheduled or
  triggered workflow run materializes the new value into
  `.sandcastle/secrets/` automatically. No file to touch by hand in CI.
- **`CLAUDE_CODE_OAUTH_TOKEN`:** rotate more readily than the file-mounted
  tokens given its wider exposure surface — regenerate with
  `claude setup-token` (or a fresh Anthropic API key) and update the
  `CLAUDE_CODE_OAUTH_TOKEN` org Actions secret.
- **Manual host runs:** re-run the `install -m 0600 …` commands in
  `.sandcastle/secrets/README.md` with the new value; `chmod 600` keeps the
  file owner-readable only.
