#!/usr/bin/env bash
# Offline tests for ../land-pr.sh — the ONE command a worker runs to land a
# `landing-pr` ticket (idss ADR 0267). Drives the REAL script with shimmed
# git + curl. Run: bash tests/land-pr-test.sh
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
pass=0 fail=0
check() { if eval "$2"; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: $1"; fi; }

mkdir -p "$tmp/bin"
cat > "$tmp/bin/git" <<'SH'
#!/usr/bin/env bash
case "${1:-}" in
  push)     printf '%s\n' "$*" >> "$GIT_PUSHES"; exit "${PUSH_RC:-0}" ;;
  rev-list) printf '%s\n' "${AHEAD:-1}" ;;
esac
exit 0
SH
cat > "$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
set -u
url="" method=GET data="" prev="" upload=""
for a in "$@"; do
  [ "$prev" = -X ] && method="$a"
  [ "$prev" = -d ] && data="$a"
  [ "$prev" = -F ] && upload="$a"
  prev="$a"
  case "$a" in http*) url="$a" ;; esac
done
printf '%s %s\n' "$method" "$url" >> "$CALLS_LOG"
[ -n "$data" ] && printf '%s\n' "$data" >> "$BODIES_LOG"
case "$url" in
  */pulls?state=open*)  cat "$STATE/open-pulls.json" 2>/dev/null || echo '[]' ;;
  */pulls/[0-9]*)
    if [ "$method" = PATCH ]; then jq -r '.body' <<<"$data" > "$STATE/pr-body"; echo 200
    else jq -n --rawfile b "$STATE/pr-body" '{number:101, body:$b}'; fi ;;
  */pulls)
    jq -r '.body' <<<"$data" > "$STATE/pr-body"
    echo '[{"number":101,"head":{"ref":"agent/issue-7"}}]' > "$STATE/open-pulls.json"
    echo '{"number":101}' ;;
  */issues/*/assets)
    if [ "$method" = POST ]; then
      name="${upload#*filename=}"; name="${name%%;*}"
      jq --arg n "$name" '. + [{name:$n}]' "$STATE/assets.json" > "$STATE/assets.tmp" && mv "$STATE/assets.tmp" "$STATE/assets.json"
      printf '{"name":"%s","browser_download_url":"http://fj.test/attachments/%s"}\n' "$name" "$name"
    else cat "$STATE/assets.json"; fi ;;
  */issues/*/comments)  echo '{"id":1}' ;;
  */issues/[0-9]*)      printf '{"number":7,"state":"open","labels":%s}\n' "${ISSUE_LABELS:-[]}" ;;
  *) echo "fake curl: unhandled $method $url" >&2; exit 22 ;;
esac
SH
chmod +x "$tmp/bin/git" "$tmp/bin/curl"

export PATH="$tmp/bin:$PATH" FORGEJO_TOKEN=tok FORGEJO_API="http://fj.test/api/v1/repos/Acme/widget"
export GIT_PUSHES="$tmp/pushes.log" CALLS_LOG="$tmp/calls.log" BODIES_LOG="$tmp/bodies.log" STATE="$tmp/state"
printf 'LANDING=push\n' > "$tmp/swarm-policy.sh"; export SWARM_POLICY_FILE="$tmp/swarm-policy.sh"
fresh() { rm -rf "$STATE"; mkdir -p "$STATE"; echo '[]' > "$STATE/assets.json"; : > "$STATE/pr-body"; : > "$GIT_PUSHES"; : > "$CALLS_LOG"; : > "$BODIES_LOG"; }
PRLABELS='[{"name":"ready-for-agent"},{"name":"landing-pr"}]'
printf 'Fixed the rail foot so Report an issue sits under Sign out.\n' > "$tmp/body.md"
printf 'Go-side fix.\n\n**Screenshots:** none — the change is in the broker client, nothing renders\n' > "$tmp/body-waiver.md"
printf 'PNG' > "$tmp/after.png"
land() { bash "$here/../land-pr.sh" "$@" >"$tmp/out" 2>"$tmp/err"; }

