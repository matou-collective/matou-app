#!/usr/bin/env bash
# Offline tests for ../forgejo-lib.sh — the tracker adapter (ADR 0180 / #571).
# A dedicated fake curl (not tests/fakebin/curl — that one has no -w/-o
# support, and forgejo_post_code/forgejo_delete_code depend on both) records
# every call's argv + body and answers per-endpoint fixtures.
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"

cat > "$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
set -u
url="" data="" method=GET want_code=false prev="" form=""
for a in "$@"; do
  case "$a" in
    -X) : ;;
    -w) want_code=true ;;
  esac
  [ "$prev" = -X ] && method="$a"
  [ "$prev" = -d ] && data="$a"
  [ "$prev" = -F ] && form="$a"
  prev="$a"
  case "$a" in http*) url="$a" ;; esac
done
printf '%s %s\n' "$method" "$url" >> "$CALLS_LOG"
[ -n "$data" ] && printf '%s\n' "$data" >> "$BODIES_LOG"
[ -n "$form" ] && printf '%s\n' "$form" >> "$FORMS_LOG"
case "$url" in
  */fail/*) exit 22 ;;
  */issues/comments/9001/assets)
    $want_code && { echo "${ASSET_CODE:-201}"; exit 0; }
    echo '{"id":1}'
    ;;
  */issues/555/assets)
    $want_code && { echo "${ASSET_CODE:-201}"; exit 0; }
    echo '{"id":1}'
    ;;
  */issues/42/comments)
    $want_code && { echo "${FAKE_CODE:-204}"; exit 0; }
    echo '{"id":9001}'
    ;;
  */issues/42/labels)
    $want_code && { echo "${FAKE_CODE:-204}"; exit 0; }
    echo '[]'
    ;;
  */issues/42/timeline*)
    cat "${TIMELINE_JSON:-/dev/null}" 2>/dev/null || echo '[]'
    ;;
  */issues/42/labels/7)
    $want_code && { echo "${FAKE_CODE:-204}"; exit 0; }
    echo ''
    ;;
  */issues/42/dependencies)
    $want_code && { echo "${FAKE_CODE:-201}"; exit 0; }
    echo '{}'
    ;;
  */actions/workflows/swarm.yml/dispatches)
    $want_code && { echo "${FAKE_CODE:-204}"; exit 0; }
    echo '{}'
    ;;
  */issues)
    echo '{"number": 555}'
    ;;
  */labels?limit=100|*/labels)
    echo '[{"id":36,"name":"ready-for-agent"},{"id":40,"name":"bug"}]'
    ;;
  */pulls?state=open*)
    cat "${OPEN_PULLS:-/dev/null}" 2>/dev/null || echo '[]'
    ;;
  */pulls/7/merge)
    $want_code && { echo "${MERGE_CODE:-200}"; exit 0; }
    echo '{}'
    ;;
  */commits/prheadsha7/status)
    cat "${STATUS_JSON:-/dev/null}" 2>/dev/null || echo '{"state":"success","statuses":[]}'
    ;;
  */pulls/7)
    # PATCH close (forgejo_close_pr, -w) → HTTP code; GET → the PR object,
    # carrying .mergeable so forgejo_pr_mergeable has a field to read (#114).
    $want_code && { echo "${CLOSE_CODE:-200}"; exit 0; }
    echo "{\"number\":7,\"head\":{\"ref\":\"agent/issue-7\",\"sha\":\"prheadsha7\"},\"mergeable\":${PR7_MERGEABLE:-true}}"
    ;;
  */pulls)
    echo '{"number":101,"head":{"ref":"agent/issue-7"}}'
    ;;
  */repos/Matou/idss)   # repo-root GET — #20 write probe + #15 default_merge_style
    echo "{\"permissions\":{\"push\":${PROBE_PUSH:-true}},\"default_merge_style\":\"${MERGE_STYLE:-merge}\"}"
    ;;
  *)
    echo "fake curl: unhandled url $url" >&2
    exit 22
    ;;
esac
SH
chmod +x "$tmp/bin/curl"

export PATH="$tmp/bin:$PATH"
export FORGEJO_TOKEN=ftok
export FORGEJO_API="http://fj.test/api/v1/repos/Matou/idss"
export CALLS_LOG="$tmp/calls.log" BODIES_LOG="$tmp/bodies.log" FORMS_LOG="$tmp/forms.log"
touch "$CALLS_LOG" "$BODIES_LOG" "$FORMS_LOG"
# shellcheck source=../forgejo-lib.sh
. "$here/../forgejo-lib.sh"

