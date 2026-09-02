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
(sandbox, read-only) instead of forwarding those tokens as `-e` values.
Sandbox-side consumer scripts (`list-ready-tasks.sh`, `preflight-triage.sh`,
`ask-human.sh`, `notify-mattermost.sh`, `schedule-backstop.sh`) read their
token from the environment first and fall back to the matching
`/run/secrets/<name>` file — so the same script works identically on the
host (env var or `.env`) and in CI (Actions secrets materialized to files by
`run-swarm.sh` at the start of every run).

| File | Consumed by |
| --- | --- |
| `.sandcastle/secrets/forgejo_token` | `list-ready-tasks.sh`, `preflight-triage.sh`, `schedule-backstop.sh`, `prompt.md`'s example curl commands |
| `.sandcastle/secrets/mattermost_bot_token` | `ask-human.sh`, `notify-mattermost.sh`, `check-verifications.sh` |

`check-verifications.sh` is the one asymmetric case: it hard-requires
`FORGEJO_TOKEN` as an env var (`: "${FORGEJO_TOKEN:?}"`, no `/run/secrets`
fallback) but *does* fall back to `/run/secrets/mattermost_bot_token` for the
Mattermost side. That's because `verify.yml` runs it directly on the runner
host — never inside the Sandcastle sandbox — with `FORGEJO_TOKEN` supplied
straight from the `SWARM_FORGEJO_TOKEN` Actions secret as a workflow env var;
there's no secrets-mount in that path for the Forgejo token to fall back to.

Every file under `.sandcastle/secrets/` except its `README.md` is
git-ignored — the secret values themselves are never committed. In CI,
`run-swarm.sh` materializes both files from that process's own environment
(Forgejo org Actions secrets) at the start of every `swarm.yml` run, so a
rotated org secret takes effect on the very next run with nothing to do.
`verify.yml` doesn't materialize either file — it passes `FORGEJO_TOKEN` and
`MATTERMOST_BOT_TOKEN` straight into `check-verifications.sh`'s process
environment as workflow env vars, which is why that script can hard-require
`FORGEJO_TOKEN` and never needs the `/run/secrets` fallback it does have for
the Mattermost token. For a manual host run, an operator writes the files
directly rather than putting values in `.sandcastle/.env`
(`.sandcastle/secrets/README.md` has the exact `install` commands).

## The residual exception: `CLAUDE_CODE_OAUTH_TOKEN`

`CLAUDE_CODE_OAUTH_TOKEN` stays in `.sandcastle/.env` (and thus as a
`docker run -e` value) because the `claude` CLI has no file-based flag for
supplying it — there is no `/run/secrets`-compatible option to move it to.
This is a documented, accepted residual exposure, not an oversight.

## Push-relay FCM credential (deployment secret)

The push-relay service (`backend/cmd/push-relay`, design doc
`08-push-notifications.md` topology C, slice 2 of #177) introduces one new
secret: the **Google service-account JSON** that lets the relay send FCM
messages. Per that design's §3 the relay is the *single* holder of this
credential — it exists in exactly one place, never on member devices and never
embedded in the app.

The credential obeys the same **files, not env vars** doctrine as the tokens
above. The relay reads it from a path, never from an inlined env value:

| Secret | Delivered as | Consumed by | Needed if |
| --- | --- | --- | --- |
| FCM service-account JSON | a mounted file referenced by `MATOU_PUSH_RELAY_FCM_CREDENTIALS` (the file *path*, not the JSON) | `push-relay` at startup (`NewFCMClient`) | push notifications are deployed |

Inlining the JSON into an env var would reintroduce exactly the
`docker inspect .Config.Env` exposure this document exists to close, so the
relay takes only a path. The relay also holds the `AID → device-token` map
(push plumbing, not an identity registry — design §2); that map is *not* a
secret but is enrolled here because it is state the relay persists alongside
the credential.

Rotation: reissue the service-account key in the Firebase console, replace the
mounted file, restart the relay. `MATOU_PUSH_RELAY_FCM_DISABLED=1` runs the
relay with dispatch stubbed out (no credential needed) for dev/dry-run.

Hosting the relay and provisioning this credential are human decisions tracked
on #177 (§10 Q1) — this entry only reserves the secret's place in the
inventory.

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
