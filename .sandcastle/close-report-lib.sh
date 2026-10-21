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
#     "binds":          [{"symbol":"<name>", "defined_in":"<non-test path>"|"owed_by":<open issue>}, ...],
#     "mirror_waiver":  "<reason>",     # waives a mirrors.tsv violation (surfaced in the comment)
#     "summary":        "<one sentence>",
#     "reason":         "<why>",        # REQUIRED non-empty when status != success
#     "blockers":       ["<item>", ...],# MUST be empty when status == success
#     "no_code_change": "<why>"         # permits success with zero commits
#   }
#
# The gates (all deterministic; a failure of ANY refuses the close):
#   1. every SHA in commits is a real commit reachable from the landing head —
#      main's pushed head in push mode, the issue's open PR head in pr mode
#      (#13, LANDING=pr): the caller passes the head, the gate is mode-agnostic.
#      When the run's START sha is known (run-swarm drops it in the host-signals
#      dir, close-report.sh exports CR_START_SHA) the commit must also be NEW
#      since that start — within start..head, not a pre-existing/foreign SHA —
#      and cite #<issue> in its subject (#206). Both are additive: with no
#      CR_START_SHA gate 1 stays at today's reachability-only behaviour
#   2. changed_files is EXACTLY the union diff of those commits — both ways
#      (#206): a claimed file absent from the diff is a fabrication; a diff file
#      absent from changed_files is an under-claim (the old one-directional gate)
#   3. status:success needs >=1 commit OR a non-empty no_code_change reason
#   4. status:success is refuted by any tests[] entry with a non-zero exit_code;
#      AND (#206) by a host re-run of the pinned test command that disagrees —
#      close-report.sh re-executes TEST_CMD host-side and passes its exit code in
#      CR_TEST_HOST_EC, so a self-reported pass the host cannot reproduce refuses
#   5. verdict consistency: success with a non-empty blockers[] is refuted;
#      blocked/refused with no reason is refuted
#  5b. criteria presence (#206): on a status:success close, the issue body
#      (CR_ISSUE_BODY, exported by close-report.sh) must carry no more acceptance
#      clauses than the envelope's `criteria` has entries — every acceptance
#      clause needs an evidence entry (PRESENCE, not truth)
#   6. binds: every declared symbol is either DEFINED under a non-test path in
#      the union diff (`defined_in` in changed_files), or OWED by a still-open
#      issue (`owed_by`) — #1934 declared two verbs the state machine consumed
#      and nothing implemented; this refuses that envelope while leaving the
#      legitimate interface-first slice legal (it must name who owes the impl)
#   7. mirrors: a changed_files entry matching a trigger in .sandcastle/mirrors.tsv
#      must ship its mirror in the same close (#1933 moved appdoor.go but not the
#      golden matou-app copies) — waivable ONLY by a non-empty `mirror_waiver`,
#      which then sits in the posted comment for a human to read
#   8. required-suites: on a status:success close, a changed_files entry matching
#      an area in .sandcastle/required-suites.tsv demands that at least one tests[]
#      command ran that area's suite — gate 4 only refutes a LISTED failing test,
#      so an agent that simply OMITS the required suite from tests[] passes gate 4
#      clean (#1934/#1933's root: the agent chooses its own evidence). This is a
#      repo-level `area-glob<TAB>suite-token[|alt…]` registry (the sibling of
#      gate 7's mirrors.tsv); a green whose changed area's suite is absent from
#      tests[] is refused, naming the area and the suite it never ran
#   9. cross-repo mirrors: a changed_files entry matching a trigger in
#      .sandcastle/cross-repo-mirrors.tsv must be accompanied by a `cross_repo`
#      entry naming an OPEN issue in the foreign repo that owes the copy. Gate 7
#      cannot reach this case: its pairing is within one repo by construction,
#      so a golden whose only mirror lives in matou-app moves alone and closes
#      green (#1959 → matou-app#678). This cannot demand the foreign file change
#      here; it demands that someone is written down as owing it and still
#      exists — gate 6's `owed_by` shape, across the repo split. Waivable ONLY
#      by a non-empty `cross_repo_waiver`, which then sits in the posted comment
#
# Fails CLOSED: malformed JSON, a missing required field, a git error, a
# non-integer exit_code, a non-list binds or cross_repo, an unverifiable foreign
# issue, or a malformed registry line (in ANY of the three registries) is itself
# a violation — never a silent pass.
# (`unproven_by_seam` is prose the manifest/prompt carry for triage +
# design-verify; it is NOT gated here.)

