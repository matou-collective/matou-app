#!/usr/bin/env bash
# Smoke-tier e2e driver for matou-app (Matou/matou-app#41, ruled by Ben
# 2026-08-20). One real journey — an adaptive base sub-journey plus an optional
# feature-showcase leg — driven against freshly-bootstrapped test infra, emitting
# the six-clause e2e-driver-contract artifacts so the vendored reporter/healer
# (.sandcastle/rehearsal-report.sh) can read the run dir on its own.
#
# The six clauses this driver satisfies:
#   1. legs.json    — rewritten after EVERY leg (partial progress survives a red)
#   2. verdict.json — authoritative green/red for the whole drive
#   3. run dir      — test-results/smoke/<stamp>/ (UTC basic stamp = basename)
#   4. screenshots  — per-leg, under <run>/screenshots/<leg>/
#   5. text logs    — per-leg Playwright output under <run>/logs/*.txt
#   6. rc != 0      — the drive exits non-zero on the FIRST red leg
#
# Usage:
#   run-smoke-drive.sh [--base a|b] [--feature <issue-N>] [--run-dir DIR]
#                      [--skip-infra] [-h|--help]
#
#   --base a|b     a = org-setup alone; b = org-setup -> registration ->
#                  invitation (the membership growth loop). Default: auto —
#                  read from the feature spec's `smoke-base:` marker, else `a`.
#   --feature N    add a feature-showcase leg running the per-issue feature spec
#                  frontend/tests/e2e/features/issue-N.spec.ts (the same specs
#                  run-pr-e2e.sh resolves). Screenshots are the review currency.
#   --run-dir DIR  override the run directory (default test-results/smoke/<stamp>).
#   --skip-infra   assume KERI/any-sync/backend are already up (hand-runs against
#                  a live test env); otherwise the driver bootstraps them.
#
# Runnable by hand and by workflow dispatch from day one. Standing-drive
# scheduling (a periodic bare lap) waits on Matou/dev-factory#3 — out of scope.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=smoke-drive-lib.sh
. "$here/smoke-drive-lib.sh"
root="$(cd "$here/../.." && pwd)"
# shellcheck source=../../.sandcastle/verdict-lib.sh
. "$root/.sandcastle/verdict-lib.sh"

usage() { sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

base_opt="" feature="" run_dir="" skip_infra=0
while [ $# -gt 0 ]; do
  case "$1" in
    --base)      base_opt="${2:-}"; shift 2 ;;
    --feature)   feature="${2:-}"; feature="${feature#\#}"; shift 2 ;;
    --run-dir)   run_dir="${2:-}"; shift 2 ;;
    --skip-infra) skip_infra=1; shift ;;
    -h|--help)   usage; exit 0 ;;
    *) echo "run-smoke-drive: unknown arg '$1'" >&2; usage >&2; exit 2 ;;
  esac
done

case "$base_opt" in ""|a|b) ;; *) echo "run-smoke-drive: --base must be a or b" >&2; exit 2 ;; esac
if [ -n "$feature" ] && ! [[ "$feature" =~ ^[0-9]+$ ]]; then
  echo "run-smoke-drive: --feature must be an issue number" >&2; exit 2
fi

spec=""
if [ -n "$feature" ]; then
  spec="frontend/tests/e2e/features/issue-$feature.spec.ts"
  if [ ! -f "$root/$spec" ]; then
    echo "run-smoke-drive: feature spec $spec not found" >&2; exit 2
  fi
fi

base="$(sd_resolve_base "$base_opt" "$root/$spec")"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
# The exact tree this lap drives — recorded in verdict.json (matou-app#49) so a
# green/red can never be mistaken for a test of a different ref. git HEAD is
# authoritative (it is literally what was checked out); GITHUB_SHA is the
# fallback when run outside a git checkout.
sha="$(git -C "$root" rev-parse HEAD 2>/dev/null || echo "${GITHUB_SHA:-unknown}")"
[ -n "$run_dir" ] || run_dir="$root/test-results/smoke/$stamp"
mkdir -p "$run_dir/artifacts" "$run_dir/logs" "$run_dir/screenshots"
legs_d="$run_dir/artifacts/legs.d"; mkdir -p "$legs_d"
results_dir="$root/frontend/tests/e2e/results"

