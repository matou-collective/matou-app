#!/usr/bin/env bash
# Drift alarm for the vendored factory core (ADR 0180 / #571: the factory
# moved out of this repo into Matou/dev-factory; this repo now PULLS from it
# at a pinned ref instead of idss pushing sed-transformed copies into
# siblings). "Drift" used to mean "a far-side copy was hand-edited instead of
# re-synced"; it now means the same thing from the other direction — a
# vendored file here no longer matches FACTORY_REF's content, byte for byte,
# no rendering (the old sed transform's "slug as value" vs "slug as
# canonical-repo reference" ambiguity — the #571 bug where 2 of 13 synced
# files arrived ownership-inverted, one of them this very file — cannot
# recur: there is no transform).
#
# FACTORY_REPO is the SAME upstream for every consumer (unlike FORGEJO_API,
# this is not a per-repo value the ownership-inversion bug class applies to —
# every product repo vendors from the one factory repo), so it is a plain
# default here, not sourced from swarm-identity.sh.
#
# Inputs (both under .sandcastle/, both committed):
#   FACTORY_REF       one line, the pinned Matou/dev-factory commit SHA.
#   FACTORY_MANIFEST  one vendored path per line (relative to .sandcastle/),
#                     `#`-comments and blank lines ignored.
#
# No FACTORY_REF -> this repo has never vendored the factory core; nothing to
# enforce, green (mirrors the old marker's absence-is-fine rule).
#
# Exit 0 in sync (or not applicable); 1 on drift; 3 when the factory could
# not be reached (a TRANSPORT fault — drift was never read; see the fetch
# retry posture below).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"       # .sandcastle
ref_file="$here/FACTORY_REF"
manifest="$here/FACTORY_MANIFEST"
: "${FACTORY_REPO:=https://git.matou.nz/Matou/dev-factory.git}"

# Scrub git's leaked hook environment (#129 / matou-app#232,#233). When this
# script is reached from git-hooks/pre-push (gate 1, the #932 drift gate) it
# runs inside git's own hook environment, where GIT_DIR is exported — and in a
# sandbox worker it points at the host's linked-worktree admin dir. Left set,
# `git init "$work"` IGNORES "$work" and re-initialises GIT_DIR's repository
# (writing core.bare=true into the consumer's shared .git, breaking every later
# checkout), and every `git -C "$work"` here targets GIT_DIR's repo instead of
# the temp checkout. This script only ever operates on the throwaway "$work"
# repo, never the real one, so scrubbing the whole leaked env once up front is
# both safe and complete. Prefer gate-lib.sh's canonical gate_scrub_git_env()
# when the vendored sibling is present; fall back to an inline unset otherwise.
if [ -f "$here/gate-lib.sh" ]; then
  # shellcheck source=gate-lib.sh
  . "$here/gate-lib.sh" && gate_scrub_git_env
else
  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_PREFIX \
        GIT_OBJECT_DIRECTORY GIT_QUARANTINE_PATH GIT_INTERNAL_GITDIR 2>/dev/null || true
fi

if [ ! -f "$ref_file" ]; then
  echo "check-harness-drift: no $ref_file — this repo does not vendor the factory core; nothing to enforce."
  exit 0
fi
[ -f "$manifest" ] || { echo "check-harness-drift: $ref_file exists but $manifest is missing." >&2; exit 1; }

factory_ref="$(tr -d '[:space:]' <"$ref_file")"
[ -n "$factory_ref" ] || { echo "check-harness-drift: $ref_file is empty." >&2; exit 1; }

# Fetch the pinned revision into a throwaway checkout — never a working tree
# we share. Shallow fetch of the exact SHA; fall back to a full clone for
# servers that refuse by-SHA fetch.
work="$(mktemp -d "${TMPDIR:-/tmp}/factory-drift.XXXXXX")"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT

# Transport posture (#1394 / GOTCHAS #217 — the git-transport half of #1359's
# rule that "a probe that cannot reach the server has not obtained a verdict").
# This fetch is the drift check's ONE live network call. A transient Forgejo
# 5xx on it used to red the whole seam at stage one with a bare `exit 128` that
# read as a harness/drift fault and burned a healer investigation on a fault
# that was never in this repo (ci run 21982, 2026-09-11). Retry with
# exponential backoff (each attempt bounded by git's own transport), matching
# forgejo-lib.sh's #20 probe (#52/#1359): a momentary blip is ridden out. A
# SUSTAINED outage still exhausts the attempts and reds — the factory was
# unreachable, so drift was NEVER read, and a guard that could not reach the
# code it guards must never be mistaken for a clean result (GOTCHAS #30) — but
# it exits DISTINCTLY (code 3), NAMING TRANSPORT, never a bare exit 128 and
# never a false "DRIFT".
FACTORY_FETCH_RETRIES="${FACTORY_FETCH_RETRIES:-3}"
FACTORY_FETCH_BACKOFF="${FACTORY_FETCH_BACKOFF:-2}"
EX_TRANSPORT=3

