#!/usr/bin/env bash
# Offline test for git-cred-lib.sh (#195): the swarm bot's git credential is
# supplied PER INVOCATION, never persisted as a token-in-URL in .git/config
# nor placed on argv. No network: a credential-free https remote drives git's
# own credential machinery, which `git credential fill` exercises offline.
# Run: bash tests/git-cred-lib-test.sh
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"
# shellcheck source=../git-cred-lib.sh
. "$here/../git-cred-lib.sh"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

# Point the sandbox secret path at nothing so these offline tests never read
# the real /run/secrets/forgejo_token — token sources are driven deterministically
# through SWARM_TOKEN_FILE / FORGEJO_TOKEN only.
export SWARM_SANDBOX_TOKEN_FILE="$tmp/no-sandbox-secret"

# fill <git-dir-repo> <token-file> — ask git to fill a git.matou.nz https
# credential using whatever helper the repo/env carries, echo its output.
fill() { printf 'protocol=https\nhost=git.matou.nz\n\n' | SWARM_TOKEN_FILE="$2" git -C "$1" credential fill 2>/dev/null; }

# --- 1) git_cred_strip_url removes any embedded credential --------------------
check "a swarm:token@ https URL is stripped to credential-free" \
  '[ "$(git_cred_strip_url "https://swarm:tok12@git.matou.nz/Matou/idss.git")" = "https://git.matou.nz/Matou/idss.git" ]'
check "a bare user@ https URL is stripped too" \
  '[ "$(git_cred_strip_url "https://swarm@git.matou.nz/Matou/idss.git")" = "https://git.matou.nz/Matou/idss.git" ]'
check "an already credential-free URL passes through unchanged" \
  '[ "$(git_cred_strip_url "https://git.matou.nz/Matou/idss.git")" = "https://git.matou.nz/Matou/idss.git" ]'
check "a local fixture path (no scheme) passes through unchanged" \
  '[ "$(git_cred_strip_url "/tmp/x/origin.git")" = "/tmp/x/origin.git" ]'

# --- 2) the helper string itself carries no secret ----------------------------
# It is a POINTER (a `cat <file>`), deferred to git-invocation time — so it is
# safe to persist in config / place in argv. It must embed no token value and
# no `user:pass@host` credential.
check "GIT_CRED_HELPER embeds no @git. credential" \
  '! printf "%s" "$GIT_CRED_HELPER" | grep -q "@git\."'
check "GIT_CRED_HELPER reads the token from a file/env at runtime, not inline" \
  'printf "%s" "$GIT_CRED_HELPER" | grep -q "forgejo_token" && printf "%s" "$GIT_CRED_HELPER" | grep -q "FORGEJO_TOKEN"'

# --- 3) git_cred_persist: a repo authenticates with no token in .git/config ---
repo="$tmp/repo"; git init -q "$repo"
git_cred_persist -C "$repo"
cfg="$repo/.git/config"
check "persisted .git/config carries NO @git. credential" '! grep -q "@git\." "$cfg"'
check "persisted .git/config carries NO raw token" '! grep -q "forgejo_token=\|password=[A-Za-z0-9]" "$cfg"'
check "the credential helper IS configured (the auth seam exists)" \
  '[ -n "$(git -C "$repo" config --local --get-all credential.helper | tail -1)" ]'

tfile="$tmp/tok"; printf 'persist-tok-77' > "$tfile"
out="$(fill "$repo" "$tfile")"
check "fill yields username=swarm via the persisted helper" 'printf "%s" "$out" | grep -qx "username=swarm"'
check "fill yields the token read from the file at call time" 'printf "%s" "$out" | grep -qx "password=persist-tok-77"'

# The reset entry means an inherited global helper does not also fire. Read the
# repo's OWN (--local) list: without the scope flag a global `credential.helper`
# in the runner user's ~/.gitconfig (matou-workstation carries `helper = store`)
# prepends ahead of the repo's reset entry, so head -1 is `store`, not the empty
# reset this assertion is about (#227 — an env leak, git-cred-lib.sh is correct).
check "the helper list begins with an empty reset entry" \
  '[ -z "$(git -C "$repo" config --local --get-all credential.helper | head -1)" ]'

# --- 4) git_cred_export: child git authenticates with nothing persisted -------
repo2="$tmp/repo2"; git init -q "$repo2"
tfile2="$tmp/tok2"; printf 'export-tok-33' > "$tfile2"
out2="$(
  git_cred_export
  printf 'protocol=https\nhost=git.matou.nz\n\n' | SWARM_TOKEN_FILE="$tfile2" git -C "$repo2" credential fill 2>/dev/null
)"
check "exported env makes a fresh repo authenticate as swarm" 'printf "%s" "$out2" | grep -qx "username=swarm"'
check "exported env supplies the file token at call time" 'printf "%s" "$out2" | grep -qx "password=export-tok-33"'
check "git_cred_export left the repo's own .git/config untouched (no helper persisted)" \
  '! git -C "$repo2" config --local --get-all credential.helper >/dev/null 2>&1'

# --- 5) helper precedence: SWARM_TOKEN_FILE beats the env fallback ------------
# (The host override wins over a stale FORGEJO_TOKEN so the two never disagree.)
tfile3="$tmp/tok3"; printf 'file-wins' > "$tfile3"
out3="$(printf 'protocol=https\nhost=git.matou.nz\n\n' | \
  FORGEJO_TOKEN=env-loses SWARM_TOKEN_FILE="$tfile3" git -C "$repo" credential fill 2>/dev/null)"
check "a readable SWARM_TOKEN_FILE wins over FORGEJO_TOKEN" 'printf "%s" "$out3" | grep -qx "password=file-wins"'

out4="$(printf 'protocol=https\nhost=git.matou.nz\n\n' | \
  FORGEJO_TOKEN=env-used SWARM_TOKEN_FILE="$tmp/nope" git -C "$repo" credential fill 2>/dev/null)"
check "with no readable token file, FORGEJO_TOKEN is the fallback" 'printf "%s" "$out4" | grep -qx "password=env-used"'

echo "git-cred-lib: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
