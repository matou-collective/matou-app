#!/usr/bin/env bash
# Pure helpers for the smoke-tier e2e driver (Matou/matou-app#41). Source this
# file; no side effects, no network, no filesystem writes. Unit-tested in
# smoke-drive-lib-test.sh, which is runnable in the swarm sandbox (no infra).
#
# The driver satisfies the six-clause e2e-driver contract at the low-effort
# "smoke" tier (ruled by Ben, 2026-08-20, #41): one real journey composed of a
# base sub-journey plus a feature-showcase leg, emitting machine-readable
# per-leg artifacts (legs.json / verdict.json) that the vendored
# .sandcastle/rehearsal-report.sh reporter+healer can read WITHOUT re-running
# anything. Keeping the leg-planning and artifact-shaping logic here — pure and
# unit-tested — is what lets the driver be verified in a sandbox that cannot
# stand up KERI/any-sync.

# sd_repo_tag <repo-slug> <forgejo-api> <git-remote-url> — the repo tag the swarm
# healer keys its per-repo verdict marker on, derived the SAME way heal.sh derives
# REPO_TAG: REPO_SLUG when set, else FORGEJO_API's trailing `owner/name`, with a
# git-remote fallback for a hand-run outside the workflow (which sets neither).
# Slashes aren't valid in a path segment, so `Matou/matou-app` -> `Matou-matou-app`.
# Reader (heal.sh) and writer (run-smoke-drive.sh) must agree on the path
# /tmp/matou-<tag>-smoke-drive-verdict.txt, so this mirrors that formula exactly.
sd_repo_tag() {
  local slug="${1:-}" api="${2:-}" remote="${3:-}"
  if [ -z "$slug" ] && [ -n "$api" ]; then
    slug="${api##*/repos/}"
    [ "$slug" = "$api" ] && slug=""   # no /repos/ segment — not a Forgejo API url
  fi
  if [ -z "$slug" ] && [ -n "$remote" ]; then
    slug="$(printf '%s' "$remote" | sed -E 's#\.git$##; s#.*[/:]([^/]+/[^/]+)$#\1#')"
    [[ "$slug" =~ ^[^/]+/[^/]+$ ]] || slug=""   # unrecognised url shape
  fi
  printf '%s' "${slug//\//-}"
}

# sd_detect_base <spec-file> — a feature spec declares which base sub-journey it
# needs with a `smoke-base: a|b` marker comment (see README). `b` selects the
# membership growth loop (org-setup -> registration -> invitation) for features
# that exercise it; `a` (org-setup alone) is the minimal base otherwise. A
# missing / unreadable / unrecognised marker defaults to `a`.
sd_detect_base() {
  local spec="${1:-}" m
  [ -n "$spec" ] && [ -f "$spec" ] || { echo a; return; }
  m="$(sed -nE 's@.*smoke-base:[[:space:]]*([ab]).*@\1@p' "$spec" | head -1)"
  case "$m" in b) echo b ;; *) echo a ;; esac
}

# sd_resolve_base <explicit> <spec-file> — an explicit `--base a|b` wins; else
# the feature spec's marker decides (sd_detect_base); a bare standing lap with
# neither an override nor a feature spec resolves to `a`.
sd_resolve_base() {
  local explicit="${1:-}" spec="${2:-}"
  case "$explicit" in
    a|b) echo "$explicit"; return ;;
  esac
  sd_detect_base "$spec"
}

# sd_plan_legs <base> <feature-issue> — emit the ordered leg plan, one leg per
# line as `<leg-name><TAB><playwright-project><TAB><file-filter>`. Legs run as
# independent `--no-deps` Playwright invocations sequenced by the driver; disk
# state (tests/e2e/test-accounts.json, the test org on the backend) persists
# across invocations, so the legs compose exactly like the real journey.
#
# A base-`a` drive that carries a feature leg inserts the `registration-member`
# bootstrap the `features` project depends on (its fixtures need a member in
# test-accounts.json); a base-`b` drive's full `registration` leg already
# persists one, so no bootstrap is inserted there.
sd_plan_legs() {
  local base="${1:?}" feat="${2:-}"
  printf 'org-setup\torg-setup\t\n'
  if [ "$base" = b ]; then
    printf 'registration\tregistration\t\n'
    printf 'invitation\tinvitation\t\n'
  fi
  if [ -n "$feat" ]; then
    [ "$base" = a ] && printf 'registration-member\tregistration-member\t\n'
    printf 'feature-issue-%s\tfeatures\ttests/e2e/features/issue-%s.spec.ts\n' "$feat" "$feat"
  fi
}

