#!/usr/bin/env bash
# Ratchet: the product-owner guide's label reference (docs/guide/07-labels.md)
# names every label the factory mints (onboarding/labels.json, core + design),
# so the guide cannot silently drift from the tracker vocabulary.
# Passes vacuously when docs/guide/ is absent (a consumer's vendored copy of
# this test has no guide to check).
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"

# shellcheck source=lib.sh
. "$here/lib.sh"

page="$root/docs/guide/07-labels.md"
labels="$root/onboarding/labels.json"

if [ ! -d "$root/docs/guide" ] || [ ! -f "$labels" ]; then
  echo "guide-labels-test: no docs/guide or labels.json here — nothing to check"
  exit 0
fi

check "07-labels.md exists" '[ -f "$page" ]'

names="$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print("\n".join(l["name"] for k in ("core","design") for l in d.get(k,[])))' "$labels")"
check "labels.json yields at least one label" '[ -n "$names" ]'

while IFS= read -r name; do
  [ -n "$name" ] || continue
  check "07-labels.md documents \`$name\`" 'grep -qF "\`$name\`" "$page"'
done <<< "$names"

echo "guide-labels-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
