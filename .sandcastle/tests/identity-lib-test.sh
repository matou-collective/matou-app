#!/usr/bin/env bash
# Offline tests for identity-lib.sh — the contract seam between the vendored
# harness and the consumer-owned swarm-identity.sh (#31). #19 made the harness
# call swarm_git_identity (defined in the vendor-EXCLUDED identity file); a pin
# bump reached a consumer's harness scripts without touching their identity file,
# so an OLD file made every session-runner tick die on `command not found`. This
# lib turns that silent seam LOUD: swarm-identity.sh stamps
# SWARM_IDENTITY_CONTRACT, the harness declares IDENTITY_CONTRACT, and
# identity_require refuses an older stamp. Pure environment, no network, no
# docker. Run: bash .sandcastle/tests/identity-lib-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sc="$here/.."
fail() { echo "FAIL: $1" >&2; exit 1; }

# require <stamp> <slug> — source identity-lib.sh in a clean env with the given
# SWARM_IDENTITY_CONTRACT stamp (empty = unset) and REPO_SLUG, run
# identity_require, echo "<rc>|<stderr>".
require() { # require <stamp-or-empty> <slug-or-empty>
  local stamp="$1" slug="$2"
  env -u SWARM_IDENTITY_CONTRACT -u REPO_SLUG \
    bash -c '
      [ -n "$1" ] && SWARM_IDENTITY_CONTRACT="$1"
      [ -n "$2" ] && REPO_SLUG="$2"
      . "'"$sc"'/identity-lib.sh"
      err="$(identity_require 2>&1 1>/dev/null)"; rc=$?
      printf "%s|%s\n" "$rc" "$err"' _ "$stamp" "$slug"
}

# 1: the harness declares its required contract.
out="$(bash -c '. "'"$sc"'/identity-lib.sh"; echo $IDENTITY_CONTRACT')"
[ "$out" = 1 ] || fail "IDENTITY_CONTRACT should be 1 (swarm_git_identity), got: $out"
echo "ok 1 IDENTITY_CONTRACT declared"

# 2: a stamp AT the required contract passes silently (rc 0, no message).
out="$(require 1 Acme/widget)"
[ "$out" = "0|" ] || fail "contract 1 vs need 1 should pass silently, got: $out"
echo "ok 2 stamp at contract passes"

# 3: a stamp AHEAD of the required contract passes (a newer identity layer than
#    this harness needs is fine — forward compatible).
out="$(require 5 Acme/widget)"
[ "$out" = "0|" ] || fail "contract 5 vs need 1 should pass, got: $out"
echo "ok 3 stamp ahead of contract passes"

# 4: an ABSENT stamp (the pre-#19 identity layer — the real #31 outage) fails
#    rc 2 and names the exact regenerate command with the repo slug.
out="$(require '' Acme/widget)"
[ "${out%%|*}" = 2 ] || fail "an absent stamp must return 2, got: $out"
grep -q "swarm-identity.sh is contract 0, this harness needs 1" <<<"$out" \
  || fail "the message must name have=0/need=1, got: $out"
grep -q "re-run: onboard.sh identity Acme/widget .sandcastle/swarm-identity.sh" <<<"$out" \
  || fail "the message must name the regenerate command with the slug, got: $out"
echo "ok 4 absent stamp fails loud, names the fix"

# 5: a non-numeric stamp is treated as 0 (a garbage/hand-edited value never
#    passes as a high contract).
out="$(require garbage Acme/widget)"
[ "${out%%|*}" = 2 ] || fail "a non-numeric stamp must be treated as behind, got: $out"
grep -q "is contract 0," <<<"$out" || fail "a non-numeric stamp folds to 0, got: $out"
echo "ok 5 non-numeric stamp folds to 0"

# 6: no REPO_SLUG in the env — the message falls back to <owner/repo>, never a
#    product literal.
out="$(require '' '')"
grep -q "onboard.sh identity <owner/repo> .sandcastle/swarm-identity.sh" <<<"$out" \
  || fail "an unset slug must read <owner/repo>, got: $out"
echo "ok 6 unset slug falls back to <owner/repo>"

