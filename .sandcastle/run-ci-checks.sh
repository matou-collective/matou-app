#!/usr/bin/env bash
# run-ci-checks.sh — the `ci` workflow's build + frontend/backend checks, with
# an on-failure seam verdict (#388).
#
# ci.yml's "Frontend + backend checks in the sandbox image" step ran entirely
# inline in the YAML and wrote NO verdict, even though heal.sh's verdict_path()
# maps `ci` -> $SEAM_VERDICT and its comment claimed `ci` (#197) drops one. It
# never did: nothing in the repo wrote that file. So on EVERY red ci,
# error_line() found no fresh verdict and no breadcrumb, dropped the
# `seam-degraded` marker, and returned an empty line — collapsing every distinct
# ci fault onto one constant signature `sha1("ci|")`. A moved fault then looked
# like the same incident (the exact failure mode #235 fixed for swarm/triage,
# #228 for verify).
#
# This drops the SAME stage/exit/error verdict format verdict-lib.sh's other
# callers use (run-verify.sh #228, run-swarm.sh/run-triage.sh #235), keyed on the
# ACTUAL failing leg — `npm ci` / `test:script` / `lint` / `build` / `go build` /
# `make test` / `golangci-lint` / `kit:apply drift` — so two ci failures with
# different causes yield two different signatures. A clean run leaves no verdict
# (verdict_write's contract).
#
# The fiddly part: the checks run INSIDE `docker run`, so the failing leg and its
# error lines have to cross back to the host. The container echoes a
# `::ci-stage:: <leg>` breadcrumb before each leg (set -euo pipefail inside means
# the LAST breadcrumb printed names the leg that died), and its combined output
# is tee'd to a host-side log. On failure the host reads the last breadcrumb to
# name the stage and feeds the tee'd log to the verdict as the errlog.
#
# Env (all supplied by ci.yml's step): REPO_SLUG (owner/name), CI_CONTAINER,
# CI_RUN_ID. Test seams: SEAM_VERDICT_PATH (verdict location) and
# CI_SLOT_WAIT_TIMEOUT (host-capacity camp deadline).
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=verdict-lib.sh
. "$here/verdict-lib.sh"

# Same repo-tagged default path heal.sh's verdict_path() reads for `ci` (#574 —
# one runner serves two repos, so the tag disambiguates). heal.sh derives its tag
# from FORGEJO_API; this derives the identical tag from REPO_SLUG (github.repository).
repo_slug="${REPO_SLUG:-}"
[ -n "$repo_slug" ] || repo_slug="${FORGEJO_API##*/repos/}"
repo_tag="${repo_slug//\//-}"
SEAM_VERDICT="${SEAM_VERDICT_PATH:-/tmp/matou-$repo_tag-seam-verdict.txt}"

CI_CONTAINER="${CI_CONTAINER:-matou-app-ci}"
CI_RUN_ID="${CI_RUN_ID:-0}"
SLOT_WAIT="${CI_SLOT_WAIT_TIMEOUT:-1800}"

# Drop a stage/exit verdict on failure so the healer keys the incident signature
# on the run's REAL failing leg, not the bare `ci` workflow name (#388).
verdict_begin "$SEAM_VERDICT"
trap 'verdict_write $?' EXIT

# --- Stage 1: build the sandbox image -----------------------------------------
# AGENT_UID/GID MUST follow the host user (sandcastle build-image does the same):
# the image's "agent" defaults to 1000, and the bind-mounted workspace is owned
# by whichever uid the runner runs as — 1000 on matou-workstation, 1500 on
# elitebook-03. Without this, npm ci dies with EACCES on node_modules the moment
# the job lands on a pool host whose uid differs (dev-factory GOTCHAS 6).
# Host-capacity slot (#268): the image build and the checks are the heavy work —
# they starved the pr-e2e drive when they co-ran unlocked. Each rides ONE pooled
# slot via the bounded-camp wrapper (event-driven job: a yield would lose the
# run). Two acquisitions, not one held across both, so an exclusive drive can
# slip between.
build_log="$(mktemp)"
verdict_stage "docker build (sandbox image)" "$build_log"
if bash "$here/host-slot-wait.sh" "$SLOT_WAIT" \
     docker build --build-arg AGENT_UID="$(id -u)" --build-arg AGENT_GID="$(id -g)" \
       -t matou-app-ci -f "$here/Dockerfile" "$here" 2>&1 | tee "$build_log"; then
  rm -f "$build_log"
