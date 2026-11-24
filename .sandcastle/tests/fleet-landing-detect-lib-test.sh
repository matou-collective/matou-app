#!/usr/bin/env bash
# Offline test for fleet-landing-detect-lib.sh — the fleet dispatcher's LANDING
# DETECTION (ADR 0009, slice 5 / #358). Drives the PURE detection core over
# crafted facts (all four anomaly cases + the live-run suppression), the gather
# helpers over a shimmed curl and a throwaway git repo (the fleet-queue-lib /
# close-report-lib precedent), and the file seam in both modes (shadow logs +
# files nothing; live POSTs once and re-arms a duplicate). No network, no docker.
# Run: bash tests/fleet-landing-detect-lib-test.sh
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"
sc="$here/.."

export FORGEJO_TOKEN=t
export FLEET_LANDING_NOW=1000000
# The curl shim is a separate process; it reads these fixtures from the env, so
# every FIX_/FILE_ name must be EXPORTED (a bare assignment never reaches it).
export FIX_STATUS FIX_COMMENTS FIX_TIMELINE FIX_BRANCHES FIX_PULLS FIX_LABELS FIX_SEARCH FIX_WORKING FIX_ISSUE FILE_CODE
# shellcheck source=../fleet-landing-detect-lib.sh
. "$sc/fleet-landing-detect-lib.sh"

root=https://forge.test/api/v1

# ── the pure core: four rules + suppression ──────────────────────────────────
facts="$(jq -cn '{
  closes: [ {repo:"Acme/alpha", number:10, commits:["aaa","bbb"], unreached:["bbb"]},
            {repo:"Acme/alpha", number:11, commits:["ccc"], unreached:[]} ],
  working:[ {repo:"Acme/beta", number:5}, {repo:"Acme/beta", number:6} ],
  live:   [ {repo:"Acme/beta", issue:6} ],
  rescues:[ {repo:"Acme/alpha", branch:"sandcastle/rescue-20261118-010101", head:"deadbeef", merged:false},
            {repo:"Acme/alpha", branch:"sandcastle/rescue-landed", head:"cafe", merged:true} ],
  prs:    [ {repo:"Acme/gamma", number:20, head:"agent/issue-20", state:"open", status:"success", merged:false},
            {repo:"Acme/gamma", number:21, head:"agent/issue-21", state:"open", status:"pending", merged:false} ]
}')"
anoms="$(fleet_landing_detect "$facts")"
check "detect returns a JSON array" 'jq -e "type==\"array\"" <<<"$anoms" >/dev/null'
check "case 1: a close with an unreached commit is stranded-close (bbb named, aaa/bbb claimed)" \
  'jq -e "any(.[]; .kind==\"stranded-close\" and .repo==\"Acme/alpha\" and .number==10 and (.ref==\"bbb\") and (.evidence|test(\"bbb\") and test(\"aaa\")))" <<<"$anoms" >/dev/null'
check "case 1: a close whose commits all landed is NOT flagged" \
  '! jq -e "any(.[]; .number==11)" <<<"$anoms" >/dev/null'
check "case 2: an agent-working ticket no live run holds is working-no-run" \
  'jq -e "any(.[]; .kind==\"working-no-run\" and .repo==\"Acme/beta\" and .number==5)" <<<"$anoms" >/dev/null'
check "case 2: an agent-working ticket a fresh report HOLDS is suppressed" \
  '! jq -e "any(.[]; .kind==\"working-no-run\" and .number==6)" <<<"$anoms" >/dev/null'
check "case 3: an unmerged rescue branch is unrelanded-rescue (branch named in ref)" \
  'jq -e "any(.[]; .kind==\"unrelanded-rescue\" and .ref==\"sandcastle/rescue-20261118-010101\")" <<<"$anoms" >/dev/null'
check "case 3: a merged rescue branch is NOT flagged" \
  '! jq -e "any(.[]; .kind==\"unrelanded-rescue\" and .ref==\"sandcastle/rescue-landed\")" <<<"$anoms" >/dev/null'
check "case 4: a green open agent PR is unmerged-pr" \
  'jq -e "any(.[]; .kind==\"unmerged-pr\" and .repo==\"Acme/gamma\" and .number==20)" <<<"$anoms" >/dev/null'
check "case 4: a non-green (pending) agent PR is NOT flagged" \
  '! jq -e "any(.[]; .kind==\"unmerged-pr\" and .number==21)" <<<"$anoms" >/dev/null'
