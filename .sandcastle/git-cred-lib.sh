#!/usr/bin/env bash
# git-cred-lib.sh — supply the swarm bot's git credential PER INVOCATION,
# without ever writing the token VALUE to disk or argv (#195).
#
# The hazard this closes: the org-wide FORGEJO_TOKEN used to ride inside
# `origin`'s URL — `https://swarm:$FORGEJO_TOKEN@git.matou.nz/<slug>.git` —
# persisted in the `.git/config` of the shared per-repo workdir that every
# worker container bind-mounts, so any worker (`git remote get-url origin`),
# any same-uid host process, or anyone reading host disk recovered the write
# token; the same shape in a push argv was `ps`-visible.
#
# The fix keeps `origin` CREDENTIAL-FREE (`https://git.matou.nz/<slug>.git`)
# and hands git the credential at call time through a one-shot credential
# helper. The helper itself carries NO secret — only a `cat <file>` that is
# evaluated when git runs — so neither `.git/config` nor any argv ever holds
# the token. The helper reads the token at runtime from, first match wins:
#   $SWARM_TOKEN_FILE            — host secrets path, when the harness exports it
#   /run/secrets/forgejo_token   — the sandbox docker secret (the path is
#                                  $SWARM_SANDBOX_TOKEN_FILE, defaulting to it;
#                                  tests point it elsewhere to stay offline)
#   $FORGEJO_TOKEN               — env fallback (tests, already-resolved callers)
# so one seam authenticates in both the sandbox and host-side.
#
# Offline-testable: a credential-free https remote drives git's credential
# machinery, which `git credential fill` exercises without a network
# (tests/git-cred-lib-test.sh, tests/git-setup-test.sh).

# The helper command. A leading `!` makes git run it through the shell with
# the credential operation (get/store/erase) appended as $1; only `get`
# produces output. Single-quoted on purpose: every expansion ($1, the token
# paths, $FORGEJO_TOKEN) is deferred to git-invocation time, so this string is
# a POINTER to the secret, never the secret — safe to persist in config or
# place in argv.
# shellcheck disable=SC2016
GIT_CRED_HELPER='!f(){ [ "$1" = get ] || exit 0; t="${FORGEJO_TOKEN:-}"; for p in "${SWARM_TOKEN_FILE:-}" "${SWARM_SANDBOX_TOKEN_FILE:-/run/secrets/forgejo_token}"; do [ -n "$p" ] && [ -r "$p" ] && { t="$(cat "$p")"; break; }; done; printf "username=swarm\npassword=%s\n" "$t"; }; f'

# git_cred_strip_url <url> — echo <url> with any `user[:pass]@` userinfo
# removed, normalising a URL that still embeds a credential to a
# credential-free remote. A URL with no userinfo, and a non-URL (a local
# fixture path), pass through unchanged.
git_cred_strip_url() {
  case "$1" in
    *://*@*) printf '%s://%s\n' "${1%%://*}" "${1#*://*@}" ;;
    *)       printf '%s\n' "$1" ;;
  esac
}

# git_cred_persist [-C <dir>] — persist the token-free helper into a repo's
# config so EVERY later git invocation in that workdir (a separate process:
# run-swarm's push, landing-lib's rescue ladder, heal_push) authenticates with
# no further wiring. The empty first value resets any inherited (global/system)
# helper so only ours runs; useHttpPath=false scopes the credential to the host.
# Pass `-C <dir>` exactly as git takes it, or nothing to act on the cwd repo.
git_cred_persist() {
  git "$@" config --replace-all credential.helper "" || return 1
  git "$@" config --add credential.helper "$GIT_CRED_HELPER" || return 1
  git "$@" config credential.useHttpPath false || return 1
}

# git_cred_export — export GIT_CONFIG_* env so git in THIS process and its
# children authenticate via the helper WITHOUT touching any `.git/config` and
# WITHOUT the token on argv. For callers that invoke git indirectly (land-pr
# hands the push to landing-lib) or in a checkout they must not persist to.
# Idempotent; preserves nothing of a pre-existing GIT_CONFIG_COUNT on purpose
# (the swarm never sets one otherwise).
git_cred_export() {
  export GIT_CONFIG_COUNT=3
  export GIT_CONFIG_KEY_0=credential.helper   GIT_CONFIG_VALUE_0=""
  export GIT_CONFIG_KEY_1=credential.helper   GIT_CONFIG_VALUE_1="$GIT_CRED_HELPER"
  export GIT_CONFIG_KEY_2=credential.useHttpPath GIT_CONFIG_VALUE_2=false
}
