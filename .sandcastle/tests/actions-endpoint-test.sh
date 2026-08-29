#!/usr/bin/env bash
# Ratchet (#28): how the harness is allowed to read Forgejo's Actions API.
#
# 2026-08-22: `GET .../actions/runs?limit=N` stopped answering inside 60 s on
# the big repos (8,900+ runs; `curl -m 60` -> code 000) from every host tried,
# while `GET .../actions/tasks?limit=100&page=N` answered in under a second
# with the same per-job rows the harness reads. `runs` scales with the repo's
# whole run history and the swarm mints runs by the hundred under a label
# storm, so a reader of it is a tick that will one day never return. Every
# harness reader is on `tasks` today — this test is what keeps it that way, and
# what makes the two conditions that keep `tasks` cheap and survivable
# (`page=1`, a curl timeout) structural instead of remembered. GOTCHAS 16.
#
# Scans the harness's own directory ($here/..), non-recursively — the same
# surface in this repo's root and in a consumer's vendored .sandcastle/, so a
# consumer running its vendored tests gets the same guard (#23: a vendored test
# may never reach outside the harness dir).
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
harness="$(cd "$here/.." && pwd)"

pass=0 fail=0
check() { if eval "$2"; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: $1"; fi; }

cd "$harness" || exit 1
shells="$(ls -1 ./*.sh 2>/dev/null)"
check "there are harness scripts to scan" '[ -n "$shells" ]'

# 1. No script reads the runs listing — with ONE narrow exemption. Comment
#    lines are exempt (this hazard has to be explainable in prose next to the
#    code it constrains); anything executable naming it is the regression this
#    ticket exists to prevent. Note the web link `<server>/<repo>/actions/runs/
#    <n>` in a workflow's RUN_URL is a browser URL, not an API read, and lives
#    in .yml — out of this scan by construction.
#    THE EXEMPTION (#105, GOTCHAS 34): scheduler-canary.sh's saturation
#    assertion MUST read `actions/runs?...status=waiting...` — a `waiting` run
#    is NOT in the `tasks` (claimed-only) view, so the queue-depth alarm has no
#    other source. That read is bounded on BOTH axes GOTCHAS 16 cared about:
#    the `status=waiting` filter caps the result at the (tiny) live queue, and
#    checks 2b/3 below still force it to be paged and curl-timed. A runs read
#    WITHOUT one of these filters is still the forbidden unbounded read.
#    SECOND EXEMPTION (#109, GOTCHAS 37): the canary's liveness assertion reads
#    `actions/runs?head_sha=<sha>` — server-side filtered to ONE commit's runs
#    (the forge honours it: a bogus sha returns total_count 0), paged from the
#    last page where the oldest run — ci's — lives. The tasks view it replaced
#    pages by recency, so the ci task fell off page 1 within hours on a busy head.
runs_readers="$(grep -n 'actions/runs' $shells 2>/dev/null | grep -v ':[0-9]*:[[:space:]]*#' | grep -v 'status=waiting' | grep -v 'head_sha=' || true)"
check "no harness script reads /actions/runs (except the status=waiting / head_sha= canary reads)" '[ -z "$runs_readers" ] || { printf "%s\n" "$runs_readers"; false; }'

# 2. Every tasks read is PAGED. Forgejo ignores `limit` without `page`, so an
#    unpaged read dumps the whole task table — the ~30 s response that first
#    blinded the healer (2026-07-30) and the same shape of failure `runs` has
#    now reached permanently.
unpaged="$(grep -n 'actions/tasks?[^"'"'"' ]*' $shells 2>/dev/null | grep -v ':[0-9]*:[[:space:]]*#' | grep -v 'page=' || true)"
check "every /actions/tasks read is paged" '[ -z "$unpaged" ] || { printf "%s\n" "$unpaged"; false; }'

# 2b. The exempted runs read is PAGED too. Same forge behaviour: `limit` is
#     ignored without `page`, so the canary's `status=waiting` read must still
#     carry `page=` or it dumps the whole (filtered, but unpaged) listing.
unpaged_runs="$(grep -n 'actions/runs?[^"'"'"' ]*' $shells 2>/dev/null | grep -v ':[0-9]*:[[:space:]]*#' | grep -v 'page=' || true)"
check "every /actions/runs read is paged" '[ -z "$unpaged_runs" ] || { printf "%s\n" "$unpaged_runs"; false; }'

# 3. Every script that reads the Actions API bounds its curl. A forge that
#    stops answering must RED the tick loudly, not stall it holding a
#    host-capacity slot with nothing on the ticket to say why. Only files that
#    actually FETCH count — heal-lib.sh names the endpoint in a comment because
#    it parses the payload heal.sh fetched, and owns no curl of its own.
fetchers="$(grep -n 'actions/tasks\|actions/runs' $shells 2>/dev/null | grep -v ':[0-9]*:[[:space:]]*#' | cut -d: -f1 | sort -u)"
untimed=""
for f in $fetchers; do
  grep -Eq -- '--max-time|[^-]-m ' "$f" || untimed="$untimed $f"
done
check "every Actions-API reader carries a curl timeout" '[ -z "$untimed" ] || { echo "untimed:$untimed"; false; }'

echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
