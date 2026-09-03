#!/usr/bin/env bash
# The rehearsal healer's rails (spec 2026-08-10-rehearsal-healer-design):
# pure functions over an explicit checkout — the PROMPT guides the healer
# session, these functions are LAW. Sourced by rehearsal-report.sh; unit-tested
# in isolation (tests/rehearsal-heal-lib-test.sh).
#
# HEALER-FIRST REGIME (#1144, Ben ruled 2026-09-02): every red drive goes to the
# healer before the reporter, with NO signature gate — so the refusal rules ARE
# the rails. A healer whose goal is "make the drive green" and meets a product
# defect has one cheap move: weaken the assertion (the #1113 lesson — a red that
# is inconvenient is not a red that is wrong). The three HARD refusal rules below
# force those reds onto the ticket path with the paper trail intact. On a
# refusal heal_rails resets the checkout, names the rule in HEAL_RAIL_REASON, and
# returns 1; the caller (try_heal) files the blocker itself with that reason as
# its "healer refused: <rule>" diagnosis (ticket-on-refusal).

# HEAL_RAIL_REASON / HEAL_RAIL_SWARMABLE — set by heal_rails on every refusal so
# the caller's ticket-on-refusal can name the rule that fired and route the
# label. SWARMABLE=true means a swarm worker can act without a human ruling (a
# too-big-but-mechanical fix); false means a session/design ruling is needed
# (never weaken a check, never change a product surface). Cleared on accept.
HEAL_RAIL_REASON=""
HEAL_RAIL_SWARMABLE=""

# The test-file pattern shared by the line cap (tests don't count) and the
# product-surface rule (test plumbing is fair game). Kept in one place.
HEAL_TEST_FILE_RE='(_test\.[A-Za-z]+|\.test\.[A-Za-z]+|\.spec\.[A-Za-z]+)$'

# Product-behaviour surfaces (#1144 refusal rule 3): a heal may never change what
# a community sees or what a deploy does. Path-glob based and CONSUMER-configured
# — this generic factory file ships them EMPTY (a factory-default consumer has no
# product surfaces, so the rule is a no-op), and a product repo declares its own
# via the environment (IDSS: `internal/* app/src/*`). Test files and fixtures are
# fair game (harness, fixtures, scripts/, wiring and test plumbing), so a changed
# path that matches a surface glob is still refused ONLY when it is neither a test
# file nor an exempt (fixture/testdata/stories) path. Newline/space separated.
HEAL_PRODUCT_SURFACE_GLOBS="${HEAL_PRODUCT_SURFACE_GLOBS:-}"
HEAL_PRODUCT_SURFACE_EXEMPT_GLOBS="${HEAL_PRODUCT_SURFACE_EXEMPT_GLOBS:-*testdata* *fixtures* *__fixtures__* *.fixture.* *.stories.*}"

# _heal_weakens_check <co> <a> <b> — 0 if the diff a..b would WEAKEN what a check
# proves: it removes or rewrites an assertion/expectation line, removes a
# test/leg declaration, or adds a skip/pending marker. This is refusal rule 1 —
# the #1113 backstop. A heal that ADDS a new assertion (a net-new expect/assert
# line) is fine; only removed/changed assertion lines and added skips trip it. A
# selector-drift heal that edits a `page.getByRole(...)`/locator/action line
# (NOT an `expect(...)` line) is NOT a weakened check and passes — the healer's
# bread-and-butter mechanical fix stays in-lane.
_heal_weakens_check() {
  local co="$1" a="$2" b="$3" diff
  diff="$(git -C "$co" diff --unified=0 "$a..$b" 2>/dev/null)"
  # Removed/changed assertion or expectation line (old side: `-` not `---`).
  if printf '%s\n' "$diff" | grep -qE '^-[^-].*(\bexpect\(|\.toBe|\.toEqual|\.toContain|\.toMatch|\.toHave|\bassert[.(]|\brequire\.(Equal|NoError|Error|True|False|Nil|NotNil|Len|Contains|ElementsMatch)|\bt\.(Fatal|Fatalf|Error|Errorf)\b|\bshould[.(])'; then
    return 0
  fi
  # Removed a test or leg declaration (deleting what a check covers).
  if printf '%s\n' "$diff" | grep -qE '^-[^-].*(\bfunc Test[A-Z]|\bit\(|\btest\(|\bdescribe\(|\bleg\()'; then
    return 0
  fi
  # Added a skip/pending marker (disabling a check without deleting it).
  if printf '%s\n' "$diff" | grep -qE '^\+[^+].*(\.skip\(|\bxit\(|\bxdescribe\(|\bit\.skip|\bdescribe\.skip|\btest\.skip|\bt\.Skip(Now)?\()'; then
    return 0
  fi
  return 1
}

