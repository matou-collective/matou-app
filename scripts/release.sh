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

# Update version using jq
tmpfile=$(mktemp)
jq ".version = \"$VERSION\"" package.json > "$tmpfile"
mv "$tmpfile" package.json

git add package.json
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
