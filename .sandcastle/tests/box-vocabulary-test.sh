#!/usr/bin/env bash
# The harness names the ROLE, never one provider's product name (#53).
#
# A drive stands up a machine and drives against it. CONTEXT.md calls that
# machine a **box**, deliberately shape-neutral: a consumer's drive may stand
# up a container, a VM, bare metal, or a provider's instance, and the harness
# is vendored byte-identical into all of them. "Droplet" is DigitalOcean's
# product name for one of those shapes — it entered the harness with the live
# door (the reporter's ssh section), the TUI's drive panel and the worker-class
# table without ever being ruled into the vocabulary, so a consumer whose drive
# stands up anything else read a word that did not describe its deployment.
# The cost is comprehension, not breakage, which is exactly why it needs a
# ratchet: nothing else would ever red on it.
#
# Scope — the FACTORY's own text, i.e. what is vendored byte-identical:
#   $harness/*.sh, prompts/**, tui/**, tests/**.
# Deliberately NOT scanned:
#   - a repo's RENDERED *prompt*.md and prompt-enrichments/** — per-repo text
#     by construction (#49/#51), where a product's own word for its own box is
#     CORRECT, and
#   - docs/**, onboarding/** and .env.example — vendor-excluded, so nothing
#     there reaches another repo; `onboarding/templates/` names droplets beside
#     `doctl`/`digitalocean_access_token`, where the provider IS the subject.
# Fixtures inside the scanned tree are NOT exempt, keeping #29's precedent:
# scrubbing them too makes the ratchet absolute rather than "only in tests".
#
# Scans the harness's own directory ($here/..), so a consumer running its
# vendored tests gets the same guard (#23).
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
harness="$(cd "$here/.." && pwd)"

pass=0 fail=0
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); echo "FAIL: $1"; }

# One provider's product name per line. The rule is general — add a word here
# when a new one appears; the ruling it enforces is CONTEXT.md's **Box**.
provider_words='droplet'

# The scan is unconditional: #55 gave the rehearsal HEAL skeleton — the one
# named exception this test shipped with — #49/#51's {{ENRICH}} slot treatment,
# so no harness file names a provider's box shape any more.

targets=""
for f in "$harness"/*.sh; do
  [ -f "$f" ] && targets="$targets $f"
done
for d in prompts tui tests; do
  [ -d "$harness/$d" ] || continue
  while IFS= read -r f; do targets="$targets $f"; done < <(
    find "$harness/$d" -type f ! -path '*/__pycache__/*' ! -path '*/.venv/*' \
      ! -name '*.pyc' | sort)
done
[ -n "$targets" ] && ok || bad "nothing to scan under $harness"

# A LINE may carry the word when it says why, with the marker below — the one
# legitimate case being harness code that READS a key a consumer already
# writes under the old spelling (tui/data/drive_status.py: pull-only means a
# rename cannot reach the writer, so the read has to be additive). The waiver
# is per line and greppable, and the count is printed, so it stays visible
# rather than becoming a quiet blanket exemption.
waiver='box-vocabulary-waiver'

hits=""; waived=0
for f in $targets; do
  rel="${f#"$harness"/}"
  [ "$rel" = "tests/$(basename "${BASH_SOURCE[0]}")" ] && continue   # this file states the rule
  named="$(grep -inE "$provider_words" "$f" || true)"
  h="$(grep -v "$waiver" <<<"$named" | grep -v '^$' || true)"
  waived=$((waived + $(grep -c "$waiver" <<<"$named" || true)))
  [ -n "$h" ] && hits="$hits$rel:$h
"
done
[ -z "$hits" ] && ok || bad "harness text names one provider's box shape instead of the role (CONTEXT.md: **Box**) — a consumer whose drive stands up a container, a VM or bare metal reads a word that does not describe its deployment (#53):
$hits"

# The live door's two halves must AGREE. rehearsal-report.sh WRITES the
# section; the reporter skeleton tells the diagnosis how to treat it. That
# agreement is the whole reason the skeleton's paragraph is factory CONTRACT
# rather than product prose (#47's rule, applied in #51) — if the emitted
# header and the prompt drift apart, the paragraph describes a section that
# does not exist under that name.
reporter="$harness/rehearsal-report.sh"
if [ -f "$reporter" ]; then
  grep -q 'Live box at' "$reporter" && ok \
    || bad "rehearsal-report.sh must emit its live door as a 'Live box at <ip>' section — the name the reporter prompt's live-box paragraph promises"
fi
skel="$harness/prompts/rehearsal-report-prompt.md"
if [ -f "$skel" ]; then
  grep -q 'live-box section' "$skel" && ok \
    || bad "prompts/rehearsal-report-prompt.md must name the harness-written section as a 'live-box section' — it is contract only while it agrees with what rehearsal-report.sh emits"
fi

echo "box-vocabulary-test: $pass/$((pass + fail)) checks passed ($waived waived line(s), no baseline)"
[ "$fail" -eq 0 ]
