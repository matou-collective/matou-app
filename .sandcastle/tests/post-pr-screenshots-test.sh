#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
s="$here/../post-pr-screenshots.sh"
fail() { echo "FAIL: $1" >&2; exit 1; }

# usage errors
bash "$s" >/dev/null 2>&1 && fail "no-arg call must fail"
FORGEJO_TOKEN=t FORGEJO_API=http://f bash "$s" 12 >/dev/null 2>&1 && fail "missing status must fail"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/bin"
cat >"$tmp/bin/curl" <<'CURL'
#!/usr/bin/env bash
printf '%s ' "$@" | tr '\n' ' ' >> "${CURL_LOG:?}"; echo >> "$CURL_LOG"
case "$*" in
  *"/assets?name="*)
    [[ "$*" == *broken.png* ]] && exit 22
    all="$*"; n="${all##*name=}"; echo "{\"browser_download_url\":\"http://f/attachments/$n\"}" ;;
  *"/comments?limit="*)
    cat "${COMMENTS_JSON:?}" ;;
  *"-X PATCH"*|*"-X POST"*)
    # capture body (-d '<json>')
    for ((i=1;i<=$#;i++)); do [ "${!i}" = "-d" ] && { j=$((i+1)); echo "${!j}" >> "${CURL_LOG}.bodies"; }; done
    echo '{"id":99}' ;;
esac
CURL

chmod +x "$tmp/bin/curl"
mkdir -p "$tmp/snaps"; : > "$tmp/snaps/01-filter_open.png"; : > "$tmp/snaps/02-broken.png"

# no prior comment → POST a new one with the marker, the status and the images
echo '[{"id":1,"body":"unrelated"}]' > "$tmp/comments.json"
out="$(PATH="$tmp/bin:$PATH" CURL_LOG="$tmp/calls.log" COMMENTS_JSON="$tmp/comments.json" \
  FORGEJO_TOKEN=t FORGEJO_API=http://f bash "$s" 12 "✅ passed" "$tmp/snaps"/*.png "$tmp/absent.png" 2>"$tmp/err")"
[ "$out" = "1" ] || fail "must print number of uploaded shots, got: $out"
grep -q 'upload failed for .*02-broken.png' "$tmp/err" || fail "failed upload must be reported on stderr"
[ "$(grep -c '/issues/12/assets?name=' "$tmp/calls.log")" -eq 2 ] || fail "2 upload attempts (absent file skipped)"
grep -q -- '-X POST.*/issues/12/comments' "$tmp/calls.log" || fail "must POST a new comment"
grep -q -- '-X PATCH' "$tmp/calls.log" && fail "must not PATCH when no marked comment exists"
body="$(jq -r .body "$tmp/calls.log.bodies")"
[[ "$body" == "<!-- pr-e2e -->"* ]] || fail "comment body must carry the marker"
grep -q '✅ passed' <<<"$body" || fail "status in body"
grep -q '!\[filter open\](http://f/attachments/01-filter_open.png)' <<<"$body" || fail "image embedded by download url"
grep -q 'broken' <<<"$body" && fail "failed upload must not be embedded"

# prior marked comment → PATCH it in place (latest marked one wins)
rm -f "$tmp/calls.log" "$tmp/calls.log.bodies"
echo '[{"id":1,"body":"unrelated"},{"id":7,"body":"<!-- pr-e2e -->\nold"},{"id":8,"body":"<!-- pr-e2e -->\nolder-newer"}]' > "$tmp/comments.json"
PATH="$tmp/bin:$PATH" CURL_LOG="$tmp/calls.log" COMMENTS_JSON="$tmp/comments.json" \
  FORGEJO_TOKEN=t FORGEJO_API=http://f bash "$s" 12 "❌ failed" >/dev/null 2>&1
grep -q -- '-X PATCH.*/issues/comments/8' "$tmp/calls.log" || fail "must PATCH the latest marked comment"
grep -q -- '/issues/12/comments$' "$tmp/calls.log" && fail "must not POST when a marked comment exists"
grep -q 'screenshot(s)' "$tmp/calls.log.bodies" && fail "no shots → no details block"

# comment API failure → still exit 0 (best-effort), noted on stderr
cat >"$tmp/bin/curl" <<'CURL'
#!/usr/bin/env bash
[[ "$*" == *"/comments?limit="* ]] && { echo '[]'; exit 0; }
exit 22
CURL
PATH="$tmp/bin:$PATH" FORGEJO_TOKEN=t FORGEJO_API=http://f bash "$s" 12 "x" >/dev/null 2>"$tmp/err2" || fail "comment failure must not fail the caller"
grep -q 'could not comment' "$tmp/err2" || fail "comment failure must be reported"

echo "post-pr-screenshots: 16 checks passed"
