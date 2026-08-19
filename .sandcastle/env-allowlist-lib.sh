#!/usr/bin/env bash
# Preflight allowlist guard (#593, part 1 of #592): sandcastle forwards every
# key .sandcastle/.env declares into the sandbox as a `docker run -e` value,
# which lands in `docker inspect .Config.Env` — readable by anyone with Docker
# API access (the 2026-07-11 breach vector; docs/architecture/07-secrets-
# architecture.md). That's why .env.example holds only CLAUDE_CODE_OAUTH_TOKEN
# (no file-based delivery option) / ANTHROPIC_API_KEY plus non-secret config —
# every other bearer token ships as a read-only file under
# .sandcastle/secrets/ instead (see secrets/README.md). This lib is the
# content check that catches a stray secret-shaped key BEFORE it ships: same
# content-not-existence spirit as preflight-swarm.sh's guard_secrets_content.
# Unit-tested offline by tests/env-allowlist-lib-test.sh.

# Keys .sandcastle/.env is allowed to carry — mirrors .env.example exactly.
ENV_ALLOWLIST_KEYS=(
  CLAUDE_CODE_OAUTH_TOKEN
  ANTHROPIC_API_KEY
  FORGEJO_API
  MATTERMOST_URL
  MATTERMOST_CHANNEL_ID
  BASH_DEFAULT_TIMEOUT_MS
  BASH_MAX_TIMEOUT_MS
  REHEARSAL_DRIVE_ISSUE
  REHEARSAL_DRIVE_TARGET
  SWARM_HOST
  SWARM_RUN_ID
)

# Any key shaped like this needs the read-only-file treatment (like
# forgejo_token/mattermost_bot_token/digitalocean_access_token already get),
# never a docker -e value — unless it's on the allowlist above.
ENV_ALLOWLIST_SECRET_SHAPE_RE='(TOKEN|SECRET|KEY|PASS)'

_env_allowlist_key_allowed() { # _env_allowlist_key_allowed <key>
  local key="$1" allowed
  for allowed in "${ENV_ALLOWLIST_KEYS[@]}"; do
    [ "$key" = "$allowed" ] && return 0
  done
  # REHEARSAL_* is a documented open-ended prefix (.env.example's
  # REHEARSAL_DRIVE_ISSUE/_TARGET today) — trust the prefix so a future
  # REHEARSAL_* config key doesn't need a code change here to stay allowed.
  case "$key" in
    REHEARSAL_*) return 0 ;;
  esac
  return 1
}

# env_allowlist_violations <envfile> — prints one offending KEY per line
# (empty output = clean). A missing file is not a violation — the caller
# already branches on file-existence before deciding whether to check at all.
# Handles blank lines, `#` comments, and `export KEY=value` forms.
env_allowlist_violations() {
  local envfile="$1" line key
  [ -f "$envfile" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*) continue ;;
    esac
    key="${line#export }"
    key="${key%%=*}"
    key="$(printf '%s' "$key" | tr -d '[:space:]')"
    [ -n "$key" ] || continue
    if [[ "$key" =~ $ENV_ALLOWLIST_SECRET_SHAPE_RE ]] && ! _env_allowlist_key_allowed "$key"; then
      printf '%s\n' "$key"
    fi
  done < "$envfile"
}
