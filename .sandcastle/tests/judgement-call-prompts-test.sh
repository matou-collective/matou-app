#!/usr/bin/env bash
# Offline text assertions for the ADR 0174 judgement-call fallback (#585): the
# headless /triage prompt (run-triage.sh) and the mid-task needs_human_decision
# flow (prompt.md rule 6 + "When you are blocked") must attempt an agent ruling
# under ADR 0174 before ever defaulting to ready-for-human, and ready-for-human
# itself must be reserved for a genuine one-way door (a `## Why human` line).
# No network, no claude call — pure grep over the prompt source text.
#
# #1 turned root prompt.md into a generic skeleton (prompts/prompt.md) whose
# judgement-call wording now lives per-consumer in .sandcastle/prompt-
# enrichments/rules.md plus (since #14) the policy-generated hand-off
# block, rendered into .sandcastle/prompt.md —
# the live text this repo's own workers actually read. This test asserts
# against THAT rendered artifact, not the skeleton (which carries no prose
# of its own to assert on).
# Run: bash .sandcastle/tests/judgement-call-prompts-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$here/.."
# Where the LIVE rendered prompts sit depends on which copy is running us: in
# the factory root they are under .sandcastle/ beside their docs/; vendored
# into a consumer, tests/ IS .sandcastle/tests/, so they sit in $root itself
# and the repo's docs/ is one level up (#23: a vendored test must work
# standalone in a consumer's tree).
if [ -f "$root/.sandcastle/prompt.md" ]; then
  rendered_dir="$root/.sandcastle"; docs_root="$root"
else
  rendered_dir="$root"; docs_root="$root/.."
fi
prompt_md="$rendered_dir/prompt.md"

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
rule6="$(sed -n '/^6\. \*\*If you hit anything in `needs_human_decision`/,/^7\./p' "$prompt_md")"
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
blocked="$(sed -n '/^## When you are blocked/,/^## /p' "$prompt_md")"

# #14 generates this section from the policy's HUMAN_LABELS, so the bar is now
# carried by the one-way-door TRIGGER's guidance rather than hand-written prose.
grep -q 'trigger \*\*one-way-door\*\*' <<<"$blocked" \
  || fail "the blocked path must route its human label by an explicit one-way-door trigger"; ok
grep -q "genuine one-way-door call" <<<"$blocked" \
  || fail "the blocked path must narrow that label to a genuine one-way door"; ok
grep -q '## Why human' <<<"$blocked" \
  || fail "the blocked path must require a \`## Why human\` line, matching docs/agents/triage-labels.md"; ok
# ...and it must resolve label ids by NAME: the idss ids this text once carried
# (36/48) were wrong for every other repo that vendored the same prose (#14).
grep -qE '/labels/[0-9]+' <<<"$blocked" \
  && fail "the blocked path must not hardcode a numeric label id — resolve by name"; ok