# sd_leg_record <name> <status> <ms> <error> — one leg record as compact JSON,
# matching the contract's legs.json element shape: {leg,status,ms} plus an
# `error` field only on a red leg (so green records stay noise-free). <ms> must
# be a non-negative integer; empty/absent -> 0.
sd_leg_record() {
  local name="${1:?}" status="${2:?}" ms="${3:-0}" error="${4:-}"
  [[ "$ms" =~ ^[0-9]+$ ]] || ms=0
  jq -cn --arg leg "$name" --arg status "$status" --argjson ms "$ms" --arg error "$error" \
    '{leg:$leg, status:$status, ms:$ms} + (if $error == "" then {} else {error:$error} end)'
}

# sd_leg_error <log-file> <exit-code> — the actionable error for a red leg's
# legs.json record. Playwright's line/list reporter ends a failed run with a
# failure summary listing each failing test as an `  N) [project] › file:line ›
# title` header followed by the assertion detail; the FIRST such block (the first
# failing test) is the real fault. Extract it — NOT the trailing console `FAILED`
# line, which today echoes the non-fatal `?type=ixn` request noise the app logs
# during a run (matou-app#51). Falls back to the legacy error-ish grep, then to a
# bare exit note, so a leg that dies before Playwright prints a summary (a crash,
# a killed process) still records something.
sd_leg_error() {
  local log="${1:-}" rc="${2:-1}" block=""
  if [ -n "$log" ] && [ -f "$log" ]; then
    block="$(awk '
      /^[[:space:]]*[0-9]+\)[[:space:]]/ { if (grab) exit; grab=1 }
      grab { lines[++n]=$0; if (n>=14) exit }
      END { while (n>0 && lines[n] ~ /^[[:space:]]*$/) n--; for (i=1;i<=n;i++) print lines[i] }
    ' "$log" 2>/dev/null)"
  fi
  if [ -z "$block" ]; then
    block="$(grep -m1 -E 'Error|error|FAIL|timed out|✘|✖' "$log" 2>/dev/null | tail -c 400)"
  fi
  [ -n "$block" ] || block="playwright exited $rc"
  printf '%s' "$block" | head -c 600
}

# sd_legs_array <legs-dir> — concatenate the per-leg record files (`NN-*.json`,
# whose zero-padded prefixes sort into run order) into the legs.json array. An
# empty / absent dir yields `[]`.
sd_legs_array() {
  local dir="${1:?}"
  if compgen -G "$dir"/*.json >/dev/null 2>&1; then
    jq -s '.' "$dir"/*.json
  else
    echo '[]'
  fi
}

# sd_verdict_json <green|red> <base> <feature> <stamp> <legs-total> <legs-red> [sha] —
# the authoritative run verdict (contract clause 5): the reporter reads `.verdict`
# and trusts it over any out-of-band exit code. The extra fields are for humans
# reading the run dir. `sha` records the exact tree the lap drove (the dispatched
# ref's tip, matou-app#49) so a green/red can never be mistaken for a test of a
# different tree; empty when the driver runs outside a git checkout.
sd_verdict_json() {
  local verdict="${1:?}" base="${2:?}" feature="${3:-}" stamp="${4:?}" total="${5:-0}" red="${6:-0}" sha="${7:-}"
  [[ "$total" =~ ^[0-9]+$ ]] || total=0
  [[ "$red" =~ ^[0-9]+$ ]] || red=0
  jq -cn --arg verdict "$verdict" --arg base "$base" --arg feature "$feature" \
    --arg stamp "$stamp" --argjson total "$total" --argjson red "$red" --arg sha "$sha" \
    '{verdict:$verdict, tier:"smoke", base:$base, feature:$feature, sha:$sha, stamp:$stamp, legs_total:$total, legs_red:$red}'
}
