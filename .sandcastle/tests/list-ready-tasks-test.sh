#!/usr/bin/env bash
# Offline test for the swarm task source: a standing rehearsal DRIVE issue is
# executed host-mode by the workstation cron scripts/rehearsal-executor.sh —
# Ben's ruling on Matou/idss#380 (DO/broker secrets stay off the swarm
# containers, #377 proved the substrate cannot drive). So list-ready-tasks.sh
# must NEVER surface it to the swarm, even though it is open + ready-for-agent
# + unblocked — otherwise a swarm iteration hot-loops on an issue it
# structurally cannot run. The `standing-drive` LABEL is the sole automatic
# exclusion (per-repo-safe); REHEARSAL_DRIVE_ISSUE is an optional numeric
# backstop with NO product default (#11) — unset excludes nothing by number.
# Every OTHER rehearsal-183 issue (the holes the swarm plugs) must still come
# through. Drives the REAL script with a shimmed curl. Run:
#   bash .sandcastle/tests/list-ready-tasks-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
# No global REHEARSAL_DRIVE_ISSUE pin: the number backstop now has no default
# (#11), and cases exercise unset / set explicitly. The host's .sandcastle/.env
# can leak a value into this suite's ambient env, so the "unset" cases run under
# `env -u REHEARSAL_DRIVE_ISSUE` and the "set" cases pin it inline.
export PATH="$tmp/bin:$PATH" FORGEJO_TOKEN=t
unset REHEARSAL_DRIVE_ISSUE 2>/dev/null || true

# curl shim: answers the ready-for-agent issue-list query from a fixture, and
# every dependency query as "no open blockers". A page fixture holds < 50
# issues so the script's pagination loop breaks after one page.
cat > "$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
[ -n "${CURL_LOG:-}" ] && echo "$*" >> "$CURL_LOG"
for a in "$@"; do case "$a" in
  */dependencies*)
    # per-issue blockers when a fixture names them (drive-blocker ordering, #24);
    # default "no open blockers" so every candidate is unblocked and surfaces.
    n="${a#*/issues/}"; n="${n%%/*}"
    if [ -n "${DEPS_DIR:-}" ] && [ -f "$DEPS_DIR/$n.json" ]; then cat "$DEPS_DIR/$n.json"; else echo '[]'; fi
    exit 0 ;;
  *pulls?state=open*) sleep "${LEG_SLEEP:-0}"; cat "${PULLS_FIXTURE:-/dev/null}" 2>/dev/null || echo '[]'; exit 0 ;;
  *labels=standing-drive*) sleep "${LEG_SLEEP:-0}"; if [ -n "${DRIVES_FIXTURE:-}" ]; then cat "$DRIVES_FIXTURE"; else echo '[]'; fi; exit 0 ;;
  *labels=ready-for-agent*) sleep "${LEG_SLEEP:-0}"; cat "${ISSUE_FIXTURE:?}"; exit 0 ;;
esac; done
echo '[]'
SH
chmod +x "$tmp/bin/curl"
export ISSUE_FIXTURE="$tmp/issues.json"

# Fixture: an unlabelled issue #492 (idss's retired drive number — the
# product literal #11 removed from the harness default), a re-minted drive
# #700 wearing the `standing-drive` label (the PRIMARY exclusion, idss#493
# ruling), plus two ordinary ready swarm tasks, one of them a rehearsal-183
# hole (#999) — that label alone must NOT exclude it.
cat > "$ISSUE_FIXTURE" <<'JSON'
[
  {"number": 492, "title": "rehearsal: THE DRIVE", "body": "standing drive issue", "html_url": "u/492"},
  {"number": 700, "title": "rehearsal: THE NEXT DRIVE", "body": "re-minted drive", "html_url": "u/700",
   "labels": [{"name": "ready-for-agent"}, {"name": "rehearsal-183"}, {"name": "standing-drive"}]},
  {"number": 999, "title": "rehearsal: a hole to plug", "body": "b", "html_url": "u/999",
   "labels": [{"name": "rehearsal-183"}]},
  {"number": 500, "title": "some other feature slice", "body": "b", "html_url": "u/500"}
]
JSON

