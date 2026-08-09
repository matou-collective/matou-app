#!/usr/bin/env bash
# Test stub for the healer's agent call. Reads the prompt from $1, extracts
# the evidence dir, writes a canned diagnosis there. STUB_ACTION and
# STUB_ESCALATE control the report (defaults: a repair happened, no escalation).
set -euo pipefail
prompt="$1"
ev="$(printf '%s' "$prompt" | sed -n 's/^- Evidence directory: \([^ ]*\).*/\1/p' | head -1)"
cat > "$ev/diagnosis.md" <<EOF
CLASS: harness-infra
CONFIDENCE: high
ACTION-TAKEN: ${STUB_ACTION:-committed a fix}
ESCALATE: ${STUB_ESCALATE:-no}

**Root cause** — stub diagnosis for testing.
EOF
echo "stub agent ran"
