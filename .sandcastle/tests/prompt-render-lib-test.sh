#!/usr/bin/env bash
# Offline unit tests for prompt-render-lib.sh (#1): pure filesystem, no
# network, no git. The fetch-by-ref + cutover-proof integration lives in
# onboarding/tests/onboard-lib-test.sh (onboard_render_prompts).
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../prompt-render-lib.sh
. "$here/../prompt-render-lib.sh"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
pass=0 fail=0
check() { if eval "$2"; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: $1"; fi; }

mkdir -p "$tmp/enrich"

# --- prompt_render_one: inline placeholder substitution ---
cat > "$tmp/skel-inline.md" <<'EOF'
Repo is {{REPO_SLUG}} on {{FORGEJO_HOST}}, runner {{RUNNER_HOST}}.
EOF
out="$(prompt_render_one "$tmp/skel-inline.md" "$tmp/enrich" Matou/dev-factory git.matou.nz matou-workstation)"
check "inline substitution fills all three placeholders" \
  '[ "$out" = "Repo is Matou/dev-factory on git.matou.nz, runner matou-workstation." ]'

# --- prompt_render_one: {{ENRICH:<slot>}} splices a whole-line block ---
printf 'line one\nline two\n' > "$tmp/enrich/mybit.md"
cat > "$tmp/skel-enrich.md" <<'EOF'
before
{{ENRICH:mybit}}
after
EOF
out="$(prompt_render_one "$tmp/skel-enrich.md" "$tmp/enrich" x x x)"
check "ENRICH slot splices the file verbatim between skeleton lines" \
  '[ "$out" = "$(printf "before\nline one\nline two\nafter")" ]'

# --- prompt_render_handoff_rules (#14): the "when to hand off" block is
#     GENERATED from the policy's HUMAN_LABELS, not spliced from a static
#     enrichment file — loop-in granularity lives in the definition and use
#     of the human labels, per repo (Ben, 2026-08-22). ---
default_block="$(prompt_render_handoff_rules "$tmp/absent-policy.sh")"; rc=$?
check "handoff_rules: an absent policy file renders from the defaults (exit 0)" '[ "$rc" -eq 0 ]'
check "handoff_rules: one bullet per default label, in policy order" \
  '[ "$(grep -c "^   - \`" <<<"$default_block")" -eq 3 ]'
check "handoff_rules: first bullet is ready-for-human / one-way-door" \
  'grep -q "^   - \`ready-for-human\` — trigger \*\*one-way-door\*\*\.$" <<<"$default_block"'
check "handoff_rules: agent-blocked carries the cannot-proceed trigger" \
  'grep -q "^   - \`agent-blocked\` — trigger \*\*cannot-proceed\*\*\.$" <<<"$default_block"'
check "handoff_rules: needs-info carries the missing-context trigger" \
  'grep -q "^   - \`needs-info\` — trigger \*\*missing-context\*\*\.$" <<<"$default_block"'
check "handoff_rules: each bullet carries its trigger's guidance sentence" \
  'grep -q "provable by a test you can run" <<<"$default_block" &&
   grep -q "outside your slice" <<<"$default_block" &&
   grep -q "not yet an implementable one" <<<"$default_block"'
check "handoff_rules: still tells the worker to drop ready-for-agent" \
  'grep -q "remove \`ready-for-agent\`" <<<"$default_block"'
check "handoff_rules: still releases the claim comment + agent-working" \
  'grep -q "swarm-claim host=" <<<"$default_block" && grep -q "agent-working" <<<"$default_block"'
# The recipe resolves BY NAME at run time — the defect this ticket names (idss
# label ids 36/48 baked into prose that every repo then inherited).
check "handoff_rules: the label swap recipe resolves ids by NAME" \
  'grep -q "label_id" <<<"$default_block" && grep -q "select(.name == \$n)" <<<"$default_block"'
check "handoff_rules: no hardcoded numeric label id anywhere in the block" \
  '! grep -qE "/labels/[0-9]+" <<<"$default_block"'
# Prose wraps at the prompt's column; the indented shell recipe lines are
# copied verbatim from the text this block replaces and are exempt.
check "handoff_rules: every prose line wraps at 74 columns" \
  '[ -z "$(awk "!/^       / && length > 74" <<<"$default_block" | head -1)" ]'

# Ben's acceptance: a repo that adds `needs-product-owner` gets exactly ONE
# more bullet and no other diff.
printf 'HUMAN_LABELS="ready-for-human:one-way-door agent-blocked:cannot-proceed needs-info:missing-context needs-product-owner:product-decision"\n' \
  > "$tmp/policy-extra.sh"
extra_block="$(prompt_render_handoff_rules "$tmp/policy-extra.sh")"; rc=$?
check "handoff_rules: an added label renders (exit 0)" '[ "$rc" -eq 0 ]'
check "handoff_rules: an added label yields exactly one more bullet" \
  '[ "$(grep -c "^   - \`" <<<"$extra_block")" -eq 4 ]'
diff_out="$(diff <(printf '%s\n' "$default_block") <(printf '%s\n' "$extra_block") || true)"
check "handoff_rules: the added label is the ONLY diff (pure addition)" \
  '! grep -q "^<" <<<"$diff_out"'
check "handoff_rules: the added lines are exactly that label's bullet" \
  '[ "$(grep -c "^>" <<<"$diff_out")" -eq 3 ] &&
   grep -q "^> *- \`needs-product-owner\` — trigger \*\*product-decision\*\*\.$" <<<"$diff_out" &&
   grep -q "belongs to the product owner" <<<"$diff_out"'

# A policy with no hand-off label at all leaves a blocked worker nowhere to
# park a ticket — refuse rather than render a prompt with an empty list.
printf 'HUMAN_LABELS=""\n' > "$tmp/policy-empty.sh"
err_empty="$(prompt_render_handoff_rules "$tmp/policy-empty.sh" 2>&1 >/dev/null)"; rc=$?
check "handoff_rules: an empty HUMAN_LABELS refuses (exit != 0)" '[ "$rc" -ne 0 ]'
check "handoff_rules: the empty refusal names HUMAN_LABELS" 'grep -q "HUMAN_LABELS" <<<"$err_empty"'

printf 'HUMAN_LABELS="escalate:someday"\n' > "$tmp/policy-badtrig.sh"
err_bad="$(prompt_render_handoff_rules "$tmp/policy-badtrig.sh" 2>&1 >/dev/null)"; rc=$?
check "handoff_rules: an out-of-vocabulary trigger refuses, naming it" \
  '[ "$rc" -ne 0 ] && grep -q "someday" <<<"$err_bad"'

# The renderer must not leak the consumer's policy into its own caller — it
# sources policy_load in a subshell (#14). Assert that by clearing the var in a
# controlled subshell, rendering, and reading it back: a renderer that sourced
# the policy in the CALLER's shell would leave it set. Reading the AMBIENT var
# instead reds whenever the invoking shell has already run policy_load (a live
# swarm/session-runner shell) even though the renderer is correct (#58) — so the
# probe owns its own environment rather than trusting the host's.
leak="$(unset SWARM_POLICY_HUMAN_LABELS
        prompt_render_handoff_rules "$tmp/policy-extra.sh" >/dev/null 2>&1
        echo "${SWARM_POLICY_HUMAN_LABELS:-<unset>}")"