CR_MAIN_HEAD_DEFAULT="origin/main"

# _cr_is_test_path <path> — rc 0 if the path looks like test-only code. Gate 6
# refuses a symbol "defined" only in a test path: a verb proven solely by its
# own test is exactly #1934's hole.
_cr_is_test_path() {
  case "$1" in
    */test/*|test/*|*/tests/*|tests/*|*/testdata/*|testdata/*|*/__tests__/*|__tests__/*) return 0 ;;
    *_test.go|*_test.py|*_test.sh|*-test.sh|*.test.*|*.spec.*) return 0 ;;
  esac
  return 1
}

# _cr_acceptance_clauses <issue-body> — echo one line per list item under a
# heading whose text matches /accept/i, up to the next heading of any level.
# Both checkbox (`- [ ]`) and plain (`-`/`*`) bullets count. Gate 5b counts
# these; a nested sub-heading ends the section (under-counting is the safe
# direction — it never demands MORE criteria than the agent could be expected
# to write).
_cr_acceptance_clauses() {
  awk '
    /^[[:space:]]*#+[[:space:]]/ { inacc = (tolower($0) ~ /accept/) ? 1 : 0; next }
    inacc && /^[[:space:]]*[-*][[:space:]]/ { print }
  ' <<<"${1:-}"
}

# cr_issue_state <issue-number> — echo open|closed|missing. The gate-6 `owed_by`
# check needs the tracker, but this library is pure/offline; so the state comes
# through a seam. Tests set CR_ISSUE_STATE_CMD to a stub; production leaves it
# unset and this queries Forgejo via forgejo_get (sourced by close-report.sh).
# When neither is available it echoes `missing` — an owed_by that cannot be
# verified open FAILS CLOSED. A caller may override by pre-defining the function.
if ! declare -F cr_issue_state >/dev/null 2>&1; then
  cr_issue_state() {
    local n="$1" body
    if [ -n "${CR_ISSUE_STATE_CMD:-}" ]; then
      "$CR_ISSUE_STATE_CMD" "$n" 2>/dev/null || echo missing
      return 0
    fi
    if declare -F forgejo_get >/dev/null 2>&1 && [ -n "${FORGEJO_API:-}" ]; then
      body="$(forgejo_get "/issues/$n" 2>/dev/null || true)"
      case "$(jq -r '.state // "missing"' <<<"$body" 2>/dev/null)" in
        open)   echo open ;;
        closed) echo closed ;;
        *)      echo missing ;;
      esac
      return 0
    fi
    echo missing
  }
fi

# cr_foreign_issue_state <owner/repo> <issue-number> — echo open|closed|missing.
# Gate 9's sibling of cr_issue_state, for an issue in ANOTHER repo. Same seam
# discipline: tests set CR_FOREIGN_ISSUE_STATE_CMD to a stub; production derives
# the tracker's repo base from FORGEJO_API (…/api/v1/repos/<owner>/<repo>, so the
# last two segments come off) and queries the foreign repo directly. Anything it
# cannot verify OPEN echoes `missing`, and gate 9 fails closed on that.
if ! declare -F cr_foreign_issue_state >/dev/null 2>&1; then
  cr_foreign_issue_state() {
    local slug="$1" n="$2" body base
    if [ -n "${CR_FOREIGN_ISSUE_STATE_CMD:-}" ]; then
      "$CR_FOREIGN_ISSUE_STATE_CMD" "$slug" "$n" 2>/dev/null || echo missing
      return 0
    fi
    if declare -F _forgejo_get >/dev/null 2>&1 && [ -n "${FORGEJO_API:-}" ]; then
      base="${FORGEJO_API%/*/*}"
      body="$(_forgejo_get "$base/$slug/issues/$n" 2>/dev/null || true)"
      case "$(jq -r '.state // "missing"' <<<"$body" 2>/dev/null)" in
        open)   echo open ;;
        closed) echo closed ;;
        *)      echo missing ;;
      esac
      return 0
    fi
    echo missing
  }
