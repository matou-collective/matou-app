#!/usr/bin/env bash
# Offline test for fleet-dispatch.sh — the shadow dispatcher's `once` pass
# (ADR 0009, slice 2 / #355). Fake checkouts with fake listers (the fleet order),
# crafted slot reports on disk (the hosts' half), a shimmed curl. Proves one pass
# rebuilds the order, allocates the head pick to a free slot on a named host,
# LOGS it, and in shadow DISPATCHES NOTHING; and that flipping the mode to live
# (slice 4) makes the SAME pass ride the workflow_dispatch seam.
# Run: bash tests/fleet-dispatch-test.sh
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"
sc="$here/.."

tmp="$(tmpdir)"
export FLEET_DISPATCH_HOME="$tmp/dispatch"
export FLEET_DISPATCH_INBOX="$tmp/dispatch/inbox"
export FLEET_DISPATCH_REPORTS="$tmp/dispatch/reports"
export FLEET_DISPATCH_REPORT_TTL=240
export FORGEJO_TOKEN=t CURL_LOG="$tmp/curl.log"
mkdir -p "$FLEET_DISPATCH_INBOX" "$FLEET_DISPATCH_REPORTS"

mk_checkout() { # <dir> <slug> <lister-json>
  mkdir -p "$1/.sandcastle"
  printf ': "${FORGEJO_API:=https://forge.test/api/v1/repos/%s}"\n' "$2" >"$1/.sandcastle/swarm-identity.sh"
  printf '#!/usr/bin/env bash\ncat <<'"'"'JSON'"'"'\n%s\nJSON\n' "$3" >"$1/.sandcastle/list-ready-tasks.sh"
}
mk_checkout "$tmp/alpha" Acme/alpha '[{"number":10,"title":"oldest","body":"","url":"u","created_at":"2026-10-01T00:00:00Z","priority":false,"blocker":false}]'
mk_checkout "$tmp/beta"  Acme/beta  '[{"number":5,"title":"mid","body":"","url":"u","created_at":"2026-10-10T00:00:00Z","priority":false,"blocker":false}]'
export FLEET_QUEUE_REPOS="$tmp/alpha:Acme/alpha $tmp/beta:Acme/beta"

# a report on disk, keyed by host, already stamped received-at=now
put_report() { # <host> <drive_reserved> <slots-json>
  jq -cn --arg h "$1" --argjson dr "$2" --argjson slots "$3" --argjson now "$(date +%s)" \
    '{report_version:1,event:"tick",host:$h,now:$now,drive_reserved:$dr,slots:$slots,ended:null,_received_at:$now}' \
    >"$FLEET_DISPATCH_REPORTS/$1.json"
}
free_slot() { jq -cn --argjson n "$1" '{n:$n,path:("/s/"+($n|tostring)),state:"free",issue:null,iteration:null,holder:null}'; }
busy_slot() { jq -cn --argjson n "$1" '{n:$n,path:("/s/"+($n|tostring)),state:"busy",issue:99,iteration:null,holder:{kind:"ticket",repo:"Acme/x",worker:"w",ref:"99",since:1,pid:1,pid_alive:true}}'; }

shim curl <<'SH'
printf '%s\n' "$*" >>"${CURL_LOG:?}"
case "$*" in *'%{http_code}'*) printf '204' ;; esac
SH
run() { bash "$sc/fleet-dispatch.sh" "$@" 2>&1; }
dispatched() { local n; n="$(grep -c "dispatches" "$CURL_LOG" 2>/dev/null)" || true; echo "${n:-0}"; }

# ── shadow once: the fleet head is allocated to a free slot, nothing dispatched ─
: >"$CURL_LOG"
put_report boxA false "[$(busy_slot 1),$(free_slot 2)]"   # one free slot
out="$(run once)"
check "once names the mode and the fleet-wide counts" \
  'grep -q "mode=shadow" <<<"$out" && grep -q "2 ready fleet-wide" <<<"$out"'
check "once allocates the fleet head (alpha#10) to boxA's free slot 2" \
  'grep -q "ALLOC  Acme/alpha#10 -> boxA slot 2" <<<"$out"'
check "once exercises the start-a-run seam in shadow (would start, dispatches nothing)" \
  'grep -qi "SHADOW — would start Acme/alpha#10 on boxA" <<<"$out"'
