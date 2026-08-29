#!/usr/bin/env bash
# The rehearsal healer's rails (spec 2026-08-10-rehearsal-healer-design):
# pure functions over an explicit checkout — the PROMPT guides the healer
# session, these functions are LAW. Sourced by rehearsal-report.sh; unit-tested
# in isolation (tests/rehearsal-heal-lib-test.sh).

# heal_rails <co> <pre_head> — accept HEAD as a healed commit, or reset to
# <pre_head> and fail. Caps per Ben's rulings: ≤3 files, ≤200 changed
# NON-TEST lines, exactly 1 commit, never touching the healer's own harness.
# The line cap was 60 until 2026-08-28: on the #854 device drive it reverted
# two CORRECT heals (89 and 152 lines, one carrying a red-then-green
# regression test) that the swarm then re-landed at 155 and 227 lines — every
# real fix that night was 113–255 lines, while the only heals the cap ever let
# through were 3, 14 and 50 lines. Test files (`*_test.*`, `*.test.*`,
# `*.spec.*`) no longer count toward the line cap at all: counting them
# penalised exactly the disciplined heals. The 3-file cap still bounds the
# blast radius (GOTCHAS #101).
HEAL_LINE_CAP="${HEAL_LINE_CAP:-200}"
heal_rails() {
  local co="$1" pre="$2" head files lines
  head="$(git -C "$co" rev-parse HEAD)"
  if [ "$head" = "$pre" ]; then
    echo "healer: claimed healed but committed nothing"
    return 1
  fi
  if [ "$(git -C "$co" rev-list --count "$pre..$head")" -gt 1 ]; then
    echo "healer: multiple commits — reverting"
    git -C "$co" reset --hard "$pre" >/dev/null
    return 1
  fi
  files="$(git -C "$co" diff --name-only "$pre..$head" | grep -c . || true)"
  lines="$(git -C "$co" diff --numstat "$pre..$head" \
    | grep -vE '(_test\.[A-Za-z]+|\.test\.[A-Za-z]+|\.spec\.[A-Za-z]+)$' \
    | awk '{s+=$1+$2} END{print s+0}')"
  if [ "$files" -gt 3 ] || [ "$lines" -gt "$HEAL_LINE_CAP" ]; then
    echo "healer: diff cap breach ($files files / $lines non-test lines; cap 3/$HEAL_LINE_CAP) — reverting"
    git -C "$co" reset --hard "$pre" >/dev/null
    return 1
  fi
  if git -C "$co" diff --name-only "$pre..$head" \
      | grep -qE '^\.sandcastle/rehearsal-|^\.forgejo/workflows/'; then
    echo "healer: self-modification attempt — reverting"
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
