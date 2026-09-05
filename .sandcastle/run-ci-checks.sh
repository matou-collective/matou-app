#!/usr/bin/env bash
# ci.yml's `checks` job, wrapped in the on-failure verdict seam.
#
# The healer already maps `ci` to a seam verdict at
# /tmp/matou-<repo-tag>-seam-verdict.txt (heal.sh:verdict_path), and that path
# was documented as being written by `scripts/seam-smoke.sh` (#197) — a script
# this repo does not have. Nothing here ever wrote the file, so EVERY red ci run
# hit heal.sh's no-fresh-verdict branch: the incident signature degraded to the
# bare workflow name, the `seam-degraded` marker fired, and the healer's
# investigation opened with "Trigger error line: unknown" and no run-verdict.txt
# (matou-app run 13398, PR #414 — the lint stage failed and the healer could not
# see which stage, let alone which lines).
#
# This is the writer half. Host-side stages (image build / checks run) come from
# the wrapper; the in-container stage comes from the last `==> stage:` marker the
# container printed, so a verdict names the ACTUAL failing sub-stage
# (npm ci / vitest / eslint / quasar build / go build / go test / golangci-lint /
# kit drift) and carries that stage's error lines. verdict_write skips `==> `
# lines when it harvests errors, so the markers never pollute the error block.
#
# Not a vendored factory file (see FACTORY_MANIFEST) — ci.yml is this repo's own.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=verdict-lib.sh
. "$here/verdict-lib.sh"

# Same repo-tag formula heal.sh uses (FORGEJO_API's trailing owner/repo, slashes
# to dashes), so reader and writer agree on the path without sharing state.
repo_slug="${REPO_SLUG:-${GITHUB_REPOSITORY:-Matou/matou-app}}"
repo_tag="${repo_slug//\//-}"
verdict_begin "${SEAM_VERDICT_PATH:-/tmp/matou-$repo_tag-seam-verdict.txt}"

log="$(mktemp "${TMPDIR:-/tmp}/matou-ci-checks.XXXXXX.log")"
finish() { local ec=$?; verdict_write "$ec"; rm -f "$log"; }
trap finish EXIT

# Run <stage> <cmd...> — stream to the console AND the verdict errlog, and on a
# non-zero exit stamp the stage (refined by the container's own marker, when the
# failure happened inside it) before letting `set -e` unwind.
run_stage() {
  local stage="$1"; shift
  verdict_stage "$stage" "$log"
  local rc=0
  # errexit off across the pipeline (pipefail is on, so `set -e` would unwind
  # before the stage can be stamped); `|| true` is NOT usable here — a simple
  # command after the pipeline resets PIPESTATUS.
  set +e
  "$@" 2>&1 | tee -a "$log"
  rc="${PIPESTATUS[0]}"
  set -e
  if [ "$rc" -ne 0 ]; then
    local inner; inner="$(sed -n 's/^==> stage: //p' "$log" | tail -1)"
    [ -n "$inner" ] && verdict_stage "$stage :: $inner" "$log"
    exit "$rc"
  fi
}

# AGENT_UID/GID MUST follow the host user (sandcastle build-image does the same):
# the image's "agent" defaults to 1000, and the bind-mounted workspace is owned by
# whichever uid the runner runs as — 1000 on matou-workstation, 1500 on
# elitebook-03. Without this, npm ci dies with EACCES on node_modules the moment
# the job lands on a pool host whose uid differs (dev-factory GOTCHAS 6).
# Host-capacity slot (#268): the image build and the checks are the heavy work —
# they starved the pr-e2e drive when they co-ran unlocked. Each rides ONE pooled
# slot via the bounded-camp wrapper (event-driven job: a yield would lose the
# run). Two acquisitions, not one held across both, so an exclusive drive can slip
# between.
run_stage "docker build (sandbox image)" \
  bash "$here/host-slot-wait.sh" 1800 \
  docker build --build-arg AGENT_UID="$(id -u)" --build-arg AGENT_GID="$(id -g)" \
    -t matou-app-ci -f "$here/Dockerfile" "$here"

# --entrypoint bash is required: the image's ENTRYPOINT is ["sleep", "infinity"]
# (for sandcastle's own bind-mount/exec workflows), and without an override
# `docker run` appends the trailing command to that entrypoint's argv instead of
# replacing it — so this would silently run `sleep infinity bash -lc ...` and hang
# until timeout-minutes kills the job.
# --init gives the container a signal-forwarding/zombie-reaping PID 1 (tini) so a
# runner SIGTERM on cancel actually stops the tree instead of being ignored by
# `bash -lc` (#331). --name/--label let a cancelled or outage-killed run be reaped
# by name (always() step in ci.yml) and by label (dev-factory#122 sweep) once
# --rm can no longer fire.
run_stage "frontend + backend checks" \
  bash "$here/host-slot-wait.sh" 1800 \
  docker run --rm --init --name "${CI_CONTAINER:-matou-app-ci-local}" \
    --label matou.factory=ci --label "matou.run=${CI_RUN_ID:-local}" \
    --entrypoint bash -v "$PWD":/work -w /work matou-app-ci -lc '
    set -euo pipefail
    cd frontend
    echo "==> stage: npm ci"; CI=true npm ci
    echo "==> stage: vitest (npm run test:script)"; npm run test:script
    echo "==> stage: eslint (npm run lint)"; npm run lint
    echo "==> stage: quasar build (npm run build)"; npm run build
    cd ../backend
    echo "==> stage: go build"; go build ./...
    echo "==> stage: go test (make test)"; make test
    cd ..
    echo "==> stage: go lint (golangci-lint --new-from-rev origin/main)"
    echo "==> Go lint (#346): same stages as the sandbox pre-push gate, findings since origin/main"
    git fetch -q --depth=1 origin main
    cd backend && golangci-lint run --new-from-rev origin/main ./... && cd ..
    echo "==> stage: kit drift (npm run kit:apply)"
    echo "==> kit drift check (#245): generated artefacts must match npm run kit:apply"
    cd frontend && npm run kit:apply && git diff --exit-code -- src/generated src/css/kit-tokens.scss kit.build.json src-capacitor/capacitor.config.json src-capacitor/android/app/src/main/res/values/strings.xml || {
      echo "ERROR: generated kit artefacts drifted — run npm run kit:apply and commit the result (icons are excluded: PNG output varies across sharp builds)" >&2
      exit 1
    }
  '