check "every anomaly carries a stable dedup key" \
  '[ "$(jq -r "[.[].key] | map(select(. != null and . != \"\")) | length" <<<"$anoms")" = "$(jq "length" <<<"$anoms")" ]'

# a null-repo busy slot (a report that could not name the repo) suppresses the
# ticket in ANY repo — err toward NOT filing a bogus anomaly.
anoms2="$(fleet_landing_detect "$(jq -cn '{working:[{repo:"Acme/beta",number:7}], live:[{repo:null,issue:7}]}')")"
check "case 2: a busy slot with a null repo holding issue N suppresses N everywhere" \
  '[ "$(jq length <<<"$anoms2")" = 0 ]'

# empty-commit phrasing (a close-report with no commits array)
anoms3="$(fleet_landing_detect "$(jq -cn '{closes:[{repo:"R",number:1,commits:[],unreached:["x"]}]}')")"
check "case 1: an empty claimed-commits list reads 'no commits' in the evidence" \
  'jq -e ".[0].evidence | test(\"no commits\")" <<<"$anoms3" >/dev/null'

# cold start (#363): with NO fresh report from any host, working-no-run is suppressed
# wholesale — the dispatcher cannot tell a dead run from one it has not heard from yet.
cold="$(fleet_landing_detect "$(jq -cn '{working:[{repo:"R",number:9}], live:[], reports_seen:false}')")"
check "case 2: a cold-started dispatcher (reports_seen=false) flags no working-no-run" \
  '[ "$(jq length <<<"$cold")" = 0 ]'
idle="$(fleet_landing_detect "$(jq -cn '{working:[{repo:"R",number:9}], live:[], reports_seen:true}')")"
check "case 2: reports seen but no busy slot still flags a dead run (reports_seen=true)" \
  'jq -e "any(.[]; .kind==\"working-no-run\" and .number==9)" <<<"$idle" >/dev/null'
check "case 2: reports_seen defaults from live — omitted flag + empty live suppresses" \
  '[ "$(fleet_landing_detect "$(jq -cn "{working:[{repo:\"R\",number:9}]}")" | jq length)" = 0 ]'

# ── format: one log line per anomaly, naming kind + subject + evidence ───────
lines="$(fleet_landing_format "$anoms")"
check "format names a stranded close with its ticket and evidence" \
  'grep -q "LANDING stranded-close  Acme/alpha#10" <<<"$lines" && grep -qi "absent from main" <<<"$lines"'
check "format names a rescue branch (no number, the branch in place of #n)" \
  'grep -q "LANDING unrelanded-rescue  Acme/alpha sandcastle/rescue-20261118-010101" <<<"$lines"'

# ── gather: fleet_landing_close_commits parses the newest close-report envelope ─
env_body='**close-report** for #10 — status `success`

gates passed.

<details><summary>envelope</summary>

```json
{
  "status": "success",
  "commits": ["aaa111", "bbb222"],
  "changed_files": ["x"]
}
```
</details>'
export FIX_COMMENTS
FIX_COMMENTS="$(jq -cn --arg b "$env_body" '[{id:1, body:"an earlier note"}, {id:2, body:$b}]')"
shim curl <<'SH'
args="$*"
case "$args" in *'%{http_code}'*) cat >/dev/null 2>&1 || true; printf '%s' "${FILE_CODE:-201}"; exit 0 ;; esac
case "$args" in
  *"/status"*)               printf '%s' "${FIX_STATUS:-{\}}" ;;
  *"/comments"*)             printf '%s' "${FIX_COMMENTS:-[]}" ;;
  *"/timeline"*)             printf '%s' "${FIX_TIMELINE:-[]}" ;;
  *"/branches"*)             printf '%s' "${FIX_BRANCHES:-[]}" ;;
  *"/pulls"*)                printf '%s' "${FIX_PULLS:-[]}" ;;
  *"/labels"*)               printf '%s' "${FIX_LABELS:-[]}" ;;
  *"data-urlencode"*)        printf '%s' "${FIX_SEARCH:-[]}" ;;
  *"labels=agent-working"*)  printf '%s' "${FIX_WORKING:-[]}" ;;
  *"/issues/"*)              printf '%s' "${FIX_ISSUE:-{\}}" ;;
  *)                         printf '[]' ;;
