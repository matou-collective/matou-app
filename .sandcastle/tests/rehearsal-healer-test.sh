#!/usr/bin/env bash
# Offline test for the healer phase: drives the REAL rehearsal-report.sh with
# shimmed curl/claude and a REAL throwaway git checkout + bare origin, so
# commits, rails, and pushes are exercised for real (no network, no gate hooks).
# Run: bash .sandcastle/tests/rehearsal-healer-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/run/artifacts" "$tmp/run/logs" "$tmp/state"
export PATH="$tmp/bin:$PATH" FORGEJO_TOKEN=t REHEARSAL_STATE="$tmp/state" RACE_TMP="$tmp"
# Pin the drive issue: fixtures below are hardcoded to #378, but the ambient
# environment (host .sandcastle/.env, re-minted independently — #493) may
# export a different REHEARSAL_DRIVE_ISSUE. Without this the suite is not
# hermetic and breaks silently on every re-mint.
export REHEARSAL_DRIVE_ISSUE=378
export CLAUDE_LIMIT_MARKER="$tmp/claude-limit"
export CURL_LOG="$tmp/curl.log" ISSUE_FIXTURE="$tmp/issues.json" LIST_COUNT="$tmp/list-count"
export CLAUDE_CALLS="$tmp/claude-calls"
export REHEARSAL_HEAL_PROMPT_FILE="$here/../.sandcastle/rehearsal-heal-prompt.md"
export REHEARSAL_REPORT_PROMPT_FILE="$here/../.sandcastle/rehearsal-report-prompt.md"

# --- real checkout + bare origin ---------------------------------------------
mkrepo() { # (re)build $tmp/origin.git + $tmp/co, export REHEARSAL_CHECKOUT
  rm -rf "$tmp/origin.git" "$tmp/co"
  git init -q --bare "$tmp/origin.git"
  git init -q "$tmp/co"; (
    cd "$tmp/co"
    git config user.email t@t; git config user.name t
    echo base > wizard.ts; mkdir -p .sandcastle
    echo guard > .sandcastle/rehearsal-report.sh
    git add -A; git commit -qm base
    git remote add origin "$tmp/origin.git"
    git push -q origin HEAD:main
  )
  export REHEARSAL_CHECKOUT="$tmp/co"
}

# --- curl shim (same shape as rehearsal-report-test.sh) ----------------------
cat > "$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
echo "$@" >> "${CURL_LOG:?}"
want_code=false; is_dep=false; is_lab=false; prev=""; body=""
for a in "$@"; do
  [ "$prev" = "-d" ] && body="$a"
  case "$a" in -w) want_code=true;; */dependencies) is_dep=true;; */issues/*/labels) is_lab=true;; esac
  prev="$a"
done
if $is_dep; then $want_code && echo "${DEP_CODE:-201}"; exit 0; fi
if $is_lab; then $want_code && echo "${LABEL_CODE:-204}"; exit 0; fi
for a in "$@"; do case "$a" in
  *labels=rehearsal-183*) cat "${ISSUE_FIXTURE:?}"; exit 0;;
  *labels\?limit=100*) echo '[{"id":36,"name":"ready-for-agent"},{"id":37,"name":"ready-for-human"},{"id":40,"name":"bug"},{"id":97,"name":"rehearsal-183"},{"id":99,"name":"priority"}]'; exit 0;;
  */issues/378/comments\?limit=50) echo '[]'; exit 0;;
esac; done
echo '{"number": 991}'
SH
chmod +x "$tmp/bin/curl"

# --- claude shim: behaviour driven by HEAL_MODE ------------------------------
cat > "$tmp/bin/claude" <<'SH'
#!/usr/bin/env bash
echo x >> "${CLAUDE_CALLS:?}"
# Only the FIRST call is the tool-enabled healer session; any later call is
# the classic tool-less diagnosis and must not mutate the checkout.
if [ "$(wc -l < "$CLAUDE_CALLS")" != "1" ]; then
  echo '{"title":"post-heal diagnosis","body":"b","confident":false}'
  exit 0
