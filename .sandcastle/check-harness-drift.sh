#!/usr/bin/env bash
# Far-side drift alarm for the shared Sandcastle harness (#250). This file is
# itself shipped by sync-harness.sh (it is on the harness-manifest, kept
# identical across repos by this very check) — so it is GENERIC by
# construction: it carries no repo slug of its own and reads everything it
# needs (which repo is canonical, which is the target) from the
# .harness-canonical marker the sync recorded, so the slug transform is a
# no-op on it. (#571: naming the canonical repo literally in this comment,
# instead of only in the marker, was the ownership-inversion bug — a
# hardcoded "canonical in ourcloud" claim reads as false once sed-rendered
# into the far side, even though the file's actual LOGIC never hardcoded it.)
#
# What it proves, run from a target repo's checkout root in that repo's ci:
# every manifest file here matches what re-rendering the canonical revision the
# last sync recorded produces. If a copy was edited directly on the far side,
# CI goes RED naming the file and the canonical rule — the fix belongs in the
# repo the marker's slug= names as canonical (or the file belongs OUT of the
# manifest), never in a divergent far-side edit (the limit-guard-storm class:
# fixed in one place, re-erupts in the other).
#
# Marker: .sandcastle/.harness-canonical, written by sync-harness.sh, four
# `key=value` lines: repo= (canonical git URL) rev= (the synced canonical SHA)
# slug= (canonical slug) target= (this repo's slug, the transform target).
# No marker → this repo has never been synced; nothing to enforce, green.
#
# Exit 0 in sync (or no marker / not applicable); 1 on drift.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"       # .sandcastle
repo_root="$(cd "$here/.." && pwd)"
marker="$here/.harness-canonical"

if [ ! -f "$marker" ]; then
  echo "check-harness-drift: no $marker — this repo is not a harness-sync target; nothing to enforce."
  exit 0
fi

# Parse the marker (only the four keys we write; ignore anything else).
canon_repo=""; canon_rev=""; canon_slug=""; target_slug=""
while IFS='=' read -r k v; do
  case "$k" in
    repo)   canon_repo="$v" ;;
    rev)    canon_rev="$v" ;;
    slug)   canon_slug="$v" ;;
    target) target_slug="$v" ;;
  esac
done <"$marker"

if [ -z "$canon_repo" ] || [ -z "$canon_rev" ] || [ -z "$canon_slug" ] || [ -z "$target_slug" ]; then
  echo "check-harness-drift: $marker is malformed (need repo=/rev=/slug=/target=)." >&2
  exit 1
fi

# Fetch the recorded canonical revision into a throwaway checkout — never a
# working tree we share. Shallow fetch of the exact SHA; fall back to a shallow
# clone for servers that refuse by-SHA fetch.
work="$(mktemp -d "${TMPDIR:-/tmp}/harness-drift.XXXXXX")"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT

if ! (
  git init -q "$work" &&
  git -C "$work" remote add origin "$canon_repo" &&
  git -C "$work" fetch -q --depth 1 origin "$canon_rev" &&
  git -C "$work" checkout -q FETCH_HEAD
) 2>/dev/null; then
  rm -rf "$work"; work="$(mktemp -d "${TMPDIR:-/tmp}/harness-drift.XXXXXX")"
  git clone -q "$canon_repo" "$work"
  git -C "$work" checkout -q "$canon_rev"
fi

canon_sc="$work/.sandcastle"
manifest="$canon_sc/harness-manifest"
[ -f "$manifest" ] || { echo "check-harness-drift: canonical rev $canon_rev has no harness-manifest." >&2; exit 1; }

# The transform: the single allowed one, the repo-slug substitution. `#` is a
# safe sed delimiter because slugs never contain it.
render() { sed "s#${canon_slug}#${target_slug}#g" "$1"; }

drift=0
while read -r kind name; do
  [ "$kind" = "file" ] || continue
  src="$canon_sc/$name"
  local_copy="$here/$name"
  if [ ! -f "$src" ]; then
    echo "check-harness-drift: manifest lists $name but canonical rev has no such file." >&2
    drift=1; continue
  fi
  if [ ! -f "$local_copy" ]; then
    echo "DRIFT: $name is missing here but is a synced harness file (canonical: $canon_slug). Re-run the sync; do not hand-add it." >&2
    drift=1; continue
  fi
  if ! diff -u <(render "$src") "$local_copy" >/dev/null; then
    echo "DRIFT: .sandcastle/$name was edited directly here — it is owned by $canon_slug (rev $canon_rev)." >&2
    echo "       Shared harness files are canonical in $canon_slug: land the fix THERE and let sync-harness.sh propagate it," >&2
    echo "       or remove $name from the harness-manifest if it must diverge. Diff (rendered canonical -> local):" >&2
    diff -u <(render "$src") "$local_copy" | sed 's/^/       /' >&2 || true
    drift=1
  fi
done <"$manifest"

if [ "$drift" -ne 0 ]; then
  echo "check-harness-drift: FAILED — shared harness copies drifted from $canon_slug@$canon_rev." >&2
  exit 1
fi
echo "check-harness-drift: OK — every synced harness file matches $canon_slug@$canon_rev."