# 1 — a ticket that lands by push is refused before anything is touched.
fresh; ISSUE_LABELS='[{"name":"ready-for-agent"}]' land 7 "fix (#7)" "$tmp/body.md" "$tmp/after.png"; rc=$?
check "a push ticket is refused (rc 2)" '[ "$rc" -eq 2 ]'
check "…with no push at all" '[ ! -s "$GIT_PUSHES" ]'

# 2 — neither screenshot nor waiver: refused BEFORE the branch is pushed.
fresh; ISSUE_LABELS="$PRLABELS" land 7 "fix (#7)" "$tmp/body.md"; rc=$?
check "no screenshot and no waiver is refused (rc 2)" '[ "$rc" -eq 2 ] && grep -q "Screenshots" "$tmp/err"'
check "…before any push" '[ ! -s "$GIT_PUSHES" ]'

# 3 — a named screenshot that does not exist is refused, not silently skipped.
fresh; ISSUE_LABELS="$PRLABELS" land 7 "fix (#7)" "$tmp/body.md" "$tmp/nope.png"; rc=$?
check "a missing screenshot file is refused (rc 2)" '[ "$rc" -eq 2 ] && grep -q "nope.png" "$tmp/err"'

# 4 — the happy path with a screenshot.
fresh; ISSUE_LABELS="$PRLABELS" land 7 "fix (#7)" "$tmp/body.md" "$tmp/after.png"; rc=$?
check "screenshot path exits 0" '[ "$rc" -eq 0 ]'
check "it prints the PR number" '[ "$(tail -1 "$tmp/out")" = 101 ]'
check "it pushes agent/issue-7 by token URL, never main, never --force" \
  'grep -q "^push http://swarm:tok@fj.test/Acme/widget.git HEAD:refs/heads/agent/issue-7$" "$GIT_PUSHES" && ! grep -q "main\|force" "$GIT_PUSHES"'
check "the PR body opens with closes #7 and carries the worker's words" \
  '[ "$(head -1 "$STATE/pr-body")" = "closes #7" ] && grep -q "rail foot" "$STATE/pr-body"'
check "the screenshot is attached to the PR" 'jq -e "any(.[]; .name == \"after.png\")" "$STATE/assets.json" >/dev/null'
check "…and embedded in a comment a reviewer can see" 'grep -q "attachments/after.png" "$BODIES_LOG"'

# 5 — the waiver path: no upload, still verified.
fresh; ISSUE_LABELS="$PRLABELS" land 7 "fix (#7)" "$tmp/body-waiver.md"; rc=$?
check "the waiver path exits 0 with no attachment" '[ "$rc" -eq 0 ] && [ "$(jq length "$STATE/assets.json")" -eq 0 ]'

# 6 — a retry against an already-open PR refreshes its body (so a waiver added on
#     the second attempt actually lands) and opens no duplicate.
fresh; ISSUE_LABELS="$PRLABELS" land 7 "fix (#7)" "$tmp/body.md" "$tmp/after.png"
: > "$CALLS_LOG"; ISSUE_LABELS="$PRLABELS" land 7 "fix (#7)" "$tmp/body-waiver.md"; rc=$?
check "a retry exits 0" '[ "$rc" -eq 0 ]'
check "…opens NO second PR" '! grep -q "^POST .*/pulls$" "$CALLS_LOG"'
check "…and refreshes the open PR's body" 'grep -q "^PATCH .*/pulls/101$" "$CALLS_LOG" && grep -qF "**Screenshots:** none — " "$STATE/pr-body"'

# 7 — a refused branch push (someone else's commits on the branch) stops loud.
fresh; PUSH_RC=1 ISSUE_LABELS="$PRLABELS" land 7 "fix (#7)" "$tmp/body.md" "$tmp/after.png"; rc=$?
check "a rejected branch push exits 1 and says never force-push" '[ "$rc" -eq 1 ] && grep -qi "never force-push" "$tmp/err"'

echo "land-pr: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
