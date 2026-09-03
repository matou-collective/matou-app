#!/usr/bin/env bash
# Map a semver X.Y.Z app version to an Android versionCode (issue #321).
#
#   scripts/android/version-code.sh <version> [package-json-path]
#   scripts/android/version-code.sh 0.5.0        -> 5000
#   scripts/android/version-code.sh v0.4.1       -> 4001
#   scripts/android/version-code.sh              -> reads frontend/package.json
#
# The code is MMMmmmppp: MAJOR*1000000 + MINOR*1000 + PATCH. Monotonic and
# human-decodable (0.4.1 -> 4001), room for 999 patch releases per minor;
# Play's max versionCode is 2100000000.
#
# This is the single home for the version->code mapping so BOTH the tag and the
# non-tag (dispatch) paths in .forgejo/workflows/android.yml stamp the same
# code for the same version — a dispatch build of 0.5.0 reports 5000 just like
# the eventual 0.5.0 tag build, instead of the bare CI run number it used to
# use. See scripts/android/version-code-test.sh for the asserted cases.
set -euo pipefail

version="${1:-}"

if [ -z "$version" ]; then
  pkg="${2:-frontend/package.json}"
  version="$(sed -n 's/^  "version": "\(.*\)",/\1/p' "$pkg")"
  if [ -z "$version" ]; then
    echo "ERROR: could not read version from $pkg" >&2
    exit 1
  fi
fi

# Accept an optional leading v (tag refs are vX.Y.Z).
version="${version#v}"

if [[ ! "$version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  echo "ERROR: version must be X.Y.Z (got '$version')" >&2
  exit 1
fi

echo $(( ${BASH_REMATCH[1]} * 1000000 + ${BASH_REMATCH[2]} * 1000 + ${BASH_REMATCH[3]} ))
