#!/usr/bin/env bash
# Integration test for run-smoke-drive.sh's control flow and six-clause artifact
# emission, WITHOUT any real infra: a stub `npx` on PATH stands in for Playwright,
# writing a screenshot and exiting green/red per SMOKE_TEST_RED_PROJECT. Verifies
# the driver sequences legs, rewrites legs.json per leg, stops at the first red,
# and emits an authoritative verdict.json. Sandbox-runnable (needs `jq`).
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

pass=0 fail=0
ok()  { pass=$((pass+1)); printf 'ok   %s\n' "$1"; }
bad() { fail=$((fail+1)); printf 'FAIL %s\n     expected: %s\n     actual:   %s\n' "$1" "$2" "$3"; }
eq()  { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT

# Stub npx: emits a PNG into the (cwd-relative) results dir Playwright uses, then
# exits 1 iff --project matches SMOKE_TEST_RED_PROJECT, else 0.
mkdir -p "$work/bin"
cat > "$work/bin/npx" <<'STUB'
#!/usr/bin/env bash
# Parse both `--project=VALUE` and `--project VALUE`, as the driver uses the
# former.
proj=""; prev=""
for a in "$@"; do
  case "$a" in --project=*) proj="${a#--project=}";; esac
  [ "$prev" = --project ] && proj="$a"
  prev="$a"
done
mkdir -p tests/e2e/results
printf 'png' > "tests/e2e/results/${proj:-noproj}-shot.png"
echo "stub playwright: project=$proj"
if [ -n "${SMOKE_TEST_RED_PROJECT:-}" ] && [ "$proj" = "$SMOKE_TEST_RED_PROJECT" ]; then
  # Mimic Playwright's red output: non-fatal ?type=ixn console noise (#51) BEFORE
  # the numbered failure summary the driver must key on instead.
  echo "[chromium] POST http://localhost:9080/api/v1/anchor?type=ixn => 500 FAILED"
  echo "  1) [$proj] › tests/e2e/$proj.spec.ts:9:3 › $proj › stub assertion ─────"
  echo ""
  echo "    Error: stub red for $proj"
  echo ""
  echo "  1 failed"
  exit 1
fi
exit 0
STUB
chmod +x "$work/bin/npx"
export PATH="$work/bin:$PATH"

run() { # <run-dir> <extra-args...>
  local rd="$1"; shift
  # Isolate the healer verdict marker per run so assertions never race a real
  # /tmp path (#46).
  SMOKE_DRIVE_VERDICT_PATH="$rd.verdict" \
    bash "$here/run-smoke-drive.sh" --skip-infra --run-dir "$rd" "$@" >"$rd.out" 2>&1
  echo $?
}

# ---- green base-b drive ---------------------------------------------------
rd="$work/green"; rc="$(run "$rd" --base b)"
eq "green: rc 0" 0 "$rc"
eq "green: verdict.json green" green "$(jq -r .verdict "$rd/artifacts/verdict.json")"
eq "green: 3 legs recorded" "org-setup,registration,invitation" \
  "$(jq -r '[.[].leg]|join(",")' "$rd/artifacts/legs.json")"
eq "green: all green" "green,green,green" \
  "$(jq -r '[.[].status]|join(",")' "$rd/artifacts/legs.json")"
eq "green: legs_total=3" 3 "$(jq -r .legs_total "$rd/artifacts/verdict.json")"
[ -f "$rd/screenshots/org-setup/org-setup-shot.png" ] \
  && ok "green: per-leg screenshot harvested" \
  || bad "green: per-leg screenshot harvested" "org-setup-shot.png" "missing"
[ -f "$rd/logs/01-org-setup.txt" ] \
  && ok "green: per-leg log written" || bad "green: per-leg log" "01-org-setup.txt" "missing"
# A green drive leaves NO healer verdict marker (verdict-lib writes only on a
# non-zero exit; verdict_begin cleared any stale one) — #46.
[ ! -f "$rd.verdict" ] \
  && ok "green: no healer verdict marker" \
  || bad "green: no healer verdict marker" "absent" "present"

# ---- red drive stops at first red (clause 6) ------------------------------
rd="$work/red"; rc="$(SMOKE_TEST_RED_PROJECT=registration run "$rd" --base b)"
eq "red: rc 1" 1 "$rc"
eq "red: verdict.json red" red "$(jq -r .verdict "$rd/artifacts/verdict.json")"
eq "red: stops after registration (invitation never runs)" \
  "org-setup,registration" \
  "$(jq -r '[.[].leg]|join(",")' "$rd/artifacts/legs.json")"
eq "red: registration marked red" red \
  "$(jq -r '.[]|select(.leg=="registration")|.status' "$rd/artifacts/legs.json")"
eq "red: red leg carries error" true \
  "$(jq -r '.[]|select(.leg=="registration")|has("error")' "$rd/artifacts/legs.json")"
eq "red: legs_red=1" 1 "$(jq -r .legs_red "$rd/artifacts/verdict.json")"
[ ! -f "$rd/logs/03-invitation.txt" ] \
  && ok "red: invitation leg never executed" \
  || bad "red: invitation leg never executed" "no 03-invitation.txt" "present"
# The red leg's legs.json error carries the Playwright failure summary, not the
# non-fatal ?type=ixn console noise (#51).
regerr="$(jq -r '.[]|select(.leg=="registration")|.error' "$rd/artifacts/legs.json")"
case "$regerr" in *"stub assertion"*) ok "red: error carries the failure summary";;
  *) bad "red: error carries the failure summary" "*stub assertion*" "$regerr";; esac
case "$regerr" in *"?type=ixn"*) bad "red: error excludes ?type=ixn noise" "no ?type=ixn" "$regerr";;
  *) ok "red: error excludes ?type=ixn noise";; esac
# A red drive DID drop the healer verdict marker, keyed on the failing leg's
# stage + exit code (#46) — this is exactly what the healer folds into the
# incident signature instead of stale worker prose (#235).
if [ -f "$rd.verdict" ]; then
  ok "red: healer verdict marker written"
  v="$(cat "$rd.verdict")"
  case "$v" in *"exit=1"*) ok "red: verdict marker records exit=1";;
    *) bad "red: verdict marker records exit=1" "*exit=1*" "$v";; esac
  case "$v" in *"registration"*) ok "red: verdict marker keys on the red leg";;
    *) bad "red: verdict marker keys on the red leg" "*registration*" "$v";; esac
else
  bad "red: healer verdict marker written" "present" "absent"
fi

# ---- bare base-a lap (standing health lap) --------------------------------
rd="$work/bare"; rc="$(run "$rd")"
eq "bare: rc 0" 0 "$rc"
eq "bare: single org-setup leg" "org-setup" \
  "$(jq -r '[.[].leg]|join(",")' "$rd/artifacts/legs.json")"
eq "bare: base recorded a" a "$(jq -r .base "$rd/artifacts/verdict.json")"
# verdict.json records the driven tree's SHA (matou-app#49): the driver reads it
# from the checkout's git HEAD so a lap can never be mistaken for a test of a
# different tree.
eq "bare: verdict sha == git HEAD" \
  "$(git -C "$here" rev-parse HEAD 2>/dev/null || echo unknown)" \
  "$(jq -r .sha "$rd/artifacts/verdict.json")"

# ---------------------------------------------------------------------------
printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
