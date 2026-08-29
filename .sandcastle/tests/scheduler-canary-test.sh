#!/usr/bin/env bash
# Offline test for scheduler-canary.sh (#105) — the detection half of the
# scheduler-silence failure mode. Run: bash .sandcastle/tests/scheduler-canary-test.sh
#
# curl is shimmed on PATH (as broker-install-test.sh / schedule-backstop-test.sh
# do): it serves canned Forgejo payloads on the GETs and captures the Mattermost
# POST body to $POSTS_LOG so each assertion can see whether — and WHAT — the
# canary posted. No docker, no network, no live tracker.
#
# The five cases the ticket pins:
#   (a) a fresh queue → silent
#   (b) 165 waiting, oldest 23 h → one `saturated` post, then de-bounced, then a
#       `recovered` line once the queue clears
#   (c) head sha 2 h old, present in `runs` as `waiting` but ABSENT from `tasks`
#       → `ungated` post (the #880 false-negative trap: a waiting run is not a
#       claimed one)
#   (d) head sha 2 h old and PRESENT in `tasks` → silent
#   (e) API down → exit 2, one post
# Plus the pure-age saturation branch (count small, oldest stale) the ticket's
# case (b) shortcuts via the count threshold.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/runs"

# ── the curl shim ────────────────────────────────────────────────────────────
# Routes by URL. Forgejo GETs read canned files; the Mattermost POST appends its
# message body (stdin) to $POSTS_LOG. API_DOWN=1 makes every Forgejo call fail
# like a dead forge (nonzero exit), while the Mattermost post still works so the
# unreachable alarm can be observed.
cat > "$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
url=""; method=GET; want_code=0; has_data=0
while [ $# -gt 0 ]; do
  case "$1" in
    -X) method="$2"; shift 2 ;;
    -w) want_code=1; shift 2 ;;
    -o) shift 2 ;;
    -d) has_data=1; method=POST; shift 2 ;;
    -H|--max-time) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done

case "$url" in
  */api/v4/posts)
    [ "$has_data" = 1 ] && cat >> "$POSTS_LOG"
    printf '{"id":"post-fake"}'
    exit 0 ;;
esac

if [ "${API_DOWN:-0}" = 1 ]; then
  # a dead forge: connection failure. curl -f and curl -s both exit nonzero.
  exit 7
fi