# 7: an explicit higher need argument fails a currently-satisfying stamp — this
#    is how a FUTURE symbol bump refuses today's identity file.
out="$(env -u SWARM_IDENTITY_CONTRACT bash -c '
  SWARM_IDENTITY_CONTRACT=1; REPO_SLUG=Acme/widget
  . "'"$sc"'/identity-lib.sh"
  err="$(identity_require 2 2>&1 1>/dev/null)"; rc=$?
  printf "%s|%s\n" "$rc" "$err"')"
[ "${out%%|*}" = 2 ] || fail "need 2 vs have 1 must return 2, got: $out"
grep -q "is contract 1, this harness needs 2" <<<"$out" || fail "explicit need must be honoured, got: $out"
echo "ok 7 explicit need argument refuses an older stamp"

# 8: the real swarm-identity.sh stamps a contract that SATISFIES the harness —
#    the two files ship in lockstep, so the factory's own tick never trips.
out="$(env -u SWARM_IDENTITY_CONTRACT -u REPO_SLUG -u FORGEJO_API bash -c '
  . "'"$sc"'/swarm-identity.sh"
  . "'"$sc"'/identity-lib.sh"
  identity_require && echo ok')"
[ "$out" = ok ] || fail "the shipped swarm-identity.sh must satisfy the shipped IDENTITY_CONTRACT, got: $out"
echo "ok 8 shipped identity file satisfies the shipped contract"

# 9: identity_apply — the IDENTITY seam of run-swarm.sh (#2) in one call. It
#    stamps the four GIT_* vars from the ONE place that owns them, and keeps the
#    belt-to-the-braces `command -v` guard at the call site so #19's exact
#    failure (a caller reaching swarm_git_identity that the consumer's identity
#    file does not define) is refused TWICE, not once.
out="$(env -u SWARM_IDENTITY_CONTRACT -u REPO_SLUG -u FORGEJO_API bash -c '
  . "'"$sc"'/swarm-identity.sh"
  . "'"$sc"'/identity-lib.sh"
  identity_apply worker || exit 9
  printf "%s|%s|%s\n" "${GIT_AUTHOR_NAME:-}" "${GIT_COMMITTER_NAME:-}" "${GIT_AUTHOR_EMAIL:-}"')"
[ -n "${out%%|*}" ] || fail "identity_apply must stamp GIT_AUTHOR_NAME, got: $out"
grep -q 'worker' <<<"$out" || fail "identity_apply must name the machinery class, got: $out"
echo "ok 9 identity_apply stamps the git identity"

# 10: a contract-satisfying stamp with NO swarm_git_identity still fails LOUD at
#     the call-site guard — never bash's bare `command not found` mid-run (#31).
out="$(env -u SWARM_IDENTITY_CONTRACT bash -c '
  SWARM_IDENTITY_CONTRACT=1; REPO_SLUG=Acme/widget
  . "'"$sc"'/identity-lib.sh"
  err="$(identity_apply worker 2>&1 1>/dev/null)"; rc=$?
  printf "%s|%s\n" "$rc" "$err"')"
[ "${out%%|*}" = 2 ] || fail "a missing swarm_git_identity must return 2, got: $out"
grep -q "swarm_git_identity missing from swarm-identity.sh" <<<"$out" \
  || fail "the refusal must name the missing symbol, got: $out"
grep -q "onboard.sh identity Acme/widget" <<<"$out" \
  || fail "the refusal must name the exact regenerate command, got: $out"
echo "ok 10 identity_apply refuses a missing swarm_git_identity by name"

# 11: an OLDER contract stamp is refused by identity_apply too — the #31 seam is
#     checked before the symbol guard, so the message names the pin lag.
out="$(env -u SWARM_IDENTITY_CONTRACT bash -c '
  REPO_SLUG=Acme/widget
  . "'"$sc"'/identity-lib.sh"
  err="$(identity_apply worker 2>&1 1>/dev/null)"; rc=$?
  printf "%s|%s\n" "$rc" "$err"')"
[ "${out%%|*}" = 2 ] || fail "an absent contract stamp must return 2, got: $out"
grep -q "is contract 0, this harness needs" <<<"$out" || fail "the contract lag must be named first, got: $out"
echo "ok 11 identity_apply refuses an older contract stamp"

echo "identity-lib: 11 groups passed"
