#!/usr/bin/env bash
# prompt-render-lib.sh — the templating primitive behind `onboard.sh
# render-prompts` (#1) and check-harness-drift.sh's stale-render advisory.
#
# Placeholder convention in a skeleton (prompts/*.md):
#   {{REPO_SLUG}}, {{FORGEJO_HOST}}, {{RUNNER_HOST}} substitute inline,
#   anywhere in a line.
#   {{ENRICH:<slot>}} must sit ALONE on its own line; the whole line is
#   replaced by the verbatim content of <enrich-dir>/<slot>.md — a
#   consumer's own committed file, never itself re-templated.
#   {{HANDOFF_RULES}} must sit ALONE on its own line too, but is GENERATED,
#   not spliced (#14): prompt_render_handoff_rules turns the per-repo
#   policy's HUMAN_LABELS into the prompt's "when to hand off" section, one
#   bullet per label. Ben's ruling (2026-08-22): loop-in granularity lives
#   in the definition and use of the human labels, per repo — so the labels
#   are declared ONCE, in swarm-policy.sh, and the prose that routes a
#   blocked worker to them is derived from that declaration rather than
#   hand-maintained beside it (where it drifted, and where idss's numeric
#   label ids leaked into every consumer that copied the file).
#
# A rendered prompt is live text handed straight to a future worker, so this
# refuses rather than ships partial: a missing enrichment file, a policy that
# declares no hand-off label at all, or any `{{...}}` still standing after
# substitution, fails loud instead of printing broken instructions.
set -u

__prompt_render_lib_here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# policy-lib.sh owns the trigger vocabulary AND its one-sentence guidance;
# it is safe to source more than once (functions only, no side effects).
# shellcheck source=policy-lib.sh
. "$__prompt_render_lib_here/policy-lib.sh"

prompt_render_handoff_rules() { # prompt_render_handoff_rules <policy-file> -> the {{HANDOFF_RULES}} block on stdout
  # Runs in a subshell: policy_load SOURCES the consumer's policy file and
  # exports SWARM_POLICY_*, which must not leak into the renderer's caller.
  local policy_file="$1"
  (
    policy_load "$policy_file" || exit 1
    _policy_check_structure "$policy_file" || exit 1
    local pairs; pairs="$(policy_human_labels)"
    [ -n "$pairs" ] || {
      echo "prompt_render_handoff_rules: the policy at $policy_file declares no HUMAN_LABELS — a blocked worker would have nowhere to park a ticket" >&2
      exit 1; }
    cat <<'HEAD'
If you cannot complete a task, do NOT leave it in the ready queue — that
loops it back to the next iteration forever. Instead:

1. Comment on the issue: what blocks it, and what a human must do to
   re-arm it.
2. Swap its labels — remove `ready-for-agent` and add the ONE hand-off
   label below whose trigger matches why you stopped:

HEAD
    local name trigger guidance
    while IFS="$(printf '\t')" read -r name trigger; do
      [ -n "$name" ] || continue
      guidance="$(policy_trigger_guidance "$trigger")" || exit 1
      printf '   - `%s` — trigger **%s**.\n' "$name" "$trigger"
      printf '%s\n' "$guidance" | sed 's/^/     /'
    done <<PAIRS
$pairs
PAIRS
    cat <<'TAIL'

   A two-way-door call — revertible, and provable by something you can
   run — is yours to RULE under the Rules above, not to park here.

   Resolve every label id by NAME at run time; ids differ per repo, so
   never hardcode one:

       token="$(cat /run/secrets/forgejo_token)"
       labels="$(curl -sf -H "Authorization: token $token" "$FORGEJO_API/labels?limit=100")"
       label_id() { jq -r --arg n "$1" '.[] | select(.name == $n) | .id' <<<"$labels"; }
       curl -sf -X DELETE -H "Authorization: token $token" \
         "$FORGEJO_API/issues/<NUMBER>/labels/$(label_id ready-for-agent)"
       curl -sf -X POST -H "Authorization: token $token" \
         -H "Content-Type: application/json" \
         -d "$(jq -cn --argjson id "$(label_id <HAND-OFF-LABEL>)" '{labels:[$id]}')" \
         "$FORGEJO_API/issues/<NUMBER>/labels"

3. Release the claim so the audit trail stays clean — delete THIS run's
   claim comment (the one whose first line is
   `swarm-claim host=... run=$SWARM_RUN_ID`) and remove `agent-working`:

       cid="$(curl -sf -H "Authorization: token $token" "$FORGEJO_API/issues/<NUMBER>/comments" |
         jq -r --arg r "$SWARM_RUN_ID" '.[] | select(.body | startswith("swarm-claim ") and contains("run=" + $r)) | .id' | head -1)"
       [ -n "$cid" ] && curl -sf -X DELETE -H "Authorization: token $token" "$FORGEJO_API/issues/comments/$cid"
       curl -sf -X DELETE -H "Authorization: token $token" \
         "$FORGEJO_API/issues/<NUMBER>/labels/$(label_id agent-working)"

4. Move on to the next task (or finish the iteration).

A human re-arms the issue by resolving the blocker and re-adding
`ready-for-agent`. Never remove a hand-off label yourself.
TAIL
  )
}