else
  ec=$?
  exit "$ec"   # trap -> verdict: stage=docker build, errlog=build_log
fi

# --- Stage 2: the frontend + backend checks, inside the image -----------------
# --entrypoint bash is required: the image's ENTRYPOINT is ["sleep", "infinity"]
# (for sandcastle's own bind-mount/exec workflows), and without an override
# `docker run` appends the trailing command to that entrypoint's argv instead of
# replacing it — so this would silently run `sleep infinity bash -lc ...` and
# hang until timeout-minutes kills the job.
# --init gives the container a signal-forwarding/zombie-reaping PID 1 (tini) so a
# runner SIGTERM on cancel actually stops the tree instead of being ignored by
# `bash -lc` (#331). --name/--label let a cancelled or outage-killed run be
# reaped by name (ci.yml's always() step) and by label (dev-factory#122 sweep)
# once --rm can no longer fire.
# Each leg is preceded by a `::ci-stage:: <leg>` breadcrumb: with set -euo
# pipefail inside the container, the first failing command aborts the script, so
# the last breadcrumb printed to the tee'd log names exactly the leg that died.
checks_log="$(mktemp)"
verdict_stage "checks" "$checks_log"
if bash "$here/host-slot-wait.sh" "$SLOT_WAIT" \
     docker run --rm --init --name "$CI_CONTAINER" \
       --label matou.factory=ci --label "matou.run=$CI_RUN_ID" \
       --entrypoint bash -v "$PWD":/work -w /work matou-app-ci -lc '
       set -euo pipefail
       # Each leg is a STANDALONE command (not a `cd X && cmd && cd ..` chain):
       # under set -e a non-final element of an && list does NOT abort the
       # script (it is exempt), so a failure buried in such a chain silently
       # continued to the next leg and mis-attributed the fault. Plain cd + cmd
       # lets set -e abort on the real failing leg, so the last breadcrumb names it.
       cd frontend
       echo "::ci-stage:: frontend npm ci";      CI=true npm ci
       echo "::ci-stage:: frontend test:script"; npm run test:script
       echo "::ci-stage:: frontend lint";        npm run lint
       echo "::ci-stage:: frontend build";       npm run build
       cd ../backend
       echo "::ci-stage:: backend go build";     go build ./...
       echo "::ci-stage:: backend make test";    make test
       cd ..
       echo "::ci-stage:: backend golangci-lint (#346)"
       echo "==> Go lint (#346): same stages as the sandbox pre-push gate, findings since origin/main"
       git fetch -q --depth=1 origin main
       cd backend
       golangci-lint run --new-from-rev origin/main ./...
       cd ..
       echo "::ci-stage:: frontend kit:apply drift (#245)"
       echo "==> kit drift check (#245): generated artefacts must match npm run kit:apply"
       cd frontend
       npm run kit:apply
       git diff --exit-code -- src/generated src/css/kit-tokens.scss kit.build.json src-capacitor/capacitor.config.json src-capacitor/android/app/src/main/res/values/strings.xml || {
         echo "ERROR: generated kit artefacts drifted — run npm run kit:apply and commit the result (icons are excluded: PNG output varies across sharp builds)" >&2
         exit 1
       }
     ' 2>&1 | tee "$checks_log"; then
  rm -f "$checks_log"
else
  ec=$?
  # Name the stage after the leg that died — the last breadcrumb in the tee'd
  # log — so a moved fault (npm ci -> make test -> golangci-lint) yields a new
  # signature instead of the degraded `ci|` constant. Fall back to the coarse
  # "checks" stage verdict_stage already set when no breadcrumb was reached
  # (e.g. the container never started).
  leg="$(grep '^::ci-stage:: ' "$checks_log" 2>/dev/null | tail -1 | sed 's/^::ci-stage:: //')"
  [ -n "$leg" ] && verdict_stage "$leg" "$checks_log"
  exit "$ec"   # trap -> verdict: stage=$leg, errlog=checks_log
fi
