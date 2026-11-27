#!/usr/bin/env bash
# Guard (#246): no harness file ever writes a token into a git remote URL.
#
# The hazard #195 closed: the org-wide FORGEJO_TOKEN used to ride inside
# `origin`'s URL — `https://swarm:<token>@git.matou.nz/<slug>.git` — which
# persisted in the `.git/config` every worker container bind-mounts, so any
# worker (`git remote get-url origin`), any same-uid host process, or anyone
# reading host disk recovered the write token. #195 made every remote
# credential-free and moved auth to a per-invocation credential helper
# (git-cred-lib.sh). The #237 worker still saw a credentialed `origin` only
# because the running self-copy's pin PREDATED #195 (resolved by the #222
# re-vendor); the harness source itself was already clean.
#
# This test is the standing proof that it STAYS clean: it scans the harness
# surface for the forbidden shape — a URL whose userinfo carries a credential
# (a `user:pass@` password component, or a `$VAR@` shell expansion) — and fails
# if any NON-COMMENT line reintroduces it. A credential-free `https://host/slug`
# (no userinfo), a bare `user@host` (no secret), and an scp-style
# `git@host:path` (no `://`) are all allowed.
#
# It is vendored (tests/** in onboarding/vendor-manifest), so a consumer
# re-runs it over its OWN byte-identical harness AND its own rendered
# `.forgejo/workflows/*.yml` per-repo layer — the surfaces where a regression
# could land. Offline: pure text scan, no network, no git.
# Run: bash tests/no-token-in-git-url-test.sh
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"
root="$(cd "$here/.." && pwd)"

# The forbidden shape. Anchored on `://` so an scp-style `git@host:path` (which
# carries no secret) never matches; the userinfo span forbids `/` (so a match
# stays inside the authority) and whitespace, and must contain a `:` (password
# separator) or `$` (an expansion like $FORGEJO_TOKEN) before the `@`.
CRED_URL_RE='://[^/[:space:]]*[:$][^/@[:space:]]*@'

# cred_url_hits <file> — print `<lineno>:<line>` for each line that embeds a
# credential in a URL, EXCEPT a full-line comment (first non-blank char `#` or
# `//`). The hazard is quoted verbatim in the header of git-cred-lib.sh that
# explains the fix; documenting the old shape is not committing it, and the
# park-wiring guard draws the same line (a comment that merely NAMES a hazard
# must not red the thing it warns against). An inline/trailing comment is left
# in scope on purpose — conservative, and no harness line writes one.
cred_url_hits() {
  grep -nE "$CRED_URL_RE" "$1" 2>/dev/null | grep -vE '^[0-9]+:[[:space:]]*(#|//)'
}

# --- 1) the matcher itself: it flags credentialed URLs in code, not comments --
fx="$(tmpdir)/fixture"
cat >"$fx" <<'FIX'
url="https://swarm:$FORGEJO_TOKEN@git.matou.nz/x/y.git"
git remote set-url origin "https://swarm:abc123@git.matou.nz/x/y.git"
git clone "https://git.matou.nz/x/y.git" .
git remote set-url origin "https://git.matou.nz/x/y.git"
remote=git@git.matou.nz:x/y.git
# `https://swarm:$FORGEJO_TOKEN@git.matou.nz/x/y.git` — the old hazard, in prose
    // https://swarm:tok@git.matou.nz/x/y.git documented in a code comment
FIX
hits="$(cred_url_hits "$fx")"
check "flags a token interpolated into a remote URL" \
  'printf "%s" "$hits" | grep -q "^1:"'
check "flags a literal credential in a set-url" \
  'printf "%s" "$hits" | grep -q "^2:"'
check "allows a credential-free clone" \
  '! printf "%s" "$hits" | grep -q "^3:"'
check "allows a credential-free set-url" \
  '! printf "%s" "$hits" | grep -q "^4:"'
check "allows an scp-style git@host:path (no ://, no secret)" \
  '! printf "%s" "$hits" | grep -q "^5:"'
check "exempts a '#' comment that documents the old hazard" \
  '! printf "%s" "$hits" | grep -q "^6:"'
check "exempts a '//' comment that documents the old hazard" \
  '! printf "%s" "$hits" | grep -q "^7:"'

# --- 2) the real scan: no harness file embeds a credential in a URL -----------
# Scan the surfaces that write git remotes and reach a consumer byte-identical
# (root shell + .mts) or as the consumer's own per-repo layer (workflow YAMLs).
# Factory-only dirs (onboarding/, templates) are scanned WHEN PRESENT; a glob
# that matches nothing is skipped. Test files are NOT scanned — they build
# credentialed URLs on purpose to prove the harness scrubs them.
targets=()
for f in "$root"/*.sh "$root"/*.mts "$root"/onboarding/*.sh; do
  [ -f "$f" ] && targets+=("$f")
done
for d in "$root/.forgejo/workflows" "$root/onboarding/templates/workflows"; do
  [ -d "$d" ] || continue
  for f in "$d"/*.yml "$d"/*.yaml "$d"/*.tmpl; do
    [ -f "$f" ] && targets+=("$f")
  done
done

scanned=0
for f in ${targets[@]+"${targets[@]}"}; do
  scanned=$((scanned + 1))
  v="$(cred_url_hits "$f")"
  rel="${f#"$root"/}"
  check "$rel writes no token into a git remote URL${v:+ — offending: $v}" '[ -z "$v" ]'
done

# A target list that silently shrank to nothing would make every check above
# vacuous — the "reads green because it read nothing" failure (park-wiring's
# rc 2). The harness always carries root shell scripts, so this is never 0.
check "the harness surface was actually scanned (got $scanned files)" \
  '[ "$scanned" -gt 0 ]'

summary no-token-in-git-url