# The default run has NO REHEARSAL_DRIVE_ISSUE set (unset above; the -u guards
# against an ambient .env leak). No number is defaulted (#11), so an issue that
# merely happens to be numbered 492 is an ordinary ticket.
out="$(env -u REHEARSAL_DRIVE_ISSUE bash "$here/../list-ready-tasks.sh")" \
  || fail "script exited non-zero"

# 1 (#11 acceptance a): with the backstop unset, nothing is excluded BY NUMBER —
# #492 is just another ready ticket and must surface.
jq -e '.[] | select(.number == 492)' <<<"$out" >/dev/null \
  || fail "with REHEARSAL_DRIVE_ISSUE unset, #492 is an ordinary task and must surface"
pass=$((pass+1))

# 1b: a `standing-drive`-labelled issue is excluded regardless of the backstop —
# the label is the sole automatic exclusion; a re-mint needs no code/env edit
if jq -e '.[] | select(.number == 700)' <<<"$out" >/dev/null; then
  fail "a standing-drive-labelled issue (#700) must not be surfaced to the swarm"
fi
pass=$((pass+1))

# 1c (#11 acceptance b): a SET backstop still excludes exactly that number —
# REHEARSAL_DRIVE_ISSUE=492 hides #492, and only #492.
out1c="$(REHEARSAL_DRIVE_ISSUE=492 bash "$here/../list-ready-tasks.sh")" \
  || fail "script exited non-zero (backstop=492)"
if jq -e '.[] | select(.number == 492)' <<<"$out1c" >/dev/null; then
  fail "with REHEARSAL_DRIVE_ISSUE=492, #492 is the drive issue and must be excluded"
fi
jq -e '.[] | select(.number == 500)' <<<"$out1c" >/dev/null \
  || fail "the backstop must exclude only its number — #500 must still surface"
pass=$((pass+1))

# 2: an ordinary rehearsal-183 hole still comes through (not the whole label)
jq -e '.[] | select(.number == 999)' <<<"$out" >/dev/null \
  || fail "a non-drive rehearsal-183 issue (#999) must still surface"
pass=$((pass+1))

# 3: unrelated ready tasks are untouched
jq -e '.[] | select(.number == 500)' <<<"$out" >/dev/null \
  || fail "an unrelated ready task (#500) must still surface"
pass=$((pass+1))

# 4: the exclusion is keyed off REHEARSAL_DRIVE_ISSUE, not a hardcoded 492
out2="$(REHEARSAL_DRIVE_ISSUE=999 bash "$here/../list-ready-tasks.sh")" \
  || fail "script exited non-zero (override)"
jq -e '.[] | select(.number == 492)' <<<"$out2" >/dev/null \
  || fail "with the override, #492 is an ordinary task and must surface"
if jq -e '.[] | select(.number == 999)' <<<"$out2" >/dev/null; then
  fail "with REHEARSAL_DRIVE_ISSUE=999, #999 is the drive issue and must be excluded"
fi
pass=$((pass+1))

# 5: when the drive issue is the ONLY ready one, the queue is legitimately
# empty — the script must emit [] and exit 0, not abort. (Regression guard for
# the xargs empty-input footgun: no -r would fire the dependency check once
# with an empty arg and exit 123.) The backstop is set here so the number
# stream genuinely empties — the real live state on a consumer that pins it.
cat > "$ISSUE_FIXTURE" <<'JSON'
[
  {"number": 492, "title": "rehearsal: THE DRIVE", "body": "standing drive issue", "html_url": "u/492"}
]
JSON
out3="$(REHEARSAL_DRIVE_ISSUE=492 bash "$here/../list-ready-tasks.sh")" || fail "empty-queue run must exit 0"
[ "$(jq 'length' <<<"$out3")" = "0" ] || fail "queue with only the drive issue must be empty"
pass=$((pass+1))

