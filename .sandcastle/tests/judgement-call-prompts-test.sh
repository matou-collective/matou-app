#!/usr/bin/env bash
# Offline text assertions for the ADR 0174 judgement-call fallback (#585): the
# headless /triage prompt (run-triage.sh) and the mid-task needs_human_decision
# flow (prompt.md rule 6 + "When you are blocked") must attempt an agent ruling
# under ADR 0174 before ever defaulting to ready-for-human, and ready-for-human
# itself must be reserved for a genuine one-way door (a `## Why human` line).
# No network, no claude call — pure grep over the prompt source text.
# Run: bash .sandcastle/tests/judgement-call-prompts-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$here/.."

fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0
ok() { pass=$((pass+1)); }

# --- run-triage.sh: the headless /triage prompt string ---------------------
triage_prompt="$(grep -o '/triage [^"]*' "$root/run-triage.sh")"

grep -q "RULE it yourself under ADR 0174" <<<"$triage_prompt" \
  || fail "run-triage.sh's /triage prompt must tell the agent to rule two-way-door calls itself"; ok
grep -q "Ruled by agent under ADR 0174" <<<"$triage_prompt" \
  || fail "run-triage.sh's /triage prompt must require the mandatory audit-trail phrase"; ok
grep -q "one-way-door list" <<<"$triage_prompt" \
  || fail "run-triage.sh's /triage prompt must name the one-way-door bar"; ok
grep -q "Only label ready-for-human when the call is a genuine one-way door" <<<"$triage_prompt" \
  || fail "run-triage.sh's /triage prompt must narrow ready-for-human to one-way doors"; ok

# --- prompt.md rule 6: mid-task needs_human_decision ------------------------
rule6="$(sed -n '/^6\. \*\*If you hit anything in `needs_human_decision`/,/^7\./p' "$root/prompt.md")"
rule6_flat="$(tr '\n' ' ' <<<"$rule6")"   # phrases below are wrapped across lines in the source

grep -q "try to rule it yourself under" <<<"$rule6" \
  || fail "prompt.md rule 6 must try an ADR-0174 self-ruling before asking a human"; ok
grep -q "Do not ask a human for a decision.*you can rule yourself" <<<"$rule6_flat" \
  || fail "prompt.md rule 6 must tell the worker not to ask when it can rule itself"; ok
grep -qi 'bash \.sandcastle/ask-human\.sh' <<<"$rule6" \
  || fail "prompt.md rule 6 must still fall back to ask-human.sh for genuine one-way doors"; ok

# The self-ruling instruction must come BEFORE the ask-human.sh invocation —
# i.e. the agent tries to rule first, only asking a human as a fallback.
rule_pos=$(grep -n "try to rule it yourself under" <<<"$rule6" | head -1 | cut -d: -f1)
ask_pos=$(grep -n 'bash \.sandcastle/ask-human\.sh' <<<"$rule6" | head -1 | cut -d: -f1)
[ -n "$rule_pos" ] && [ -n "$ask_pos" ] && [ "$rule_pos" -lt "$ask_pos" ] \
  || fail "the self-ruling attempt must precede the ask-human.sh call in rule 6"; ok

# --- prompt.md "When you are blocked": the ready-for-human bar -------------
blocked="$(sed -n '/^## When you are blocked/,/^## /p' "$root/prompt.md")"

grep -q "genuine one-way-door judgement" <<<"$blocked" \
  || fail "the blocked path must narrow ready-for-human to a genuine one-way door"; ok
grep -q '## Why human' <<<"$blocked" \
  || fail "the blocked path must require a \`## Why human\` line, matching docs/agents/triage-labels.md"; ok

echo "judgement-call-prompts-test: $pass checks passed"
