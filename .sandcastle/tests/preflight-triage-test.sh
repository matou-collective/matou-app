#!/usr/bin/env bash
# Offline test for preflight-triage.sh: (1) the transient-5xx retry (#235 AC3)
# — a Forgejo blip that clears within the attempt budget must NOT kill triage,
# but a persistent outage still fails the job; (2) the label-exclusion filter
# (#555) — issues carrying a triage outcome label (including
# `ready-for-session`, minted by ADR 0174) must not resurface as untriaged;
# (3) #341 — `api()` BOUNDS each attempt and PROPAGATES the real fault: a failed
# attempt emits a diagnostic line naming curl's rc AND `%{http_code}` (so the
# heal verdict's error-line scrape has text to find, not an empty block), and
# exhaustion returns curl's REAL rc (a timeout 28 distinguishable from an HTTP
# error 22), never the old constant 22.
# Run: bash .sandcastle/tests/preflight-triage-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail() { echo "FAIL: $1" >&2; exit 1; }

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

# A curl shim that fails (curl's HTTP-error exit 22) the first $FAIL_TIMES calls,
# then returns an empty issue page so the pager stops. It EMULATES `-w` by
# appending "\n<http-code>" to its output on every call — on a failure under
# `-f` curl suppresses the body but still writes the `-w` template, so the fail
# branch emits just "\n504" (body empty, code 504), exactly as the real client.
mkdir -p "$tmp/bin"
cat > "$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
n="$(cat "$FAIL_COUNTER" 2>/dev/null || echo 0)"; n=$((n+1)); echo "$n" > "$FAIL_COUNTER"
if [ "$n" -le "${FAIL_TIMES:-0}" ]; then
  printf '\n504'   # -w emits the code even on an -f failure; no body
  exit 22
fi
# The bare repo-root GET is the #20 issue-write probe — answer it with a
# permissions block that grants write; every other call is an empty issue page.
case "$*" in
  *repos/x/y) printf '%s\n200' '{"permissions":{"push":true}}' ;;
  *) printf '%s\n200' '[]' ;;
esac
SH
chmod +x "$tmp/bin/curl"

run_preflight() {
  env FAIL_COUNTER="$tmp/counter" PATH="$tmp/bin:$PATH" \
    FORGEJO_TOKEN=dummy FORGEJO_API=http://x/api/v1/repos/x/y \
    PREFLIGHT_BACKOFF=0 "$@" bash "$here/../preflight-triage.sh"
}

# two transient failures then success (within the 3-attempt budget) → survives
: > "$tmp/counter"
out="$(run_preflight FAIL_TIMES=2)" || fail "a transient blip within the budget must not fail the job"
[ "$(printf '%s' "$out" | jq 'length')" = "0" ] || fail "expected an empty untriaged array once the blip clears"

# #341: a failed attempt must emit a diagnostic naming curl's rc AND the HTTP
# code — the old wrapper returned a silent constant 22 and the verdict's error
# block was empty. One transient 504 then success: stdout stays clean, stderr
# carries the one diagnostic line in the documented shape.
: > "$tmp/counter"
err="$(run_preflight FAIL_TIMES=1 2>&1 >/dev/null)" || fail "one transient blip must still succeed"
echo "$err" | grep -q 'http=504' || fail "diagnostic must name the HTTP code (http=504), got: $err"
echo "$err" | grep -q 'curl=22'  || fail "diagnostic must name curl's exit code (curl=22), got: $err"
echo "$err" | grep -q 'attempt 1/3' || fail "diagnostic must name the attempt, got: $err"

# a persistent outage (more failures than attempts) → the job still fails, and
# every exhausted attempt is diagnosed (not one silent constant-22 return).
: > "$tmp/counter"
if err="$(run_preflight FAIL_TIMES=99 2>&1 >/dev/null)"; then
  fail "a persistent outage must still fail the job, never a fabricated empty result"
fi
echo "$err" | grep -q 'attempt 3/3' || fail "a persistent outage must diagnose the last attempt, got: $err"

# #341: the real curl rc is PROPAGATED, not flattened to the constant 22 — a
# connect timeout (rc 28, http 000) is distinguishable from an HTTP error. A
# shim that always times out must surface curl=28 / http=000, not curl=22.
cat > "$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
printf '\n000'   # no connection: code is 000, -w still writes it
exit 28
SH
chmod +x "$tmp/bin/curl"
if err="$(env PATH="$tmp/bin:$PATH" FORGEJO_TOKEN=dummy \
    FORGEJO_API=http://x/api/v1/repos/x/y PREFLIGHT_BACKOFF=0 \
    bash "$here/../preflight-triage.sh" 2>&1 >/dev/null)"; then
  fail "a persistent connect timeout must fail the job"
fi
echo "$err" | grep -q 'curl=28'  || fail "a timeout must surface curl's real rc (curl=28), not the constant 22, got: $err"
echo "$err" | grep -q 'http=000' || fail "a timeout must surface http=000, got: $err"

# A curl shim that serves a fixed page-1 batch of issues (mixed labels) then
# an empty page-2, so the pager stops. #100 carries ready-for-session — the
# #555 regression — plus one of each other excluded label, and one issue
# (#104) with no outcome label at all, which must still surface. Each reply
# emulates `-w` with a trailing "\n200".
cat > "$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
case "$*" in
  *repos/x/y) printf '%s\n200' '{"permissions":{"push":true}}' ;;  # #20 issue-write probe
  *page=1*) cat <<'JSON'
[
  {"number": 100, "title": "already ruled ready-for-session", "html_url": "u",
   "labels": [{"name": "ready-for-session"}]},
  {"number": 101, "title": "already ruled ready-for-human", "html_url": "u",
   "labels": [{"name": "ready-for-human"}]},
  {"number": 102, "title": "wayfinder map", "html_url": "u",
   "labels": [{"name": "wayfinder:map"}]},
  {"number": 103, "title": "deferred", "html_url": "u",
   "labels": [{"name": "deferred"}]},
  {"number": 104, "title": "genuinely untriaged", "html_url": "u",
   "labels": []}
]
200
JSON
    ;;
  *) printf '%s\n200' '[]' ;;
esac
SH
chmod +x "$tmp/bin/curl"

out="$(env PATH="$tmp/bin:$PATH" FORGEJO_TOKEN=dummy \
  FORGEJO_API=http://x/api/v1/repos/x/y bash "$here/../preflight-triage.sh")"
numbers="$(printf '%s' "$out" | jq -c '[.[].number] | sort')"
[ "$numbers" = "[104]" ] ||
  fail "expected only #104 (no outcome label) to surface as untriaged, got: $numbers"

# #20: a bot that cannot write issues on this repo must red preflight, not run
# a triage that silently fails to apply a single label. The repo-root probe
# returns permissions.push=false → the job fails before listing anything.
cat > "$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
case "$*" in
  *repos/x/y) printf '%s\n200' '{"permissions":{"push":false}}' ;;
  *) printf '%s\n200' '[]' ;;
esac
SH
chmod +x "$tmp/bin/curl"
if env PATH="$tmp/bin:$PATH" FORGEJO_TOKEN=dummy \
    FORGEJO_API=http://x/api/v1/repos/x/y bash "$here/../preflight-triage.sh" >/dev/null 2>&1; then
  fail "a bot without issue-write permission must fail triage preflight"
fi

echo "preflight-triage: 6 scenarios passed"