# 6: `priority`-labelled issues surface FIRST, tracker order preserved within
#    each group — prompt.md says "pick the first task", so this sort IS the
#    scheduler. The `priority` helper flag must not leak into the emitted shape;
#    the contract is {number, title, body, url} plus the additive `.model`
#    per-ticket override (#448) — null when the ticket carries no model-* label.
cat > "$ISSUE_FIXTURE" <<'JSON'
[
  {"number": 700, "title": "ordinary first", "body": "b", "html_url": "u/700", "labels": []},
  {"number": 701, "title": "priority hole", "body": "b", "html_url": "u/701", "labels": [{"name":"ready-for-agent"},{"name":"priority"}]},
  {"number": 702, "title": "ordinary second", "body": "b", "html_url": "u/702", "labels": [{"name":"ready-for-agent"}]},
  {"number": 703, "title": "priority second", "body": "b", "html_url": "u/703", "labels": [{"name":"priority"}]}
]
JSON
out4="$(bash "$here/../list-ready-tasks.sh")" || fail "priority run exited non-zero"
[ "$(jq -r '[.[].number] | join(",")' <<<"$out4")" = "701,703,700,702" ] \
  || fail "priority issues must sort first, tracker order kept within groups (got $(jq -c '[.[].number]' <<<"$out4"))"
jq -e 'all(.[]; keys == ["body","model","number","title","url"])' <<<"$out4" >/dev/null \
  || fail "emitted shape changed — expected {body,model,number,title,url} (the priority flag must not leak; .model must survive)"
jq -e 'all(.[]; .model == null)' <<<"$out4" >/dev/null \
  || fail "unlabelled tickets must surface .model=null (default model)"
pass=$((pass+1))

# 7: a ticket's model-<name> label surfaces as its `.model` suffix — the field
#    run-swarm.sh resolves to the run's model (#448).
cat > "$ISSUE_FIXTURE" <<'JSON'
[
  {"number": 710, "title": "mechanical", "body": "b", "html_url": "u/710", "labels": [{"name":"ready-for-agent"},{"name":"model-haiku"}]}
]
JSON
out5="$(bash "$here/../list-ready-tasks.sh")" || fail "model-label run exited non-zero"
[ "$(jq -r '.[0].model' <<<"$out5")" = "haiku" ] \
  || fail "a model-haiku ticket must surface .model=haiku (got $(jq -c '.[0].model' <<<"$out5"))"
pass=$((pass+1))

# 8: a ticket already claimed by another host (agent-working) is hidden from
#    the queue entirely — the multi-host pool's claim-next-task.sh (spec D4)
#    relies on this: a claimed ticket must never resurface to a second host.
cat > "$ISSUE_FIXTURE" <<'JSON'
[
  {"number": 720, "title": "up for grabs", "body": "b", "html_url": "u/720", "labels": [{"name":"ready-for-agent"}]},
  {"number": 721, "title": "already claimed", "body": "b", "html_url": "u/721", "labels": [{"name":"ready-for-agent"},{"name":"agent-working"}]}
]
JSON
out6="$(bash "$here/../list-ready-tasks.sh")" || fail "agent-working fixture run exited non-zero"
if jq -e '.[] | select(.number == 721)' <<<"$out6" >/dev/null; then
  fail "agent-working tickets are hidden from the queue"
fi
jq -e '.[] | select(.number == 720)' <<<"$out6" >/dev/null \
  || fail "an unclaimed ready ticket (#720) must still surface"
pass=$((pass+1))

