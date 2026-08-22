#!/usr/bin/env bash
# Unit tests for smoke-drive-lib.sh — the pure leg-planning / artifact-shaping
# logic of the smoke driver. Runs offline (no KERI/any-sync/Playwright), so it
# is the sandbox-verifiable half of Matou/matou-app#41. Requires `jq`.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=smoke-drive-lib.sh
. "$here/smoke-drive-lib.sh"

pass=0 fail=0
ok()   { pass=$((pass+1)); printf 'ok   %s\n' "$1"; }
bad()  { fail=$((fail+1)); printf 'FAIL %s\n     expected: %s\n     actual:   %s\n' "$1" "$2" "$3"; }
eq()   { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

# ---- sd_repo_tag ----------------------------------------------------------
eq "repo_tag: REPO_SLUG wins"        Matou-matou-app "$(sd_repo_tag Matou/matou-app https://x/api/v1/repos/Other/repo git@h:zz/qq.git)"
eq "repo_tag: from FORGEJO_API"      Matou-matou-app "$(sd_repo_tag "" https://git.matou.nz/api/v1/repos/Matou/matou-app "")"
eq "repo_tag: from https remote"     Matou-matou-app "$(sd_repo_tag "" "" https://swarm:tok@git.matou.nz/Matou/matou-app.git)"
eq "repo_tag: from ssh remote"       Matou-matou-app "$(sd_repo_tag "" "" git@git.matou.nz:Matou/matou-app.git)"
eq "repo_tag: idss slug"             Matou-idss      "$(sd_repo_tag Matou/idss "" "")"
eq "repo_tag: non-api url ignored"   ""              "$(sd_repo_tag "" https://git.matou.nz/health "")"
eq "repo_tag: nothing -> empty"      ""              "$(sd_repo_tag "" "" "")"

# ---- sd_leg_error ---------------------------------------------------------
# A realistic Playwright red log: a failure summary block, preceded by the
# non-fatal ?type=ixn console noise (#51) that the OLD grep would have grabbed.
cat > "$tmp/red.log" <<'LOG'
Running 1 test using 1 worker
[chromium] POST http://localhost:9080/api/v1/anchor?type=ixn => 500 FAILED
  ✘  1 [features] › tests/e2e/features/issue-46.spec.ts:12:5 › feature › renders the marker (5.0s)


  1) [features] › tests/e2e/features/issue-46.spec.ts:12:5 › feature › renders the marker ─────

    Error: expect(locator).toBeVisible() failed

    Locator: getByText('marker')
    Expected: visible

  1 failed
LOG
err="$(sd_leg_error "$tmp/red.log" 1)"
case "$err" in *"toBeVisible"*) ok "leg_error: carries the assertion detail";; *) bad "leg_error: carries the assertion detail" "*toBeVisible*" "$err";; esac
case "$err" in *"issue-46.spec.ts:12:5"*) ok "leg_error: carries the failing test header";; *) bad "leg_error: carries the failing test header" "*issue-46.spec.ts:12:5*" "$err";; esac
case "$err" in *"?type=ixn"*) bad "leg_error: excludes the ?type=ixn noise" "no ?type=ixn" "$err";; *) ok "leg_error: excludes the ?type=ixn noise";; esac
# No summary block (a crash before Playwright reports): fall back to error grep.
printf 'boot\nError: backend never became healthy\nbye\n' > "$tmp/crash.log"
eq "leg_error: falls back to error grep" \
  "Error: backend never became healthy" "$(sd_leg_error "$tmp/crash.log" 1)"
# Nothing error-ish at all: a bare exit note keyed on the code.
printf 'all quiet\n' > "$tmp/quiet.log"
eq "leg_error: bare exit note when nothing matches" \
  "playwright exited 7" "$(sd_leg_error "$tmp/quiet.log" 7)"

# ---- sd_detect_base -------------------------------------------------------
printf '// smoke-base: b\nimport ...\n'   > "$tmp/b.spec.ts"
printf '// smoke-base:a\n'                 > "$tmp/a.spec.ts"
printf 'no marker here\n'                  > "$tmp/none.spec.ts"
printf '// smoke-base: q  garbage\n'       > "$tmp/bad.spec.ts"
eq "detect_base: marker b"        b "$(sd_detect_base "$tmp/b.spec.ts")"
eq "detect_base: marker a"        a "$(sd_detect_base "$tmp/a.spec.ts")"
eq "detect_base: no marker -> a"  a "$(sd_detect_base "$tmp/none.spec.ts")"
eq "detect_base: bad marker -> a" a "$(sd_detect_base "$tmp/bad.spec.ts")"
eq "detect_base: missing file -> a" a "$(sd_detect_base "$tmp/nope.spec.ts")"
eq "detect_base: empty arg -> a"  a "$(sd_detect_base "")"