# _heal_touches_product_surface <co> <a> <b> — 0 if a changed file is a product-
# behaviour surface (refusal rule 3). No-op (always 1) when no surface globs are
# declared. A changed path trips the rule only when it matches a surface glob AND
# is neither a test file nor an exempt (fixture/testdata) path.
_heal_touches_product_surface() {
  local co="$1" a="$2" b="$3" f g surfaces exempt is_exempt hit=1 had_noglob=1
  surfaces="${HEAL_PRODUCT_SURFACE_GLOBS:-}"
  [ -n "${surfaces//[[:space:]]/}" ] || return 1
  exempt="${HEAL_PRODUCT_SURFACE_EXEMPT_GLOBS:-}"
  # The globs are `case` patterns, never paths — but `for g in $surfaces`
  # word-splits AND pathname-expands, so `internal/*` would glob against the
  # cwd (e.g. a real internal/ dir in the repo the drive runs from) and iterate
  # actual files instead of the literal pattern, so `case` never matches (the
  # rule silently no-ops in exactly the product repos it exists for). Disable
  # pathname expansion around the split; restore the caller's setting.
  case $- in *f*) had_noglob=0 ;; esac
  set -f
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    # Test plumbing is fair game.
    printf '%s' "$f" | grep -qE "$HEAL_TEST_FILE_RE" && continue
    # Fixtures/testdata/stories are fair game.
    is_exempt=false
    for g in $exempt; do
      # shellcheck disable=SC2254
      case "$f" in $g) is_exempt=true; break ;; esac
    done
    [ "$is_exempt" = true ] && continue
    for g in $surfaces; do
      # shellcheck disable=SC2254
      case "$f" in $g) hit=0; break ;; esac
    done
    [ "$hit" = 0 ] && break
  done < <(git -C "$co" diff --name-only "$a..$b" 2>/dev/null)
  [ "$had_noglob" = 0 ] || set +f
  return "$hit"
}

