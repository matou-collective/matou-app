#!/usr/bin/env bash
# Offline test for preflight-triage.sh: (1) the transient-5xx retry (#235 AC3)
# — a Forgejo blip that clears within the attempt budget must NOT kill triage,
# but a persistent outage still fails the job; (2) the label-exclusion filter
# (#555) — issues carrying a triage outcome label (including
# `ready-for-session`, minted by ADR 0174) must not resurface as untriaged.
# Run: bash .sandcastle/tests/preflight-triage-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail() { echo "FAIL: $1" >&2; exit 1; }

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

# A curl shim that fails (curl's HTTP-error exit 22) the first $FAIL_TIMES calls,
# then returns an empty issue page so the pager stops.
mkdir -p "$tmp/bin"
cat > "$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
n="$(cat "$FAIL_COUNTER" 2>/dev/null || echo 0)"; n=$((n+1)); echo "$n" > "$FAIL_COUNTER"
[ "$n" -le "${FAIL_TIMES:-0}" ] && exit 22
echo '[]'
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

# a persistent outage (more failures than attempts) → the job still fails
: > "$tmp/counter"
if run_preflight FAIL_TIMES=99 >/dev/null 2>&1; then
  fail "a persistent outage must still fail the job, never a fabricated empty result"
fi

# A curl shim that serves a fixed page-1 batch of issues (mixed labels) then
# an empty page-2, so the pager stops. #100 carries ready-for-session — the
# #555 regression — plus one of each other excluded label, and one issue
# (#104) with no outcome label at all, which must still surface.
cat > "$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
case "$*" in
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
JSON
    ;;
  *) echo '[]' ;;
esac
SH
chmod +x "$tmp/bin/curl"

out="$(env PATH="$tmp/bin:$PATH" FORGEJO_TOKEN=dummy \
  FORGEJO_API=http://x/api/v1/repos/x/y bash "$here/../preflight-triage.sh")"
numbers="$(printf '%s' "$out" | jq -c '[.[].number] | sort')"
[ "$numbers" = "[104]" ] ||
  fail "expected only #104 (no outcome label) to surface as untriaged, got: $numbers"

echo "preflight-triage: 3 scenarios passed"
