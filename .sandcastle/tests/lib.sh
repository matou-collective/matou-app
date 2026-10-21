#!/usr/bin/env bash
# tests/lib.sh — the offline suite's shared assertion + fixture vocabulary (#211).
#
# The suite grew ~87 test scripts that each re-declare the same handful of
# helpers: a `pass`/`fail` counter, the `check <desc> <cond>` asserter, an
# `mktemp -d` + trap, and an ad-hoc PATH shim dir. This file is the one copy.
# Source it right after `set -u` and the `here=` line:
#
#     set -u
#     here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#     # shellcheck source=lib.sh
#     . "$here/lib.sh"
#     ...
#     check "a true condition counts a pass" 'true'
#     echo "my-test: $pass passed, $fail failed"
#     [ "$fail" -eq 0 ]
#
# It keeps the suite's contract (CLAUDE.md): no docker, no network — `shim`
# builds the fake curl/claude the tests already hand-roll, under a temp dir
# this file removes on EXIT. It is vendored byte-identical into every consumer
# (tests/** in onboarding/vendor-manifest), so it names no repo, host or path.
#
# Run directly (`bash tests/lib.sh`) it is its OWN test: the self-guard at the
# foot exercises check/fail/tmpdir/shim, so a regression here reds the suite
# (the `tests/test-env.sh` sibling precedent — a lib that carries its own test).

# ── the pass/fail counter + asserters ───────────────────────────────────────
# `pass` and `fail` are the counters the dominant idiom already reads in its
# closing `echo "...: $pass passed, $fail failed"; [ "$fail" -eq 0 ]`; keeping
# the names means a test migrates by deleting its local copies of these three
# lines and sourcing this file — no behaviour change.
pass=0
fail=0

# ok — record one pass.
ok() { pass=$((pass + 1)); }

# fail <msg…> — record one failure and print it (the first-class failure
# reporter). Non-exiting, so the counter can tally every failing case in a run
# rather than stopping at the first; the closing `[ "$fail" -eq 0 ]` is what
# turns a non-zero tally into a red.
fail() {
  fail=$((fail + 1))
  echo "FAIL: $*" >&2
}

# check <desc> <cond> — eval <cond> (a string, as the existing idiom passes it);
# count a pass on success, else report <desc> as a failure.
check() {
  if eval "$2"; then
    ok
  else
    fail "$1"
  fi
}

# summary [label] — print the tally and return non-zero if anything failed.
# Optional convenience: a test may keep its own closing line instead.
summary() {
  local label="${1:-$(basename -- "$0" .sh)}"
  echo "$label: $pass passed, $fail failed"
  [ "$fail" -eq 0 ]
}

# ── temp dirs + PATH shims, cleaned on EXIT ─────────────────────────────────
# Every temp dir lives under ONE per-process root. `$$` is the parent shell's
# PID even inside a `$(…)` subshell, so `d="$(tmpdir)"` returns a dir that
# OUTLIVES the substitution — a per-call trap would (and a first draft did)
# delete the dir on the subshell's own EXIT. The single root trap below, armed
# in the parent at source time, removes the whole tree at the real exit.
_LIB_ROOT="${TMPDIR:-/tmp}/sandcastle-test.$$"
_LIB_SHIMDIR=""

_lib_cleanup() {
  [ -n "${_LIB_ROOT:-}" ] && rm -rf "$_LIB_ROOT"
  # Run whatever EXIT handler was set before we were sourced, so this file
  # never silently drops a test's own cleanup.
  [ -n "${_LIB_PREV_EXIT:-}" ] && eval "$_LIB_PREV_EXIT"
}

# Chain any pre-existing EXIT handler, then arm ours. A test that sets its OWN
# `trap … EXIT` AFTER sourcing this file replaces this one — fine for the
# common case (such tests manage their own `mktemp -d` and never call tmpdir,
# so the root is never created); a test that uses tmpdir/shim should not also
# install its own EXIT trap.
_LIB_PREV_EXIT="$(trap -p EXIT)"
_LIB_PREV_EXIT="${_LIB_PREV_EXIT#trap -- \'}"
_LIB_PREV_EXIT="${_LIB_PREV_EXIT%\' EXIT}"
trap _lib_cleanup EXIT

# tmpdir — make a fresh temp dir under the per-process root and print it.
# The root is created on first use, so a test that never calls tmpdir leaves
# no empty dir behind.
tmpdir() {
  mkdir -p "$_LIB_ROOT"
  mktemp -d "$_LIB_ROOT/d.XXXXXX"
}

# shim <name> — read a script body from stdin into an executable <name> on a
# PATH dir prepended once, so a test can stand up a fake curl/claude/binary:
#
#     shim curl <<'SH'
#     echo '{"ok":true}'
#     SH
#
# A body with no `#!` line gets a bash shebang.
shim() {
  local name="$1" body
  if [ -z "$_LIB_SHIMDIR" ]; then
    _LIB_SHIMDIR="$(tmpdir)"
    PATH="$_LIB_SHIMDIR:$PATH"
    export PATH
  fi
  body="$(cat)"
  case "$body" in
    '#!'*) : ;;
    *) body="#!/usr/bin/env bash
$body" ;;
  esac
  printf '%s\n' "$body" >"$_LIB_SHIMDIR/$name"
  chmod +x "$_LIB_SHIMDIR/$name"
}

# ── self-guard: only when executed directly, never when sourced ─────────────
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  set -u
  g=0
  # An asserter INDEPENDENT of the helpers under test, so a broken check/fail
  # cannot launder its own regression into a green.
  must() { if eval "$2"; then g=$((g + 1)); else echo "FAIL: $1" >&2; exit 1; fi; }

  # A log file for the reporter output. Redirect the counter-mutating calls to
  # it rather than capturing in `$(...)`, which would run them in a subshell
  # and lose the increment — the one real gotcha of a counter helper.
  log="$(tmpdir)/log"

  # check: a true cond counts a pass and nothing else.
  check "a true cond passes" 'true'
  must "check counts the pass" '[ "$pass" -eq 1 ] && [ "$fail" -eq 0 ]'

  # check: a false cond counts a fail and prints the description.
  check "deliberately false" 'false' 2>"$log"
  must "check counts the fail" '[ "$fail" -eq 1 ] && [ "$pass" -eq 1 ]'
  must "check prints the description" 'grep -q "FAIL: deliberately false" "$log"'

  # fail: the standalone reporter tallies and prints too.
  fail "a bare failure" 2>>"$log"
  must "fail tallies" '[ "$fail" -eq 2 ]'
  must "fail prints to stderr" 'grep -q "FAIL: a bare failure" "$log"'

  # tmpdir: a real, writable dir.
  d="$(tmpdir)"
  must "tmpdir makes a dir" '[ -d "$d" ]'
  : >"$d/probe"
  must "tmpdir is writable" '[ -f "$d/probe" ]'

  # shim: an executable on PATH that runs the given body (no shebang needed).
  shim factory-fake-cmd <<'SH'
echo shimmed-ok
SH
  must "shim runs with no shebang" '[ "$(factory-fake-cmd)" = "shimmed-ok" ]'

  echo "lib: $g self-checks passed"
fi