check "once DISPATCHES NOTHING in shadow" '[ "$(dispatched)" -eq 0 ]'

# ── the second pick is queued when only one slot is free, with why-not-sooner ─
check "the second ready ticket (beta#5) is queued because the 1 free slot went ahead" \
  'grep -q "QUEUE  Acme/beta#5" <<<"$out" && grep -qi "went to the 1 higher" <<<"$out"'

# ── a drive-reserved host is offered nothing (ruling E) ──────────────────────
: >"$CURL_LOG"; rm -f "$FLEET_DISPATCH_REPORTS"/*.json
put_report boxDrive true "[$(free_slot 1)]"
out="$(run once)"
check "a drive-reserved host contributes no slot; the head is queued" \
  'grep -q "QUEUE  Acme/alpha#10" <<<"$out" && grep -qi "no free slot anywhere" <<<"$out"'
check "the host line names the drive reservation and ruling E" \
  'grep -q "boxDrive" <<<"$out" && grep -qi "drive reservation held" <<<"$out"'

# ── a stale report marks its host unknown; offered nothing ───────────────────
: >"$CURL_LOG"; rm -f "$FLEET_DISPATCH_REPORTS"/*.json
put_report boxStale false "[$(free_slot 1)]"
jq -c '._received_at = (._received_at - 9999)' "$FLEET_DISPATCH_REPORTS/boxStale.json" >"$FLEET_DISPATCH_REPORTS/boxStale.json.t" \
  && mv "$FLEET_DISPATCH_REPORTS/boxStale.json.t" "$FLEET_DISPATCH_REPORTS/boxStale.json"
out="$(run once)"
check "a stale host is marked unknown and offered nothing" \
  'grep -q "boxStale" <<<"$out" && grep -qi "unknown" <<<"$out" && [ "$(dispatched)" -eq 0 ]'

# ── the seam flips to live (slice 4): the SAME pass rides workflow_dispatch ───
: >"$CURL_LOG"; rm -f "$FLEET_DISPATCH_REPORTS"/*.json
put_report boxA false "[$(free_slot 1)]"
out="$(FLEET_DISPATCH_MODE=live FLEET_DISPATCH_DETECT=off run once)"
check "FLEET_DISPATCH_MODE=live makes the pass dispatch the head via swarm.yml" \
  '[ "$(dispatched)" -ge 1 ] && grep -q "Acme/alpha/actions/workflows/swarm.yml/dispatches" "$CURL_LOG"'

# ── stage 6b (slice 4 / #357): live on ONE host; the other is logged-only ─────
# Two idle hosts, two ready tickets: alpha#10 -> boxA#1, beta#5 -> boxB#1 (the
# fleet order against host-then-slot free slots). Scoped live to boxA: alpha#10 is
# dispatched for real; beta#5 on boxB is logged-only, boxB left on its own tick.
: >"$CURL_LOG"; rm -f "$FLEET_DISPATCH_REPORTS"/*.json
put_report boxA false "[$(free_slot 1)]"
put_report boxB false "[$(free_slot 1)]"
out="$(FLEET_DISPATCH_MODE=live FLEET_DISPATCH_LIVE_HOSTS=boxA FLEET_DISPATCH_DETECT=off run once)"
check "scoped-live names the live host in the mode line" \
  'grep -q "mode=live (live hosts: boxA)" <<<"$out"'
check "scoped-live dispatches the in-scope host's pick for real (alpha -> boxA)" \
  'grep -q "Acme/alpha/actions/workflows/swarm.yml/dispatches" "$CURL_LOG"'
check "scoped-live does NOT dispatch the out-of-scope host's pick (beta -> boxB)" \
  '! grep -q "Acme/beta/actions/workflows/swarm.yml/dispatches" "$CURL_LOG"'
check "scoped-live logs the out-of-scope pick as a shadow would-start" \
  'grep -qi "SHADOW — would start Acme/beta#5 on boxB" <<<"$out"'
check "exactly one real dispatch under stage 6b" '[ "$(dispatched)" -eq 1 ]'
check "the host lines mark boxA live and boxB on its own tick" \
  'grep "boxA" <<<"$out" | grep -qi "live — dispatcher allocates" && grep "boxB" <<<"$out" | grep -qi "shadow — on its own tick"'

# ── stage 6c: empty allowlist in live mode is fleet-wide — both dispatched ────
: >"$CURL_LOG"; rm -f "$FLEET_DISPATCH_REPORTS"/*.json
put_report boxA false "[$(free_slot 1)]"
put_report boxB false "[$(free_slot 1)]"
out="$(FLEET_DISPATCH_MODE=live FLEET_DISPATCH_DETECT=off run once)"
check "fleet-wide live dispatches BOTH hosts' picks (stage 6c)" \
  '[ "$(dispatched)" -eq 2 ] && grep -q "Acme/alpha/actions/workflows/swarm.yml/dispatches" "$CURL_LOG" && grep -q "Acme/beta/actions/workflows/swarm.yml/dispatches" "$CURL_LOG"'

# ── live arbitration (#365): no duplicate runs, honour the #351 marker ───────
# The live path used to call the start-a-run seam for every placed pick on EVERY
# ~17 s pass — a fresh workflow_dispatch each pass until the leg claimed (5–15
# duplicates). It now arbitrates on the tracker first (reusing #351's marker), so
# a pick it already offered — or one a peer host is dispatching — is skipped. A
# richer comment-store curl shim (the fleet-queue tracker) stands in for the forge.
export FLEET_QUEUE_MARKS="$tmp/dispatch/marks"
export COMMENTS_DIR="$tmp/comments"
shim curl <<'SH'
url=""; method=GET; data=""
while [ $# -gt 0 ]; do
  case "$1" in -X) method="$2"; shift 2 ;; -H|-d|--max-time|-o|-w) [ "$1" = -d ] && data="$2"; shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac
done
[ "$data" = "@-" ] && data="$(cat)"
printf '%s %s %s\n' "$method" "$url" "$data" >>"${CURL_LOG:?}"
store="${COMMENTS_DIR:?}"; mkdir -p "$store"
cfile() { local k="${url#*/repos/}"; k="${k%/comments}"; printf '%s/%s.json' "$store" "${k//\//_}"; }
nextid() { local i; i=$(( $(cat "$store/seq" 2>/dev/null || echo 100) + 1 )); echo "$i" >"$store/seq"; echo "$i"; }
put() { local f="$1" id c; id="$(nextid)"; [ -f "$f" ] || echo '[]' >"$f"
  c="$(jq -cn --argjson id "$id" --arg b "$3" --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{id:$id, body:$b, created_at:$t}')"
  jq -c --argjson c "$c" '. + [$c]' "$f" >"$f.tmp" && mv "$f.tmp" "$f"; printf '%s' "$c"; }
case "$method $url" in
  "GET "*/issues/*/comments) f="$(cfile)"; if [ -f "$f" ]; then cat "$f"; else printf '[]'; fi ;;
  "POST "*/issues/*/comments) f="$(cfile)"; put "$f" x "$(jq -r .body <<<"$data")" ;;
  "DELETE "*/issues/comments/*)
    id="${url##*/}"; hit=404
    for f in "$store"/*.json; do [ -f "$f" ] || continue
      if jq -e --argjson id "$id" 'any(.[]; .id == $id)' "$f" >/dev/null; then
        jq -c --argjson id "$id" 'map(select(.id != $id))' "$f" >"$f.tmp" && mv "$f.tmp" "$f"; hit=204; fi
    done; printf '%s' "$hit" ;;
  *"/dispatches") printf '204' ;;
  *) printf '[]' ;;
esac
SH

# acceptance 1 + 3: two ready tickets, ONE free slot on the live host. Pass 1
# dispatches the head once and queues the second; pass 2, with no claim between,
# dispatches NOTHING — exactly one dispatch across two consecutive passes.
: >"$CURL_LOG"; rm -rf "$COMMENTS_DIR"; rm -f "$FLEET_QUEUE_MARKS"; rm -f "$FLEET_DISPATCH_REPORTS"/*.json
put_report boxA false "[$(free_slot 1)]"
out="$(FLEET_DISPATCH_MODE=live FLEET_DISPATCH_DETECT=off run once)"
check "pass 1 dispatches the fleet head exactly once (alpha -> boxA)" \
  '[ "$(dispatched)" -eq 1 ] && grep -q "Acme/alpha/actions/workflows/swarm.yml/dispatches" "$CURL_LOG"'
check "pass 1 posts a dispatch marker naming the target host (boxA)" \
  'grep -q "POST .*/repos/Acme/alpha/issues/10/comments" "$CURL_LOG" && grep -q "fleet-dispatch host=boxA" "$CURL_LOG"'