check "handoff_rules: does not leak SWARM_POLICY_* into the caller" \
  '[ "$leak" = "<unset>" ]'

# --- prompt_render_one: {{HANDOFF_RULES}} is filled from the policy file ---
cat > "$tmp/skel-handoff.md" <<'EOF'
## When you are blocked

{{HANDOFF_RULES}}
EOF
out="$(prompt_render_one "$tmp/skel-handoff.md" "$tmp/enrich" x x x "$tmp/policy-extra.sh")"
check "HANDOFF_RULES is filled from the policy passed explicitly" \
  '[ "$(grep -c "^   - \`" <<<"$out")" -eq 4 ] &&
   [ "$(head -1 <<<"$out")" = "## When you are blocked" ]'
check "HANDOFF_RULES no longer needs a handoff-rules.md enrichment file" \
  '[ ! -e "$tmp/enrich/handoff-rules.md" ]'

# ...and defaults to <enrich-dir>/../swarm-policy.sh, which is where a
# consumer's policy sits relative to its prompt-enrichments/ dir.
mkdir -p "$tmp/sc-default/prompt-enrichments"
printf 'HUMAN_LABELS="escalate:product-decision"\n' > "$tmp/sc-default/swarm-policy.sh"
out_def="$(prompt_render_one "$tmp/skel-handoff.md" "$tmp/sc-default/prompt-enrichments" x x x)"
check "HANDOFF_RULES defaults the policy to <enrich-dir>/../swarm-policy.sh" \
  '[ "$(grep -c "^   - \`" <<<"$out_def")" -eq 1 ] && grep -q "escalate" <<<"$out_def"'

