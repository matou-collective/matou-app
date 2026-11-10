#!/usr/bin/env bash
# tests/gotchas-index-merge-test.sh — the GOTCHAS index is conflict-free under
# concurrent writers (#300).
#
# docs/GOTCHAS.md was the last single-anchor concurrent-write surface: two
# workers forked from the same `main` both (a) minted the same monotonic hazard
# number off their own fork's max row and (b) appended a row at the file's one
# tail anchor. Divergent inserts at one anchor are a textual conflict a plain
# 3-way merge cannot resolve — it reded run 23830 at post-run land and stranded
# #298 (GOTCHAS 72 family). The fix is two parts, both proven here:
#   1. `.gitattributes` sets `docs/GOTCHAS.md merge=union`, so divergent tail
#      inserts resolve by KEEPING BOTH rows with no conflict markers.
#   2. A hazard is keyed by its CLOSING TICKET number (`#<ticket>`), assigned
#      uniquely by the tracker and held by exactly one worker — so two workers
#      can never mint the same id and the union-merged rows never duplicate.
#
# Offline: a throwaway git repo under a temp dir, no docker, no network. It
# pulls the REAL repo-root `.gitattributes` into the fixture so a regression
# that drops the union rule reds here.
# Run: bash tests/gotchas-index-merge-test.sh
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"
root="$(cd "$here/.." && pwd)"

# Vendored byte-identical into every consumer's `.sandcastle/` (and this repo's
# own self-copy), where `root` IS `.sandcastle/` — which carries neither the
# factory-root `.gitattributes` nor `docs/GOTCHAS.md` (both vendor-excluded).
# The union-merge rule is a factory-core concern, so there this test has nothing
# to assert: skip it visibly rather than red (the #294 docs-budget-test idiom,
# GOTCHAS 4). The signal is the resolved root's basename, as in that test.
if [ "$(basename "$root")" = ".sandcastle" ]; then
  echo "gotchas-index-merge-test: SKIPPING — factory-core only, absent in vendored copy (root $root)"
  exit 0
fi

# ── the real attribute is configured ────────────────────────────────────────
check "repo-root .gitattributes exists" "[ -f '$root/.gitattributes' ]"
check "it sets docs/GOTCHAS.md merge=union" \
  "grep -Eq '^docs/GOTCHAS\.md[[:space:]]+merge=union\$' '$root/.gitattributes'"

# ── a throwaway repo seeded like the real index ─────────────────────────────
# seed_repo <dir> [attr]  — a git repo on `main` with a two-row index, plus
# body files; copies the real .gitattributes only when `attr` is "attr".
seed_repo() {
  local d="$1" attr="${2:-}"
  git -c init.defaultBranch=main init -q "$d"
  git -C "$d" config user.email t@example.invalid
  git -C "$d" config user.name tester
  mkdir -p "$d/docs/gotchas"
  cat >"$d/docs/GOTCHAS.md" <<'MD'
# Gotchas — operational hazards

## Index

| # | Sev | Hazard | Body |
|---|---|---|---|
| 1 | ⭐ | a legacy hazard | [body](gotchas/01-a.md) |
| 2 | ⭐ | another legacy hazard | [body](gotchas/02-b.md) |
MD
  : >"$d/docs/gotchas/01-a.md"
  : >"$d/docs/gotchas/02-b.md"
  [ "$attr" = attr ] && cp "$root/.gitattributes" "$d/.gitattributes"
  git -C "$d" add -A
  git -C "$d" commit -qm base
}

# add_hazard <dir> <ticket> <slug>  — the new add-a-hazard operation: a body
# file keyed by the closing ticket number + one appended index row. Committed
# on whatever branch is checked out.
add_hazard() {
  local d="$1" ticket="$2" slug="$3"
  printf '## #%s. hazard from %s\n' "$ticket" "$slug" \
    >"$d/docs/gotchas/$ticket-$slug.md"
  printf '| #%s | ⭐ | hazard from %s | [body](gotchas/%s-%s.md) |\n' \
    "$ticket" "$slug" "$ticket" "$slug" >>"$d/docs/GOTCHAS.md"
  git -C "$d" add -A
  git -C "$d" commit -qm "$ticket"
}

# ── two concurrent writers, merged onto main ────────────────────────────────
wu="$(tmpdir)/with-union"
seed_repo "$wu" attr

# Branch A off main → hazard keyed by ticket 777.
git -C "$wu" checkout -q -b workerA
add_hazard "$wu" 777 alpha
# Branch B off the SAME base main → hazard keyed by ticket 778.
git -C "$wu" checkout -q main
git -C "$wu" checkout -q -b workerB
add_hazard "$wu" 778 beta

# Land both onto main: A fast-forwards, B is a real 3-way merge whose only
# divergence from A is a second row at the same tail anchor.
git -C "$wu" checkout -q main
git -C "$wu" merge --no-edit -q workerA
git -C "$wu" merge --no-edit workerB >/dev/null 2>&1
rc=$?
check "merging two concurrent hazard-adds onto main does NOT conflict (rc=$rc)" \
  "[ $rc -eq 0 ]"
check "no conflict markers in the merged index" \
  "! grep -q '^<<<<<<<' '$wu/docs/GOTCHAS.md'"

# Both body files survive (one file per hazard already merges cleanly).
check "worker A's body file landed" "[ -f '$wu/docs/gotchas/777-alpha.md' ]"
check "worker B's body file landed" "[ -f '$wu/docs/gotchas/778-beta.md' ]"

# Both rows are present in the index…
check "worker A's row is in the merged index" \
  "grep -q '^| #777 ' '$wu/docs/GOTCHAS.md'"
check "worker B's row is in the merged index" \
  "grep -q '^| #778 ' '$wu/docs/GOTCHAS.md'"

# …and no hazard id appears twice (ticket-keyed ids are collision-free, so the
# union-kept rows never duplicate — the half the merge driver cannot give us).
ids="$(grep -oE '^\| #[0-9]+ ' "$wu/docs/GOTCHAS.md" | tr -d '| #')"
dupes="$(printf '%s\n' "$ids" | sort | uniq -d)"
check "no duplicate hazard id after the merge (dupes: '${dupes:-none}')" \
  "[ -z \"\$(printf '%s\n' \"$ids\" | sort | uniq -d)\" ]"

# ── the attribute is load-bearing: without it the SAME scenario conflicts ────
# Proves the fix (not some incidental ordering) is what resolves the collision.
nu="$(tmpdir)/no-union"
seed_repo "$nu"   # no attr copied
git -C "$nu" checkout -q -b workerA
add_hazard "$nu" 777 alpha
git -C "$nu" checkout -q main
git -C "$nu" checkout -q -b workerB
add_hazard "$nu" 778 beta
git -C "$nu" checkout -q main
git -C "$nu" merge --no-edit -q workerA
git -C "$nu" merge --no-edit workerB >/dev/null 2>&1
rc=$?
check "control: WITHOUT merge=union the same two tail-appends DO conflict (rc=$rc)" \
  "[ $rc -ne 0 ]"
git -C "$nu" merge --abort 2>/dev/null || true

summary gotchas-index-merge-test
