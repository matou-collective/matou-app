#!/usr/bin/env bash
# Offline text assertions for the push-mode Landing section (#193). Before #193
# the in-sandbox worker pushed `main` itself and carried a rebase-conflict
# RE-TEST ladder (#217, the sandbox half of #207). #193 moves the push-mode
# landing OFF the sandbox entirely: the worker pushes only its per-run worker
# branch and the HOST promotes it to `main` after the post-run verify gates, so
# the worker NEVER rebases `main` and never resolves a `main` conflict in the
# sandbox — the host owns that rebase-rescue ladder (#207). The invariant is
# unchanged (a conflict the worker touched never reaches `main` unverified); what
# changed is WHO owns it, so this test now asserts the sandbox carries NO
# main-push / no in-sandbox rebase, and that the prose names the host as the
# lander.
#
# Like judgement-call-prompts-test.sh, this asserts against the LIVE rendered
# worker prompt (.sandcastle/prompt.md), not the skeleton. The push instruction
# lives in the harness {{LANDING_RULES}} slot (policy-lib.sh's
# policy_landing_guidance, #220), rendered for every repo — push- and pr-default
# alike, byte-identical — so this test anchors on the Landing section's
# `"landing": "push"` branch. Vendored, it stays red in any repo whose pin
# predates #193 until that repo re-renders.
# No network, no claude call — pure grep over the rendered prompt text.
# Run: bash .sandcastle/tests/worker-conflict-retest-prompt-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$here/.."

# Rendered prompts sit under .sandcastle/ in the factory root, or in $root
# itself when this test is vendored into a consumer (tests/ IS .sandcastle/
# tests/ there) — the same detection judgement-call-prompts-test.sh uses (#23).
if [ -f "$root/.sandcastle/prompt.md" ]; then
  rendered_dir="$root/.sandcastle"
else
  rendered_dir="$root"
fi
prompt_md="$rendered_dir/prompt.md"

fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0
ok() { pass=$((pass+1)); }

# A pin that predates the render pipeline (#1) has no rendered prompt.md yet —
# say so rather than reporting coverage that did not run.
if [ ! -f "$prompt_md" ]; then
  echo "worker-conflict-retest-prompt-test: SKIP — no $prompt_md (pin predates the render pipeline)" >&2
  echo "worker-conflict-retest-prompt-test: 0 checks passed"
  exit 0
fi

# The push-landing block (the Landing section's `"landing": "push"` branch) —
# from that subsection header to the `pr` one.
push="$(sed -n '/^### .*landing.*push/,/^### .*landing.*pr/p' "$prompt_md")"
[ -n "$push" ] || fail "prompt.md has no \`\"landing\": \"push\"\` branch to assert on (#220: it carries the push instruction)"
push_flat="$(tr '\n' ' ' <<<"$push")"   # phrases below wrap across source lines

# (1) The worker must be told explicitly NOT to push to main from the sandbox —
#     the core of #193 (the host lands after verify, never the worker before it).
grep -qiE 'do \*{0,2}NOT\*{0,2} push to .?main' <<<"$push_flat" \
  || fail "the Push step must tell the worker NOT to push to \`main\` from the sandbox (#193)"; ok

# (2) The worker pushes its per-run worker branch, NOT main — the literal command
#     targets the current branch, never refs/heads/main.
grep -qF 'HEAD:refs/heads/$(git rev-parse --abbrev-ref HEAD)' <<<"$push" \
  || fail "the Push step must push HEAD to the per-run worker branch, not main (#193)"; ok
! grep -qF 'push origin HEAD:refs/heads/main' <<<"$push" \
  || fail "the Push step must NOT carry a direct \`git push origin HEAD:refs/heads/main\` (#193)"; ok

# (3) It must name the HOST as what lands the branch on main after verify.
grep -qiE 'host' <<<"$push_flat" \
  && grep -qiE 'after .*verify|verify gate|post-run gate' <<<"$push_flat" \
  || fail "the Push step must say the HOST lands the worker branch on \`main\` after the verify gates (#193)"; ok

# (4) The rebase-rescue ladder is the HOST's, not the sandbox's: the worker must
#     be told it does NOT rebase main / resolve a main conflict in the sandbox.
grep -qiE 'do NOT rebase .?main' <<<"$push_flat" \
  || fail "the Push step must say the worker does NOT rebase \`main\` in the sandbox — the host owns the rebase-rescue ladder (#193/#207)"; ok

# (5) It must still state the invariant (nothing the worker touched reaches main
#     unverified) — now carried by the host.
grep -qiE 'unverified' <<<"$push_flat" \
  || fail "the Push step must state the #207 invariant: nothing reaches \`main\` unverified (now the host's guarantee, #193)"; ok

# (6) A worker-branch push that cannot land routes to the blocked path, not main.
grep -qi 'blocked path' <<<"$push_flat" \
  || fail "the Push step must route an unlandable worker-branch push to the blocked path, never main (#193)"; ok

echo "worker-conflict-retest-prompt-test: $pass checks passed"