# Drop a stage/exit verdict for the swarm healer, mirroring run-swarm.sh's EXIT
# trap (#235, matou-app#46). The healer reads this marker to key a red drive's
# incident signature on the run's REAL failing stage — instead of grepping stale
# worker chain-of-thought prose (the #235 mis-key this repairs). Repo-tagged
# (#238/#574) so matou-app and idss never stomp each other's file; the reader
# (heal.sh) derives the same path from the same slug. verdict_begin clears any
# stale marker, so a marker on disk always belongs to THIS run, and (per
# verdict-lib's contract) verdict_write only writes on a non-zero exit — a green
# drive leaves none, a red one always does.
repo_tag="$(sd_repo_tag "${REPO_SLUG:-}" "${FORGEJO_API:-}" "$(git -C "$root" remote get-url origin 2>/dev/null || true)")"
[ -n "$repo_tag" ] || repo_tag="Matou-matou-app"
verdict_begin "${SMOKE_DRIVE_VERDICT_PATH:-/tmp/matou-$repo_tag-smoke-drive-verdict.txt}"
verdict_stage "startup (base=$base feature=${feature:-none})"

echo "run-smoke-drive: base=$base feature=${feature:-none} sha=$sha run-dir=$run_dir"
sd_plan_legs "$base" "$feature" | sed 's/^/  leg: /' | cut -f1

# --- infra bootstrap (mirrors .sandcastle/run-pr-e2e.sh) -------------------
INFRA="${MATOU_INFRA_DIR:-$HOME/matou/matou-infrastructure}"
backend_pid="" smtp_pid=""
teardown() {
  local ec=$?
  [ -n "$backend_pid" ] && kill "$backend_pid" 2>/dev/null || true
  [ -n "$smtp_pid" ] && kill "$smtp_pid" 2>/dev/null || true
  if [ "$skip_infra" -eq 0 ]; then
    # Keep the KERI-side story (KERIA + witnesses) next to the browser/backend
    # logs before the containers go away. Escrow reasons (MissingRegistryError,
    # Missing anchor, MissingWitnessSignature…) are only ever written here —
    # a red registration leg is undiagnosable without them (matou-app#51).
    ( cd "$INFRA/keri" && docker compose --env-file .env.test \
        -f docker-compose.yml -f docker-compose.patched.yml logs --no-color --timestamps ) \
      >"$run_dir/logs/zz-keri-containers.txt" 2>&1 || true
    fuser -k 9003/tcp 2>/dev/null || true
    make -C "$INFRA/any-sync" down-test >/dev/null 2>&1 || true
    make -C "$INFRA/keri" down-test >/dev/null 2>&1 || true
  fi
  # Write the healer marker last, from the final exit code + current stage (#46).
  verdict_write "$ec"
}
trap teardown EXIT

if [ "$skip_infra" -eq 0 ]; then
  verdict_stage "infra bootstrap (KERI/any-sync/backend)" "$run_dir/logs/00-backend.txt"
  echo "run-smoke-drive: bootstrapping test infra under $INFRA"
  ( cd "$root" && bash scripts/clean-test.sh )
  make -C "$INFRA/keri" clean-test start-and-wait-test
  make -C "$INFRA/any-sync" clean-test setup-test
  command -v go >/dev/null 2>&1 || export PATH="$HOME/go-sdk/go/bin:$PATH"
  if [ -z "${CONFIG_ADMIN_TOKEN:-}" ] && [ -f "$INFRA/keri/.env.test" ]; then
    CONFIG_ADMIN_TOKEN="$(sed -n 's/^CONFIG_ADMIN_TOKEN=//p' "$INFRA/keri/.env.test" | head -1)"
  fi
  export CONFIG_ADMIN_TOKEN="${CONFIG_ADMIN_TOKEN:-}" MATOU_CONFIG_SERVER_TOKEN="${CONFIG_ADMIN_TOKEN:-}"
  # Test-mode backends send booking confirmations to MATOU_SMTP_PORT (3525 —
  # backend-manager.ts); with nothing listening the booking endpoint answers
  # 500 and `user books a Whakawhānaunga session` reds the registration leg
  # (clean-start gotcha #16, seen on smoke lap 20260822T170144Z). Run a
  # throwaway sink; received mail is summarised in logs/zz-smtp-sink.txt.
  if ! ss -ltn 2>/dev/null | grep -qE '[:.]3525\b'; then
    python3 "$here/smtp-sink.py" --port 3525 --log "$run_dir/logs/zz-smtp-sink.txt" \
      2>>"$run_dir/logs/zz-smtp-sink.txt" &
    smtp_pid=$!
  fi
  ( cd "$root/backend" && make build )
  ( cd "$root/backend" && MATOU_ENV=test exec ./bin/server ) >"$run_dir/logs/00-backend.txt" 2>&1 &
  backend_pid=$!
  for _ in $(seq 1 60); do curl -sf http://localhost:9080/health >/dev/null && break; sleep 2; done
  curl -sf http://localhost:9080/health >/dev/null \
    || { echo "backend never became healthy" >&2; exit 1; }
  ( cd "$root/frontend" && npm ci && npx playwright install chromium )