err_bad2="$(prompt_render_one "$tmp/skel-handoff.md" "$tmp/enrich" x x x "$tmp/policy-badtrig.sh" 2>&1 >/dev/null)"; rc=$?
check "prompt_render_one refuses when the policy cannot render the block" \
  '[ "$rc" -ne 0 ] && grep -q "someday" <<<"$err_bad2"'

# --- prompt_render_one: refuses a missing enrichment file, names it ---
cat > "$tmp/skel-missing.md" <<'EOF'
{{ENRICH:absent}}
EOF
err="$(prompt_render_one "$tmp/skel-missing.md" "$tmp/enrich" x x x 2>&1 >/dev/null)"; rc=$?
check "missing ENRICH file refuses (exit != 0)" '[ "$rc" -ne 0 ]'
check "missing ENRICH file names the expected path" 'grep -q "enrich/absent.md" <<<"$err"'

# --- prompt_render_one: refuses a leftover {{...}} after substitution ---
cat > "$tmp/skel-leftover.md" <<'EOF'
still has {{SOMETHING_UNKNOWN}} in it
EOF
err3="$(prompt_render_one "$tmp/skel-leftover.md" "$tmp/enrich" x x x 2>&1 >/dev/null)"; rc3=$?
check "unfilled placeholder refuses (exit != 0)" '[ "$rc3" -ne 0 ]'
check "unfilled placeholder names the offending line" 'grep -q "SOMETHING_UNKNOWN" <<<"$err3"'

# --- prompt_render_identity ---
cat > "$tmp/swarm-identity.sh" <<'EOF'
: "${FORGEJO_API:=https://git.matou.nz/api/v1/repos/Matou/some-repo}"
: "${REPO_SLUG:=Matou/some-repo}"
: "${RUNNER_HOST:=some-host}"
EOF
ident="$(prompt_render_identity "$tmp")"
check "render_identity extracts REPO_SLUG/FORGEJO_HOST/RUNNER_HOST as tab-separated" \
  '[ "$ident" = "$(printf "Matou/some-repo\tgit.matou.nz\tsome-host")" ]'

cat > "$tmp/swarm-identity-no-runner.sh" <<'EOF'
: "${FORGEJO_API:=https://git.matou.nz/api/v1/repos/Matou/some-repo}"
: "${REPO_SLUG:=Matou/some-repo}"
EOF
mkdir -p "$tmp/no-runner"; cp "$tmp/swarm-identity-no-runner.sh" "$tmp/no-runner/swarm-identity.sh"
err4="$(prompt_render_identity "$tmp/no-runner" 2>&1 >/dev/null)"; rc4=$?
check "render_identity refuses when RUNNER_HOST is never set (no cross-product default)" '[ "$rc4" -ne 0 ]'
check "render_identity names RUNNER_HOST in the refusal" 'grep -q "RUNNER_HOST" <<<"$err4"'

err5="$(prompt_render_identity "$tmp/does-not-exist" 2>&1 >/dev/null)"; rc5=$?
check "render_identity refuses when swarm-identity.sh is missing" '[ "$rc5" -ne 0 ] && grep -q "missing" <<<"$err5"'

echo "prompt-render-lib: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
