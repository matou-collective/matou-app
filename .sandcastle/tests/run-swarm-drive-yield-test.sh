#!/usr/bin/env bash
# Offline seam test for run-swarm.sh's drive-reservation yield (#663 producer /
# #664 consumer / #30). A waiting rehearsal drive needs EVERY host lock at once
# and loses to anything that claims a NEW ticket in the gap; run-swarm is about
# to spawn workers that claim, so a FRESH reservation must make it stand down —
# exit 0 BEFORE any API call / any claim — while an EXPIRED (mtime > TTL) one must
# not. The gate sits at the very top of run-swarm.sh, before the EXIT trap /
# verdict / preflight / pnpm / docker, so this whole-script run reaches it with
# no network, no pnpm and no docker. Run: bash .sandcastle/tests/run-swarm-drive-yield-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
# Redirect host state off the live host (#58): tests 3+4 run past the yield gate
# and die downstream on the absent pnpm/preflight, reaching run-swarm.sh's EXIT
# trap — which would otherwise append a `preflight-red` row to the operator's
# real ~/swarm/logs/run-swarm-verdicts.log and write ~/swarm/state/swarm.db.
# shellcheck source=test-env.sh
. "$here/test-env.sh"; test_env_hermetic "$tmp"

# A curl that logs every call — the yield path must touch NOTHING (no claim, no
# API). It never runs on the yield path; if it ever does, the log is non-empty
# and the "before any claim" assertion fails loud.
cat > "$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
echo "$*" >> "${CURL_LOG:?}"
echo '[]'
SH
chmod +x "$tmp/bin/curl"

drive="$tmp/drive-wanted"
defer="$tmp/swarm-defer-count"
verdict="$tmp/swarm-verdict.txt"
curl_log="$tmp/curl.log"

run_swarm() {
  env -u MATTERMOST_URL -u MATTERMOST_BOT_TOKEN -u MATTERMOST_CHANNEL_ID \
    -u GITHUB_ACTIONS \
    PATH="$tmp/bin:$PATH" \
    FORGEJO_TOKEN=dummy FORGEJO_API=http://x/api/v1/repos/x/y \
    REPO_SLUG=Acme/widget SWARM_HOST=box1 \
    HOST_CAPACITY_DRIVE_WANTED="$drive" SWARM_DRIVE_DEFER_COUNT="$defer" \
    SWARM_VERDICT_PATH="$verdict" \
    CURL_LOG="$curl_log" \
    "$@" bash "$here/../run-swarm.sh"
}

# --- 1. a FRESH reservation makes run-swarm yield: exit 0, before any claim,
#        leaving no verdict, and climbing its own consecutive-defer count. ---
rm -f "$defer" "$verdict"; : > "$curl_log"; : > "$drive"
out="$(run_swarm 2>&1)" || fail "a drive-yield must exit 0 (got: $out)"
grep -q "yielding this run to a ready drive" <<<"$out" || fail "a standing reservation must be reported (got: $out)"
grep -q "reservation age" <<<"$out" || fail "the yield must log the reservation's age (got: $out)"
grep -q "skipped 1 consecutive tick(s)" <<<"$out" || fail "the first deferred tick must read skipped 1 (got: $out)"
[ -s "$curl_log" ] && fail "yielding to the drive must stop before ANY API call / claim (curl log: $(cat "$curl_log"))"
[ ! -f "$verdict" ] || fail "a drive-yield is a clean exit — no verdict, got: $(cat "$verdict")"
[ "$(cat "$defer")" = 1 ] || fail "the first deferred tick must leave a defer count of 1, got: $(cat "$defer" 2>/dev/null)"
pass=$((pass+1))

# --- 2. the consecutive-defer count climbs on a second consecutive defer. ---
: > "$curl_log"
out2="$(run_swarm 2>&1)" || fail "a second drive-yield must exit 0 (got: $out2)"
grep -q "skipped 2 consecutive tick(s)" <<<"$out2" || fail "the count must climb on a second consecutive defer (got: $out2)"
[ "$(cat "$defer")" = 2 ] || fail "the second deferred tick must leave a defer count of 2, got: $(cat "$defer" 2>/dev/null)"
pass=$((pass+1))

