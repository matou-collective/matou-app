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

# forgejo_repo_slug — derived from FORGEJO_API's .../repos/<owner>/<repo> tail
check "forgejo_repo_slug derives owner/repo from FORGEJO_API" '[ "$(forgejo_repo_slug)" = Matou/idss ]'

# curl -f semantics: forgejo_get dies loud (rc != 0) on a real failure, never a silent empty success
if forgejo_get "/fail/x" >/dev/null 2>&1; then fail=$((fail+1)); echo "FAIL: forgejo_get propagates curl's failure rc"; else pass=$((pass+1)); fi

echo "forgejo-lib: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
