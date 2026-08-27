#!/usr/bin/env bash
# park-wiring-lib.sh — the ONE implementation of the standby-token wiring
# property (#85), as VENDORED code so it can run in the repo where a violation
# actually lives.
#
# The property: every workflow STEP that invokes an entry point able to reach
# `claude_limit_park` (limit-lib.sh) must have the standby token
# `CLAUDE_CODE_OAUTH_TOKEN_B` in scope for that step. Otherwise
# `claude_standby_available` sees an unset variable, `claude_failover` declines,
# and `claude_limit_park` stamps the HOST-GLOBAL marker: one under-provisioned
# caller parks every factory caller on that host for the rest of the window —
# the 2026-08-25 triage outage, where one workflow passed the primary token
# alone while its siblings passed both.
#
# Why this is a LIB and not a test: the property was first written as a
# factory-only check over the templates and this repo's own rendered workflows.
# But a consumer's workflows are the consumer's own per-repo layer — the
# templates are a starting point it edits, and several of its workflows never
# came from a template at all. A check that can only read the factory's own
# files can never fire in the repo where the bug lives, so it reads green
# forever while consumers park hosts (GOTCHAS 30). Vendored, it travels with
# the pin and runs consumer-side; the factory-only test over the templates
# becomes one more CALLER of this same function, so the two can never diverge.
#
# A repo with no standby SECRET is unaffected by wiring the reference: it
# renders to an empty string and `claude_standby_available`'s `[ -n … ]` already
# treats empty as "no standby". This asserts the token is WIRED, not that a
# second account exists.
#
# Offline-tested by tests/park-wiring-lib-test.sh. Callers:
#   preflight-swarm.sh          guard_park_token_wiring (fails the run CLOSED)
#   check-harness-drift.sh      advisory NOTE at install / pin-bump time
#   onboarding/tests/park-token-guard-test.sh   templates + this repo's renders

if [ -z "${__SWARM_PARK_WIRING_LIB:-}" ]; then
__SWARM_PARK_WIRING_LIB=1

# The standby reference a park-capable step must carry.
PARK_WIRING_TOKEN="${PARK_WIRING_TOKEN:-CLAUDE_CODE_OAUTH_TOKEN_B}"

# Entry points that (transitively) call claude_limit_park, matched by basename
# in a step's `run:` body. limit-lib.sh only DEFINES the function, so it is not
# an invocation target. Keep in step with limit-lib.sh's callers: when a new
# entry point learns to park, it belongs here in the same commit.
PARK_WIRING_ENTRYPOINT_RE='run-swarm\.sh|run-triage\.sh|heal\.sh|session-runner\.sh|rehearsal-report\.sh'

# park_wiring_file_violations <file>
#   Print one line per violating step: `<step label>`. rc 1 if any, else 0.
#
# Parsing rules (deliberately structural, not line-matching):
#   * A step block starts at a list item (`- `) whose indent equals the indent
#     of the first list item after a `steps:` key, and runs until the next such
#     item, the next `steps:`, or a column-0 key.
#   * A step is park-capable if its own text invokes a PARK_WIRING_ENTRYPOINT_RE
#     basename.
#   * A park-capable step is SATISFIED if the token appears in its own block,
#     OR anywhere in the file OUTSIDE every step block — that second case is a
#     workflow-level or job-level `env:` the steps inherit, which is legitimate
#     wiring. The over-approximation is deliberate: this predicate gates a run
#     CLOSED, so it must never red a correctly-wired repo. The bug shape it
#     exists to catch (a step carrying the primary token alone, with the
#     standby nowhere but inside a SIBLING step) is still caught exactly.
park_wiring_file_violations() {
  local file="$1"
  [ -f "$file" ] || return 0
  awk -v re="$PARK_WIRING_ENTRYPOINT_RE" -v tok="$PARK_WIRING_TOKEN" '
    function flush(   label) {
      if (block == "") return
      if (block ~ re) {
        label = blockname
        if (label == "") label = "(unnamed step at line " blockline ")"
        parkable[++np] = label
        parkable_has[np] = (index(block, tok) > 0)
      }
      block = ""; blockname = ""; blockline = 0
    }
    function indent_of(s,   n) { n = match(s, /[^ ]/); return (n ? n - 1 : -1) }
    {
      line = $0
      ind = indent_of(line)
      # A column-0 key (or any column-0 content) closes the current steps list.
      if (ind == 0 && line !~ /^ *$/) { flush(); in_steps = 0; step_indent = -1 }
      if (line ~ /^ *steps: *$/)      { flush(); in_steps = 1; step_indent = -1; outside = outside line "\n"; next }
      if (in_steps && line ~ /^ *- /) {
        if (step_indent < 0) step_indent = ind
        if (ind == step_indent) {
          flush(); block = line "\n"; blockline = NR
          if (line ~ /name: /) { blockname = line; sub(/^.*name: */, "", blockname) }
          next
        }
      }
      if (block != "") {
        block = block line "\n"
        if (blockname == "" && line ~ /^ *name: /) { blockname = line; sub(/^.*name: */, "", blockname) }
      } else {
        outside = outside line "\n"
      }
    }
    END {
      flush()
      inherited = (index(outside, tok) > 0)
      for (i = 1; i <= np; i++)
        if (!parkable_has[i] && !inherited) print parkable[i]
    }
  ' "$file"
}

# park_wiring_scan <path>...
#   Each path is a workflow FILE, or a DIRECTORY whose *.yml/*.yaml are scanned.
#   Prints one `<path>: <step label>` line per violating step.
#   rc 0 = scanned at least one file, no violations
#   rc 1 = violations printed
#   rc 2 = NOTHING WAS SCANNED. Never treat this as clean: it is the shape that
#          hid #85 (a guard that cannot reach the code it guards reads as
#          green). Callers must say so out loud.
park_wiring_scan() {
  local p f files=0 violations=0 targets=()
  for p in "$@"; do
    if [ -d "$p" ]; then
      for f in "$p"/*.yml "$p"/*.yaml; do [ -f "$f" ] && targets+=("$f"); done
    elif [ -f "$p" ]; then
      targets+=("$p")
    fi
  done
  for f in ${targets+"${targets[@]}"}; do
    files=$((files + 1))
    while IFS= read -r step; do
      [ -n "$step" ] || continue
      printf '%s: %s\n' "$f" "$step"
      violations=1
    done < <(park_wiring_file_violations "$f")
  done
  [ "$files" -eq 0 ] && return 2
  [ "$violations" -eq 0 ]
}

# park_wiring_remedy — the one-sentence fix, so every caller says the same
# thing and no consumer has to guess what "violation" means.
park_wiring_remedy() {
  printf '%s\n' "Add \`$PARK_WIRING_TOKEN: \${{ secrets.$PARK_WIRING_TOKEN }}\` to that step's own \`env:\` (or the job's), beside the primary token. Without it the step cannot fail over, and a usage-limit refusal parks EVERY repo on that host for the window."
}

fi