fi
case "${HEAL_MODE:-legacy}" in
  healed-good)
    cd "${REHEARSAL_CHECKOUT:?}"
    if [ -n "${RACE_ADVANCE_CMD:-}" ]; then
      # Simulate a concurrent push landing WHILE this "session" is thinking —
      # the race window heal_push's own rebase-before-push exists to close.
      adv="${RACE_TMP:?}/race-adv"; rm -rf "$adv"
      git clone -q "$(git remote get-url origin)" "$adv" 2>/dev/null
      ( cd "$adv"; git config user.email t@t; git config user.name t
        git checkout -q main 2>/dev/null || git checkout -q -b main origin/main
        eval "$RACE_ADVANCE_CMD"; git add -A; git commit -qm "operator: concurrent"
        git push -q origin HEAD:main )
    fi
    sed -i 's/base/fixed/' wizard.ts
    git commit -aqm "rehearsal healer: S5 selector drift (sigT)"
    echo "{\"action\":\"healed\",\"commit\":\"$(git rev-parse HEAD)\",\"summary\":\"selector\",\"checks\":\"vitest wizard: pass\"}" ;;
  decline-file)
    echo '{"action":"file","title":"healer declined: real defect","body":"needs the swarm","confident":true}' ;;
  healed-wide)
    cd "${REHEARSAL_CHECKOUT:?}"
    for i in 1 2 3 4; do echo $i > "f$i.txt"; done
    git add -A; git commit -qm "rehearsal healer: too wide"
    echo "{\"action\":\"healed\",\"commit\":\"$(git rev-parse HEAD)\",\"summary\":\"wide\",\"checks\":\"none\"}" ;;
  healed-selfmod)
    cd "${REHEARSAL_CHECKOUT:?}"
    echo hacked >> .sandcastle/rehearsal-report.sh
    git commit -aqm "rehearsal healer: sly"
    echo "{\"action\":\"healed\",\"commit\":\"$(git rev-parse HEAD)\",\"summary\":\"sly\",\"checks\":\"none\"}" ;;
  healed-keyword)
    cd "${REHEARSAL_CHECKOUT:?}"
    sed -i 's/base/fixed/' wizard.ts
    git commit -aqm "closes #378 wizard fix"
    echo "{\"action\":\"healed\",\"commit\":\"$(git rev-parse HEAD)\",\"summary\":\"kw\",\"checks\":\"ok\"}" ;;
  healed-residual)
    cd "${REHEARSAL_CHECKOUT:?}"
    sed -i 's/base/fixed/' wizard.ts
    git commit -aqm "rehearsal healer: bar visibility (sigR)"
    echo "{\"action\":\"healed\",\"commit\":\"$(git rev-parse HEAD)\",\"summary\":\"bar hid the fault\",\"checks\":\"vitest: pass\",\"residual\":{\"title\":\"underlying supply fault\",\"body\":\"the real fault beneath the healed bar\",\"confident\":true}}" ;;
  legacy)
    echo '{"title":"legacy diagnosis","body":"b","confident":true}' ;;
esac
SH
chmod +x "$tmp/bin/claude"

red_run() {
  cat > "$tmp/run/artifacts/legs.json" <<EOF
[{"leg":"found","status":"red","ms":1,"error":"$1"}]
EOF
}
reset_case() {
  echo '[]' > "$ISSUE_FIXTURE"; : > "$CURL_LOG"; : > "$CLAUDE_CALLS"
  rm -f "$LIST_COUNT" "$tmp/state"/heal-fail-*   # fresh backstop state per case
  mkrepo
}

