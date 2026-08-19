#!/usr/bin/env bash
# close-report-lib.sh — deterministic claim gates for a swarm worker's
# close-report envelope (#444, learning L1). "Agent proposes, code disposes."
#
# A swarm worker used to close a ticket on its word; its verdict was audited only
# LATER (code-review / design-verify / human eyeballs). The swarm's false-green
# class — drive 15, the 185108Z GREEN-with-a-faulted-leg run, the all-skipped
# deploy masquerading as success, #435 green-and-empty — all trace to that one
# root. SSSF's answer, borrowed here: the worker emits a TYPED close-report
# envelope (JSON) and this library re-derives every claim it makes from the git
# history and the envelope itself. A claim that does not check out is a
# violation; any violation refuses the close.
#
# Pure + sourceable (the gate-lib.sh / verdict-lib.sh shape): no network, only
# `git -C <root>` reads and jq. close-report.sh wires it to the live issue
# (posts the envelope as a comment in every outcome, closes only on a clean
# gate); tests/close-report-lib-test.sh drives it offline over a throwaway repo;
# preflight-swarm.sh self-tests it on a canned bad envelope before every run.
#
# Envelope schema (minimum) — documented for workers in .sandcastle/prompt.md:
#   {
#     "issue":          <number>,
#     "status":         "success" | "blocked" | "refused",
#     "commits":        ["<sha>", ...],
#     "changed_files":  ["<path>", ...],
#     "tests":          [{"command": "<cmd>", "exit_code": <int>}, ...],
#     "criteria":       {"<criterion>": "<evidence>", ...},
#     "summary":        "<one sentence>",
#     "reason":         "<why>",        # REQUIRED non-empty when status != success
#     "blockers":       ["<item>", ...],# MUST be empty when status == success
#     "no_code_change": "<why>"         # permits success with zero commits
#   }
#
# The gates (all deterministic; a failure of ANY refuses the close):
#   1. every SHA in commits is a real commit reachable from main's pushed head
#   2. every path in changed_files appears in the union diff of those commits
#   3. status:success needs >=1 commit OR a non-empty no_code_change reason
#   4. status:success is refuted by any tests[] entry with a non-zero exit_code
#   5. verdict consistency: success with a non-empty blockers[] is refuted;
#      blocked/refused with no reason is refuted
#
# Fails CLOSED: malformed JSON, a missing required field, a git error, or a
# non-integer exit_code is itself a violation — never a silent pass.

CR_MAIN_HEAD_DEFAULT="origin/main"