fetch_factory() { # fill a fresh "$work" from FACTORY_REPO@factory_ref; rc 0 on success
  rm -rf "$work"; work="$(mktemp -d "${TMPDIR:-/tmp}/factory-drift.XXXXXX")"
  if (
    git init -q "$work" &&
    git -C "$work" remote add origin "$FACTORY_REPO" &&
    git -C "$work" fetch -q --depth 1 origin "$factory_ref" &&
    git -C "$work" checkout -q FETCH_HEAD
  ) 2>/dev/null; then
    return 0
  fi
  # Some servers refuse by-SHA fetch; a full clone is the fallback.
  rm -rf "$work"; work="$(mktemp -d "${TMPDIR:-/tmp}/factory-drift.XXXXXX")"
  ( git clone -q "$FACTORY_REPO" "$work" && git -C "$work" checkout -q "$factory_ref" ) 2>/dev/null
}

attempt=1; delay="$FACTORY_FETCH_BACKOFF"
until fetch_factory; do
  if [ "$attempt" -ge "$FACTORY_FETCH_RETRIES" ]; then
    echo "check-harness-drift: TRANSPORT — could not reach $FACTORY_REPO after $attempt attempt(s) to fetch $factory_ref; the factory was unreachable, so drift was NOT read here (a transport fault: not a hand-edited vendored file, and not a harness fault)." >&2
    exit "$EX_TRANSPORT"
  fi
  sleep "$delay"
  delay=$((delay * 2))
  attempt=$((attempt + 1))
done

drift=0
while IFS= read -r name; do
  case "$name" in ''|'#'*) continue ;; esac
  src="$work/$name"
  local_copy="$here/$name"
  if [ ! -f "$src" ]; then
    echo "check-harness-drift: FACTORY_MANIFEST lists $name but $FACTORY_REPO@$factory_ref has no such file." >&2
    drift=1; continue
  fi
  if [ ! -f "$local_copy" ]; then
    echo "DRIFT: $name is missing here but is a vendored factory file (pinned: $factory_ref). Re-vendor it; do not hand-add it." >&2
    drift=1; continue
  fi
  if ! diff -u "$src" "$local_copy" >/dev/null; then
    echo "DRIFT: .sandcastle/$name was edited directly here — it is owned by $FACTORY_REPO (pinned rev $factory_ref)." >&2
    echo "       Vendored factory files are canonical in $FACTORY_REPO: land the fix THERE, bump FACTORY_REF, and re-vendor," >&2
    echo "       or remove $name from FACTORY_MANIFEST if it must diverge here. Diff (pinned factory -> local):" >&2
    diff -u "$src" "$local_copy" | sed 's/^/       /' >&2 || true
    drift=1
  fi
done <"$manifest"

if [ "$drift" -ne 0 ]; then
  echo "check-harness-drift: FAILED — vendored factory copies drifted from $FACTORY_REPO@$factory_ref." >&2
  exit 1
fi

echo "check-harness-drift: OK — every vendored factory file matches $FACTORY_REPO@$factory_ref."

# Identity-layer advisory (#31, never fails the check): swarm-identity.sh is
# NOT vendored (the consumer owns it), so a pin can start REQUIRING a newer
# identity contract than this repo ever regenerated — the #19 seam that killed
# every session-runner tick silently. Compare the pinned harness's required
# contract (identity-lib.sh IDENTITY_CONTRACT) with our own stamp and WARN so a
# behind identity layer is visible without failing a drift-clean run.
need_contract=""; have_contract=0
[ -f "$work/identity-lib.sh" ] && need_contract="$(sed -n 's/^IDENTITY_CONTRACT=\([0-9][0-9]*\).*/\1/p' "$work/identity-lib.sh" | head -1)"
[ -f "$here/swarm-identity.sh" ] && have_contract="$(sed -n 's/^SWARM_IDENTITY_CONTRACT=\([0-9][0-9]*\).*/\1/p' "$here/swarm-identity.sh" | head -1)"
: "${have_contract:=0}"
if [ -n "$need_contract" ] && [ "$have_contract" -lt "$need_contract" ] 2>/dev/null; then
  echo "check-harness-drift: WARNING: identity layer behind — this pin needs identity contract $need_contract, swarm-identity.sh is $have_contract. Run: onboard.sh identity <owner/repo> .sandcastle/swarm-identity.sh"