pass=0 fail=0
check() { if eval "$2"; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: $1"; fi; }

# forgejo_get / forgejo_post hit the right relative path
labels="$(forgejo_get "/labels?limit=100")"
check "forgejo_get resolves relative to FORGEJO_API" \
  'grep -q "GET http://fj.test/api/v1/repos/Matou/idss/labels?limit=100" "$CALLS_LOG"'
check "forgejo_get returns the fixture body" '[ "$(jq -r ".[0].name" <<<"$labels")" = ready-for-agent ]'

# forgejo_label_id — pure jq, no network, on the labels_json already fetched
check "forgejo_label_id resolves by name" '[ "$(forgejo_label_id "$labels" bug)" = "40" ]'
check "forgejo_label_id misses cleanly" '[ -z "$(forgejo_label_id "$labels" no-such)" ]'

# forgejo_comment — POST with a {body:...} envelope
: > "$BODIES_LOG"
forgejo_comment 42 "hello world"
check "forgejo_comment posts to the issue's comments endpoint" \
  'grep -q "POST http://fj.test/api/v1/repos/Matou/idss/issues/42/comments" "$CALLS_LOG"'
check "forgejo_comment's body envelope is {body:...}" \
  '[ "$(jq -r .body < "$BODIES_LOG")" = "hello world" ]'

# forgejo_comment_id — same POST, but returns the new comment's id (#596: the
# id is what the asset-attach calls key off)
cid="$(forgejo_comment_id 42 "hello again")"
check "forgejo_comment_id returns the fixture's id" '[ "$cid" = 9001 ]'

# forgejo_attach_comment_asset / forgejo_attach_issue_asset — multipart POST
# to the comment/issue asset endpoint (#596); a missing file never shells out
shot="$tmp/shot.png"; : > "$shot"
code="$(forgejo_attach_comment_asset 9001 "$shot" "shot.png")"
check "forgejo_attach_comment_asset returns the HTTP code" '[ "$code" = 201 ]'
check "forgejo_attach_comment_asset hits the comment's asset endpoint" \
  'grep -q "POST http://fj.test/api/v1/repos/Matou/idss/issues/comments/9001/assets" "$CALLS_LOG"'
check "forgejo_attach_comment_asset's -F names the file and display name" \
  'grep -q "attachment=@$tmp/shot.png;filename=shot.png;type=image/png" "$FORMS_LOG"'

code="$(forgejo_attach_issue_asset 555 "$shot" "shot.png")"
check "forgejo_attach_issue_asset returns the HTTP code" '[ "$code" = 201 ]'
check "forgejo_attach_issue_asset hits the issue's own asset endpoint" \
  'grep -q "POST http://fj.test/api/v1/repos/Matou/idss/issues/555/assets" "$CALLS_LOG"'

: > "$CALLS_LOG"
code="$(forgejo_attach_comment_asset 9001 "$tmp/no-such-file.png")"
check "forgejo_attach_comment_asset never shells out for a missing file" \
  '[ "$code" = 000 ] && [ ! -s "$CALLS_LOG" ]'

# forgejo_add_labels — returns the HTTP code, POST /labels body is {labels:[ids]}
: > "$BODIES_LOG"
code="$(FAKE_CODE=204 forgejo_add_labels 42 "36,40")"
check "forgejo_add_labels returns the HTTP code" '[ "$code" = 204 ]'
check "forgejo_add_labels body is {labels:[ids]}" '[ "$(jq -c .labels < "$BODIES_LOG")" = "[36,40]" ]'

# forgejo_remove_label — DELETE, code passthrough
code="$(FAKE_CODE=204 forgejo_remove_label 42 7)"
check "forgejo_remove_label returns the HTTP code" '[ "$code" = 204 ]'
check "forgejo_remove_label issues a DELETE" 'grep -q "DELETE .*/issues/42/labels/7" "$CALLS_LOG"'

# forgejo_add_dependency — the #381 IssueMeta shape (index + owner + repo)
: > "$BODIES_LOG"
code="$(FAKE_CODE=201 forgejo_add_dependency 42 991 Matou idss)"
check "forgejo_add_dependency returns the HTTP code" '[ "$code" = 201 ]'
check "forgejo_add_dependency body names index+owner+repo (#381)" \
  '[ "$(jq -c "{index,owner,repo}" < "$BODIES_LOG")" = "{\"index\":991,\"owner\":\"Matou\",\"repo\":\"idss\"}" ]'
code="$(FAKE_CODE=409 forgejo_add_dependency 42 991 Matou idss)"
check "forgejo_add_dependency surfaces 409 (already-a-blocker) for the caller to tolerate" '[ "$code" = 409 ]'

# forgejo_dispatch_workflow
: > "$BODIES_LOG"
code="$(FAKE_CODE=204 forgejo_dispatch_workflow swarm.yml main)"
check "forgejo_dispatch_workflow returns the HTTP code" '[ "$code" = 204 ]'
check "forgejo_dispatch_workflow body names the ref" '[ "$(jq -r .ref < "$BODIES_LOG")" = main ]'

# forgejo_create_issue — with and without labels
resp="$(forgejo_create_issue "a title" "a body")"
check "forgejo_create_issue (no labels) returns the created issue" '[ "$(jq -r .number <<<"$resp")" = 555 ]'
: > "$BODIES_LOG"
forgejo_create_issue "a title" "a body" "[36,40]" >/dev/null
check "forgejo_create_issue with labels sends them inline" '[ "$(jq -c .labels < "$BODIES_LOG")" = "[36,40]" ]'
: > "$BODIES_LOG"
forgejo_create_issue "t" "b" >/dev/null
no_label_body="$(cat "$BODIES_LOG")"
check "forgejo_create_issue without labels omits the field" \
  '[ "$(jq "has(\"labels\")" <<<"$no_label_body")" = false ]'

# forgejo_open_pr_for (#13) — finds an OPEN PR by head.ref, empty on miss
open_pulls="$tmp/open-pulls.json"
printf '%s\n' '[{"number":101,"head":{"ref":"agent/issue-7"}},{"number":102,"head":{"ref":"other"}}]' >"$open_pulls"
check "forgejo_open_pr_for returns the PR number matching head.ref" \
  '[ "$(OPEN_PULLS=$open_pulls forgejo_open_pr_for agent/issue-7)" = "101" ]'
printf '%s\n' '[]' >"$tmp/no-pulls.json"
check "forgejo_open_pr_for is empty when no open PR matches" \
  '[ -z "$(OPEN_PULLS=$tmp/no-pulls.json forgejo_open_pr_for agent/issue-7)" ]'

# forgejo_create_pr (#13) — POST /pulls with {title,head,base,body}
: > "$BODIES_LOG"
resp="$(forgejo_create_pr "a title (#7)" "agent/issue-7" "main" "closes #7")"
check "forgejo_create_pr returns the created PR number" '[ "$(jq -r .number <<<"$resp")" = "101" ]'
check "forgejo_create_pr posts to /pulls" 'grep -q "POST .*/pulls$" "$CALLS_LOG"'
check "forgejo_create_pr body names head+base+title+body" \
  '[ "$(jq -c "{title,head,base,body}" < "$BODIES_LOG")" = "{\"title\":\"a title (#7)\",\"head\":\"agent/issue-7\",\"base\":\"main\",\"body\":\"closes #7\"}" ]'

# forgejo_pr_head_sha (#13) — the head commit the close gate checks reachability from
check "forgejo_pr_head_sha returns the PR head sha" '[ "$(forgejo_pr_head_sha 7)" = "prheadsha7" ]'

# forgejo_merge_pr (#13) — POST /pulls/N/merge, {Do:style}, HTTP code passthrough
: > "$BODIES_LOG"
code="$(MERGE_CODE=200 forgejo_merge_pr 7)"
check "forgejo_merge_pr returns the HTTP code" '[ "$code" = "200" ]'
check "forgejo_merge_pr body carries {Do:merge}" '[ "$(jq -r .Do < "$BODIES_LOG")" = "merge" ]'
check "forgejo_merge_pr hits the merge endpoint" 'grep -q "POST .*/pulls/7/merge" "$CALLS_LOG"'

# forgejo_pr_mergeable (#114) — reads .mergeable off the PR object; the idle
# landing sweep keys a drift-close on a literal `false` (which jq's `//` would
# have swallowed — so the impl must NOT use `//`).
check "forgejo_pr_mergeable passes a true through" \
  '[ "$(PR7_MERGEABLE=true forgejo_pr_mergeable 7)" = true ]'
check "forgejo_pr_mergeable passes a false through (not swallowed by //)" \
  '[ "$(PR7_MERGEABLE=false forgejo_pr_mergeable 7)" = false ]'

# forgejo_close_pr (#114) — PATCH the PR state to closed, HTTP code passthrough
: > "$CALLS_LOG"
code="$(CLOSE_CODE=200 forgejo_close_pr 7)"
check "forgejo_close_pr returns the HTTP code" '[ "$code" = 200 ]'
check "forgejo_close_pr PATCHes the PR endpoint" 'grep -q "PATCH .*/pulls/7$" "$CALLS_LOG"'

# forgejo_pr_combined_status (#15) — resolves the PR head sha, then GETs the
# commit's combined status; the caller reads .state / .statuses[].context
: > "$CALLS_LOG"
printf '%s\n' '{"state":"success","statuses":[{"status":"success","context":"ci/build"}]}' > "$tmp/green.json"
combined="$(STATUS_JSON=$tmp/green.json forgejo_pr_combined_status 7)"
check "forgejo_pr_combined_status returns the combined .state" '[ "$(jq -r .state <<<"$combined")" = success ]'
check "forgejo_pr_combined_status GETs the head sha's status endpoint" \
  'grep -q "GET .*/commits/prheadsha7/status" "$CALLS_LOG"'

# forgejo_repo_default_merge_style (#15) — reads the repo setting; squash and
# unknowns fall back to a plain merge (never a squash-rewrite of a real commit)
check "default merge style passes through a rebase setting" \
  '[ "$(MERGE_STYLE=rebase forgejo_repo_default_merge_style)" = rebase ]'
check "default merge style maps squash -> merge" \
  '[ "$(MERGE_STYLE=squash forgejo_repo_default_merge_style)" = merge ]'
check "default merge style falls back to merge on an unknown value" \
  '[ "$(MERGE_STYLE=weird forgejo_repo_default_merge_style)" = merge ]'

# forgejo_repo_slug — derived from FORGEJO_API's .../repos/<owner>/<repo> tail
check "forgejo_repo_slug derives owner/repo from FORGEJO_API" '[ "$(forgejo_repo_slug)" = Matou/idss ]'

# forgejo_issue_write_probe (#20): a repo whose permissions block grants write
# passes; one that does not reds LOUD, naming the missing write.
check "issue-write probe passes when permissions.push is true" \
  '( export PROBE_PUSH=true; forgejo_issue_write_probe >/dev/null )'
check "issue-write probe reds when permissions.push is false" \
  '! ( export PROBE_PUSH=false; forgejo_issue_write_probe >/dev/null 2>&1 )'
probe_out="$( ( export PROBE_PUSH=false; forgejo_issue_write_probe ) 2>&1 || true )"
check "issue-write probe names the missing write access" \
  'grep -q "no write access" <<<"$probe_out"'

# forgejo_label_applied_at (#99): the LATEST label-ADD timestamp from the issue
# timeline, ignoring removes and earlier adds; empty for a label never added.
timeline="$tmp/timeline.json"
cat > "$timeline" <<'JSON'
[
  {"type":"comment","body":"kickoff","created_at":"2026-08-25T09:00:00Z"},
  {"type":"label","body":"1","label":{"name":"ready-for-agent"},"created_at":"2026-08-25T09:30:00Z"},
  {"type":"label","body":"","label":{"name":"ready-for-agent"},"created_at":"2026-08-25T09:45:00Z"},
  {"type":"label","body":"1","label":{"name":"ready-for-agent"},"created_at":"2026-08-25T10:00:00Z"},
  {"type":"label","body":"1","label":{"name":"agent-working"},"created_at":"2026-08-25T10:10:00Z"}
]
JSON
ready_epoch="$(jq -n '"2026-08-25T10:00:00Z" | fromdateiso8601')"
working_epoch="$(jq -n '"2026-08-25T10:10:00Z" | fromdateiso8601')"
: > "$CALLS_LOG"
check "label_applied_at returns the LATEST ready-for-agent ADD (not the earlier add or the remove)" \
  '[ "$(TIMELINE_JSON=$timeline forgejo_label_applied_at 42 ready-for-agent)" = "$ready_epoch" ]'
check "label_applied_at returns the agent-working ADD time" \
  '[ "$(TIMELINE_JSON=$timeline forgejo_label_applied_at 42 agent-working)" = "$working_epoch" ]'
check "label_applied_at is empty for a label never added" \
  '[ -z "$(TIMELINE_JSON=$timeline forgejo_label_applied_at 42 no-such-label)" ]'
check "label_applied_at reads the issue timeline endpoint" \
  'TIMELINE_JSON=$timeline forgejo_label_applied_at 42 ready-for-agent >/dev/null; grep -q "GET .*/issues/42/timeline" "$CALLS_LOG"'
check "label_applied_at is empty on an empty timeline" \
  '[ -z "$(TIMELINE_JSON=/dev/null forgejo_label_applied_at 42 ready-for-agent)" ]'

# curl -f semantics: forgejo_get dies loud (rc != 0) on a real failure, never a silent empty success
if forgejo_get "/fail/x" >/dev/null 2>&1; then fail=$((fail+1)); echo "FAIL: forgejo_get propagates curl's failure rc"; else pass=$((pass+1)); fi

echo "forgejo-lib: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
