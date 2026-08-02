#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
n="$here/../notify-mattermost-files.sh"
fail() { echo "FAIL: $1" >&2; exit 1; }

# creds unset → message+files to stderr, NOTHING on stdout, exit 0
out="$(env -u MATTERMOST_URL -u MATTERMOST_BOT_TOKEN -u MATTERMOST_CHANNEL_ID \
  bash "$n" "hello" /nonexistent.png 2>/dev/null)"
[ -z "$out" ] || fail "stdout must stay empty when chat is unset"

# no message → usage error
if bash "$n" >/dev/null 2>&1; then fail "no-arg call must fail"; fi

# 12 files → 12 uploads, 2 posts (root with 10, one threaded overflow reply)
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/bin"
cat >"$tmp/bin/curl" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "${CURL_LOG:?}"
if [[ "$*" == */api/v4/files* ]]; then
  echo "{\"file_infos\":[{\"id\":\"fid-$RANDOM$RANDOM\"}]}"
else
  # capture the posted JSON body from stdin (curl -d @-)
  cat >> "${CURL_LOG}.bodies"
  echo '{"id":"post-1"}'
fi
EOF
chmod +x "$tmp/bin/curl"
for i in $(seq 1 12); do : > "$tmp/s$i.png"; done
out="$(PATH="$tmp/bin:$PATH" CURL_LOG="$tmp/calls.log" \
  MATTERMOST_URL=http://mm MATTERMOST_BOT_TOKEN=t MATTERMOST_CHANNEL_ID=chan \
  bash "$n" "msg here" "$tmp"/s*.png)"
[ "$out" = "post-1" ] || fail "must print root post id, got: $out"
[ "$(grep -c '/api/v4/files' "$tmp/calls.log")" -eq 12 ] || fail "expected 12 uploads"
[ "$(grep -c '/api/v4/posts' "$tmp/calls.log")" -eq 2 ] || fail "expected root + overflow posts"
grep -q '"root_id":"post-1"' "$tmp/calls.log.bodies" || fail "overflow must thread under root"

# one file upload fails → script continues, root post created, 11 successful uploads
tmp2="$(mktemp -d)"; trap 'rm -rf "$tmp" "$tmp2"' EXIT
mkdir "$tmp2/bin"
cat >"$tmp2/bin/curl" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "${CURL_LOG:?}"
if [[ "$*" == */api/v4/files* ]]; then
  if [[ "$*" == *s3.png* ]]; then
    exit 22  # simulate upload failure for s3.png
  fi
  echo "{\"file_infos\":[{\"id\":\"fid-$RANDOM$RANDOM\"}]}"
else
  cat >> "${CURL_LOG}.bodies"
  echo '{"id":"post-1"}'
fi
EOF
chmod +x "$tmp2/bin/curl"
for i in $(seq 1 12); do : > "$tmp2/s$i.png"; done
out2="$(PATH="$tmp2/bin:$PATH" CURL_LOG="$tmp2/calls.log" \
  MATTERMOST_URL=http://mm MATTERMOST_BOT_TOKEN=t MATTERMOST_CHANNEL_ID=chan \
  bash "$n" "msg here" "$tmp2"/s*.png)"
[ "$out2" = "post-1" ] || fail "upload-failure: must print root post id, got: $out2"
[ "$(grep -c '/api/v4/files' "$tmp2/calls.log")" -eq 12 ] || fail "upload-failure: expected 12 upload attempts"
[ "$(grep -c '/api/v4/posts' "$tmp2/calls.log")" -eq 2 ] || fail "upload-failure: expected 2 posts (one failure skipped)"
grep -q '"root_id":"post-1"' "$tmp2/calls.log.bodies" || fail "upload-failure: overflow must thread under root"

echo "notify-files: 8 checks passed (5 baseline + 3 failure-handling)"