fi

# Advisory only (never fails the check): how far behind dev-factory's main
# tip the pin is, so a stale-but-intentional pin stays visible without
# forcing an upgrade — "drift" is a mismatch, not simply "not on the latest
# tag" (ADR 0180: "a product repo upgrades by bumping the ref"). Best-effort
# extra fetch (the primary fetch above is shallow-by-SHA and may not carry
# main); silently skipped if unreachable — this is a bonus note, not a check.
git -C "$work" fetch -q origin main:refs/remotes/origin/main 2>/dev/null || true
if behind="$(git -C "$work" rev-list --count "$factory_ref"..origin/main 2>/dev/null)" && [ "${behind:-0}" -gt 0 ] 2>/dev/null; then
  echo "check-harness-drift: NOTE — FACTORY_REF is $behind commit(s) behind $FACTORY_REPO main. Bump it when convenient (not a failure)."
fi

# Stale-rendered-prompt advisory (#1, never fails the check): the five
# .sandcastle/*.md prompts are consumer-committed, not vendored — re-running
# render-prompts is how a skeleton or enrichment fix propagates into them.
# vendored prompts/*.md is drift-checked above like any other manifest entry,
# so if we get here it already matches the pin; only the RENDER OUTPUT can
# have gone stale (an enrichment file edited without re-rendering, or a
# skeleton bump not yet re-rendered). Best-effort: any failure here (identity
# missing RUNNER_HOST, an enrichment file absent) just skips the advisory.
if [ -d "$here/prompts" ] && [ -f "$here/prompt-render-lib.sh" ]; then
  . "$here/prompt-render-lib.sh"
  if p_ident="$(prompt_render_identity "$here" 2>/dev/null)"; then
    IFS=$'\t' read -r p_repo_slug p_forgejo_host p_runner_host <<<"$p_ident"
    stale=""
    for pf in "$here"/prompts/*.md; do
      [ -e "$pf" ] || continue
      pbase="$(basename "$pf")"
      [ -f "$here/$pbase" ] || continue
      if p_rendered="$(prompt_render_one "$pf" "$here/prompt-enrichments" "$p_repo_slug" "$p_forgejo_host" "$p_runner_host" 2>/dev/null)"; then
        printf '%s\n' "$p_rendered" | cmp -s - "$here/$pbase" || stale="$stale $pbase"
      fi
    done
    if [ -n "$stale" ]; then
      echo "check-harness-drift: NOTE — rendered prompt(s) stale against the pinned skeleton:$stale. Re-run: onboard.sh render-prompts .sandcastle"
    fi
  fi
fi

# Standby-token wiring advisory (#85 / GOTCHAS 30, never fails the check): a
# repo's WORKFLOWS are its own per-repo layer, so nothing vendored can be
# byte-compared against them — yet a park-capable step there without
# CLAUDE_CODE_OAUTH_TOKEN_B parks the whole HOST for the window, every repo on
# it. Same family as the identity-contract advisory above: a per-repo file that
# has fallen behind what the pinned harness needs. Reported HERE because this is
# what runs at install and at every `onboard.sh vendor` pin bump, so a human
# sees it at the moment they adopt the pin — before preflight-swarm.sh's guard
# (which owns the same property, from park-wiring-lib.sh) starts refusing runs.
if [ -f "$here/park-wiring-lib.sh" ]; then
  # shellcheck source=park-wiring-lib.sh
  . "$here/park-wiring-lib.sh"
  repo_root="$(cd "$here/.." && pwd)"
  park_rc=0
  park_out="$(park_wiring_scan "$repo_root/.forgejo/workflows" "$repo_root/.github/workflows")" || park_rc=$?
  case "$park_rc" in
    1)
      echo "check-harness-drift: WARNING: park-capable workflow step(s) carry no \$$PARK_WIRING_TOKEN — a usage-limit refusal there parks EVERY repo on that host for the window:"
      printf '%s\n' "$park_out" | sed "s|^$repo_root/|       |"
      echo "       $(park_wiring_remedy)"
      ;;
    2)
      # Say it. A guard that could not reach the code it guards must never be
      # mistaken for a clean result — that silence is the whole hazard.
      echo "check-harness-drift: NOTE — no workflow files found under $repo_root; the standby-token wiring check had nothing to read."
      ;;
  esac
fi
