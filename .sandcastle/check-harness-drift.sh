#!/usr/bin/env bash
# Drift alarm for the vendored factory core (ADR 0180 / #571: the factory
# moved out of this repo into Matou/dev-factory; this repo now PULLS from it
# at a pinned ref instead of idss pushing sed-transformed copies into
# siblings). "Drift" used to mean "a far-side copy was hand-edited instead of
# re-synced"; it now means the same thing from the other direction — a
# vendored file here no longer matches FACTORY_REF's content, byte for byte,
# no rendering (the old sed transform's "slug as value" vs "slug as
# canonical-repo reference" ambiguity — the #571 bug where 2 of 13 synced
# files arrived ownership-inverted, one of them this very file — cannot
# recur: there is no transform).
#
# FACTORY_REPO is the SAME upstream for every consumer (unlike FORGEJO_API,
# this is not a per-repo value the ownership-inversion bug class applies to —
# every product repo vendors from the one factory repo), so it is a plain
# default here, not sourced from swarm-identity.sh.
#
# Inputs (both under .sandcastle/, both committed):
#   FACTORY_REF       one line, the pinned Matou/dev-factory commit SHA.
#   FACTORY_MANIFEST  one vendored path per line (relative to .sandcastle/),
#                     `#`-comments and blank lines ignored.
#
# No FACTORY_REF -> this repo has never vendored the factory core; nothing to
# enforce, green (mirrors the old marker's absence-is-fine rule).
#
# Exit 0 in sync (or not applicable); 1 on drift.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"       # .sandcastle
ref_file="$here/FACTORY_REF"
manifest="$here/FACTORY_MANIFEST"
: "${FACTORY_REPO:=https://git.matou.nz/Matou/dev-factory.git}"

if [ ! -f "$ref_file" ]; then
  echo "check-harness-drift: no $ref_file — this repo does not vendor the factory core; nothing to enforce."
  exit 0
fi
[ -f "$manifest" ] || { echo "check-harness-drift: $ref_file exists but $manifest is missing." >&2; exit 1; }

factory_ref="$(tr -d '[:space:]' <"$ref_file")"
[ -n "$factory_ref" ] || { echo "check-harness-drift: $ref_file is empty." >&2; exit 1; }

# Fetch the pinned revision into a throwaway checkout — never a working tree
# we share. Shallow fetch of the exact SHA; fall back to a full clone for
# servers that refuse by-SHA fetch.
work="$(mktemp -d "${TMPDIR:-/tmp}/factory-drift.XXXXXX")"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT

if ! (
  git init -q "$work" &&
  git -C "$work" remote add origin "$FACTORY_REPO" &&
  git -C "$work" fetch -q --depth 1 origin "$factory_ref" &&
  git -C "$work" checkout -q FETCH_HEAD
) 2>/dev/null; then
  rm -rf "$work"; work="$(mktemp -d "${TMPDIR:-/tmp}/factory-drift.XXXXXX")"
  git clone -q "$FACTORY_REPO" "$work"
  git -C "$work" checkout -q "$factory_ref"
fi

drift=0
while IFS= read -r name; do
  case "$name" in ''|'#'*) continue ;; esac
  src="$work/$name"
  local_copy="$here/$name"
  if [ ! -f "$src" ]; then
    echo "check-harness-drift: FACTORY_MANIFEST lists $name but $FACTORY_REPO@$factory_ref has no such file." >&2
    drift=1; continue
  fi
  if [ ! -f "$local_copy" ]; then
    echo "DRIFT: $name is missing here but is a vendored factory file (pinned: $factory_ref). Re-vendor it; do not hand-add it." >&2
    drift=1; continue
  fi
  if ! diff -u "$src" "$local_copy" >/dev/null; then
    echo "DRIFT: .sandcastle/$name was edited directly here — it is owned by $FACTORY_REPO (pinned rev $factory_ref)." >&2
    echo "       Vendored factory files are canonical in $FACTORY_REPO: land the fix THERE, bump FACTORY_REF, and re-vendor," >&2
    echo "       or remove $name from FACTORY_MANIFEST if it must diverge here. Diff (pinned factory -> local):" >&2
    diff -u "$src" "$local_copy" | sed 's/^/       /' >&2 || true
    drift=1
  fi
done <"$manifest"

if [ "$drift" -ne 0 ]; then
  echo "check-harness-drift: FAILED — vendored factory copies drifted from $FACTORY_REPO@$factory_ref." >&2
  exit 1
fi

echo "check-harness-drift: OK — every vendored factory file matches $FACTORY_REPO@$factory_ref."

# Advisory only (never fails the check): how far behind dev-factory's main
# tip the pin is, so a stale-but-intentional pin stays visible without
# forcing an upgrade — "drift" is a mismatch, not simply "not on the latest
# tag" (ADR 0180: "a product repo upgrades by bumping the ref"). Best-effort
# extra fetch (the primary fetch above is shallow-by-SHA and may not carry
# main); silently skipped if unreachable — this is a bonus note, not a check.
git -C "$work" fetch -q origin main:refs/remotes/origin/main 2>/dev/null || true
if behind="$(git -C "$work" rev-list --count "$factory_ref"..origin/main 2>/dev/null)" && [ "${behind:-0}" -gt 0 ] 2>/dev/null; then
  echo "check-harness-drift: NOTE — FACTORY_REF is $behind commit(s) behind $FACTORY_REPO main. Bump it when convenient (not a failure)."
fi
