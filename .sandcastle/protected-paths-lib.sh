#!/usr/bin/env bash
# protected-paths-lib.sh — an OUTCOME boundary around every swarm worker (#445).
#
# Learning L3 (docs/research/2026-08-11-software-factory-learnings.md): a tool
# list is a capability list, not a boundary — `bash` can run `git checkout`,
# `write` reaches any path — so "this worker changes nothing under the
# machinery" cannot be kept by a blocklist. `.sandcastle/git-fence` blocks ONE
# command (`git worktree …`) by name; nothing stops a worker editing the very
# scripts and workflows that judge its work. #239 (in-sandbox `git worktree
# repair` corrupting the shared `.git/worktrees` admin) and the 93c6afb
# regression were both this class: a worker touching plumbing it should never
# own. `git-fence` STAYS as cheap defence-in-depth — it is just no longer the
# boundary.
#
# The boundary here is on OUTCOMES, adapted from SSSF's permissions.py: fingerprint
# the protected tree BEFORE the worker runs and AFTER its last send, and attribute
# every protected path whose content APPEARED, VANISHED, or CHANGED to the worker.
# Comparing the two change-sets (not watching writes) is what also catches a
# `git checkout` revert: a path whose pre-run content differs from its post-run
# content is attributed even if the worker "put it back" to some other state.
# Unauthorized introductions are ROLLED BACK to their pre-run content and the run
# FAILS LOUD, naming every path and what happened to it — and pointing at the
# escape path (below) so a worker that was RIGHT routes instead of improvising.
#
# The fingerprinted protected set is `.sandcastle/` and `.forgejo/` — the in-repo
# machinery. `.git/` admin (hooks, worktrees, config) is DECLARED protected too
# (pp_is_protected returns true for it) but is deliberately NOT fingerprinted by
# default: the host mutates `.git/` under every normal git operation during a run
# (index, logs, refs), so fingerprinting it would false-positive constantly. That
# dir stays git-fence's job; add it to PP_PROTECTED_DIRS only in an environment
# where `.git/` does not churn.
#
# A path that was already DIRTY before the worker ran (another session's
# uncommitted work on the shared worktree) is left ALONE unless the worker itself
# changed it — its pre-run content is what we compare against, so untouched
# pre-existing work is never attributed and never collateral (the #239 shared-
# worktree hazard).
#
# Content-digest fingerprinting cannot catch a modify-then-restore-to-BYTE-
# IDENTICAL-pre-run-content (no after-the-fact method can — that needs a write
# watcher, which SSSF and we both reject); every net change IS caught.
#
# Pure and sourceable — no network, no git repo required (digests are sha256 of
# working-tree bytes, so snapshots work over a plain directory). Wired into
# .sandcastle/run-swarm.sh around the sandcastle run; driven offline by
# .sandcastle/tests/protected-paths-lib-test.sh.

# The fingerprinted protected directories (repo-relative), newline/space
# separated. Overridable in tests via PP_PROTECTED_DIRS.
PP_PROTECTED_DIRS_DEFAULT=".sandcastle .forgejo"

# Paths exempted from the protected set — runtime, not machinery. The healer's
# evidence directories (/tmp/matou-heal-*) are runtime artifacts the healer
# writes during an investigation; they must never be treated as machinery a
# worker edited. Overridable/extendable via PP_EXEMPT_GLOBS (newline/space
# separated shell globs, matched against the path). The healer's own "never
# edits itself" rule is unchanged and lives in the rehearsal healer's rails —
# this exemption only keeps its evidence dirs out of the worker boundary.
PP_EXEMPT_GLOBS_DEFAULT="*matou-heal-* */matou-heal-*"

# The escape path, spelled out verbatim so every enforcement failure routes a
# worker that was RIGHT the machinery needs changing instead of letting it
# improvise (Ben's ruling 2026-08-11). Kept in ONE place so the worker prompt
# (.sandcastle/prompt.md) and the failure banner cannot drift.
PP_ESCAPE_PATH='A protected path is machinery that judges your work — you must NOT edit it.
If you believe a protected path genuinely needs changing, do NOT edit it. Instead:
  1. File a separate Forgejo issue describing the needed machinery change —
     symptom, proposed fix, and the ticket you were working when you found it;
  2. Label that issue ready-for-session (ADR 0174: a protected .sandcastle/
     path per #445 needs an interactive session'"'"'s standing, not Ben — a
     session escalates to ready-for-human itself only if it finds a genuine
     one-way door);
  3. Continue your original ticket without the machinery change if possible, or
     report blocked in your close report naming the filed issue.'

# pp_protected_dirs — echo the fingerprinted protected directories, one per line.
pp_protected_dirs() {
  local raw="${PP_PROTECTED_DIRS:-$PP_PROTECTED_DIRS_DEFAULT}" d
  for d in $raw; do [ -n "$d" ] && printf '%s\n' "$d"; done
}