prompt_render_one() { # prompt_render_one <skeleton-file> <enrich-dir> <repo-slug> <forgejo-host> <runner-host> [policy-file]
  local skel="$1" enrich_dir="$2" repo_slug="$3" forgejo_host="$4" runner_host="$5"
  # A consumer's swarm-policy.sh sits beside its prompt-enrichments/ dir, in
  # the same .sandcastle/ — absent is fine, policy_load then uses the defaults.
  local policy_file="${6:-$enrich_dir/../swarm-policy.sh}"
  local line slot f rendered handoff=""
  # Generated ONCE, before the read loop: policy_load sources the consumer's
  # policy file, which must not run with the skeleton on its stdin.
  if grep -q '^{{HANDOFF_RULES}}$' "$skel"; then
    handoff="$(prompt_render_handoff_rules "$policy_file")" || return 1
  fi
  rendered="$(
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        '{{HANDOFF_RULES}}')
          printf '%s\n' "$handoff" ;;
        '{{ENRICH:'*'}}')
          slot="${line#\{\{ENRICH:}"; slot="${slot%\}\}}"
          f="$enrich_dir/$slot.md"
          [ -f "$f" ] || { echo "prompt_render_one: $skel needs {{ENRICH:$slot}} but $f is missing" >&2; exit 1; }
          cat "$f" ;;
        *)
          line="${line//\{\{REPO_SLUG\}\}/$repo_slug}"
          line="${line//\{\{FORGEJO_HOST\}\}/$forgejo_host}"
          line="${line//\{\{RUNNER_HOST\}\}/$runner_host}"
          printf '%s\n' "$line" ;;
      esac
    done <"$skel"
  )" || return 1
  case "$rendered" in
    *'{{'*'}}'*)
      echo "prompt_render_one: $skel rendered with an unfilled placeholder — refusing:" >&2
      grep -n '{{[A-Za-z_:-]*}}' <<<"$rendered" | head -5 >&2
      return 1 ;;
  esac
  printf '%s\n' "$rendered"
}

prompt_render_identity() { # prompt_render_identity <sandcastle-dir> -> "repo_slug<TAB>forgejo_host<TAB>runner_host"; 1 on failure
  local target="$1" forgejo_host
  [ -f "$target/swarm-identity.sh" ] || { echo "prompt_render_identity: $target/swarm-identity.sh missing" >&2; return 1; }
  local out
  out="$(
    REPO_SLUG='' FORGEJO_API='' RUNNER_HOST=''
    . "$target/swarm-identity.sh"
    printf 'REPO_SLUG=%q\n' "$REPO_SLUG"
    printf 'FORGEJO_API=%q\n' "$FORGEJO_API"
    printf 'RUNNER_HOST=%q\n' "$RUNNER_HOST"
  )" || { echo "prompt_render_identity: $target/swarm-identity.sh failed to source" >&2; return 1; }
  eval "$out"
  # RUNNER_HOST has no cross-product default (CLAUDE.md: never default a
  # per-repo value to any product) — a consumer that never declared it
  # fails loud here instead of rendering a prompt naming the wrong host.
  [ -n "$RUNNER_HOST" ] || { echo "prompt_render_identity: $target/swarm-identity.sh must set RUNNER_HOST (the host session-runner.sh/heal.sh run on)" >&2; return 1; }
  forgejo_host="${FORGEJO_API#*://}"; forgejo_host="${forgejo_host%%/*}"
  printf '%s\t%s\t%s\n' "$REPO_SLUG" "$forgejo_host" "$RUNNER_HOST"
}