# 1: HEALED — commit reaches origin, #378 gets a healer comment, NO issue
#    filed, NO dependency wired (drive stays armed), reporter exits 0.
reset_case; export HEAL_MODE=healed-good
red_run "click timeout on continue"
bash "$here/../rehearsal-report.sh" "$tmp/run" 1 || fail "reporter exited non-zero"
[ "$(git -C "$tmp/origin.git" rev-list --count main)" = "2" ] || fail "healed commit did not reach origin"
grep -q '378/comments' "$CURL_LOG" || fail "no #378 healer comment"
grep -q 'rehearsal healer:' "$CURL_LOG" || fail "healer comment body missing prefix"
grep -q '"title"' "$CURL_LOG" && fail "an issue was filed on the healed path"
grep -q 'dependencies' "$CURL_LOG" && fail "a dependency was wired on the healed path"
[ "$(wc -l < "$CLAUDE_CALLS")" = "1" ] || fail "more than one claude call"
pass=$((pass+1))

# 2: DECLINE with a file-verdict — issue filed from the session's verdict,
#    dependency wired, exactly ONE claude call, origin untouched.
reset_case; export HEAL_MODE=decline-file
red_run "genuinely hard defect"
bash "$here/../rehearsal-report.sh" "$tmp/run" 1 || fail "reporter exited non-zero (decline)"
grep -q 'healer declined: real defect' "$CURL_LOG" || fail "file-verdict title not used"
grep -q 'dependencies' "$CURL_LOG" || fail "decline path did not wire the blocker"
[ "$(git -C "$tmp/origin.git" rev-list --count main)" = "1" ] || fail "origin moved on decline"
[ "$(wc -l < "$CLAUDE_CALLS")" = "1" ] || fail "decline made a second claude call"
pass=$((pass+1))

# 3: CAP BREACH — reverted, mechanical failure marked, generic issue filed,
#    origin untouched.
reset_case; export HEAL_MODE=healed-wide
red_run "wide fix temptation"
bash "$here/../rehearsal-report.sh" "$tmp/run" 1 || fail "reporter exited non-zero (cap)"
[ "$(git -C "$tmp/origin.git" rev-list --count main)" = "1" ] || fail "origin moved on cap breach"
[ "$(git -C "$tmp/co" rev-list --count HEAD)" = "1" ] || fail "checkout not reset on cap breach"
sig_now="$(grep -o 'rehearsal-sig: [a-f0-9]*' "$CURL_LOG" | head -1 | awk '{print $2}')"
[ "$(cat "$tmp/state/heal-fail-$sig_now" 2>/dev/null)" = "1" ] || fail "mechanical failure not marked"
grep -q '"title"' "$CURL_LOG" || fail "cap breach did not fall through to filing"
pass=$((pass+1))

# 4: SELF-MOD — reverted + filed (same shape as cap breach).
reset_case; export HEAL_MODE=healed-selfmod
red_run "sly self-edit"
bash "$here/../rehearsal-report.sh" "$tmp/run" 1 || fail "reporter exited non-zero (selfmod)"
[ "$(git -C "$tmp/origin.git" rev-list --count main)" = "1" ] || fail "origin moved on self-mod"
grep -q '"title"' "$CURL_LOG" || fail "self-mod did not fall through to filing"
pass=$((pass+1))

# 5: KEYWORD SCRUB — healed commit lands with "advances #378", never "closes".
reset_case; export HEAL_MODE=healed-keyword
red_run "keyword commit"
bash "$here/../rehearsal-report.sh" "$tmp/run" 1 || fail "reporter exited non-zero (kw)"
msg="$(git -C "$tmp/origin.git" log -1 --pretty=%B main)"
grep -qi 'closes #378' <<<"$msg" && fail "close keyword reached origin"
grep -q 'advances #378' <<<"$msg" || fail "keyword not rewritten"
grep -q '^rehearsal healer: ' <<<"$msg" || fail "prefix not enforced on push"
pass=$((pass+1))