# --- a doc POINTER must resolve in the repo it renders into (#33/#42/#47) ----
# A decision-record NUMBER is per-repo: ADR 0174 is `Matou/idss`'s two-way-door
# record, which this factory inherited but does not carry (its own sequence
# starts at 0001). The session prompt's rules heading said "read
# `docs/adr/0174-*.md` first" — the literal file the session's own governing
# prompt pointed at, and a 404 in every repo but idss. So:
#   (a) no SKELETON may name a doc path or a repo slug — it renders into every
#       consumer (CLAUDE.md's blast-radius rule); the per-repo pointer belongs
#       in that consumer's own prompt-enrichments file.
#   (b) every doc path this repo's own live text DOES name must exist here.
#   (c) no harness .sh may name a doc path in EXECUTABLE text (#42 — a prompt
#       string in a shell script, where no slot reaches), and
#   (d) a pointer the repo DOES declare (TWO_WAY_DOOR_DOC) must resolve here.
# The bare phrase "ADR 0174" is deliberately NOT covered: it is the factory's
# inherited audit-trail vocabulary (this repo's own ADR headers use it), it
# names no path, and it cannot 404. Paths are the hazard.
#
# #47 widened (a)/(b)/(c) from `docs/adr/` to the WHOLE `docs/` family, because
# the ruling that closed it is about the family, not one subtree: `docs/**` is
# vendor-excluded (`onboarding/vendor-exclude`), so NO harness doc path resolves
# in a consumer's checkout — the `/triage` prompt's `docs/agents/triage-labels.md`
# was a live 404 in `matou-app`, which carries no `docs/agents/` at all. Factory
# doctrine reaches a consumer as vendored CODE that renders text
# (`policy-lib.sh`'s `policy_trigger_guidance`, the prompt skeletons), never as a
# doc path the consumer is trusted to have.
#
# #47 left ONE occurrence outstanding and carried it here as a named baseline:
# `prompts/rehearsal-report-prompt.md` named `Matou/idss`'s design spec for its
# rehearsal drive. #49 closed it with #33's slot treatment — the whole opening
# paragraph became `{{ENRICH:rehearsal-drive-intro}}`, so the drive's identity
# (its spec, its shape, its issue number) is authored per repo — and the
# baseline is deleted with it, exactly as the staleness check demanded. The scan
# below is now unconditional: NO skeleton may name a doc path at all.
skel_dir="$root/prompts"
if [ -d "$skel_dir" ]; then
  skel_docs="$(grep -rn 'docs/' "$skel_dir" || true)"
  [ -z "$skel_docs" ] \
    || fail "a prompt skeleton names a doc path — docs/** is vendor-excluded, so it 404s in every consumer; put the pointer in an {{ENRICH:...}} slot or state the doctrine inline (#47): $skel_docs"; ok
  skel_slug="$(grep -rn 'Matou/' "$skel_dir" || true)"
  [ -z "$skel_slug" ] \
    || fail "a prompt skeleton names a repo slug — sourced from the identity layer, never literal: $skel_slug"; ok
  # #51: a bare tracker number in a SKELETON is not the "lesser hazard" a doc
  # path is — it is a different one. A path 404s, which is at least loud; a
  # number MISRESOLVES, silently, because the prompt is read by an agent whose
  # tracker is a different repo's, where that number exists and means something
  # else ("once #414's no-sshd hardening lands" claimed another repo's roadmap
  # as fact in every consumer's reporter prompt). Issue numbers are per-repo by
  # construction: a skeleton names the MECHANISM, and a repo's own enrichment —
  # per-repo text by definition — names its own tickets.
  skel_nums="$(grep -rn '#[0-9]' "$skel_dir" || true)"
  [ -z "$skel_nums" ] \
    || fail "a prompt skeleton names a tracker issue number — it misresolves in every other consumer's tracker instead of 404ing; name the mechanism, or put the number in an {{ENRICH:...}} slot (#51): $skel_nums"; ok
  # #56: the fourth scan, and the only one about TRUTH rather than reach. A
  # skeleton's evidence ANCHOR is the part deliberately kept OUT of the slot —
  # it tells every consumer's reader which records the HARNESS ITSELF handles,
  # so it may only name a record some harness script actually touches. The
  # reporter's anchor named `artifacts/journey.json` as one of "the two files
  # this harness itself writes and reads"; no harness file has ever written or
  # read it (it is one product's founding rows), so a consumer whose drive
  # writes no such file was told to read a record that does not exist, and was
  # pointed away from `artifacts/verdict.json`, which `rehearsal-report.sh`
  # demonstrably does read. Per-repo evidence belongs in the slot; the anchor
  # states what is provable here. Comment lines do not count as a use, same
  # bar as (c) below — a record named only in prose is not one the harness
  # handles. Non-recursive on purpose: the scan covers this root and, vendored,
  # a consumer's .sandcastle/ (#23), where the same scripts sit beside it.
  while read -r rec; do
    [ -n "$rec" ] || continue
    used=""
    for f in "$root"/*.sh; do
      [ -f "$f" ] || continue
      grep -n "$rec" "$f" | grep -qv '^[0-9]*:[[:space:]]*#' && { used=1; break; }
    done
    [ -n "$used" ] \
      || fail "a prompt skeleton's evidence anchor names $rec, which no harness script reads or writes — the anchor is factory contract, so it may only name the harness's OWN records; per-repo evidence belongs in an {{ENRICH:...}} slot (#56)"; ok
  done < <(grep -rho 'artifacts/[0-9A-Za-z._-]*' "$skel_dir" | sort -u)
else
  # A consumer pinned before #1 has no vendored prompts/ dir yet — say so
  # rather than silently reporting coverage that did not run.
  echo "judgement-call-prompts-test: SKIP skeleton checks — no $skel_dir (pin predates the render pipeline)" >&2
fi

# (c) #42: the same hazard one layer down — a prompt string embedded in a
# harness `.sh` file, which no {{ENRICH:<slot>}} slot reaches (a shell prompt is
# assembled at RUN time, not rendered at onboard time). `run-triage.sh`'s
# /triage prompt named `docs/adr/0174-*.md`, a path that exists only in
# Matou/idss — and, one line further on, `docs/agents/triage-labels.md`, a
# factory doc no consumer vendors (#47). So no harness script may carry ANY doc
# PATH in executable text: a per-repo pointer comes from the POLICY layer
# (TWO_WAY_DOOR_DOC, ADR 0002), and factory doctrine is stated in the prompt's
# own words rather than linked. Comment lines are exempt, as in
# actions-endpoint-test.sh (#28): a hazard has to stay explainable next to the
# code it constrains. Non-recursive on purpose — the scan then covers the same
# surface in this root and in a consumer's vendored .sandcastle/ (#23).
#
# The per-repo IDENTITY LAYER is exempt — and must be, or this check would red
# on the very file the fix asks a repo to declare its pointer in: swarm-policy.sh
# and swarm-identity.sh are vendor-EXCLUDED, consumer-owned, and per-repo by
# construction, so a path in them cannot reach another repo. That is the whole
# point of (d) below, which checks the declared path resolves.
sh_docs=""
for f in "$root"/*.sh; do
  [ -f "$f" ] || continue
  case "$(basename "$f")" in swarm-policy.sh|swarm-identity.sh) continue ;; esac
  hits="$(grep -n 'docs/' "$f" | grep -v '^[0-9]*:[[:space:]]*#' || true)"
  [ -n "$hits" ] && sh_docs="$sh_docs$(basename "$f"):$hits
"
done
[ -z "$sh_docs" ] \
  || fail "a harness script names a doc path in live text — docs/** is vendor-excluded, so it 404s in every consumer; take a per-repo pointer from the policy layer (TWO_WAY_DOOR_DOC) or state the doctrine in the prompt's own words (#47): $sh_docs"; ok

# ...and run-triage.sh must actually READ that knob rather than phrase the
# pointer itself, so a repo's declaration is what reaches the triage agent.
grep -q 'SWARM_POLICY_TWO_WAY_DOOR_DOC' "$root/run-triage.sh" \
  || fail "run-triage.sh must take its two-way-door pointer from the policy layer (SWARM_POLICY_TWO_WAY_DOOR_DOC)"; ok
grep -q 'two_way_door' <<<"$triage_prompt" \
  || fail "run-triage.sh's /triage prompt must interpolate the per-repo two-way-door pointer"; ok

# (d) a DECLARED pointer must resolve in the repo that declares it — the same
# bar (b) sets for rendered prose. An undeclared one is a legitimate state (the
# prompt says so in words), so there is nothing to check.
policy_file="$root/swarm-policy.sh"
if [ -f "$policy_file" ]; then
  declared="$(sed -n 's/^[[:space:]]*TWO_WAY_DOOR_DOC=//p' "$policy_file" | tail -1 | tr -d "\"'")"
  if [ -n "$declared" ]; then
    # shellcheck disable=SC2086
    set -- $docs_root/$declared
    [ -f "$1" ] \
      || fail "swarm-policy.sh declares TWO_WAY_DOOR_DOC=$declared, which does not resolve in this repo — the triage agent would be sent to a 404"; ok
  fi
fi

for f in "$rendered_dir"/*prompt*.md "$rendered_dir"/prompt-enrichments/*.md; do
  [ -f "$f" ] || continue
  while read -r p; do
    [ -n "$p" ] || continue
    # No exemption: since #49 every doc path in a repo's own rendered text came
    # from that repo's own enrichment file, so it is fixable where it is named.
    # $p carries a glob (docs/adr/0001-*.md); an unmatched glob stays literal,
    # so the -f test fails exactly when nothing resolves.
    # shellcheck disable=SC2086
    set -- $docs_root/$p
    [ -f "$1" ] \
      || fail "$(basename "$f") points at $p, which does not exist in this repo — a doc in another repo must be named as such, not linked as a local path"; ok
  done < <(grep -o 'docs/[0-9A-Za-z*_./-]*\.md' "$f" | sort -u)
done

echo "judgement-call-prompts-test: $pass checks passed"
