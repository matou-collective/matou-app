#!/usr/bin/env bash
# Offline test for fleet-dispatch-receiver.py — the dispatcher's dumb report
# receiver (ADR 0009, slice 2 / #355). Exercises the real behaviour (auth gate +
# spool one body into the inbox) through the receiver's --write-stdin seam, with
# NO socket bound — the serve() path that binds a port is runtime glue proven at
# the ends (the main-mts-offline rule). The body is spooled verbatim: validation
# and keying are the tested bash half (fleet_dispatch_ingest over the inbox).
# Run: bash tests/fleet-dispatch-receiver-test.sh
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"
sc="$here/.."

if ! command -v python3 >/dev/null 2>&1; then
  echo "fleet-dispatch-receiver-test: SKIPPED — no python3 on PATH."
  exit 0
fi

tmp="$(tmpdir)"
export FLEET_DISPATCH_INBOX="$tmp/inbox"
mkdir -p "$FLEET_DISPATCH_INBOX"
rx() { python3 "$sc/fleet-dispatch-receiver.py" "$@"; }
inbox_count() { local n; n="$(ls -1 "$FLEET_DISPATCH_INBOX" 2>/dev/null | wc -l)"; echo "${n// /}"; }

body='{"host":"boxA","slots":[]}'

# ── no token set: the endpoint is open ───────────────────────────────────────
: >"$tmp/out"
printf '%s' "$body" | FLEET_DISPATCH_TOKEN="" rx --write-stdin >"$tmp/out" 2>/dev/null
check "open receiver spools the body (rc 0)"   '[ "$?" -eq 0 ]'
check "the spooled file exists and is the body" 'p="$(cat "$tmp/out")"; [ -f "$p" ] && [ "$(jq -r .host "$p")" = boxA ]'
check "exactly one file in the inbox"           '[ "$(inbox_count)" = 1 ]'

# ── token set: a correct bearer is accepted ──────────────────────────────────
rm -f "$FLEET_DISPATCH_INBOX"/*
printf '%s' "$body" | FLEET_DISPATCH_TOKEN="sekret" rx --write-stdin --auth "Bearer sekret" >/dev/null 2>&1
check "a correct bearer is accepted and spools" '[ "$?" -eq 0 ] && [ "$(inbox_count)" = 1 ]'

# ── token set: a wrong/absent bearer is refused, nothing spooled ─────────────
rm -f "$FLEET_DISPATCH_INBOX"/*
printf '%s' "$body" | FLEET_DISPATCH_TOKEN="sekret" rx --write-stdin --auth "Bearer nope" >/dev/null 2>&1
check "a wrong bearer is refused (rc 1)"        '[ "$?" -eq 1 ]'
printf '%s' "$body" | FLEET_DISPATCH_TOKEN="sekret" rx --write-stdin >/dev/null 2>&1
check "an absent bearer is refused (rc 1)"      '[ "$?" -eq 1 ]'
check "a refused request spools nothing"        '[ "$(inbox_count)" = 0 ]'

# ── the spool is opaque: a non-JSON body is still written (bash drops it later) ─
rm -f "$FLEET_DISPATCH_INBOX"/*
printf 'not json' | FLEET_DISPATCH_TOKEN="" rx --write-stdin >/dev/null 2>&1
check "the receiver does not parse — it spools whatever arrives" '[ "$(inbox_count)" = 1 ]'

# ── the acknowledgement (ADR 0009 decision 4 / #356): the 200 body reflects mode ─
# --ack prints the exact body a 200 carries, without a socket. Live says acting;
# shadow (and the default) does not — so a host only stands down for a live
# dispatcher. The both-ends match with the host parser is the contract test.
a="$(FLEET_DISPATCH_MODE=live rx --ack)"
check "live ack says acting=true and names the mode" \
  '[ "$(jq -r .acting <<<"$a")" = true ] && [ "$(jq -r .mode <<<"$a")" = live ] && [ "$(jq -r .ok <<<"$a")" = true ]'
a="$(FLEET_DISPATCH_MODE=shadow rx --ack)"
check "shadow ack says acting=false" '[ "$(jq -r .acting <<<"$a")" = false ]'
a="$(env -u FLEET_DISPATCH_MODE python3 "$sc/fleet-dispatch-receiver.py" --ack)"
check "the default (no mode set) acks acting=false — never a stand-down by accident" \
  '[ "$(jq -r .acting <<<"$a")" = false ] && [ "$(jq -r .mode <<<"$a")" = shadow ]'

# ── per-host ack (slice 4 / #357): stage 6b stands down only the named host ───
# live + empty allowlist (stage 6c): any host, and a hostless --ack, acks acting.
a="$(FLEET_DISPATCH_MODE=live FLEET_DISPATCH_LIVE_HOSTS="" rx --ack --host boxA)"
check "live + empty allowlist: a named host acks acting=true (fleet-wide)" '[ "$(jq -r .acting <<<"$a")" = true ]'
a="$(FLEET_DISPATCH_MODE=live FLEET_DISPATCH_LIVE_HOSTS="" rx --ack)"
check "live + empty allowlist: a hostless --ack still acks acting=true" '[ "$(jq -r .acting <<<"$a")" = true ]'
# live + scoped allowlist (stage 6b): only the listed host is acted on.
a="$(FLEET_DISPATCH_MODE=live FLEET_DISPATCH_LIVE_HOSTS="boxA" rx --ack --host boxA)"
check "live + scoped: the listed host acks acting=true (stands down)" '[ "$(jq -r .acting <<<"$a")" = true ]'
a="$(FLEET_DISPATCH_MODE=live FLEET_DISPATCH_LIVE_HOSTS="boxA" rx --ack --host boxB)"
check "live + scoped: an unlisted host acks acting=false (keeps ticking)" '[ "$(jq -r .acting <<<"$a")" = false ]'
a="$(FLEET_DISPATCH_MODE=live FLEET_DISPATCH_LIVE_HOSTS="boxA" rx --ack)"
check "live + scoped: a hostless --ack acks acting=false (safe direction)" '[ "$(jq -r .acting <<<"$a")" = false ]'

# the per-host ack flows through a real spooled POST: the body names the host.
rm -f "$FLEET_DISPATCH_INBOX"/*
out="$(printf '%s' '{"host":"boxA","slots":[]}' | FLEET_DISPATCH_MODE=live FLEET_DISPATCH_LIVE_HOSTS="boxA" rx --write-stdin 2>/dev/null; :)"
check "a spooled report is still written under scoped-live" '[ "$(inbox_count)" = 1 ]'

summary fleet-dispatch-receiver-test