# 9 (#13): LANDING=pr drops issues with an OPEN agent PR (agent/issue-<N>) so
#    the swarm neither re-claims nor re-works them while a human reviews. Under
#    the default push policy the same fixture surfaces everything (nil-diff).
cat > "$ISSUE_FIXTURE" <<'JSON'
[
  {"number": 730, "title": "no PR yet", "body": "b", "html_url": "u/730", "labels": [{"name":"ready-for-agent"}]},
  {"number": 731, "title": "has an open PR", "body": "b", "html_url": "u/731", "labels": [{"name":"ready-for-agent"}]}
]
JSON
# push mode (no policy file): both surface, no /pulls call is even made.
out7push="$(env -u SWARM_POLICY_FILE bash "$here/../list-ready-tasks.sh")" \
  || fail "push-mode pr-filter run exited non-zero"
jq -e '.[] | select(.number == 731)' <<<"$out7push" >/dev/null \
  || fail "push mode must NOT drop #731 (the pr filter is pr-mode only — nil-diff)"
pass=$((pass+1))

# pr mode: #731 has an open agent/issue-731 PR and must be dropped; #730 stays.
printf '%s\n' 'LANDING=pr' > "$tmp/swarm-policy.sh"
# a NON-matching PR head first, to prove the filter doesn't abort on it (a bare
# jq `capture` would error on the non-match and drop the real match after it).
printf '%s\n' '[{"number":89,"head":{"ref":"some/other-branch"}},{"number":88,"head":{"ref":"agent/issue-731"}}]' > "$tmp/pulls.json"
out7pr="$(SWARM_POLICY_FILE="$tmp/swarm-policy.sh" PULLS_FIXTURE="$tmp/pulls.json" bash "$here/../list-ready-tasks.sh")" \
  || fail "pr-mode pr-filter run exited non-zero"
if jq -e '.[] | select(.number == 731)' <<<"$out7pr" >/dev/null; then
  fail "pr mode must drop #731 — it has an open agent/issue-731 PR"
fi
jq -e '.[] | select(.number == 730)' <<<"$out7pr" >/dev/null \
  || fail "pr mode must keep #730 — it has no open agent PR"
pass=$((pass+1))

# 10 (#24): a ready ticket that is a native Forgejo dependency ("blocked by")
#    of an OPEN `standing-drive` issue is surfaced AHEAD of ordinary backlog —
#    even ahead of a `priority` non-blocker and even when its own number is
#    HIGHER — so the swarm plugs the drive's hole first instead of losing the
#    "lowest live claim id" race (the swarm-gridlock shape). One GET per standing
#    drive resolves the blockers.
export DEPS_DIR="$tmp/deps"; mkdir -p "$DEPS_DIR"
export DRIVES_FIXTURE="$tmp/drives.json"
# the standing drive #950 is blocked by #900 (open) — that is the drive blocker.
printf '%s\n' '[{"number":950,"title":"THE DRIVE","labels":[{"name":"standing-drive"}]}]' > "$DRIVES_FIXTURE"
printf '%s\n' '[{"number":900,"state":"open"}]' > "$DEPS_DIR/950.json"
cat > "$ISSUE_FIXTURE" <<'JSON'
[
  {"number": 300, "title": "ordinary lower number", "body": "b", "html_url": "u/300", "labels": [{"name":"ready-for-agent"}]},
  {"number": 400, "title": "priority non-blocker", "body": "b", "html_url": "u/400", "labels": [{"name":"ready-for-agent"},{"name":"priority"}]},
  {"number": 900, "title": "the drive blocker", "body": "b", "html_url": "u/900", "labels": [{"name":"ready-for-agent"}]}
]
JSON
out8="$(bash "$here/../list-ready-tasks.sh")" || fail "drive-blocker ordering run exited non-zero"
[ "$(jq -r '[.[].number] | join(",")' <<<"$out8")" = "900,400,300" ] \
  || fail "the drive blocker (#900) must sort first, then priority (#400), then the rest (#300) (got $(jq -c '[.[].number]' <<<"$out8"))"