# --- 3. an EXPIRED reservation (mtime older than the TTL) does NOT yield: the
#        run proceeds PAST the gate (which resets the defer counter) instead of
#        standing down. Pre-seed the counter so the reset is an observable
#        signal the else-branch ran; the run then dies downstream on the absent
#        pnpm/preflight (unrelated to the gate), so only the gate's side effects
#        are asserted, never the exit code. ---
echo 5 > "$defer"; : > "$curl_log"; touch -d '@1' "$drive"
out3="$(run_swarm 2>&1 || true)"
grep -q "yielding this run to a ready drive" <<<"$out3" && fail "an expired reservation must NOT yield (got: $out3)"
[ -f "$defer" ] && fail "proceeding past an expired reservation must reset the consecutive-defer counter (still present: $(cat "$defer"))"
pass=$((pass+1))

# --- 4. no reservation at all also proceeds past the gate (counter reset). ---
echo 9 > "$defer"; rm -f "$drive"
out4="$(run_swarm 2>&1 || true)"
grep -q "yielding this run to a ready drive" <<<"$out4" && fail "no reservation must NOT yield (got: $out4)"
[ -f "$defer" ] && fail "an absent reservation must reset the consecutive-defer counter (still present: $(cat "$defer"))"
pass=$((pass+1))

# --- ticket holder: written at start from HOST_CAPACITY_HELD_SLOT, cleared by on_exit ---
# The suite has no fake pnpm/docker on this host — every prior case here dies
# BEFORE the toolchain, at preflight_gate's ONE live network call
# (guard_issue_write_permission -> forgejo_issue_write_probe -> curl), which is
# the earliest point reached after the ticket holder is written (right after
# swarmdb_run_start) and before on_exit clears it. Snapshot there instead of
# in a fake pnpm. Overwriting curl here is safe: tests 1-4 above already ran
# with the original fake.
slot="$tmp/held-slot"; : > "$slot"
seen="$tmp/holder-seen.json"
cat > "$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
[ -n "${HELD_HOLDER:-}" ] && [ -f "$HELD_HOLDER" ] && cp "$HELD_HOLDER" "${HOLDER_SEEN:?}"
echo '[]'
SH
chmod +x "$tmp/bin/curl"
run_swarm HOST_CAPACITY_HELD_SLOT="$slot" HELD_HOLDER="$slot.holder" HOLDER_SEEN="$seen" >/dev/null 2>&1 || true
[ -s "$seen" ] || fail "ticket holder must exist by the time run-swarm reaches its toolchain"
[ "$(jq -r .kind "$seen")" = ticket ]        || fail "ticket holder kind: $(cat "$seen")"
[ "$(jq -r .ref "$seen")" = run ]            || fail "ticket holder ref must be 'run': $(cat "$seen")"
[ "$(jq -r .worker "$seen")" = swarm-worker ] || fail "ticket holder worker: $(cat "$seen")"
[ "$(jq -r .repo "$seen")" = Acme/widget ]   || fail "ticket holder repo must be the run's REPO_SLUG: $(cat "$seen")"
jq -e '.run_id | type == "string" and length > 0' "$seen" >/dev/null || fail "ticket holder must carry the run id: $(cat "$seen")"
[ ! -e "$slot.holder" ] || fail "on_exit must clear the ticket holder"
# Unset → nothing written, no error.
rm -f "$seen"
run_swarm HELD_HOLDER="$slot.holder" HOLDER_SEEN="$seen" >/dev/null 2>&1 || true
[ ! -e "$seen" ] && [ ! -e "$slot.holder" ] || fail "no HOST_CAPACITY_HELD_SLOT → no holder written"
pass=$((pass+1))

echo "run-swarm-drive-yield: $pass scenarios passed"