esac
SH
commits="$(fleet_landing_close_commits "$root" Acme/alpha 10)"
check "close_commits reads the newest envelope's commits array" \
  '[ "$commits" = "aaa111 bbb222 " ] || [ "$commits" = "aaa111 bbb222" ]'
FIX_COMMENTS='[]'
check "close_commits is empty (rc 0) when there is no close-report comment" \
  '[ -z "$(fleet_landing_close_commits "$root" Acme/alpha 10)" ]'

# ── gather: reachability + rescue merged-ness over a throwaway git repo ───────
repo="$(tmpdir)/gitrepo"
mkdir -p "$repo"
(
  cd "$repo" || exit
  git init -q
  git config user.email t@t; git config user.name t
  git checkout -q -b main
  echo a >a; git add a; git commit -qm A
  A="$(git rev-parse HEAD)"
  echo b >b; git add b; git commit -qm B      # B landed on main
  B="$(git rev-parse HEAD)"
  git checkout -q -b side "$A"
  echo c >c; git add c; git commit -qm C       # C never merged to main
  C="$(git rev-parse HEAD)"
  git checkout -q main
  printf '%s %s %s\n' "$A" "$B" "$C" >"$repo/shas"
)
read -r SHA_A SHA_B SHA_C <"$repo/shas"
un="$(fleet_landing_unreached "$repo" main "$SHA_B,$SHA_C")"
check "unreached keeps the un-landed commit and drops the landed one" \
  '[ "$un" = "$SHA_C" ]'
check "unreached is empty when every commit landed" \
  '[ -z "$(fleet_landing_unreached "$repo" main "$SHA_A $SHA_B")" ]'
check "unreached flags a commit the checkout cannot even resolve (never pushed)" \
  '[ "$(fleet_landing_unreached "$repo" main deadbeefdeadbeef)" = deadbeefdeadbeef ]'

# ── gather: fleet_landing_unlanded is robust to a REWRITTEN landing sha (#363) ──
# The landing path rewrites commits (push rebase; PR merge/squash), so by-SHA
# ancestry is not evidence of a strand. Build: a commit landed on main under a NEW
# sha (cherry-pick = same patch-id), and a landing commit that references a ticket.
(
  cd "$repo" || exit
  git checkout -q main
  git checkout -q -b feat "$SHA_A"
  echo r >r; git add r; git commit -qm "feat r"      # authored off A, lands elsewhere
  git rev-parse HEAD >"$repo/rebase_src.sha"
  git checkout -q main
  git cherry-pick "$(cat "$repo/rebase_src.sha")" >/dev/null 2>&1  # SAME diff, NEW sha on main
  echo t >t; git add t; git commit -qm "land the thing (#777)"   # witness-3 ref on main
)
REBASE_SRC="$(cat "$repo/rebase_src.sha")"
check "unlanded drops a commit landed under a REWRITTEN sha (patch-id witness)" \
  '[ -z "$(fleet_landing_unlanded "$repo" main "$REBASE_SRC")" ]'
check "unlanded still flags a genuinely absent commit (no witness)" \
  '[ "$(fleet_landing_unlanded "$repo" main "$SHA_C")" = "$SHA_C" ]'
check "unlanded keeps dropping a cleanly-landed sha (witness 1)" \
  '[ -z "$(fleet_landing_unlanded "$repo" main "$SHA_B")" ]'
check "unlanded clears the WHOLE close when #N is referenced on main (squash/merge witness)" \
  '[ -z "$(fleet_landing_unlanded "$repo" main "deadbeefdeadbeef" 777)" ]'
check "unlanded does NOT clear on an UNreferenced number (still flagged)" \
  '[ "$(fleet_landing_unlanded "$repo" main "$SHA_C" 778)" = "$SHA_C" ]'
check "the ref witness honours a digit boundary (#77 does not match #777)" \
  '! _fleet_landing_ref_on_main "$repo" main 77'

# ── fail safe when the main-ref baseline cannot be resolved (#385) ─────────────
# A cold / unfetched dispatcher checkout cannot resolve origin/main; every git read
# then silently returns nothing and a LANDED commit reads absent. Detection must
# judge NOTHING on an unreadable baseline, not manufacture a stranded-close for
# every recently-closed ticket (the 12-flag shadow-pass signature of #385).
check "ref_resolves is true for a real ref, false for a missing one (#385)" \
  '_fleet_landing_ref_resolves "$repo" main && ! _fleet_landing_ref_resolves "$repo" refs/heads/does-not-exist'
