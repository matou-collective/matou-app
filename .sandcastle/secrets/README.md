# .sandcastle/secrets/

Bearer tokens for the sandcastle sandbox, delivered as read-only files
(`main.mts`'s `mounts:` config) instead of `docker run -e` values. Env vars
land in `docker inspect .Config.Env`, readable by anyone with Docker API
access — see `docs/architecture/07-secrets-architecture.md` and the
2026-07-11 breach it documents. `CLAUDE_CODE_OAUTH_TOKEN` is the one
exception: it has no file-based flag in the `claude` CLI, so it still ships
via `.sandcastle/.env`.

Every file in this directory except this README is git-ignored — the
secret files themselves are never committed.

## Files

| File | Consumed by |
| --- | --- |
| `forgejo_token` | `list-ready-tasks.sh`, `preflight-triage.sh`, `prompt.md`'s example curl commands |
| `mattermost_bot_token` | `ask-human.sh`, `notify-mattermost.sh` |

## Populating it

`run-swarm.sh` materializes these files from its own process env (which CI
sets from Forgejo org Actions secrets) at the start of every run — nothing
to do for the CI path.

For a manual host run, write the files yourself instead of putting values in
`.sandcastle/.env`:

```sh
install -m 0600 /dev/stdin .sandcastle/secrets/forgejo_token <<< "$FORGEJO_TOKEN"
install -m 0600 /dev/stdin .sandcastle/secrets/mattermost_bot_token <<< "$MATTERMOST_BOT_TOKEN"
```

Any file can be omitted — each consumer only fails if it actually needs the
token that's missing.