# heal_rails <co> <pre_head> — accept HEAD as a healed commit, or reset to
# <pre_head>, name the rule in HEAL_RAIL_REASON, and fail. Rules (all reset +
# fail): exactly 1 commit; ≤3 files; ≤400 changed NON-TEST lines (#1144, raised
# from 200 — phase-5's real fixes were 113–255 lines and the cap kept reverting
# correct heals the swarm then re-landed); never touch the healer's own harness;
# never weaken a check (refusal rule 1); never change a product surface (rule 3).
# The line cap was 60 until 2026-08-28, then 200 (09d2ea0e), now 400. Test files
# (`*_test.*`, `*.test.*`, `*.spec.*`) don't count toward the line cap — counting
# them penalised the disciplined heals. The 3-file cap still bounds blast radius
# (GOTCHAS #101).
HEAL_LINE_CAP="${HEAL_LINE_CAP:-400}"
heal_rails() {
  local co="$1" pre="$2" head files lines
  HEAL_RAIL_REASON=""; HEAL_RAIL_SWARMABLE=""
  head="$(git -C "$co" rev-parse HEAD)"
  if [ "$head" = "$pre" ]; then
    HEAL_RAIL_REASON="no commit"; HEAL_RAIL_SWARMABLE=false
    echo "healer: claimed healed but committed nothing"
    return 1
  fi
  if [ "$(git -C "$co" rev-list --count "$pre..$head")" -gt 1 ]; then
    HEAL_RAIL_REASON="multiple commits"; HEAL_RAIL_SWARMABLE=false
    echo "healer: multiple commits — reverting"
    git -C "$co" reset --hard "$pre" >/dev/null
    return 1
  fi
  # Self-modification of the harness that judges the heal — a hard refusal.
  if git -C "$co" diff --name-only "$pre..$head" \
      | grep -qE '^\.sandcastle/rehearsal-|^\.forgejo/workflows/'; then
    HEAL_RAIL_REASON="self-modification"; HEAL_RAIL_SWARMABLE=false
    echo "healer: self-modification attempt — reverting"
    git -C "$co" reset --hard "$pre" >/dev/null
    return 1
  fi
  # Refusal rule 1: never weaken what a check proves (assertion/leg/skip).
  if _heal_weakens_check "$co" "$pre" "$head"; then
    HEAL_RAIL_REASON="assertion rule"; HEAL_RAIL_SWARMABLE=false
    echo "healer: fix would weaken a check (assertion/leg/skip) — reverting and filing"
    git -C "$co" reset --hard "$pre" >/dev/null
    return 1
  fi
  # Refusal rule 3: never change a product-behaviour surface.
  if _heal_touches_product_surface "$co" "$pre" "$head"; then
    HEAL_RAIL_REASON="product-behaviour surface"; HEAL_RAIL_SWARMABLE=false
    echo "healer: fix touches a product-behaviour surface — reverting and filing"
    git -C "$co" reset --hard "$pre" >/dev/null
    return 1
  fi
  files="$(git -C "$co" diff --name-only "$pre..$head" | grep -c . || true)"
  lines="$(git -C "$co" diff --numstat "$pre..$head" \
    | grep -vE '(_test\.[A-Za-z]+|\.test\.[A-Za-z]+|\.spec\.[A-Za-z]+)$' \
    | awk '{s+=$1+$2} END{print s+0}')"
  if [ "$files" -gt 3 ]; then
    HEAL_RAIL_REASON="3-file cap"; HEAL_RAIL_SWARMABLE=true
    echo "healer: diff cap breach ($files files; cap 3) — reverting"
    git -C "$co" reset --hard "$pre" >/dev/null
    return 1
  fi
  if [ "$lines" -gt "$HEAL_LINE_CAP" ]; then
    HEAL_RAIL_REASON="line cap (>$HEAL_LINE_CAP non-test lines)"; HEAL_RAIL_SWARMABLE=true
    echo "healer: diff cap breach ($lines non-test lines; cap $HEAL_LINE_CAP) — reverting"
    git -C "$co" reset --hard "$pre" >/dev/null
    return 1
  fi
  return 0
}