# cr_violations <envelope-json> [root] [main-head]
#   Echo one human-readable violation line per failed gate; empty output means
#   the envelope's claims all verify. Returns 0 iff there are no violations.
#   root      — repo to check commits against (default: cwd)
#   main-head — the ref commits must be reachable from (default: $CR_MAIN_HEAD
#               or origin/main). Tests point this at a local branch.
cr_violations() {
  local json="$1" root="${2:-.}" head="${3:-${CR_MAIN_HEAD:-$CR_MAIN_HEAD_DEFAULT}}"
  local out=""
  _cr_add() { out="${out}${out:+$'\n'}$1"; }

  # --- gate 0: the envelope must be parseable at all ----------------------
  if ! jq -e . >/dev/null 2>&1 <<<"$json"; then
    printf 'envelope is not valid JSON\n'
    return 1
  fi

  # --- structural: required scalar fields ---------------------------------
  local status issue summary reason no_code_change
  status="$(jq -r '.status // "" | tostring' <<<"$json")"
  issue="$(jq -r '.issue // "" | tostring' <<<"$json")"
  summary="$(jq -r '.summary // "" | tostring' <<<"$json")"
  reason="$(jq -r '.reason // "" | tostring' <<<"$json")"
  no_code_change="$(jq -r '.no_code_change // "" | tostring' <<<"$json")"

  case "$status" in
    success|blocked|refused) : ;;
    "") _cr_add "status is missing (must be success|blocked|refused)" ;;
    *)  _cr_add "status \"$status\" is not one of success|blocked|refused" ;;
  esac
  [[ "$issue" =~ ^[0-9]+$ ]] || _cr_add "issue is missing or not a number"
  [ -n "$summary" ] || _cr_add "summary is empty (one sentence required)"

  # --- collect the commit + changed-file arrays ---------------------------
  local shas=() files=()
  if jq -e 'has("commits")' >/dev/null 2>&1 <<<"$json"; then
    if [ "$(jq -r '.commits | type' <<<"$json")" = "array" ]; then
      mapfile -t shas < <(jq -r '.commits[]? | tostring' <<<"$json")
    else
      _cr_add "commits must be an array of commit SHAs"
    fi
  fi
  if jq -e 'has("changed_files")' >/dev/null 2>&1 <<<"$json"; then
    if [ "$(jq -r '.changed_files | type' <<<"$json")" = "array" ]; then
      mapfile -t files < <(jq -r '.changed_files[]? | tostring' <<<"$json")
    else
      _cr_add "changed_files must be an array of paths"
    fi
  fi

  # --- gate 1: every claimed commit is real AND reachable from main -------
  local valid_shas=() sha headok=1
  if [ "${#shas[@]}" -gt 0 ]; then
    if ! git -C "$root" rev-parse -q --verify "${head}^{commit}" >/dev/null 2>&1; then
      headok=0
      _cr_add "cannot resolve main head '$head' — commits cannot be verified reachable (is the push landed?)"
    fi
    for sha in "${shas[@]}"; do
      [ -n "$sha" ] || continue
      if ! git -C "$root" rev-parse -q --verify "${sha}^{commit}" >/dev/null 2>&1; then
        _cr_add "commit $sha is not a valid commit object (fabricated, or never pushed)"
        continue
      fi
      if [ "$headok" = 1 ] && ! git -C "$root" merge-base --is-ancestor "$sha" "$head" 2>/dev/null; then
        _cr_add "commit $sha is not reachable from $head (not landed on main)"
        continue
      fi
      valid_shas+=("$sha")
    done
  fi

  # --- gate 2: every changed_file is in the union diff of those commits ----
  if [ "${#files[@]}" -gt 0 ]; then
    local union="" f
    if [ "${#valid_shas[@]}" -gt 0 ]; then
      union="$(for sha in "${valid_shas[@]}"; do
                 git -C "$root" show --name-only --pretty=format: "$sha" 2>/dev/null
               done | sed '/^[[:space:]]*$/d' | sort -u)"
    fi
    for f in "${files[@]}"; do
      [ -n "$f" ] || continue
      grep -qxF -- "$f" <<<"$union" ||
        _cr_add "changed_files: '$f' is not in the diff of the claimed commits"
    done
  fi

  # --- gate 3: success needs a commit OR a no-code-change reason -----------
  if [ "$status" = success ] && [ "${#shas[@]}" -eq 0 ] && [ -z "$no_code_change" ]; then
    _cr_add "status:success with no commits and no 'no_code_change' reason — a green with nothing to show (#435)"
  fi

  # --- gate 4: success is refuted by any non-zero test exit ----------------
  if jq -e 'has("tests")' >/dev/null 2>&1 <<<"$json"; then
    if [ "$(jq -r '.tests | type' <<<"$json")" != "array" ]; then
      _cr_add "tests must be an array of {command, exit_code}"
    else
      local n i cmd ec
      n="$(jq -r '.tests | length' <<<"$json")"
      for ((i = 0; i < n; i++)); do
        cmd="$(jq -r ".tests[$i].command // \"(unnamed)\" | tostring" <<<"$json")"
        ec="$(jq -r ".tests[$i].exit_code // \"\" | tostring" <<<"$json")"
        if ! [[ "$ec" =~ ^-?[0-9]+$ ]]; then
          _cr_add "tests: '$cmd' has a missing/non-integer exit_code"
        elif [ "$status" = success ] && [ "$ec" -ne 0 ]; then
          _cr_add "status:success but test '$cmd' exited $ec (a claimed-passing run that did not pass)"
        fi
      done
    fi
  fi

  # --- gate 5: verdict consistency ----------------------------------------
  local nblock
  nblock="$(jq -r '(.blockers // []) | if type=="array" then length else 1 end' <<<"$json")"
  if [ "$status" = success ] && [ "$nblock" -gt 0 ]; then
    _cr_add "status:success but blockers[] is non-empty — a success cannot carry unresolved blocking items"
  fi
  if { [ "$status" = refused ] || [ "$status" = blocked ]; } && [ -z "$reason" ]; then
    _cr_add "status:$status with no 'reason' — a refusal/blocked MUST name why (label refusals loud)"
  fi

  if [ -n "$out" ]; then
    printf '%s\n' "$out"
    return 1
  fi
  return 0
}