check "unlanded FAILS SAFE (flags nothing, even for an absent sha) when main cannot resolve (#385)" \
  '[ -z "$(fleet_landing_unlanded "$repo" refs/heads/does-not-exist "$SHA_B $SHA_C deadbeefdeadbeef" 777 2>/dev/null)" ]'
check "the baseline collapse emits a diagnostic on stderr (#385)" \
  'fleet_landing_unlanded "$repo" refs/heads/does-not-exist "$SHA_B" 1 2>&1 >/dev/null | grep -qi "cannot resolve"'

# ── gather: the close grace defers a just-closed ticket (#363 / idss#2202) ──────
# FLEET_LANDING_NOW is pinned to 1000000 at the top; a close younger than the grace
# must not be judged (a run may still be landing it).
recent_iso="$(date -u -d @999800 +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo 2001-01-01T00:00:00Z)"
old_close_iso="$(date -u -d @990000 +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo 1999-01-01T00:00:00Z)"
check "a close inside the grace window is deferred (rc 0)" \
  'FLEET_LANDING_CLOSE_GRACE=900 _fleet_landing_close_recent "$recent_iso"'
check "a close older than the grace window is judged (rc 1)" \
  '! FLEET_LANDING_CLOSE_GRACE=900 _fleet_landing_close_recent "$old_close_iso"'
check "an empty or unparseable close time fails safe to deferred (rc 0)" \
  '_fleet_landing_close_recent "" && _fleet_landing_close_recent "not-a-date"'

FIX_BRANCHES="$(jq -cn --arg b "$SHA_B" --arg c "$SHA_C" \
  '[{name:"main",commit:{id:$b}},
    {name:"sandcastle/rescue-unlanded",commit:{id:$c}},
    {name:"sandcastle/rescue-done",commit:{id:$b}}]')"
res="$(fleet_landing_rescues "$root" Acme/alpha "$repo" main)"
check "rescues lists only sandcastle/rescue-* branches (main excluded)" \
  '[ "$(jq length <<<"$res")" = 2 ]'
check "rescues marks an on-main rescue head merged:true" \
  'jq -e "any(.[]; .branch==\"sandcastle/rescue-done\" and .merged==true)" <<<"$res" >/dev/null'
check "rescues marks an off-main rescue head merged:false" \
  'jq -e "any(.[]; .branch==\"sandcastle/rescue-unlanded\" and .merged==false)" <<<"$res" >/dev/null'
# feeding rescues through detect surfaces only the unlanded one
check "the unlanded rescue is the only one detect flags" \
  '[ "$(fleet_landing_detect "$(jq -cn --argjson r "$res" "{rescues:\$r}")" | jq length)" = 1 ]'
# an unresolvable main-ref would read every rescue head merged:false — fail safe to
# empty rather than flag every rescue branch (#385, the same baseline collapse).
check "rescues FAILS SAFE (empty) when the main-ref cannot be resolved (#385)" \
  '[ "$(fleet_landing_rescues "$root" Acme/alpha "$repo" refs/heads/does-not-exist 2>/dev/null | jq length)" = 0 ]'

# ── gather: agent PRs + combined status ──────────────────────────────────────
FIX_PULLS='[{"number":20,"head":{"ref":"agent/issue-20","sha":"s20"}},
            {"number":99,"head":{"ref":"sandcastle/worker/x","sha":"s99"}}]'
# the status read is routed by "/status"; one fixture serves both, so assert the
# agent PR is picked up and carries the success state the shim returns.
FIX_STATUS='{"state":"success"}'
prs="$(fleet_landing_agent_prs "$root" Acme/gamma)"
check "agent_prs keeps only agent/issue-* heads (worker branch excluded)" \
  '[ "$(jq length <<<"$prs")" = 1 ] && [ "$(jq -r ".[0].number" <<<"$prs")" = 20 ]'
check "agent_prs carries the combined CI status read off the head sha" \
  '[ "$(jq -r ".[0].status" <<<"$prs")" = success ]'