jq -e 'all(.[]; keys == ["body","model","number","title","url"])' <<<"$out8" >/dev/null \
  || fail "emitted shape changed — the blocker helper flag must not leak (expected {body,model,number,title,url})"
pass=$((pass+1))

# 10b: with NO standing drive (the common case), ordering is byte-identical to
#      the pre-#24 priority-only order — the drive-blocker query returns [] and
#      no ticket is promoted. Same fixture as case 10, drives cleared.
printf '%s\n' '[]' > "$DRIVES_FIXTURE"
out8b="$(bash "$here/../list-ready-tasks.sh")" || fail "no-drive ordering run exited non-zero"
[ "$(jq -r '[.[].number] | join(",")' <<<"$out8b")" = "400,300,900" ] \
  || fail "with no standing drive, order is priority-first then tracker order (got $(jq -c '[.[].number]' <<<"$out8b"))"
unset DEPS_DIR DRIVES_FIXTURE
pass=$((pass+1))

# 10c (#115): Forgejo IGNORES an unknown `labels=` filter — in a repo with no
#     `standing-drive` label the drives query returns EVERY open issue, none
#     carrying the label. The lister must re-filter CLIENT-side: zero
#     /dependencies calls (one per open issue was 25s of a 30s budget on
#     matou-app, run 7707) and the order unpromoted, byte-identical to 10b.
export DEPS_DIR="$tmp/deps" DRIVES_FIXTURE="$tmp/drives.json"
printf '%s\n' '[{"number":950,"title":"not a drive","labels":[{"name":"bug"}]},{"number":300,"title":"ordinary lower number","labels":[{"name":"ready-for-agent"}]},{"number":951,"title":"unlabelled"}]' > "$DRIVES_FIXTURE"
: > "$tmp/curl.log"
out8c="$(CURL_LOG="$tmp/curl.log" bash "$here/../list-ready-tasks.sh")" || fail "unknown-label drives run exited non-zero"
# (the DAG filter's own per-ready-issue /dependencies reads for #300/#400/#900
#  are expected; the drive candidates #950/#951 must never be resolved)
grep -qE '/issues/95[01]/dependencies' "$tmp/curl.log" && fail "an unlabelled drives response must trigger NO drive-blocker /dependencies fan-out (#115): $(grep -E '95[01]/dependencies' "$tmp/curl.log")"
[ "$(jq -r '[.[].number] | join(",")' <<<"$out8c")" = "400,300,900" ] \
  || fail "with no labelled drive, order must be the unpromoted 10b order (got $(jq -c '[.[].number]' <<<"$out8c"))"
unset DEPS_DIR DRIVES_FIXTURE
pass=$((pass+1))

# 10d (#120): LIST_READY_DRIVE_BUDGET must bound the WHOLE drive-blocker block,
#     not just its loop body. The `labels=standing-drive` listing call itself is
#     5.5-12.7s on a repo where Forgejo ignores the unknown filter; the old guard
#     sat INSIDE the loop, AFTER that fetch was already paid for. With the budget
#     spent BEFORE the block, the standing-drive listing must not be made at all,
#     and the queue is emitted unpromoted (byte-identical to the no-drive 10b
#     order). Same fixture as case 10 (drive #950 blocked by #900) — a promotion
#     that WOULD happen without the skip, proving the skip is what suppresses it.
export DEPS_DIR="$tmp/deps" DRIVES_FIXTURE="$tmp/drives.json"
printf '%s\n' '[{"number":950,"title":"THE DRIVE","labels":[{"name":"standing-drive"}]}]' > "$DRIVES_FIXTURE"
printf '%s\n' '[{"number":900,"state":"open"}]' > "$DEPS_DIR/950.json"
cat > "$ISSUE_FIXTURE" <<'JSON'
[
  {"number": 300, "title": "ordinary lower number", "body": "b", "html_url": "u/300", "labels": [{"name":"ready-for-agent"}]},
  {"number": 400, "title": "priority non-blocker", "body": "b", "html_url": "u/400", "labels": [{"name":"ready-for-agent"},{"name":"priority"}]},
  {"number": 900, "title": "the drive blocker", "body": "b", "html_url": "u/900", "labels": [{"name":"ready-for-agent"}]}
]
JSON
: > "$tmp/curl.log"
out8d="$(LIST_READY_DRIVE_BUDGET=0 CURL_LOG="$tmp/curl.log" bash "$here/../list-ready-tasks.sh" 2>"$tmp/8d.err")" \
  || fail "spent-budget drive-block run exited non-zero"