# 6: KILL SWITCH — REHEARSAL_HEALER=0 restores today's path exactly: the
#    legacy diagnosis shim files, origin untouched, no healer log lines.
reset_case; export HEAL_MODE=legacy REHEARSAL_HEALER=0
red_run "kill switch"
out="$(bash "$here/../rehearsal-report.sh" "$tmp/run" 1)" || fail "reporter exited non-zero (kill)"
grep -q 'healer:' <<<"$out" && fail "healer ran despite kill switch"
grep -q '"title"' "$CURL_LOG" || fail "kill-switch path did not file"
[ "$(git -C "$tmp/origin.git" rev-list --count main)" = "1" ] || fail "origin moved with healer off"
unset REHEARSAL_HEALER
pass=$((pass+1))

# 7: BACKSTOP — a sig with 2 marked mechanical failures skips the heal
#    attempt entirely (claude still called once, for the classic diagnosis).
reset_case; export HEAL_MODE=healed-good
red_run "stubborn sig"
# pre-mark: same error → same leg → same sig as this run will compute
. "$here/../heal-lib.sh"; pre_sig="$(compute_signature "rehearsal-183" "found")"
echo 2 > "$tmp/state/heal-fail-$pre_sig"
out="$(bash "$here/../rehearsal-report.sh" "$tmp/run" 1)" || fail "reporter exited non-zero (backstop)"
grep -q 'backstop' <<<"$out" || fail "backstop did not announce"
[ "$(git -C "$tmp/origin.git" rev-list --count main)" = "1" ] || fail "origin moved despite backstop"
grep -q '"title"' "$CURL_LOG" || fail "backstop did not file"
pass=$((pass+1))

# 8: TAIL INVARIANT — a fully-healed red leaves #378 alone: no label flip,
#    no "nothing could be filed" comment. (Without the healed_any guard the
#    tail's else-branch would flip the drive to ready-for-human.)
reset_case; export HEAL_MODE=healed-good
red_run "tail invariant"
bash "$here/../rehearsal-report.sh" "$tmp/run" 1 || fail "reporter exited non-zero (tail)"
grep -q 'labels/37' "$CURL_LOG" && fail "healed red flipped the drive label"
grep -q 'ready-for-human' "$CURL_LOG" && fail "healed red posted a flip"
grep -q 'nothing could be filed' "$CURL_LOG" && fail "healed red posted the empty-hands comment"
pass=$((pass+1))

# 9: HEALED WITH RESIDUAL — the heal fixed only the red's presentation and
#    names the distinct underlying fault (drive 20260811T165115Z: the healer
#    fixed the hidden standup bar, KNEW about the supply host-key fault, and
#    left the drive armed with nothing filed — one paid re-drive of the box per
#    occurrence). The commit lands AND the residual files from the SAME
#    session (one claude call), wired as a drive blocker + priority-labelled.
reset_case; export HEAL_MODE=healed-residual
red_run "bar hid the real fault"
bash "$here/../rehearsal-report.sh" "$tmp/run" 1 || fail "reporter exited non-zero (residual)"
[ "$(git -C "$tmp/origin.git" rev-list --count main)" = "2" ] || fail "residual heal commit did not reach origin"
grep -q 'underlying supply fault' "$CURL_LOG" || fail "residual title not filed"
grep -q 'dependencies' "$CURL_LOG" || fail "residual not wired as a drive blocker"
[ "$(wc -l < "$CLAUDE_CALLS")" = "1" ] || fail "residual made a second claude call"
grep '991/labels' "$CURL_LOG" | grep -q '\[99\]' || fail "residual blocker not priority-labelled"
pass=$((pass+1))