# rehearsal_heal_authed_url <url> — inject the same non-interactive
# `swarm:$FORGEJO_TOKEN` credential git-setup.sh's worker checkouts already
# use for git.matou.nz (#676: the healer's dedicated checkout clones/pushes
# with a bare `https://git.matou.nz/...` origin — no username, no credential
# helper, no GIT_ASKPASS — so a headless `git push` blocks on a username
# prompt and dies; that stranded the already-computed, already-validated fix
# e920f9e7 until it was landed by hand in #675). Only rewrites a plain
# git.matou.nz https URL with no userinfo yet; a local path (the test
# fixtures' bare origins) or an already-credentialed URL pass through
# unchanged, so this is safe to call unconditionally on every heal.
rehearsal_heal_authed_url() {
  case "$1" in
    https://git.matou.nz/*) printf 'https://swarm:%s@%s' "${FORGEJO_TOKEN:-}" "${1#https://}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# heal_push <co> <pre_head> <run_dir> — land the healer's single commit on
# origin/main even when main advanced under us (a concurrent operator or swarm
# push): fetch + rebase onto origin/main, re-run the rails against the replayed
# commit, then push; retry once if a further push lands during our rebase. A
# rebase conflict, a post-rebase cap/self-mod breach, a push still refused after
# the retry, or a commit that never reaches the remote all reset to <pre_head>
# and fail (the caller files). On success the healed commit is verified present
# on origin/main (spec rail 4). Without this a correct heal is silently lost to a
# non-fast-forward whenever main moves under the session — it lost three correct
# heals on 2026-08-11/12 (#460).
heal_push() {
  local co="$1" pre="$2" run_dir="$3" attempt base head errlog
  errlog="$run_dir/logs/healer-claude.err"
  for attempt in 1 2; do
    git -C "$co" fetch -q origin main >>"$errlog" 2>&1 || true
    if ! git -C "$co" rebase origin/main >>"$errlog" 2>&1; then
      git -C "$co" rebase --abort >/dev/null 2>&1 || true
      echo "healer: rebase onto origin/main conflicted — reverting and filing"
      git -C "$co" reset --hard "$pre" >/dev/null 2>&1 || true
      return 1
    fi
    # The commit is now replayed atop origin/main, so re-validate it against its
    # NEW parent (HEAD~1) — not the stale pre_head, which would fold main's
    # advance into the diff and false-breach the cap. On breach heal_rails
    # resets to that parent (origin/main's tip), discarding only the heal.
    base="$(git -C "$co" rev-parse HEAD~1)"
    if ! heal_rails "$co" "$base"; then
      git -C "$co" reset --hard "$pre" >/dev/null 2>&1 || true
      return 1
    fi
    if git -C "$co" push origin HEAD:main >>"$errlog" 2>&1; then
      head="$(git -C "$co" rev-parse HEAD)"
      if git -C "$co" ls-remote origin main 2>/dev/null | grep -q "^$head"; then
        return 0
      fi
      echo "healer: push reported ok but commit absent from origin/main — reverting and filing"
      git -C "$co" reset --hard "$pre" >/dev/null 2>&1 || true
      return 1
    fi
    echo "healer: push refused (attempt $attempt) — re-fetching and rebasing"
  done
  echo "healer: push still refused after rebase retry — reverting and filing"
  git -C "$co" reset --hard "$pre" >/dev/null 2>&1 || true
  return 1
}

# scrub_commit_message <co> — amend HEAD's message: Forgejo auto-close keywords
# become "advances #N" (the hazard has fired twice: even DESCRIBING a close
# closes), and the "rehearsal healer: " prefix is enforced.
scrub_commit_message() {
  local co="$1" msg
  msg="$(git -C "$co" log -1 --pretty=%B)"
  if grep -qiE '\b(close[sd]?|fix(e[sd])?|resolve[sd]?)[[:space:]]*#[0-9]+' <<<"$msg"; then
    msg="$(sed -E 's/\b([Cc]lose[sd]?|[Ff]ix(e[sd])?|[Rr]esolve[sd]?)[[:space:]]*#/advances #/g' <<<"$msg")"
  fi
  case "$msg" in
    "rehearsal healer: "*) ;;
    *) msg="rehearsal healer: $msg" ;;
  esac
  git -C "$co" commit --amend -qm "$msg"
}

# Consecutive MECHANICAL failure counter per FAULT (gate/cap rejects only —
# judgment declines never count). Two force filing (spec rail 6). The key is
# the caller's choice: the reporter passes a leg+error fault key, NOT the
# leg-keyed incident signature — on 2026-08-28 two cap breaches on two
# unrelated `join` faults (#936, #937) locked the whole leg out, so #938 and
# #939 were filed without a heal attempt, and the lock never expired.
_heal_fail_file() { echo "${REHEARSAL_STATE:?REHEARSAL_STATE unset}/heal-fail-$1"; }
heal_fail_count() { local f; f="$(_heal_fail_file "$1")"; [ -f "$f" ] && cat "$f" || echo 0; }
heal_fail_mark()  { local f; f="$(_heal_fail_file "$1")"; echo "$(( $(heal_fail_count "$1") + 1 ))" > "$f"; }
heal_fail_clear() { rm -f "$(_heal_fail_file "$1")"; }

# LOOP-GUARD (#1144 rail-6 lockout semantics): a fault that was HEALED on a prior
# drive and reds again is a failed heal — the second red for one signature goes
# straight to ticket-on-refusal, never a second heal attempt (no heal loops). A
# successful heal marks its fault here; the next drive's try_heal refuses to heal
# a marked fault and files instead. Keyed on the same leg::error fault key as the
# mechanical counter. Distinct from heal_fail_* (which counts RAILS rejections,
# not landed-then-reredded heals), so the two never confuse each other.
_heal_healed_file() { echo "${REHEARSAL_STATE:?REHEARSAL_STATE unset}/heal-healed-$1"; }
heal_healed_count() { local f; f="$(_heal_healed_file "$1")"; [ -f "$f" ] && cat "$f" || echo 0; }
heal_healed_mark()  { local f; f="$(_heal_healed_file "$1")"; echo "$(( $(heal_healed_count "$1") + 1 ))" > "$f"; }
heal_healed_clear() { rm -f "$(_heal_healed_file "$1")"; }