fi

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

  # --- gate 1: every claimed commit is real, reachable from the landing head,
  # NEW since the run's start, and cites #<issue> in its subject --------------
  # The reachability half is unconditional (did the commit land where the ticket
  # lands?). The membership + subject half runs only when CR_START_SHA resolves:
  # run-swarm drops the run's start sha in the host-signals dir and close-report
  # exports it. Additive — an old pin, or any context without the signal, leaves
  # CR_START_SHA empty and gate 1 is byte-identical to before (#206).
  local valid_shas=() sha headok=1 start="${CR_START_SHA:-}" startok=0
  if [ -n "$start" ] && git -C "$root" rev-parse -q --verify "${start}^{commit}" >/dev/null 2>&1; then
    startok=1
  fi
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
        # $head is main in push mode, the issue's open PR head in pr mode (#13):
        # gate 1 asks "did this commit actually land where the ticket lands?"
        # #244: name the head compared against AND when it was fetched, so a
        # false "not landed" refusal is diagnosable from the message alone (the
        # #237 stall was a stale, un-refetched origin/main).
        _cr_add "commit $sha is not reachable from $head (not landed)${CR_HEAD_FETCHED_AT:+ — compared against the live main head fetched at $CR_HEAD_FETCHED_AT}"
        continue
      fi
      if [ "$startok" = 1 ] && git -C "$root" merge-base --is-ancestor "$sha" "$start" 2>/dev/null; then
        # reachable from the run's START = already on main before this run began:
        # a pre-existing / foreign SHA, not work this run authored (#206). Drop it
        # from valid_shas so its old diff never counts toward gate 2 either.
        _cr_add "commit $sha predates the run start $start — it is not new work this run authored (gate 1 membership: a commit must be within start..$head)"
        continue
      fi
      if [ "$startok" = 1 ] && [[ "$issue" =~ ^[0-9]+$ ]]; then
        local subj
        subj="$(git -C "$root" show -s --format=%s "$sha" 2>/dev/null)"
        case "$subj" in
          *"#$issue"*) : ;;
          *) _cr_add "commit $sha subject does not cite #$issue — every commit must name its ticket (gate 1, #206): $subj" ;;
        esac
      fi
      valid_shas+=("$sha")
    done
  fi

  # --- union diff of the claimed commits (shared by gates 2 and 6) ---------
  local union="" f
  if [ "${#valid_shas[@]}" -gt 0 ]; then
    union="$(for sha in "${valid_shas[@]}"; do
               git -C "$root" show --name-only --pretty=format: "$sha" 2>/dev/null
             done | sed '/^[[:space:]]*$/d' | sort -u)"
  fi

  # --- gate 2: changed_files is EXACTLY the union diff of those commits ------
  # Both directions (#206). A claimed file absent from the diff is a fabrication
  # (the original check). A diff file absent from changed_files is an UNDER-claim
  # — a worker that touched a file it never listed, which the one-directional
  # gate let through; so report every unlisted touched file too.
  if [ "${#files[@]}" -gt 0 ]; then
    for f in "${files[@]}"; do
      [ -n "$f" ] || continue
      grep -qxF -- "$f" <<<"$union" ||
        _cr_add "changed_files: '$f' is not in the diff of the claimed commits"
    done
  fi
  if [ -n "$union" ]; then
    local uf
    while IFS= read -r uf; do
      [ -n "$uf" ] || continue
      if [ "${#files[@]}" -eq 0 ] || ! printf '%s\n' "${files[@]}" | grep -qxF -- "$uf"; then
        _cr_add "changed_files: the claimed commits touch '$uf', which changed_files does not list — claim every file you changed (#206)"
      fi
    done <<<"$union"
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

  # --- gate 4b: a host re-run of the pinned test command refutes a claimed pass -
  # Gate 4 trusts the envelope's OWN exit codes; #206's root is the Oct 2026
  # r/ClaudeCode "QA agent approved everything even when tests didn't run".
  # close-report.sh re-executes the repo's pinned TEST_CMD host-side and passes
  # its exit code in CR_TEST_HOST_EC; a status:success the host could not
  # reproduce is refused. Additive: no CR_TEST_HOST_EC (TEST_CMD unset, or a
  # context that never re-ran) → no-op.
  if [ "$status" = success ] && [ -n "${CR_TEST_HOST_EC:-}" ]; then
    if ! [[ "$CR_TEST_HOST_EC" =~ ^-?[0-9]+$ ]]; then
      _cr_add "CR_TEST_HOST_EC '$CR_TEST_HOST_EC' is not an integer (the host re-run result is unusable — fails closed)"
    elif [ "$CR_TEST_HOST_EC" -ne 0 ]; then
      _cr_add "status:success but the host re-run of the pinned test command exited $CR_TEST_HOST_EC — a self-reported pass the host could not reproduce (gate 4, #206)"
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

  # --- gate 5b: every acceptance clause in the issue body has a criteria entry -
  # #206: the gates never read `criteria`. close-report.sh exports the issue body
  # as CR_ISSUE_BODY; on a status:success close, the envelope's `criteria` object
  # must carry at least one entry per acceptance clause in the body — PRESENCE,
  # not truth (the gate cannot judge evidence, only that the agent wrote some per
  # clause). Additive: no CR_ISSUE_BODY, or a body with no acceptance list → no-op.
  if [ "$status" = success ] && [ -n "${CR_ISSUE_BODY:-}" ]; then
    local nclauses ncrit
    nclauses="$(_cr_acceptance_clauses "$CR_ISSUE_BODY" | grep -c . || true)"
    if [ "${nclauses:-0}" -gt 0 ]; then
      ncrit="$(jq -r '(.criteria // {}) | if type=="object" then (keys|length) else -1 end' <<<"$json" 2>/dev/null)"
      if [ "${ncrit:-0}" -lt 0 ]; then
        _cr_add "criteria must be an object of {clause: evidence} (fails closed, #206)"
      elif [ "$ncrit" -lt "$nclauses" ]; then
        _cr_add "criteria has $ncrit entr$([ "$ncrit" = 1 ] && echo y || echo ies), but the issue body lists $nclauses acceptance clause(s) — every acceptance clause needs a criteria entry (presence, not truth, #206)"
      fi
    fi
  fi

  # --- gate 6: binds — a declared symbol is implemented OR explicitly owed ---
  # #1934 declared mintSealingKey()/unlockFromSealedBox() on the steward-bundle
  # interface, built the whole panel state machine against them, and implemented
  # NEITHER — the phone unlock would have found both verbs undefined in a real
  # browser. Per entry: the union diff must DEFINE the symbol under a non-test
  # path (`defined_in` present in changed_files), or `owed_by` must name a
  # still-OPEN issue. Neither is a violation. The legitimate interface-first
  # slice stays legal — it just has to write down WHO owes the implementation.
  if jq -e 'has("binds")' >/dev/null 2>&1 <<<"$json"; then
    if [ "$(jq -r '.binds | type' <<<"$json")" != "array" ]; then
      _cr_add "binds must be an array of {symbol, defined_in|owed_by} (fails closed)"
    else
      local bn bi sym def owed est
      bn="$(jq -r '.binds | length' <<<"$json")"
      for ((bi = 0; bi < bn; bi++)); do
        if [ "$(jq -r ".binds[$bi] | type" <<<"$json")" != "object" ]; then
          _cr_add "binds[$bi] is not an object {symbol, defined_in|owed_by} (fails closed)"
          continue
        fi
        sym="$(jq -r ".binds[$bi].symbol // \"\" | tostring" <<<"$json")"
        def="$(jq -r ".binds[$bi].defined_in // \"\" | tostring" <<<"$json")"
        owed="$(jq -r ".binds[$bi].owed_by // \"\" | tostring" <<<"$json")"
        if [ -z "$sym" ]; then
          _cr_add "binds[$bi] has no 'symbol' — every bound entry must name the symbol it declares"
          continue
        fi
        if [ -n "$owed" ]; then
          if ! [[ "$owed" =~ ^#?[0-9]+$ ]]; then
            _cr_add "binds: '$sym' owed_by '$owed' is not an issue number"
            continue
          fi
          owed="${owed#\#}"
          est="$(cr_issue_state "$owed" 2>/dev/null || echo missing)"
          case "$est" in
            open)   : ;;  # an open issue still owes the implementation — legal interface-first slice
            closed) _cr_add "binds: '$sym' is owed_by #$owed, but that issue is CLOSED — nothing open still owes the implementation" ;;
            *)      _cr_add "binds: '$sym' is owed_by #$owed, which does not exist or cannot be verified open (fails closed)" ;;
          esac
          continue
        fi
        if [ -z "$def" ]; then
          _cr_add "binds: '$sym' is neither defined ('defined_in') nor owed ('owed_by') — who implements it?"
          continue
        fi
        if _cr_is_test_path "$def"; then
          _cr_add "binds: '$sym' defined_in '$def' is a TEST path — a symbol proven only by its own test is #1934's hole; name the non-test implementation or owe it"
          continue
        fi
        grep -qxF -- "$def" <<<"$union" ||
          _cr_add "binds: '$sym' declares defined_in '$def', but that path is not in the diff of the claimed commits (declared, not implemented)"
      done
    fi
  fi

  # --- gate 7: mirrors — files that must change together (repo registry) -----
  # #1933 changed internal/idp/appdoor.go but never extended the golden fixture
  # matou-app copies "so neither side guesses the wire" — a repo it cannot see
  # was left guessing. .sandcastle/mirrors.tsv is a repo-level registry (the
  # ticket that forgets the mirror is the one that forgets to declare it): a
  # changed_files entry matching a `trigger` must ship its `mirror` in the same
  # close, waivable ONLY by a non-empty `mirror_waiver` (surfaced in the comment
  # for a human). A malformed registry line fails closed, per the discipline.
  local mirrors_file="${CR_MIRRORS_FILE:-$root/.sandcastle/mirrors.tsv}"
  if [ -f "$mirrors_file" ] && [ "${#files[@]}" -gt 0 ]; then
    local waiver line trig mirr nfields lineno=0
    waiver="$(jq -r '.mirror_waiver // "" | tostring' <<<"$json")"
    while IFS= read -r line || [ -n "$line" ]; do
      lineno=$((lineno + 1))
      case "$line" in
        ''|'#'*) continue ;;
      esac
      nfields="$(awk -F'\t' 'END{print NF}' <<<"$line")"
      trig="$(cut -f1 <<<"$line")"; mirr="$(cut -f2 <<<"$line")"
      if [ "$nfields" -ne 2 ] || [ -z "$trig" ] || [ -z "$mirr" ]; then
        _cr_add "mirrors.tsv line $lineno is malformed (want 'trigger<TAB>mirror'): $line"
        continue
      fi
      if printf '%s\n' "${files[@]}" | grep -qxF -- "$trig"; then
        if ! printf '%s\n' "${files[@]}" | grep -qxF -- "$mirr"; then
          if [ -n "$waiver" ]; then
            :  # explicit human-readable waiver (surfaced verbatim in the posted comment)
          else
            _cr_add "mirrors: changed_files touches '$trig' but not its required mirror '$mirr' — they must move together (set 'mirror_waiver' with a reason a human will read to override)"
          fi
        fi
      fi
    done < "$mirrors_file"
  fi

  # --- gate 8: required suites — touching an area demands its suite ran -------
  # Gate 4 refutes a status:success only on a LISTED failing test; an agent that
  # simply OMITS a required suite from tests[] passes gate 4 clean — the same
  # root as #1934/#1933 (the agent chooses its own evidence), a different hole
  # from gates 6/7. .sandcastle/required-suites.tsv is a repo-level registry (the
  # sibling of gate 7's mirrors.tsv): `area-glob<TAB>suite-token[|alt…]`, one per
  # line, '#'-comments and blanks ignored. On a status:success close, if any
  # changed_files entry matches an area's glob, at least one tests[] command must
  # contain one of that area's '|'-separated suite tokens — else the green is
  # refused, naming the area and the suite it never ran. Gate 4 still refutes that
  # suite when it is listed RED; gate 8 refutes it MISSING. A malformed registry
  # line FAILS CLOSED. No registry / no match / status != success → no-op
  # (default-open, additive — every existing passing envelope still passes). This
  # judges only that the area's suite is PRESENT, not completeness in general.
  local suites_file="${CR_REQUIRED_SUITES_FILE:-$root/.sandcastle/required-suites.tsv}"
  if [ "$status" = success ] && [ -f "$suites_file" ] && [ "${#files[@]}" -gt 0 ]; then
    local cmds sline strig stok snf slineno=0 f2 hit alt matched
    # the commands the envelope claims to have run (empty if tests[] absent/not a list)
    cmds="$(jq -r '(.tests // []) | if type=="array" then (.[]? | .command // empty) else empty end | tostring' <<<"$json")"
    while IFS= read -r sline || [ -n "$sline" ]; do
      slineno=$((slineno + 1))
      case "$sline" in ''|'#'*) continue ;; esac
      snf="$(awk -F'\t' 'END{print NF}' <<<"$sline")"
      strig="$(cut -f1 <<<"$sline")"; stok="$(cut -f2 <<<"$sline")"
      if [ "$snf" -ne 2 ] || [ -z "$strig" ] || [ -z "$stok" ]; then
        _cr_add "required-suites.tsv line $slineno is malformed (want 'area-glob<TAB>suite-token'): $sline"
        continue
      fi
      hit=0
      for f2 in "${files[@]}"; do
        [ -n "$f2" ] || continue
        # shellcheck disable=SC2053  # RHS glob match is intentional (area pattern)
        if [[ "$f2" == $strig ]]; then hit=1; break; fi
      done
      [ "$hit" = 1 ] || continue
      matched=0
      while IFS= read -r alt; do
        [ -n "$alt" ] || continue
        if grep -qF -- "$alt" <<<"$cmds"; then matched=1; break; fi
      done < <(tr '|' '\n' <<<"$stok")
      if [ "$matched" != 1 ]; then
        _cr_add "required-suites: changed_files touches '$strig' but no tests[] command ran its required suite ('$stok') — a green that omits the changed area's suite is #1934's evidence-choosing hole; run it (or close blocked)"
      fi
    done < "$suites_file"
  fi

  # --- gate 9: cross-repo mirrors — a copy this close cannot make -------------
  # Gate 7 asks "did this close ship the mirror too?", which only works when both
  # files sit in this repo. The app-door golden's whole purpose is to be COPIED
  # into matou-app "so neither side guesses the wire" — and that copy is one gate
  # 7 structurally cannot see. #1959 added an `unlock` section to the golden and
  # closed gate-clean; matou-app's copy still had no `unlock` key at all, so the
  # wallet (matou-app#664) and this door shipped two different contracts, both
  # green, and every fresh unlock failed closed on a live community (matou-app#678).
  # .sandcastle/cross-repo-mirrors.tsv is a repo-level `trigger<TAB>owner/repo<TAB>
  # foreign-path` registry. Touching a trigger obliges a `cross_repo` entry naming
  # that trigger and an OPEN issue in that foreign repo — this close cannot do the
  # other repo's work, but it must name who will, and they must still exist. The
  # foreign state comes through the cr_foreign_issue_state seam (pure/offline in
  # tests). Waivable ONLY by a non-empty `cross_repo_waiver`. A malformed registry
  # line, a non-list `cross_repo`, a non-object entry, a malformed issue reference,
  # an issue in the WRONG repo, and an issue that is closed or unverifiable all
  # FAIL CLOSED. No registry / no trigger match → no-op (additive, default-open).
  local xrepo_file="${CR_CROSS_REPO_MIRRORS_FILE:-$root/.sandcastle/cross-repo-mirrors.tsv}"
  if [ -f "$xrepo_file" ] && [ "${#files[@]}" -gt 0 ]; then
    local xwaiver xline xtrig xslug xpath xnf xlineno=0 xjson xref xrslug xnum xstate
    xwaiver="$(jq -r '.cross_repo_waiver // "" | tostring' <<<"$json")"
    if jq -e 'has("cross_repo")' >/dev/null 2>&1 <<<"$json" &&
       [ "$(jq -r '.cross_repo | type' <<<"$json")" != "array" ]; then
      _cr_add "cross_repo must be an array of {trigger, issue:\"owner/repo#N\"} (fails closed)"
    fi
    while IFS= read -r xline || [ -n "$xline" ]; do
      xlineno=$((xlineno + 1))
      case "$xline" in ''|'#'*) continue ;; esac
      xnf="$(awk -F'\t' 'END{print NF}' <<<"$xline")"
      xtrig="$(cut -f1 <<<"$xline")"; xslug="$(cut -f2 <<<"$xline")"; xpath="$(cut -f3 <<<"$xline")"
      if [ "$xnf" -ne 3 ] || [ -z "$xtrig" ] || [ -z "$xslug" ] || [ -z "$xpath" ]; then
        _cr_add "cross-repo-mirrors.tsv line $xlineno is malformed (want 'trigger<TAB>owner/repo<TAB>foreign-path'): $xline"
        continue
      fi
      printf '%s\n' "${files[@]}" | grep -qxF -- "$xtrig" || continue
      [ -z "$xwaiver" ] || continue   # explicit human-readable waiver (surfaced in the comment)
      # the cross_repo entry claiming this trigger, if the envelope carries one
      xjson="$(jq -r --arg t "$xtrig" '
        (.cross_repo // []) | if type=="array" then
          (map(select(type=="object" and (.trigger // "") == $t)) | first // empty)
        else empty end | tostring' <<<"$json" 2>/dev/null || true)"
      if [ -z "$xjson" ] || [ "$xjson" = null ]; then
        if jq -e '(.cross_repo // []) | type=="array" and (map(type!="object") | any)' >/dev/null 2>&1 <<<"$json"; then
          _cr_add "cross_repo holds an entry that is not an object {trigger, issue} (fails closed)"
          continue
        fi
        _cr_add "cross-repo mirrors: changed_files touches '$xtrig', whose mirror '$xpath' lives in $xslug and CANNOT change in this close — name an open $xslug issue that owes the copy in 'cross_repo' (or set 'cross_repo_waiver' with a reason a human will read)"
        continue
      fi
      xref="$(jq -r '.issue // "" | tostring' <<<"$xjson")"
      if ! [[ "$xref" =~ ^([^/[:space:]]+/[^/#[:space:]]+)#([0-9]+)$ ]]; then
        _cr_add "cross-repo mirrors: '$xtrig' names issue '$xref', which is not an 'owner/repo#N' reference (fails closed)"
        continue
      fi
      xrslug="${BASH_REMATCH[1]}"; xnum="${BASH_REMATCH[2]}"
      if [ "$xrslug" != "$xslug" ]; then
        _cr_add "cross-repo mirrors: '$xtrig' names $xrslug#$xnum, but the mirror lives in $xslug — the issue that owes the copy must be in the repo that holds it"
        continue
      fi
      xstate="$(cr_foreign_issue_state "$xrslug" "$xnum" 2>/dev/null || echo missing)"
      case "$xstate" in
        open)   : ;;  # someone still owes the copy — legal, and now written down
        closed) _cr_add "cross-repo mirrors: '$xtrig' is owed by $xrslug#$xnum, but that issue is CLOSED — nothing open still owes the copy of '$xpath'" ;;
        *)      _cr_add "cross-repo mirrors: '$xtrig' is owed by $xrslug#$xnum, which does not exist or cannot be verified open (fails closed)" ;;
      esac
    done < "$xrepo_file"
  fi

  if [ -n "$out" ]; then
    printf '%s\n' "$out"
    return 1
  fi
  return 0
}

# ── the independent reviewer gate (#197) ──────────────────────────────────────
# The deterministic gates above check envelope self-consistency; NO agent ever
# reads the diff for correctness or spec conformance. The reviewer gate closes
# that: close-report.sh runs a SECOND, read-only agent over the run's diff on
# SWARM_REVIEW_MODEL with the review-prompt.md skeleton, and that agent emits one
# JSON verdict `{verdict: approve|reject|unsure, findings:[{file,line,severity,
# why}]}`. The CLAUDE CALL lives in close-report.sh (it is network/tool work,
# like landing-lib.sh's rebase resolver); the PARSE + verdict normalisation live
# here so they are offline-testable over a shimmed `claude` result file.

# _cr_review_is_auth_error <claude-result-file> — rc 0 when the reviewer
# subprocess could not AUTHENTICATE rather than returning a review: a `claude -p`
# child in an interactive standing session is not logged in and returns an
# api_error terminal reason with a /login `.result`
# ("Not logged in · Please run /login"). This is an environment fact (no
# logged-in reviewer here), not a bad review, so the gate treats it like an
# ABSENT reviewer binary and SKIPS — never fails CLOSED (#228). Requires BOTH the
# error signal (terminal_reason=api_error OR is_error) AND the login prompt, so a
# genuine review that merely mentions "/login" in its prose never trips this.
_cr_review_is_auth_error() {
  local rf="${1:-}"
  [ -n "$rf" ] && [ -f "$rf" ] && [ -s "$rf" ] || return 1
  jq -e '
    (type == "object")
    and (((.result // "") | tostring) | test("/login|[Nn]ot logged in"))
    and (((.terminal_reason // "") == "api_error") or ((.is_error // false) == true))
  ' "$rf" >/dev/null 2>&1
}

# _cr_review_fail <claude-result-file> -> the fail-verdict JSON. `unauthenticated`
# when the reviewer could not authenticate (the gate SKIPS it like an absent
# reviewer, #228); otherwise `malformed` — the fail-CLOSED posture for a reviewer
# that genuinely RAN and returned empty/garbage output.
_cr_review_fail() {
  if _cr_review_is_auth_error "${1:-}"; then
    printf '%s\n' '{"verdict":"unauthenticated","findings":[]}'
  else
    printf '%s\n' '{"verdict":"malformed","findings":[]}'
  fi
}

# cr_review_parse <claude-result-file> -> normalised JSON on stdout:
#   {"verdict":"approve|reject|unsure|malformed|unauthenticated","findings":[...]}
# Reads a `claude --output-format json` result (its `.result` key holds the
# agent's final text, which carries the verdict object — possibly wrapped in a
# ```json fence or the whole file IS the bare object, for a stub / older CLI).
# A reviewer that could not authenticate normalises to `unauthenticated` (the
# gate SKIPS it, #228); anything else unparseable, empty, or an out-of-vocabulary
# verdict normalises to `malformed` — the fail-CLOSED posture the gate acts on as
# a rejection. rc is always 0: the verdict in the echoed JSON drives the decision.
cr_review_parse() {
  local rf="${1:-}" text obj verdict
  if [ -z "$rf" ] || [ ! -f "$rf" ] || [ ! -s "$rf" ]; then
    _cr_review_fail "$rf"; return 0
  fi
  # `.result` is the agent's final text (claude --output-format json). Fall back
  # to the whole file when it is already the bare verdict object.
  text="$(jq -r 'if type=="object" and has("result") then (.result | tostring) else empty end' "$rf" 2>/dev/null)"
  [ -n "$text" ] || text="$(cat "$rf" 2>/dev/null)"
  # Strip markdown code fences the model may have wrapped the object in.
  text="$(printf '%s\n' "$text" | sed -e 's/^[[:space:]]*```[a-zA-Z]*[[:space:]]*$//' -e 's/^[[:space:]]*```[[:space:]]*$//')"
  obj="$(jq -c 'if type=="object" then . else empty end' <<<"$text" 2>/dev/null || true)"
  if [ -z "$obj" ]; then _cr_review_fail "$rf"; return 0; fi
  verdict="$(jq -r '.verdict // "" | tostring' <<<"$obj" 2>/dev/null || true)"
  case "$verdict" in
    approve|reject|unsure) ;;
    *) _cr_review_fail "$rf"; return 0 ;;
  esac
  jq -c '{verdict: .verdict,
          findings: ((.findings // []) | if type=="array" then . else [] end)}' <<<"$obj" 2>/dev/null \
    || _cr_review_fail "$rf"
}

# cr_review_finding_lines <normalised-json> -> one `reviewer: <file>:<line> [<sev>]
# <why>` line per finding on stdout. This is the verbatim form the gate folds
# into the close's violation list on a `reject`, and surfaces in the park comment
# on an `unsure`. Empty output when there are no findings.
cr_review_finding_lines() {
  jq -r '(.findings // [])[]?
    | "reviewer: " + ((.file // "?") | tostring)
      + ":" + ((.line // "?") | tostring)
      + " [" + ((.severity // "?") | tostring) + "] "
      + ((.why // "") | tostring)' <<<"${1:-}" 2>/dev/null || true
}