# 10: REHEARSAL_STATE DEFAULT — the executor env never exported it, and the
#     lib's ${REHEARSAL_STATE:?} guard fires inside $(...) substitutions: under
#     set -u that is a SILENT no-op that disabled rail 6's two-mechanical-
#     failures backstop (drive 20260811T165115Z, two bare errors in the log).
#     With the env var absent the reporter must default it under $HOME and the
#     mechanical-failure marker must actually land there.
reset_case; export HEAL_MODE=healed-wide
mkdir -p "$tmp/home2"
red_run "wide fix with no state env"
errlog="$tmp/state-default.err"
env -u REHEARSAL_STATE HOME="$tmp/home2" bash "$here/../rehearsal-report.sh" "$tmp/run" 1 2>"$errlog" \
  || fail "reporter exited non-zero (state default)"
grep -q 'REHEARSAL_STATE' "$errlog" && fail "REHEARSAL_STATE guard still fired: $(head -2 "$errlog")"
# The default derives from REPO_SLUG (swarm-identity.sh — ADR 0180 / #571), not
# a hardcoded repo name, so this holds byte-identical across any product repo.
repo_tag="$(. "$here/../swarm-identity.sh"; printf '%s' "${REPO_SLUG##*/}")"
ls "$tmp/home2/.local/state/$repo_tag-rehearsal"/heal-fail-* >/dev/null 2>&1 \
  || fail "mechanical-failure marker did not land in the default state dir"
pass=$((pass+1))

# advance_origin <edit-cmd> — land one commit on origin/main via a throwaway
# clone, so the reporter's heal push meets a moved main (the #460 race). The
# bare's HEAD is master, so a clone lands on unborn master — check out main.
advance_origin() {
  local a="$tmp/adv"; rm -rf "$a"
  git clone -q "$tmp/origin.git" "$a" 2>/dev/null
  ( cd "$a"; git config user.email t@t; git config user.name t
    git checkout -q main 2>/dev/null || git checkout -q -b main origin/main
    eval "$1"; git add -A; git commit -qm "operator: concurrent"; git push -q origin HEAD:main )
}

# 11: MOVED ORIGIN — origin/main advanced (unrelated file) between the checkout's
#     base and the heal push. heal_push rebases and the heal STILL lands: origin
#     carries base+advance+heal, #378 is commented, no issue filed (#460). Before
#     the fix this was a non-fast-forward that lost the heal to filing.
reset_case; export HEAL_MODE=healed-good
advance_origin 'echo more > advance.txt'
red_run "moved origin under the heal"
bash "$here/../rehearsal-report.sh" "$tmp/run" 1 || fail "reporter exited non-zero (moved origin)"
[ "$(git -C "$tmp/origin.git" rev-list --count main)" = "3" ] || fail "heal did not land atop the concurrent advance (#460)"
grep -q '378/comments' "$CURL_LOG" || fail "no #378 healer comment on the rebased heal"
grep -q '"title"' "$CURL_LOG" && fail "an issue was filed despite a successful rebased heal"
pass=$((pass+1))

# 12: MOVED ORIGIN, CONFLICT — origin changes the same line the heal touches
#     WHILE the healer session is "thinking" (the dedicated checkout's own
#     pre-heal reset already caught up before the session started — #576 — so
#     the race has to land inside the session, exactly where heal_push's own
#     fetch+rebase-before-push exists to catch it); heal_push aborts the
#     rebase, resets to pre_head, and the red falls through to filing (blocked
#     invariant holds). Origin keeps base+their-change only.
reset_case; export HEAL_MODE=healed-good RACE_ADVANCE_CMD="sed -i 's/base/theirs/' wizard.ts"
red_run "conflicting advance under the heal"
bash "$here/../rehearsal-report.sh" "$tmp/run" 1 || fail "reporter exited non-zero (conflict)"
[ "$(git -C "$tmp/origin.git" rev-list --count main)" = "2" ] || fail "heal reached origin despite a rebase conflict"
[ "$(git -C "$tmp/co" rev-list --count HEAD)" = "1" ] || fail "checkout not reset to pre_head after conflict"
unset RACE_ADVANCE_CMD
grep -q '"title"' "$CURL_LOG" || fail "conflict did not fall through to filing"
pass=$((pass+1))

echo "OK: $pass cases"