# ---- sd_resolve_base ------------------------------------------------------
eq "resolve_base: explicit a wins"        a "$(sd_resolve_base a "$tmp/b.spec.ts")"
eq "resolve_base: explicit b wins"        b "$(sd_resolve_base b "$tmp/a.spec.ts")"
eq "resolve_base: no override -> marker"  b "$(sd_resolve_base "" "$tmp/b.spec.ts")"
eq "resolve_base: bare lap -> a"          a "$(sd_resolve_base "" "")"

# ---- sd_plan_legs ---------------------------------------------------------
eq "plan a bare: 1 leg" \
  "org-setup" \
  "$(sd_plan_legs a "" | cut -f1 | paste -sd, -)"
eq "plan b bare: 3 legs" \
  "org-setup,registration,invitation" \
  "$(sd_plan_legs b "" | cut -f1 | paste -sd, -)"
eq "plan a + feature: inserts registration-member bootstrap" \
  "org-setup,registration-member,feature-issue-41" \
  "$(sd_plan_legs a 41 | cut -f1 | paste -sd, -)"
eq "plan b + feature: no bootstrap, feature appended" \
  "org-setup,registration,invitation,feature-issue-41" \
  "$(sd_plan_legs b 41 | cut -f1 | paste -sd, -)"
eq "plan: feature leg carries the spec file filter" \
  "tests/e2e/features/issue-41.spec.ts" \
  "$(sd_plan_legs a 41 | awk -F'\t' '$1=="feature-issue-41"{print $3}')"
eq "plan: feature leg uses the features project" \
  "features" \
  "$(sd_plan_legs a 41 | awk -F'\t' '$1=="feature-issue-41"{print $2}')"

# ---- sd_leg_record --------------------------------------------------------
green="$(sd_leg_record org-setup green 1200 "")"
eq "leg_record green: leg"        org-setup "$(jq -r .leg <<<"$green")"
eq "leg_record green: status"     green     "$(jq -r .status <<<"$green")"
eq "leg_record green: ms"         1200      "$(jq -r .ms <<<"$green")"
eq "leg_record green: no error key" true    "$(jq -r 'has("error")|not' <<<"$green")"
red="$(sd_leg_record invitation red 800 "timed out waiting for invite")"
eq "leg_record red: status"       red       "$(jq -r .status <<<"$red")"
eq "leg_record red: error kept"   "timed out waiting for invite" "$(jq -r .error <<<"$red")"
bogus="$(sd_leg_record x green "" "")"
eq "leg_record: empty ms -> 0"    0         "$(jq -r .ms <<<"$bogus")"

# ---- sd_legs_array --------------------------------------------------------
ld="$tmp/legs.d"; mkdir -p "$ld"
eq "legs_array: empty dir -> []" "[]" "$(sd_legs_array "$ld")"
sd_leg_record org-setup green 10 ""            > "$ld/01-org-setup.json"
sd_leg_record invitation red 20 "boom"         > "$ld/02-invitation.json"
arr="$(sd_legs_array "$ld")"
eq "legs_array: run order preserved" \
  "org-setup,invitation" \
  "$(jq -r '[.[].leg]|join(",")' <<<"$arr")"
eq "legs_array: red leg selectable (reporter path)" \
  "invitation" \
  "$(jq -r '.[]|select(.status=="red")|.leg' <<<"$arr")"

# ---- sd_verdict_json ------------------------------------------------------
v="$(sd_verdict_json red a 41 20260820T010203Z 3 1 deadbeefcafe)"
eq "verdict: .verdict"    red          "$(jq -r .verdict <<<"$v")"
eq "verdict: .tier"       smoke        "$(jq -r .tier <<<"$v")"
eq "verdict: .base"       a            "$(jq -r .base <<<"$v")"
eq "verdict: .feature"    41           "$(jq -r .feature <<<"$v")"
eq "verdict: .legs_total" 3            "$(jq -r .legs_total <<<"$v")"
eq "verdict: .legs_red"   1            "$(jq -r .legs_red <<<"$v")"
eq "verdict: .sha"        deadbeefcafe "$(jq -r .sha <<<"$v")"
# sha is optional (omitted arg -> empty field), so runs outside a checkout still
# emit a well-formed verdict.
eq "verdict: .sha empty when absent" "" "$(jq -r .sha <<<"$(sd_verdict_json green a "" 20260820T010203Z 1 0)")"

# ---------------------------------------------------------------------------
printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