# pp_is_protected <relpath> — return 0 if the path is inside the declared
# protected set (the fingerprinted dirs plus `.git/` admin) AND not exempt,
# else 1. Exemptions win. Paths are matched as repo-relative; a leading `./`
# and a trailing `/` are ignored.
pp_is_protected() {
  local rel="$1" g d
  rel="${rel#./}"; rel="${rel%/}"
  [ -n "$rel" ] || return 1

  local globs="${PP_EXEMPT_GLOBS:-$PP_EXEMPT_GLOBS_DEFAULT}"
  for g in $globs; do
    # shellcheck disable=SC2254
    case "$rel" in $g) return 1 ;; esac
  done

  case "$rel" in
    .git|.git/*) return 0 ;;
  esac
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    d="${d%/}"
    [ "$rel" = "$d" ] && return 0
    case "$rel" in "$d"/*) return 0 ;; esac
  done < <(pp_protected_dirs)
  return 1
}

# _pp_key <relpath> — a filesystem-safe key for a path (used to name its blob).
_pp_key() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }

# _pp_digest <file> — sha256 of the file's bytes (its content fingerprint).
_pp_digest() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1; }

# pp_snapshot <root> <snapdir> — fingerprint every fingerprinted-protected file
# under <root> into <snapdir>: an `index` of `<digest>\t<key>\t<relpath>` lines
# and a `blobs/<key>` copy of each file's bytes (so a rollback can restore the
# pre-run content, not merely detect the change). Exempt paths are skipped.
# Idempotent: the snapdir is (re)initialised each call.
pp_snapshot() {
  local root="$1" snap="$2" d rel f digest key
  rm -rf "$snap"; mkdir -p "$snap/blobs"; : > "$snap/index"
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    [ -d "$root/$d" ] || continue
    while IFS= read -r -d '' f; do
      rel="${f#"$root"/}"
      pp_is_protected "$rel" || continue
      digest="$(_pp_digest "$f")"
      key="$(_pp_key "$rel")"
      cp "$f" "$snap/blobs/$key" 2>/dev/null || true
      printf '%s\t%s\t%s\n' "$digest" "$key" "$rel" >> "$snap/index"
    done < <(find "$root/$d" -type f -print0 2>/dev/null)
  done < <(pp_protected_dirs)
}

# _pp_load <snapdir> <assoc-name-digest> <assoc-name-key> — read a snapshot's
# index into two caller-declared associative arrays keyed by relpath.
_pp_load() {
  local snap="$1" dg="$2" ky="$3" digest key rel
  [ -f "$snap/index" ] || return 0
  while IFS=$'\t' read -r digest key rel; do
    [ -n "$rel" ] || continue
    printf -v "${dg}[$rel]" '%s' "$digest"
    printf -v "${ky}[$rel]" '%s' "$key"
  done < "$snap/index"
}

# pp_attributed <before_snap> <after_snap> — print one `<disposition>\t<relpath>`
# line per protected path the worker introduced, where disposition is
# `appeared` (absent before), `vanished` (absent after), or `changed`. Emits
# nothing when the worker introduced no protected change. Sorted by path.
pp_attributed() {
  local before="$1" after="$2" rel b a
  local -A BD=() BK=() AD=() AK=()
  _pp_load "$before" BD BK
  _pp_load "$after"  AD AK
  {
    for rel in "${!BD[@]}" "${!AD[@]}"; do printf '%s\n' "$rel"; done | sort -u
  } | while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    b="${BD[$rel]:-}"; a="${AD[$rel]:-}"
    [ "$b" = "$a" ] && continue
    if [ -z "$b" ]; then printf 'appeared\t%s\n' "$rel"
    elif [ -z "$a" ]; then printf 'vanished\t%s\n' "$rel"
    else printf 'changed\t%s\n' "$rel"; fi
  done
}

# pp_rollback <root> <before_snap> <after_snap> — restore every attributed
# protected path to its PRE-RUN state: a path the worker created is deleted; a
# path it changed or deleted is restored byte-for-byte from the before-snapshot
# blob. Paths the worker did not touch (incl. pre-existing dirty ones) are never
# read or written. Prints one `<action>\t<relpath>` line per path acted on.
pp_rollback() {
  local root="$1" before="$2" after="$3" disp rel key
  local -A BK=() BD=()
  _pp_load "$before" BD BK
  pp_attributed "$before" "$after" | while IFS=$'\t' read -r disp rel; do
    [ -n "$rel" ] || continue
    key="${BK[$rel]:-}"
    if [ -z "$key" ]; then
      # No pre-run content: the worker created it — remove the introduction.
      rm -f "$root/$rel" 2>/dev/null || true
      printf 'deleted\t%s\n' "$rel"
    else
      mkdir -p "$(dirname "$root/$rel")" 2>/dev/null || true
      cp "$before/blobs/$key" "$root/$rel" 2>/dev/null || true
      printf 'restored\t%s\n' "$rel"
    fi
  done
}

# pp_enforce <root> <before_snap> <after_snap> — the boundary. Attribute, roll
# back, and on any violation FAIL LOUD: a human-readable banner naming every
# path + what happened + the escape path is printed to stderr, and the attributed
# relpaths are printed to stdout (for the caller's runlog/verdict). Returns 1 if
# the worker introduced any protected change, 0 if the protected tree is clean.
pp_enforce() {
  local root="$1" before="$2" after="$3"
  local attributed; attributed="$(pp_attributed "$before" "$after")"
  if [ -z "$attributed" ]; then
    return 0
  fi
  # Roll back before we report, so the tree is clean by the time the run fails.
  pp_rollback "$root" "$before" "$after" >/dev/null
  {
    echo "protected-path violation (#445): a worker changed machinery that judges its work."
    echo "The following protected path(s) were introduced and have been ROLLED BACK:"
    printf '%s\n' "$attributed" | while IFS=$'\t' read -r disp rel; do
      [ -n "$rel" ] || continue
      case "$disp" in
        appeared) echo "  - $rel — CREATED by the worker (rolled back: deleted)" ;;
        vanished) echo "  - $rel — DELETED by the worker (rolled back: restored)" ;;
        changed)  echo "  - $rel — MODIFIED by the worker (rolled back: restored to pre-run content)" ;;
      esac
    done
    echo ""
    echo "protected path — file a ready-for-session issue instead of editing the machinery:"
    printf '%s\n' "$PP_ESCAPE_PATH"
  } >&2
  # Surface the attributed paths on stdout for the caller (runlog / verdict).
  printf '%s\n' "$attributed" | cut -f2-
  return 1
}