fi

# --- drive the legs --------------------------------------------------------
export MATOU_KERI_INFRA_DIR="${MATOU_KERI_INFRA_DIR:-$INFRA/keri}"
n=0 red_count=0 first_red=""
verdict="green"

# legs.json is written once up front (empty) so the run dir is self-describing
# even if the first leg dies mid-flight, and rewritten after every leg.
sd_legs_array "$legs_d" > "$run_dir/artifacts/legs.json"

while IFS=$'\t' read -r leg project filter; do
  [ -n "$leg" ] || continue
  n=$((n+1)); nn="$(printf '%02d' "$n")"
  log="$run_dir/logs/$nn-$leg.txt"
  # Key a red drive's verdict on the failing leg + its Playwright log (#46): if
  # this is the first red leg, the EXIT trap's verdict_write reads $log for the
  # error lines the healer folds into the incident signature.
  verdict_stage "leg $nn $leg (project=$project)" "$log"
  echo "run-smoke-drive: leg $nn $leg (project=$project${filter:+ file=$filter})"

  # Isolate this leg's screenshots: clear Playwright's shared results dir first,
  # then harvest whatever PNGs the leg produced afterwards.
  rm -rf "$results_dir"; mkdir -p "$results_dir"

  start="$(date -u +%s%3N 2>/dev/null || date -u +%s000)"
  # The script runs without `set -e`, so a non-zero leg is captured, not fatal.
  ( cd "$root/frontend" && npx playwright test --project="$project" --no-deps ${filter:+"$filter"} ) \
    >"$log" 2>&1
  rc=$?
  end="$(date -u +%s%3N 2>/dev/null || date -u +%s000)"
  ms=$(( end - start )); [ "$ms" -ge 0 ] || ms=0

  # Harvest per-leg screenshots (curated snaps + Playwright's own captures).
  shot_dir="$run_dir/screenshots/$leg"; mkdir -p "$shot_dir"
  if [ -d "$results_dir" ]; then
    find "$results_dir" -name '*.png' -exec cp -f {} "$shot_dir/" \; 2>/dev/null || true
  fi

  if [ "$rc" -eq 0 ]; then
    sd_leg_record "$leg" green "$ms" "" > "$legs_d/$nn-$leg.json"
  else
    # The failure summary block ("N) [proj] › … › title" + assertion), not the
    # trailing console FAILED noise (#51). See sd_leg_error.
    err="$(sd_leg_error "$log" "$rc")"
    sd_leg_record "$leg" red "$ms" "$err" > "$legs_d/$nn-$leg.json"
    red_count=$((red_count+1)); verdict="red"; first_red="$leg"
  fi

  # Clause 1: legs.json reflects every leg run so far.
  sd_legs_array "$legs_d" > "$run_dir/artifacts/legs.json"

  # Clause 6: stop and fail at the first red leg.
  if [ "$rc" -ne 0 ]; then
    echo "run-smoke-drive: RED at leg $leg — stopping" >&2
    break
  fi
done < <(sd_plan_legs "$base" "$feature")

# Clause 2 + 5: authoritative verdict.
sd_verdict_json "$verdict" "$base" "$feature" "$stamp" "$n" "$red_count" "$sha" \
  > "$run_dir/artifacts/verdict.json"

echo "run-smoke-drive: verdict=$verdict legs=$n red=$red_count sha=$sha run-dir=$run_dir"
[ "$verdict" = green ] && exit 0
echo "run-smoke-drive: first red leg: $first_red" >&2
exit 1