# ── gather: working tickets honour the label-age grace ───────────────────────
FIX_WORKING='[{"number":5},{"number":6}]'
# #5 was labelled agent-working long ago (stale claim); #6 moments ago (fresh).
old_iso="$(date -u -d @$(( FLEET_LANDING_NOW - FLEET_LANDING_WORKING_GRACE - 60 )) +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo 2000-01-01T00:00:00Z)"
new_iso="$(date -u -d @$(( FLEET_LANDING_NOW - 5 )) +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo 2100-01-01T00:00:00Z)"
# route timeline per-issue: the shim returns FIX_TIMELINE, so drive one issue at
# a time by swapping it. fleet_landing_working reads the list then each timeline;
# give both #5 and #6 the SAME fixture only distinguishes if we vary per call —
# instead assert against a single stale ticket, then a single fresh ticket.
FIX_WORKING='[{"number":5}]'
FIX_TIMELINE="$(jq -cn --arg a "$old_iso" '[{type:"label",body:"1",label:{name:"agent-working"},created_at:$a}]')"
w="$(fleet_landing_working "$root" Acme/beta)"
check "working flags a ticket agent-working since before the grace window" \
  'jq -e "any(.[]; .number==5 and .repo==\"Acme/beta\")" <<<"$w" >/dev/null'
FIX_TIMELINE="$(jq -cn --arg a "$new_iso" '[{type:"label",body:"1",label:{name:"agent-working"},created_at:$a}]')"
check "working does NOT flag a ticket just labelled agent-working (inside the grace)" \
  '[ "$(fleet_landing_working "$root" Acme/beta | jq length)" = 0 ]'
FIX_TIMELINE='[]'
check "working does NOT flag a ticket whose label-add time cannot be read" \
  '[ "$(fleet_landing_working "$root" Acme/beta | jq length)" = 0 ]'

# a live SESSION / interactive claim takes agent-working but no heavy slot, so no slot
# report names it — working must drop it rather than flag working-no-run (#363).
FIX_WORKING='[{"number":5}]'
FIX_TIMELINE="$(jq -cn --arg a "$old_iso" '[{type:"label",body:"1",label:{name:"agent-working"},created_at:$a}]')"
sess_iso="$(date -u -d @$(( FLEET_LANDING_NOW - 100 )) +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo 2000-01-01T00:00:00Z)"
exp_iso="$(date -u -d @$(( FLEET_LANDING_NOW - 7200 )) +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo 2000-01-01T00:00:00Z)"
FIX_COMMENTS="$(jq -cn --arg c "$sess_iso" '[{id:1, body:"swarm-claim host=boxA run=123 session-ttl=3600", created_at:$c}]')"
check "working SUPPRESSES a ticket held by a LIVE session claim (#363)" \
  '[ "$(fleet_landing_working "$root" Acme/beta | jq length)" = 0 ]'
FIX_COMMENTS="$(jq -cn --arg c "$exp_iso" '[{id:1, body:"swarm-claim host=boxA run=123 session-ttl=3600", created_at:$c}]')"
check "working does NOT suppress a ticket whose session claim has EXPIRED" \
  'jq -e "any(.[]; .number==5)" <<<"$(fleet_landing_working "$root" Acme/beta)" >/dev/null'
FIX_COMMENTS="$(jq -cn '[{id:1, body:"swarm-claim host=boxA run=123", created_at:"2001-01-01T00:00:00Z"}]')"
check "working does NOT suppress a ticket held by a heavy-slot (non-session) claim" \
  'jq -e "any(.[]; .number==5)" <<<"$(fleet_landing_working "$root" Acme/beta)" >/dev/null'
FIX_COMMENTS='[]'

# ── merge-authority gate (case 4 is live only for agent-after-green) ─────────
authdir="$(tmpdir)"
mkdir -p "$authdir/aag/.sandcastle" "$authdir/hum/.sandcastle" "$authdir/none/.sandcastle"
printf 'LANDING=pr\nMERGE_AUTHORITY=agent-after-green\n' >"$authdir/aag/.sandcastle/swarm-policy.sh"
printf 'LANDING=pr\nMERGE_AUTHORITY=human\n' >"$authdir/hum/.sandcastle/swarm-policy.sh"
printf 'LANDING=push\n' >"$authdir/none/.sandcastle/swarm-policy.sh"
check "merge_authority reads agent-after-green from the policy layer" \
  '[ "$(fleet_landing_merge_authority "$authdir/aag")" = agent-after-green ]'
check "merge_authority reads an explicit human" \
  '[ "$(fleet_landing_merge_authority "$authdir/hum")" = human ]'
check "merge_authority defaults to human when the key is absent (case 4 off)" \
  '[ "$(fleet_landing_merge_authority "$authdir/none")" = human ]'