grep -q 'labels=standing-drive' "$tmp/curl.log" \
  && fail "a spent LIST_READY_DRIVE_BUDGET must skip the standing-drive listing call ENTIRELY (#120): $(grep 'labels=standing-drive' "$tmp/curl.log")"
[ "$(jq -r '[.[].number] | join(",")' <<<"$out8d")" = "400,300,900" ] \
  || fail "with the drive budget spent, #900 must NOT be promoted — unpromoted 10b order (got $(jq -c '[.[].number]' <<<"$out8d"))"
grep -q "drive-blocker ordering skipped" "$tmp/8d.err" \
  || fail "the spent-budget skip must say why on stderr: $(cat "$tmp/8d.err")"
unset DEPS_DIR DRIVES_FIXTURE
pass=$((pass+1))

# 11 (#128, matou-app#286): the /pulls (LANDING=pr) and standing-drive listings
# run in the BACKGROUND, overlapping the issues-page fetch, instead of serially
# after it. Prove it with a shim that sleeps LEG_SLEEP on each of the three
# independent listing legs (never on /dependencies): serial cost is ~3x
# LEG_SLEEP, overlapped ~1x. The queue must still come out correct.
printf '%s\n' 'LANDING=pr' > "$tmp/overlap-policy.sh"
printf '%s\n' '[]' > "$tmp/overlap-pulls.json"
printf '%s\n' '[{"number":960,"title":"THE DRIVE","labels":[{"name":"standing-drive"}]}]' > "$tmp/overlap-drives.json"
cat > "$ISSUE_FIXTURE" <<'JSON'
[
  {"number": 800, "title": "a ready task", "body": "b", "html_url": "u/800", "labels": [{"name":"ready-for-agent"}]}
]
JSON
t0="$(date +%s)"
out9="$(SWARM_POLICY_FILE="$tmp/overlap-policy.sh" PULLS_FIXTURE="$tmp/overlap-pulls.json" \
  DRIVES_FIXTURE="$tmp/overlap-drives.json" LEG_SLEEP=2 bash "$here/../list-ready-tasks.sh")" \
  || fail "overlap run exited non-zero"
elapsed=$(( $(date +%s) - t0 ))
[ "$(jq -r '.[0].number' <<<"$out9")" = "800" ] \
  || fail "overlap run must still surface the ready task (got $(jq -c '[.[].number]' <<<"$out9"))"
[ "$elapsed" -le 4 ] \
  || fail "the /pulls + standing-drive listings must OVERLAP the issues fetch (serial 3x2s vs overlapped ~2s) — took ${elapsed}s"
pass=$((pass+1))

# 11b (#128): the /pulls fetch stays fail-OPEN — a non-zero fetch drops nothing.
# Simulate a failing /pulls by pointing the shim at a curl that exits 22 on the
# pulls leg; the ready task must still surface (not be dropped by a phantom PR).
cat > "$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
[ -n "${CURL_LOG:-}" ] && echo "$*" >> "$CURL_LOG"
for a in "$@"; do case "$a" in
  */dependencies*) echo '[]'; exit 0 ;;
  *pulls?state=open*) exit 22 ;;
  *labels=standing-drive*) echo '[]'; exit 0 ;;
  *labels=ready-for-agent*) cat "${ISSUE_FIXTURE:?}"; exit 0 ;;
