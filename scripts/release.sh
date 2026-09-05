#!/usr/bin/env bash
#
# release.sh — Updates the app version, creates a tag and a commit and pushes them to main triggering a release
#
# Usage:
#   ./scripts/release.sh <version>

set -e

VERSION="${1:-}"

if [ -z "$VERSION" ]; then
  echo "❌ Usage: npm run release -- <version>"
  echo "   Example: npm run release -- 0.0.3"
  exit 1
fi

TAG="v$VERSION"
BRANCH="main"

# Operate on the checkout this script lives in, from frontend/ (whose
# package.json carries the app version the tag build verifies) — regardless
# of the caller's cwd. v0.6.3 was tagged with the ROOT package.json bumped
# because the script trusted its cwd, and the tag build failed the version
# guard having shipped nothing.
cd "$(dirname "$0")/../frontend"

echo "🚀 Releasing version $VERSION"

# Ensure clean working tree
if [ -n "$(git status --porcelain)" ]; then
  echo "❌ Uncommitted changes found. Commit or stash before releasing."
  exit 1
fi

# Ensure we're on main
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "$BRANCH" ]; then
  echo "❌ You must be on '$BRANCH' to release (currently on '$CURRENT_BRANCH')"
  exit 1
fi

# Ensure tag doesn't already exist
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "❌ Tag $TAG already exists"
  exit 1
fi

echo "📝 Updating package.json version → $VERSION"

# Bump the version in every package.json that carries the app version.
# electron-builder reads the version from frontend/package.json, so it MUST be
# bumped in lock-step with the root package.json — otherwise installer
# filenames carry the previous version (see issue #359).
PACKAGE_FILES=(package.json frontend/package.json)

for pkg in "${PACKAGE_FILES[@]}"; do
  tmpfile=$(mktemp)
  jq ".version = \"$VERSION\"" "$pkg" > "$tmpfile"
  mv "$tmpfile" "$pkg"
done

# Guard: every package.json must now agree on the version.
for pkg in "${PACKAGE_FILES[@]}"; do
  pkg_version=$(jq -r .version "$pkg")
  if [ "$pkg_version" != "$VERSION" ]; then
    echo "❌ $pkg version is $pkg_version, expected $VERSION"
    exit 1
  fi
done

git add "${PACKAGE_FILES[@]}"
git commit -m "chore(release): v$VERSION"

echo "🏷️  Creating tag $TAG"
git tag "$TAG"

echo "⬆️  Pushing commit and tag"
git push origin "$BRANCH"
git push origin "$TAG"
git push github "$BRANCH"
git push github "$TAG"

echo ""
echo "✅ Release $TAG pushed"
echo "📦 GitHub will now create a draft release and trigger builds"
echo "https://github.com/matou-collective/matou-app/releases/tag/$TAG"