check "pass 1 queues the second ready ticket (one free slot went ahead)" \
  'grep -q "QUEUE  Acme/beta#5" <<<"$out" && grep -qi "went to the 1 higher" <<<"$out"'
: >"$CURL_LOG"
out="$(FLEET_DISPATCH_MODE=live FLEET_DISPATCH_DETECT=off run once)"
check "pass 2 (no claim between) dispatches NOTHING — the marker remembers the offer" \
  '[ "$(dispatched)" -eq 0 ]'
check "pass 2 logs the SKIP naming the standing marker" \
  'grep -q "SKIP Acme/alpha#10" <<<"$out" && grep -qi "already holds it" <<<"$out"'

# acceptance 2: a ticket carrying a PEER host's live marker is not dispatched.
: >"$CURL_LOG"; rm -rf "$COMMENTS_DIR"; rm -f "$FLEET_QUEUE_MARKS"; rm -f "$FLEET_DISPATCH_REPORTS"/*.json
mkdir -p "$COMMENTS_DIR"
jq -cn --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '[{id:50, body:"fleet-dispatch host=boxPeer\n(automated)", created_at:$t}]' >"$COMMENTS_DIR/Acme_alpha_issues_10.json"
put_report boxA false "[$(free_slot 1)]"
out="$(FLEET_DISPATCH_MODE=live FLEET_DISPATCH_DETECT=off run once)"
check "a ticket carrying a peer host's live marker is NOT dispatched" \
  '! grep -q "Acme/alpha/actions/workflows/swarm.yml/dispatches" "$CURL_LOG"'
check "the skip names the peer host holding it (#351, dispatcher vs ticking host)" \
  'grep -q "SKIP Acme/alpha#10" <<<"$out" && grep -q "boxPeer" <<<"$out"'

# ── runner-queue backpressure (#373): a backed-up host gets no live offer ─────
# A free heavy slot does not mean the host's runner will pick a dispatched leg up:
# a backed-up runner leaves the leg `waiting` past the marker TTL while — in live
# mode — the host's own tick stood down, so the slot idles (the #370 stall). Before
# a live offer the dispatcher reads that host's runner-queue lag from the tracker
# (actions/runs?status=waiting) and treats a host over the ceiling as not free. A
# shim that answers the queued-run view from WAITING_JSON (or fails on WAITING_FAIL),
# plus the comment-store + dispatch seam from the arbitration block above.
export CURL_LOG="$tmp/bp.curl.log"
shim curl <<'SH'
url=""; method=GET; data=""
while [ $# -gt 0 ]; do
  case "$1" in -X) method="$2"; shift 2 ;; -H|-d|--max-time|-o|-w) [ "$1" = -d ] && data="$2"; shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac
done
[ "$data" = "@-" ] && data="$(cat)"
printf '%s %s %s\n' "$method" "$url" "$data" >>"${CURL_LOG:?}"
case "$url" in
  *"actions/runs?status=waiting"*)
    [ -n "${WAITING_FAIL:-}" ] && exit 22
    wj="${WAITING_JSON:-}"; [ -n "$wj" ] || wj='{"workflow_runs":[]}'
    printf '%s' "$wj"; exit 0 ;;
esac
store="${COMMENTS_DIR:?}"; mkdir -p "$store"
cfile() { local k="${url#*/repos/}"; k="${k%/comments}"; printf '%s/%s.json' "$store" "${k//\//_}"; }
nextid() { local i; i=$(( $(cat "$store/seq" 2>/dev/null || echo 100) + 1 )); echo "$i" >"$store/seq"; echo "$i"; }
put() { local f="$1" id c; id="$(nextid)"; [ -f "$f" ] || echo '[]' >"$f"
  c="$(jq -cn --argjson id "$id" --arg b "$3" --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{id:$id, body:$b, created_at:$t}')"
  jq -c --argjson c "$c" '. + [$c]' "$f" >"$f.tmp" && mv "$f.tmp" "$f"; printf '%s' "$c"; }
case "$method $url" in
  "GET "*/issues/*/comments) f="$(cfile)"; if [ -f "$f" ]; then cat "$f"; else printf '[]'; fi ;;
  "POST "*/issues/*/comments) f="$(cfile)"; put "$f" x "$(jq -r .body <<<"$data")" ;;
  *"/dispatches") printf '204' ;;
  *) printf '[]' ;;
esac
SH
mk_waiting() { # <host> <age-seconds> : a queued run whose leg names <host>, <age>s old
  jq -cn --arg h "$1" --argjson now "$(date +%s)" --argjson age "$2" \
    '{workflow_runs:[{display_title:("swarm "+$h+" #10"),name:"swarm",created:(($now-$age)|todateiso8601)}]}'
}

# the pick falls to the NEXT free host when the head's would-be host is backed up
: >"$CURL_LOG"; rm -rf "$COMMENTS_DIR"; rm -f "$FLEET_QUEUE_MARKS"; rm -f "$FLEET_DISPATCH_REPORTS"/*.json
put_report boxA false "[$(free_slot 1)]"
put_report boxB false "[$(free_slot 1)]"
WAITING_JSON="$(mk_waiting boxA 300)"; export WAITING_JSON   # boxA's runner is ~300s deep (> 240 ceiling)
out="$(FLEET_DISPATCH_MODE=live FLEET_DISPATCH_DETECT=off run once)"
check "a backed-off host's line names its runner-queue lag (#373)" \
  'grep "boxA" <<<"$out" | grep -qi "runner queue backed up"'
check "the pick falls to the next free host (boxB), not the backed-off boxA" \
  'grep -q "ALLOC  Acme/alpha#10 -> boxB" <<<"$out" && grep -q "Acme/alpha/actions/workflows/swarm.yml/dispatches" "$CURL_LOG"'
check "nothing is dispatched to the backed-off host (its marker names boxB)" \
  'grep -q "fleet-dispatch host=boxB" "$CURL_LOG" && ! grep -q "fleet-dispatch host=boxA" "$CURL_LOG"'

# with the only free host backed off, the head QUEUES with the reason named
: >"$CURL_LOG"; rm -rf "$COMMENTS_DIR"; rm -f "$FLEET_QUEUE_MARKS"; rm -f "$FLEET_DISPATCH_REPORTS"/*.json
put_report boxA false "[$(free_slot 1)]"
WAITING_JSON="$(mk_waiting boxA 300)"; export WAITING_JSON
out="$(FLEET_DISPATCH_MODE=live FLEET_DISPATCH_DETECT=off run once)"
check "with its only free host backed off, the head queues (no free slot anywhere)" \
  'grep -q "QUEUE  Acme/alpha#10" <<<"$out" && grep -qi "no free slot anywhere" <<<"$out"'
check "a backed-off host is dispatched nothing" '[ "$(dispatched)" -eq 0 ]'

# a failed queued-run read FAILS OPEN — the host is still offered its slot
: >"$CURL_LOG"; rm -rf "$COMMENTS_DIR"; rm -f "$FLEET_QUEUE_MARKS"; rm -f "$FLEET_DISPATCH_REPORTS"/*.json
put_report boxA false "[$(free_slot 1)]"
unset WAITING_JSON; export WAITING_FAIL=1
out="$(FLEET_DISPATCH_MODE=live FLEET_DISPATCH_DETECT=off run once)"
check "a failed queued-run read fails OPEN — the host keeps its offer and is dispatched" \
  '[ "$(dispatched)" -ge 1 ] && grep -q "Acme/alpha/actions/workflows/swarm.yml/dispatches" "$CURL_LOG"'
unset WAITING_FAIL

# shadow makes NO extra tracker read (the check is live-only) and still allocates
: >"$CURL_LOG"; rm -rf "$COMMENTS_DIR"; rm -f "$FLEET_QUEUE_MARKS"; rm -f "$FLEET_DISPATCH_REPORTS"/*.json
put_report boxA false "[$(free_slot 1)]"
WAITING_JSON="$(mk_waiting boxA 300)"; export WAITING_JSON
out="$(FLEET_DISPATCH_DETECT=off run once)"   # shadow (the default)
check "shadow reads no queued-run view (no actions/runs call) — no extra tracker traffic" \
  '! grep -q "actions/runs" "$CURL_LOG"'
check "shadow still allocates the backed-up host's slot (backpressure is live-only)" \
  'grep -q "ALLOC  Acme/alpha#10 -> boxA" <<<"$out"'
unset WAITING_JSON

# ── ingest mode spools one report ────────────────────────────────────────────
rm -f "$FLEET_DISPATCH_REPORTS"/*.json
printf '%s' "$(jq -cn '{report_version:1,event:"tick",host:"boxZ",now:1,drive_reserved:false,slots:[],ended:null}')" | run ingest >/dev/null 2>&1
check "ingest mode keys a stdin report by host" '[ -f "$FLEET_DISPATCH_REPORTS/boxZ.json" ]'

# ── usage ────────────────────────────────────────────────────────────────────
check "an unknown mode is a usage error (2)" '[ "$(run bogus >/dev/null 2>&1; echo $?)" -eq 2 ]'

# ── landing detection (slice 5 / #358): a stranded close is surfaced ─────────
# Acceptance: a ticket closed with its commits absent from main is surfaced
# within one detection pass, with the evidence named. A real git-repo checkout
# (so reachability is meaningful) + crafted forge fixtures; detection runs every
# pass (INTERVAL=0) and in SHADOW logs the anomaly and files nothing.
det="$tmp/det"; mkdir -p "$det/.sandcastle"
printf ': "${FORGEJO_API:=https://forge.test/api/v1/repos/Acme/det}"\n' >"$det/.sandcastle/swarm-identity.sh"
printf '#!/usr/bin/env bash\necho "[]"\n' >"$det/.sandcastle/list-ready-tasks.sh"
(
  cd "$det" || exit; git init -q; git config user.email t@t; git config user.name t
  git checkout -q -b main
  echo a >a; git add a; git commit -qm A
  echo b >b; git add b; git commit -qm B      # LANDED on main
  git rev-parse HEAD >"$det/landed.sha"
  git checkout -q -b side HEAD~1
  echo c >c; git add c; git commit -qm C       # STRANDED, never on main
  git rev-parse HEAD >"$det/stranded.sha"
  git checkout -q main
)
LANDED_SHA="$(cat "$det/landed.sha")"; STRANDED_SHA="$(cat "$det/stranded.sha")"; export LANDED_SHA STRANDED_SHA
# a close-report comment embedding the given sha (the ```json envelope)
cr_comment() { jq -cn --arg s "$1" '[{id:9, body:("**close-report** for #X — status `success`\n\n<details><summary>envelope</summary>\n\n```json\n{\"status\":\"success\",\"commits\":[\""+$s+"\"]}\n```\n</details>")}]'; }
CR_10="$(cr_comment "$STRANDED_SHA")"; export CR_10   # #10 closed against a stranded commit
CR_11="$(cr_comment "$LANDED_SHA")"; export CR_11      # #11 closed against a landed commit

shim curl <<'SH'
args="$*"
case "$args" in *'%{http_code}'*) b="$(cat 2>/dev/null||true)"; printf 'POST %s BODY %s\n' "$args" "$b" >>"${CURL_LOG:?}"; printf '201'; exit 0 ;; esac
case "$args" in
  *"labels=agent-working"*) printf '[]' ;;
  *"state=closed"*)         printf '[{"number":10,"closed_at":"2026-01-01T00:00:00Z"},{"number":11,"closed_at":"2026-01-01T00:00:00Z"}]' ;;
  *"/issues/10/comments"*)  printf '%s' "$CR_10" ;;
  *"/issues/11/comments"*)  printf '%s' "$CR_11" ;;
  *"/branches"*)            printf '[]' ;;
  *"/pulls"*)               printf '[]' ;;
  *"/labels"*)              printf '[]' ;;
  *"data-urlencode"*)       printf '[]' ;;
  *"/timeline"*)            printf '[]' ;;
  *)                        printf '[]' ;;
esac
SH
export FLEET_QUEUE_REPOS="$det:Acme/det"
export FLEET_DISPATCH_DETECT_INTERVAL=0
export FLEET_DISPATCH_DETECT_STAMP="$tmp/detect-stamp"
export FLEET_LANDING_MAIN_REF=main   # the throwaway repo tracks no origin/main
rm -f "$FLEET_DISPATCH_REPORTS"/*.json; : >"$CURL_LOG"
out="$(run once)"
check "detection runs a pass and names the mode" 'grep -q "fleet-landing" <<<"$out" && grep -q "mode=shadow" <<<"$out"'
check "the stranded close (#10) is surfaced with its evidence" \
  'grep -q "LANDING stranded-close  Acme/det#10" <<<"$out" && grep -qi "absent from main" <<<"$out"'
check "the cleanly-landed close (#11) is NOT surfaced" '! grep -q "Acme/det#11" <<<"$out"'
check "SHADOW files nothing (no issue POST)" '! grep -q "POST .*/issues BODY" "$CURL_LOG"'

# live: the SAME pass files the stranded close at the front (priority), once
: >"$CURL_LOG"; rm -f "$FLEET_DISPATCH_DETECT_STAMP"
out="$(FLEET_DISPATCH_MODE=live run once)"
check "live detection files a priority ticket to the anomaly's repo" \
  'grep -q "POST .*/repos/Acme/det/issues BODY" "$CURL_LOG" && grep -q "fleet-landing] stranded-close Acme/det#10" "$CURL_LOG"'

# ── issue 2 (#363): detection runs OFF the allocation path; TERM stops promptly ──
# A SLOW detection (its closed-issues read sleeps) must NOT stall the allocator (it
# keeps logging passes at the 1s cadence) and must NOT defer SIGTERM behind a read in
# flight. The fork is `disown`ed so the next pass's fleet_queue_collect bare-`wait`
# does not inherit and spin on it. Bounded hard by `timeout` so a regression cannot
# busy-spin: a working loop prints several passes and is TERM-reaped inside the window.
loopdir="$tmp/loop"; mkdir -p "$loopdir/.sandcastle"
printf ': "${FORGEJO_API:=https://forge.test/api/v1/repos/Acme/loop}"\n' >"$loopdir/.sandcastle/swarm-identity.sh"
printf '#!/usr/bin/env bash\necho "[]"\n' >"$loopdir/.sandcastle/list-ready-tasks.sh"
( cd "$loopdir" || exit; git init -q; git config user.email t@t; git config user.name t
  git checkout -q -b main; echo a >a; git add a; git commit -qm A ) >/dev/null 2>&1
shim curl <<'SH'
args="$*"
case "$args" in *'%{http_code}'*) cat >/dev/null 2>&1 || true; printf '201'; exit 0 ;; esac
case "$args" in
  *"state=closed"*) sleep 4; printf '[]' ;;   # the slow detection read (> the interval)
  *)                printf '[]' ;;