esac; done
echo '[]'
SH
chmod +x "$tmp/bin/curl"
out9b="$(SWARM_POLICY_FILE="$tmp/overlap-policy.sh" LIST_READY_RETRIES=1 bash "$here/../list-ready-tasks.sh")" \
  || fail "fail-open /pulls run exited non-zero"
jq -e '.[] | select(.number == 800)' <<<"$out9b" >/dev/null \
  || fail "a failed /pulls fetch must drop NOTHING (fail-open) — #800 must still surface"
pass=$((pass+1))

# Restore the default shim and a #400-bearing fixture for the yield cases below.
cat > "$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
[ -n "${CURL_LOG:-}" ] && echo "$*" >> "$CURL_LOG"
for a in "$@"; do case "$a" in
  */dependencies*)
    n="${a#*/issues/}"; n="${n%%/*}"
    if [ -n "${DEPS_DIR:-}" ] && [ -f "$DEPS_DIR/$n.json" ]; then cat "$DEPS_DIR/$n.json"; else echo '[]'; fi
    exit 0 ;;
  *pulls?state=open*) sleep "${LEG_SLEEP:-0}"; cat "${PULLS_FIXTURE:-/dev/null}" 2>/dev/null || echo '[]'; exit 0 ;;
  *labels=standing-drive*) sleep "${LEG_SLEEP:-0}"; if [ -n "${DRIVES_FIXTURE:-}" ]; then cat "$DRIVES_FIXTURE"; else echo '[]'; fi; exit 0 ;;
  *labels=ready-for-agent*) sleep "${LEG_SLEEP:-0}"; cat "${ISSUE_FIXTURE:?}"; exit 0 ;;
esac; done
echo '[]'
SH
chmod +x "$tmp/bin/curl"
cat > "$ISSUE_FIXTURE" <<'JSON'
[
  {"number": 300, "title": "ordinary lower number", "body": "b", "html_url": "u/300", "labels": [{"name":"ready-for-agent"}]},
  {"number": 400, "title": "priority non-blocker", "body": "b", "html_url": "u/400", "labels": [{"name":"ready-for-agent"},{"name":"priority"}]},
  {"number": 900, "title": "the drive blocker", "body": "b", "html_url": "u/900", "labels": [{"name":"ready-for-agent"}]}
]
JSON

# ── #111: the mid-run drive-yield signal ──────────────────────────────────
# main.mts mirrors a fresh host reservation into the sandbox as
# /run/host-signals/drive-wanted; when that file exists the lister answers []
# BEFORE any API call, so the run claims nothing more and completes after its
# current task. Absent, everything above still holds (the ready set surfaces).
: > "$tmp/drive-signal"; : > "$tmp/curl.log"
outy="$(env -u REHEARSAL_DRIVE_ISSUE SWARM_DRIVE_YIELD_SIGNAL="$tmp/drive-signal" CURL_LOG="$tmp/curl.log" \
  bash "$here/../list-ready-tasks.sh" 2>"$tmp/yield.err")" || fail "the yield answer must exit 0"
[ "$outy" = "[]" ] || fail "with the drive signal present the lister must answer [], got: $outy"
[ ! -s "$tmp/curl.log" ] || fail "the yield answer must come BEFORE any API call: $(cat "$tmp/curl.log")"
grep -q "reserved host capacity" "$tmp/yield.err" || fail "the yield must say why on stderr: $(cat "$tmp/yield.err")"
pass=$((pass+1))
rm -f "$tmp/drive-signal"
outn="$(env -u REHEARSAL_DRIVE_ISSUE SWARM_DRIVE_YIELD_SIGNAL="$tmp/drive-signal" bash "$here/../list-ready-tasks.sh")" \
  || fail "script exited non-zero (no signal)"
jq -e '.[] | select(.number == 400)' <<<"$outn" >/dev/null || fail "with no drive signal the ready set must surface as before"
pass=$((pass+1))

echo "PASS ($pass cases)"