case "$url" in
  *contents/.forgejo/workflows/ci.yml*)
    if [ "$want_code" = 1 ]; then printf '%s' "${CI_CODE:-200}"; else printf '{}'; fi ;;
  *actions/runs*status=waiting*)
    ev="$(printf '%s' "$url" | sed -n 's/.*event=\([a-z_]*\).*/\1/p')"
    f="$RUNS_DIR/$ev.json"
    if [ -f "$f" ]; then cat "$f"; else printf '{"total_count":0,"workflow_runs":[]}'; fi ;;
  *actions/runs*head_sha=*)   # the head's own runs (#109), paged: $HEAD_RUNS_DIR/page<N>.json
    pg="$(printf '%s' "$url" | sed -n 's/.*page=\([0-9]*\).*/\1/p')"
    f="$HEAD_RUNS_DIR/page${pg:-1}.json"
    printf '%s\n' "$url" >> "$HEAD_RUNS_DIR/reads.log"
    if [ -f "$f" ]; then cat "$f"; else printf '{"total_count":0,"workflow_runs":[]}'; fi ;;
  *actions/tasks*)
    echo "TASKS_READ" >> "$HEAD_RUNS_DIR/reads.log"
    cat "${TASKS_JSON:-/dev/null}" 2>/dev/null || printf '{"workflow_runs":[]}' ;;
  */branches/*)
    cat "${BRANCH_JSON:-/dev/null}" 2>/dev/null || printf '{}' ;;
  *)
    cat "${META_JSON:-/dev/null}" 2>/dev/null || printf '{"default_branch":"main"}' ;;
esac
SH
chmod +x "$tmp/bin/curl"

iso() { date -u -d "$1" +%Y-%m-%dT%H:%M:%SZ; }

# run_canary — one tick. Every knob is an env override so the case wiring stays
# local; the state dir persists across calls within a case so de-bounce works.
STATE="$tmp/state"
run_canary() {
  : > "$tmp/posts.log"
  env PATH="$tmp/bin:$PATH" FORGEJO_TOKEN=dummy \
    FORGEJO_API=http://x/api/v1/repos/Matou/idss \
    MATTERMOST_URL=http://mm MATTERMOST_BOT_TOKEN=t MATTERMOST_CHANNEL_ID=c NOTIFY_ALLOW_PLAIN_HTTP_FORGE=1 \
    CANARY_STATE_DIR="$STATE" \
    RUNS_DIR="$tmp/runs" TASKS_JSON="$tmp/tasks.json" HEAD_RUNS_DIR="$tmp/headruns" \
    BRANCH_JSON="$tmp/branch.json" META_JSON="$tmp/meta.json" \
    POSTS_LOG="$tmp/posts.log" \
    "$@" \
    bash "$here/../scheduler-canary.sh"
}
posts() { cat "$tmp/posts.log" 2>/dev/null; }
posted() { [ -s "$tmp/posts.log" ]; }

# Shared fixtures: repo meta + a ci.yml that exists. A HEAD that is fresh and a
# tasks view WITH the matching claimed ci task keep assertion 2 quiet unless a
# case overrides them.
printf '{"default_branch":"main"}' > "$tmp/meta.json"
fresh_head() { printf '{"name":"main","commit":{"id":"deadbeefcafe0001","timestamp":"%s"}}' "$(iso '-2 minutes')" > "$tmp/branch.json"; }
stale_head() { printf '{"name":"main","commit":{"id":"deadbeefcafe0001","timestamp":"%s"}}' "$(iso '-2 hours')" > "$tmp/branch.json"; }
# #107: a claimed ci task's `.name` is the JOB (idss's ci.yml surfaces as
# "seam"), never the workflow — the canary counts it by `.workflow_id ==
# "ci.yml"`. This real-world shape (job name "seam", workflow_id ci.yml) MUST
# count as claimed; a task NAMED "ci" under a different workflow must NOT.
# #109: the view is the head's OWN runs (`runs?head_sha=`), paged; a claimed
# run is one whose status has left `waiting`. The fixture writes page files.
head_runs() { # head_runs <total> <page> <json-array-of-runs>
  mkdir -p "$tmp/headruns"; printf '{"total_count":%s,"workflow_runs":%s}' "$1" "$3" > "$tmp/headruns/page$2.json"; }
clear_head_runs() { rm -rf "$tmp/headruns"; mkdir -p "$tmp/headruns"; }
tasks_with_ci() { clear_head_runs; head_runs 1 1 '[{"name":"seam","status":"success","workflow_id":"ci.yml"}]'; }
tasks_without_ci() { clear_head_runs; head_runs 1 1 '[{"name":"swarm","status":"success","workflow_id":"swarm.yml"}]'; }
no_waiting() { rm -f "$tmp/runs/"*.json; }

reset_case() { rm -rf "$STATE"; no_waiting; fresh_head; tasks_with_ci; }

# ── (a) a fresh queue → silent ───────────────────────────────────────────────
reset_case
run_canary >/dev/null 2>&1 || fail "(a) a fresh, healthy repo must exit 0"
posted && fail "(a) a fresh queue must post NOTHING"
pass=$((pass+1))

# ── (b) 165 waiting, oldest 23 h → saturated, once, de-bounced, then recovered ─
reset_case
old_iso="$(iso '-23 hours')"
{ printf '{"total_count":165,"workflow_runs":['
  printf '{"created":"%s","html_url":"http://x/runs/1"}' "$old_iso"
  printf ']}'; } > "$tmp/runs/push.json"

run_canary >/dev/null 2>&1 || fail "(b) a saturated repo must still exit 0"
posts | grep -qi 'SATURATED' || fail "(b) 165 waiting must post a SATURATED alarm"
posts | grep -q 'Matou/idss'  || fail "(b) the alarm must name the repo"
posts | grep -q 'http://x/runs/1' || fail "(b) the alarm must carry the oldest run's html_url"
[ "$(posts | grep -ci 'SATURATED')" = 1 ] || fail "(b) exactly one saturation post per tick"
pass=$((pass+1))

# second tick, same condition, inside the repost window → DE-BOUNCED (silent)
run_canary >/dev/null 2>&1
posts | grep -qi 'SATURATED' && fail "(b) a still-live alarm must be de-bounced, not re-posted"
pass=$((pass+1))

# queue clears → exactly one `recovered` line, then silence
no_waiting
run_canary >/dev/null 2>&1
posts | grep -qi 'recovered' || fail "(b) a cleared queue must post a recovered line"
pass=$((pass+1))
run_canary >/dev/null 2>&1
posted && fail "(b) once recovered, a healthy tick is silent again"
pass=$((pass+1))

# ── (c) head 2 h old, waiting in runs but ABSENT from tasks → ungated ─────────
# The #880 trap: a `waiting` ci run exists (so a runs-based check would say
# "covered") but no runner ever CLAIMED it — the tasks view is empty of it.
reset_case
stale_head
tasks_without_ci
# a fresh, single waiting push run: assertion 1 stays quiet (count 1, fresh) so
# only the ungated alarm can fire.
printf '{"total_count":1,"workflow_runs":[{"created":"%s","html_url":"http://x/runs/9"}]}' "$(iso '-3 minutes')" > "$tmp/runs/push.json"
run_canary >/dev/null 2>&1 || fail "(c) an ungated repo must still exit 0"
posts | grep -qi 'UNGATED' || fail "(c) a stale head with no CLAIMED ci task must post UNGATED"
posts | grep -qi 'SATURATED' && fail "(c) a fresh single waiting run must NOT trip saturation"
pass=$((pass+1))

# ── (d) head 2 h old and PRESENT in tasks → silent ───────────────────────────
# #107: the claimed task is named "seam" (the JOB), matched by workflow_id
# ci.yml — proof the workflow_id match counts a real claimed task the old
# `.name == "ci"` match would have missed (→ a false UNGATED on every aged head).
reset_case
stale_head
tasks_with_ci
run_canary >/dev/null 2>&1 || fail "(d) a claimed-ci repo must exit 0"
posted && fail "(d) a stale head WITH a claimed ci task (job 'seam', workflow_id ci.yml) must post nothing"
pass=$((pass+1))

# ── (d2) a task NAMED ci but under a different workflow_id → UNGATED ───────────
# The inverse of (d): `.name` is not the signal. A stale head whose only task
# is name="ci" but workflow_id="release.yml" was NOT claimed by ci.yml, so it
# is ungated — the old name-match would have wrongly called it covered.
reset_case
stale_head
clear_head_runs; head_runs 1 1 '[{"name":"ci","status":"running","workflow_id":"release.yml"}]' 
printf '{"total_count":1,"workflow_runs":[{"created":"%s","html_url":"http://x/runs/8"}]}' "$(iso '-3 minutes')" > "$tmp/runs/push.json"
run_canary >/dev/null 2>&1 || fail "(d2) an ungated repo must still exit 0"
posts | grep -qi 'UNGATED' || fail "(d2) a task named ci under a non-ci.yml workflow must NOT count as claimed"
pass=$((pass+1))

# ── (d3) #109: 60+ non-ci runs on the head IN FRONT of the ci run → silent ────
# dev-factory pushes ~10 cron tasks per 15 min on the same head; within ~3 h
# the ci run was off page 1 of the recency-ordered tasks view and every aged
# head read UNGATED. The head's own runs are paged from the LAST page (the ci
# run is the oldest on a head), so a stale head with 60 newer non-ci runs must
# be found claimed — and the canary must never touch the tasks view for it.
reset_case
stale_head
clear_head_runs
noise='[' ; for i in $(seq 1 50); do noise="$noise{\"name\":\"swarm\",\"status\":\"success\",\"workflow_id\":\"swarm.yml\"},"; done; noise="${noise%,}]"
head_runs 61 1 "$noise"
head_runs 61 2 '[{"name":"resume-asks","status":"success","workflow_id":"resume-asks.yml"},{"name":"seam","status":"success","workflow_id":"ci.yml"}]'
run_canary >/dev/null 2>&1 || fail "(d3) a paged, claimed head must exit 0"
posted && fail "(d3) a ci run behind 60 newer non-ci runs on the head must NOT read UNGATED (#109)"
grep -q 'page=2' "$tmp/headruns/reads.log" || fail "(d3) the canary must read the LAST page of the head's runs"
grep -q 'TASKS_READ' "$tmp/headruns/reads.log" && fail "(d3) the liveness assertion must not read the recency-paged tasks view (#109)"
pass=$((pass+1))

# ── (d4) #109/#880: a ci run that exists but is still `waiting` is NOT claimed ─
reset_case
stale_head
clear_head_runs; head_runs 1 1 '[{"name":"seam","status":"waiting","workflow_id":"ci.yml"}]'
run_canary >/dev/null 2>&1 || fail "(d4) must exit 0"
posts | grep -qi 'UNGATED' || fail "(d4) a waiting-only ci run must still read UNGATED (the #880 trap)"
pass=$((pass+1))

# ── (e) API down → exit 2, one post ──────────────────────────────────────────
reset_case
rc=0
run_canary >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 0 ] || fail "(e) sanity: a healthy tick before the outage is exit 0"
rc=0
API_DOWN=1 run_canary >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 2 ] || fail "(e) a fully-unreachable API must exit 2 (got $rc)"
posts | grep -qi 'UNREACHABLE' || fail "(e) the outage must post one UNREACHABLE alarm"
[ "$(posts | grep -c '.')" -ge 1 ] || fail "(e) exactly the outage post"
pass=$((pass+1))

# ── extra: the pure-AGE saturation branch (count small, oldest stale) ─────────
# case (b) trips on count>MAX_WAITING and never exercises the age comparison.
reset_case
printf '{"total_count":3,"workflow_runs":[{"created":"%s","html_url":"http://x/runs/2"},{"created":"%s","html_url":"http://x/runs/3"}]}' \
  "$(iso '-90 minutes')" "$(iso '-5 minutes')" > "$tmp/runs/push.json"
run_canary >/dev/null 2>&1
posts | grep -qi 'SATURATED' || fail "(age) an oldest waiting run past MAX_WAIT_MIN must alarm even below the count threshold"
pass=$((pass+1))

# …and a small, FRESH queue below both thresholds stays silent.
reset_case
printf '{"total_count":3,"workflow_runs":[{"created":"%s","html_url":"http://x/runs/4"}]}' "$(iso '-4 minutes')" > "$tmp/runs/push.json"
run_canary >/dev/null 2>&1
posted && fail "(age) a small, fresh waiting queue must stay silent"
pass=$((pass+1))

# ── (nochat) notify's would-have-sent surfaces when Mattermost is unwired ─────
# #107: the generated tick runs with a bare cron env; without the host env,
# notify-mattermost.sh finds no MATTERMOST_URL/_CHANNEL_ID/_BOT_TOKEN and prints
# "would have sent:" to STDERR. The canary must let that through (not swallow it
# with 2>&1 >/dev/null), so a dropped alarm at least reaches backstop.log.
rm -rf "$tmp/state-nochat"
{ printf '{"total_count":165,"workflow_runs":['
  printf '{"created":"%s","html_url":"http://x/runs/1"}' "$(iso '-23 hours')"
  printf ']}'; } > "$tmp/runs/push.json"
fresh_head; tasks_with_ci
# -u strips any MATTERMOST_* the host env happens to carry, so "unwired" is what
# the canary actually sees (notify-mattermost.sh short-circuits when URL or
# channel is unset, before any curl POST).
out="$(env -u MATTERMOST_URL -u MATTERMOST_CHANNEL_ID -u MATTERMOST_BOT_TOKEN \
  PATH="$tmp/bin:$PATH" FORGEJO_TOKEN=dummy \
  FORGEJO_API=http://x/api/v1/repos/Matou/idss \
  CANARY_STATE_DIR="$tmp/state-nochat" \
  RUNS_DIR="$tmp/runs" TASKS_JSON="$tmp/tasks.json" \
  BRANCH_JSON="$tmp/branch.json" META_JSON="$tmp/meta.json" \
  POSTS_LOG="$tmp/posts-nochat.log" \
  bash "$here/../scheduler-canary.sh" 2>&1)"
grep -qi 'would have sent' <<<"$out" || fail "(nochat) an unwired canary must surface the would-have-sent line, not swallow it"
grep -qi 'SATURATED' <<<"$out" || fail "(nochat) the surfaced would-have-sent must carry the alarm text"
pass=$((pass+1))

echo "scheduler-canary: $pass scenarios passed"