esac
SH
loop_log="$tmp/loop.log"; : >"$loop_log"
rm -f "$FLEET_DISPATCH_REPORTS"/*.json
# `timeout --signal=TERM 3` sends SIGTERM at 3s (the signal the loop traps) and
# SIGKILL at +2s if it has not exited; a healthy loop exits on the TERM within that
# window, a broken one is force-reaped — either way the test cannot run away.
t_start="$(date +%s)"
FLEET_QUEUE_REPOS="$loopdir:Acme/loop" FLEET_DISPATCH_INTERVAL=1 FLEET_DISPATCH_DETECT_INTERVAL=0 \
  FLEET_DISPATCH_DETECT_STAMP="$tmp/loop-stamp" FLEET_LANDING_MAIN_REF=main \
  timeout --signal=TERM --kill-after=2 3 bash "$sc/fleet-dispatch.sh" loop >"$loop_log" 2>&1
t_end="$(date +%s)"
passes="$(grep -c "ready fleet-wide" "$loop_log" 2>/dev/null || true)"
check "the allocator keeps its cadence while a slow detection runs (>=2 passes in ~3s)" \
  '[ "${passes:-0}" -ge 2 ]'
check "a SIGTERM stops the loop promptly — within the TERM window, not after the read" \
  '[ $(( t_end - t_start )) -lt 5 ]'
check "detection does not busy-spin the allocator (the fork is disowned, no runaway)" \
  '[ "${passes:-0}" -lt 100 ]'

summary fleet-dispatch-test