check "merge_authority defaults to human when there is no policy file" \
  '[ "$(fleet_landing_merge_authority "$authdir/missing")" = human ]'

# ── file: shadow logs + files nothing; live files once, re-arms a duplicate ───
anom="$(jq -cn '{kind:"stranded-close",repo:"Acme/alpha",number:10,ref:"bbb",key:"stranded-close Acme/alpha#10",evidence:"ticket closed but commit bbb absent from main"}')"
CURL_LOG="$(tmpdir)/curl.log"; export CURL_LOG; : >"$CURL_LOG"
# make the create POST record itself so we can assert no POST in shadow
shim curl <<'SH'
args="$*"
case "$args" in *'%{http_code}'*) b="$(cat 2>/dev/null || true)"; printf 'POST %s BODY %s\n' "$args" "$b" >>"${CURL_LOG:?}"; printf '%s' "${FILE_CODE:-201}"; exit 0 ;; esac
case "$args" in
  *"/labels"*)        printf '%s' "${FIX_LABELS:-[]}" ;;
  *"data-urlencode"*) printf '%s' "${FIX_SEARCH:-[]}" ;;
  *)                  printf '[]' ;;
esac
SH
out="$(fleet_landing_file shadow "$root" Acme/alpha "$anom" 2>&1)"
check "shadow file LOGS what it would file at the front" \
  'grep -qi "SHADOW — would file" <<<"$out" && grep -q "stranded-close Acme/alpha#10" <<<"$out"'
check "shadow file POSTs NOTHING" '! grep -q "POST" "$CURL_LOG"'

: >"$CURL_LOG"; FIX_SEARCH='[]'; FIX_LABELS='[{"name":"priority","id":42}]'
out="$(fleet_landing_file live "$root" Acme/alpha "$anom" 2>&1)"
check "live file POSTs a create to /issues" 'grep -q "POST" "$CURL_LOG" && grep -q "/repos/Acme/alpha/issues" "$CURL_LOG"'
check "live file attaches the priority label (front of the fleet order)" 'grep -q "42" "$CURL_LOG"'
check "live file reports it filed at the front" 'grep -qi "filed .* at the front" <<<"$out"'

: >"$CURL_LOG"
FIX_SEARCH="$(jq -cn '[{title:"[fleet-landing] stranded-close Acme/alpha#10"}]')"
out="$(fleet_landing_file live "$root" Acme/alpha "$anom" 2>&1)"
check "live file RE-ARMS (does not re-file) when the title is already open" \
  'grep -qi "already open" <<<"$out" && ! grep -q "POST" "$CURL_LOG"'

# ── the forge token never rides curl's argv (#363 — readable in `ps` otherwise) ─
# A shim that logs every invocation's ARGV; drive a GET read and the live create
# POST with a sentinel token and assert the sentinel is nowhere in the argv log.
ARGV_LOG="$(tmpdir)/argv.log"; export ARGV_LOG; : >"$ARGV_LOG"
export FORGEJO_TOKEN='SEKRET-TOKEN-0xDEADBEEF'
shim curl <<'SH'
printf '%s\n' "$*" >>"${ARGV_LOG:?}"
args="$*"
case "$args" in *'%{http_code}'*) cat >/dev/null 2>&1 || true; printf '%s' "${FILE_CODE:-201}"; exit 0 ;; esac
case "$args" in
  *"/comments"*)      printf '[]' ;;
  *"/labels"*)        printf '%s' "${FIX_LABELS:-[]}" ;;
  *"data-urlencode"*) printf '%s' "${FIX_SEARCH:-[]}" ;;
  *)                  printf '[]' ;;
esac
SH
fleet_landing_close_commits "$root" Acme/alpha 10 >/dev/null 2>&1
FIX_SEARCH='[]'; FIX_LABELS='[{"name":"priority","id":42}]'
fleet_landing_file live "$root" Acme/alpha "$anom" >/dev/null 2>&1
check "a GET read does not put the token on curl argv" \
  '! grep -q "SEKRET-TOKEN" "$ARGV_LOG"'
check "the live create POST does not put the token on curl argv" \
  'grep -q "/repos/Acme/alpha/issues" "$ARGV_LOG" && ! grep -q "SEKRET-TOKEN" "$ARGV_LOG"'
unset FORGEJO_TOKEN; export FORGEJO_TOKEN=t

summary fleet-landing-detect-lib-test
